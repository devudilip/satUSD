/**
 * Thin EVM account for Tachi: a secp256k1 key whose VTXOs pay gas in sats.
 *
 * Tachi EVM transactions spend the sender's VTXOs (inputs), return change as
 * a new VTXO (outputs) and refund unused gas as one more VTXO. This wraps that
 * into `deploy` / `send` / `read`, with one in-flight transaction per account
 * so nonces and VTXO inputs never collide.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1";
import {
  TachiClient,
  buildCallTx,
  buildDeployTx,
  signEVMTx,
  evmTxHash,
  evmAddressFromPubKey,
  contractAddress,
  maxGasFeeSats,
  MAX_GAS_PER_EVM_CALL,
  type EVMReceipt,
} from "@tachibtc/tachi-sdk-ts";
import { encodeDeployData, encodeFunctionData, decodeFunctionResult, decodeErrorResult, type Abi, type Hex } from "viem";
import { registerDeposit, type NetworkConfig } from "@satusd/tachi-kit";

const ARTIFACTS = JSON.parse(readFileSync(new URL("../../contracts/out/satusd.json", import.meta.url), "utf8")) as {
  contracts: Record<string, { abi: Abi; bytecode: Hex }>;
};
export const artifact = (name: "SatUSD" | "VaultManager") => ARTIFACTS.contracts[name]!;

/** Tachi's block explorer (EVM txs, contracts, VTXOs) for a network. */
export const tachiScanUrl = (config: NetworkConfig) => `https://${config.network}.tachibtcscan.com`;

const GAS_TOPUP_SATS = 50_000n;
const MIN_GAS_SATS = 5_000n;

/**
 * Puts real BTC behind a gas top-up: sends `sats` on Bitcoin into a TAURUS
 * vault owned by this key and returns the funding txid. Required off regtest.
 */
export type GasFunder = (account: TachiEvmAccount, sats: bigint) => Promise<{ txid: string }>;

export interface EvmTxResult {
  hash: string;
  receipt: EVMReceipt & { fee_sats?: number; contract_address?: string };
}

export class TachiEvmAccount {
  readonly xonly: Buffer;
  readonly address: Hex;
  private readonly priv: Uint8Array;
  private queue: Promise<unknown> = Promise.resolve();

  /** Deterministic key per (seed, label): restarts reuse the same EVM address. */
  constructor(
    private readonly config: NetworkConfig,
    private readonly client: TachiClient,
    seed: string,
    readonly label: string,
    private readonly fund?: { funder: GasFunder; sats: bigint; onFunded?: (account: TachiEvmAccount, txid: string, sats: bigint) => void },
  ) {
    this.priv = createHash("sha256").update(`satusd-evm/${label}/${seed}`).digest();
    this.xonly = Buffer.from(schnorr.getPublicKey(this.priv));
    this.address = evmAddressFromPubKey(this.xonly) as Hex;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async spendable() {
    const r = await this.client.getAddressVtxos(this.xonly.toString("hex"));
    return r.vtxos.filter((v) => !v.spent && !v.locked);
  }

  /**
   * Make sure this account holds VTXOs for gas. On regtest the Tachi ledger
   * accepts a deposit registration for any key, so we top up on demand. On
   * signet the account must be funded through a real Bitcoin deposit first.
   */
  async ensureGas(minSats = MIN_GAS_SATS): Promise<bigint> {
    let total = (await this.spendable()).reduce((s, v) => s + BigInt(v.amount), 0n);
    if (total >= minSats) return total;
    let amount = GAS_TOPUP_SATS;
    if (this.config.network !== "regtest") {
      // Back the VTXO with a real Bitcoin deposit before registering it on Tachi.
      if (!this.fund) throw new Error(`${this.label} EVM account ${this.address} needs gas: fund Tachi key ${this.xonly.toString("hex")} with VTXOs`);
      amount = this.fund.sats;
      const { txid } = await this.fund.funder(this, amount);
      this.fund.onFunded?.(this, txid, amount);
    }
    const signer = {
      publicKey: this.xonly,
      sign: () => {
        throw new Error("ECDSA not used");
      },
      signSchnorr: (h: Buffer) => Buffer.from(schnorr.sign(h, this.priv)),
    };
    await registerDeposit(this.config, { userSigner: signer as never, amountSats: amount, feeSats: 10n });
    total = (await this.spendable()).reduce((s, v) => s + BigInt(v.amount), 0n);
    return total;
  }

  /** The address a deploy at `offset` transactions from now will get. */
  async futureContractAddress(offset = 0n): Promise<Hex> {
    const nonce = await this.client.getEvmNonce(this.xonly.toString("hex"));
    return contractAddress(this.address, nonce + offset) as Hex;
  }

  deploy(name: "SatUSD" | "VaultManager", args: unknown[]): Promise<EvmTxResult> {
    const { abi, bytecode } = artifact(name);
    const initCode = encodeDeployData({ abi, bytecode, args });
    return this.exclusive(() => this.submit({ initCode }));
  }

  send(to: Hex, abi: Abi, functionName: string, args: unknown[]): Promise<EvmTxResult> {
    const data = encodeFunctionData({ abi, functionName, args } as never);
    return this.exclusive(() => this.submit({ to, data }));
  }

  private async submit(p: { initCode?: Hex; to?: Hex; data?: Hex }): Promise<EvmTxResult> {
    // Simulate first: a reverted Tachi EVM tx still spends gas and its nonce.
    const sim = await this.client.evmCall({ from: this.address, to: p.to, data: (p.data ?? p.initCode)! });
    if (sim.status !== 1) throw new Error(`EVM simulation reverted: ${explainRevert(sim.return_data, sim.error)}`);
    let gasLimit = (BigInt(sim.gas_used) * 13n) / 10n + 25_000n;
    if (gasLimit > MAX_GAS_PER_EVM_CALL) gasLimit = MAX_GAS_PER_EVM_CALL;
    const maxFee = maxGasFeeSats({ gasLimit, gasPrice: 1n });

    await this.ensureGas(maxFee + 1_000n);
    const vtxos = await this.spendable();
    const inputs: string[] = [];
    let inSum = 0n;
    for (const v of vtxos.sort((a, b) => b.amount - a.amount)) {
      inputs.push(v.id);
      inSum += BigInt(v.amount);
      if (inSum >= maxFee + 1n) break;
    }
    const change = inSum - maxFee;
    const nonce = await this.client.getEvmNonce(this.xonly.toString("hex"));
    const common = {
      inputs,
      outputs: change > 0n ? [{ owner: this.xonly, amount: change }] : [],
      pubKey: this.xonly,
      nonce,
      gasLimit,
    };
    const tx = p.initCode ? buildDeployTx({ ...common, initCode: p.initCode }) : buildCallTx({ ...common, to: p.to!, data: p.data! });
    const signed = await signEVMTx(tx, (h) => schnorr.sign(h, this.priv));
    const hash = await evmTxHash(signed);
    const sent = (await this.client.sendEvmTx(signed)) as { result?: { code?: number; log?: string } };
    if (sent.result?.code) throw new Error(`Tachi rejected the EVM tx: ${sent.result.log || `code ${sent.result.code}`}`);

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const receipt = (await this.client.getEvmReceipt(hash)) as EvmTxResult["receipt"];
        if (receipt.status !== 1) throw new Error(`EVM tx ${hash} failed: ${explainRevert(receipt.return_data, receipt.error)}`);
        return { hash, receipt };
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("EVM tx")) throw err;
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    throw new Error(`EVM tx ${hash} not confirmed within 60s`);
  }
}

/** Free, read-only contract call (nothing is committed). */
export async function readContract<T>(client: TachiClient, to: Hex, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const r = await client.evmCall({ to, data });
  if (r.status !== 1) throw new Error(`read ${functionName} reverted: ${explainRevert(r.return_data, r.error)}`);
  return decodeFunctionResult({ abi, functionName, data: r.return_data as Hex } as never) as T;
}

function explainRevert(data?: string, error?: string): string {
  if (data && data !== "0x") {
    for (const name of ["VaultManager", "SatUSD"] as const) {
      try {
        const d = decodeErrorResult({ abi: artifact(name).abi, data: data as Hex });
        return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
      } catch {
        /* try the next ABI */
      }
    }
  }
  return error || data || "unknown";
}
