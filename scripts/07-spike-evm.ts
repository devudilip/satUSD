/**
 * Spike: can we run EVM transactions on Tachi with a key whose gas VTXO we
 * registered ourselves? Registers a small ledger deposit for a throwaway key,
 * deploys a 10-byte contract that returns 42, then reads it back.
 *
 *   TACHI_NETWORK=regtest tsx scripts/07-spike-evm.ts
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1";
import {
  TachiClient,
  buildDeployTx,
  signEVMTx,
  evmTxHash,
  evmAddressFromPubKey,
  contractAddress,
  maxGasFeeSats,
} from "@tachibtc/tachi-sdk-ts";
import { resolveNetworkConfig, registerDeposit } from "@satusd/tachi-kit";

const GAS_VTXO_SATS = 20_000n;
const LEDGER_FEE = 10n;

async function main() {
  const config = resolveNetworkConfig((process.env.TACHI_NETWORK as "regtest" | "signet") ?? "regtest");
  const client = new TachiClient({ baseUrl: config.tachiUrl });

  const priv = randomBytes(32);
  const xonly = Buffer.from(schnorr.getPublicKey(priv));
  const signer = {
    publicKey: xonly,
    sign: () => { throw new Error("ecdsa not used"); },
    signSchnorr: (h: Buffer) => Buffer.from(schnorr.sign(h, priv)),
  };
  console.log("[evm] key", xonly.toString("hex"), "evm", evmAddressFromPubKey(xonly));

  const dep = await registerDeposit(config, { userSigner: signer as never, amountSats: GAS_VTXO_SATS, feeSats: LEDGER_FEE });
  const vtxoId = dep.vtxoId.toString("hex");
  console.log("[evm] gas VTXO", vtxoId);
  const vtxo = await client.getVtxo(vtxoId);
  console.log("[evm] vtxo", JSON.stringify(vtxo).slice(0, 200));
  const amount = BigInt((vtxo as { amount?: number | string }).amount ?? GAS_VTXO_SATS - LEDGER_FEE);

  // init: copy 10-byte runtime to memory and return it. runtime: return uint256(42).
  const initCode = "600a600c600039600a6000f3" + "602a60005260206000f3";
  const nonce = await client.getEvmNonce(xonly.toString("hex"));
  const gasLimit = 100_000n;
  const fee = maxGasFeeSats({ gasLimit, gasPrice: 1n });
  const tx = buildDeployTx({
    inputs: [vtxoId],
    outputs: [{ owner: xonly, amount: amount - fee }],
    pubKey: xonly,
    nonce,
    gasLimit,
    initCode,
  });
  const signed = await signEVMTx(tx, (h) => schnorr.sign(h, priv));
  const hash = await evmTxHash(signed);
  const sent = await client.sendEvmTx(signed);
  console.log("[evm] sent", hash, JSON.stringify(sent).slice(0, 300));

  const addr = contractAddress(evmAddressFromPubKey(xonly), nonce);
  for (let i = 0; i < 40; i++) {
    try {
      const r = await client.getEvmReceipt(hash);
      console.log("[evm] receipt", JSON.stringify(r).slice(0, 400));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const call = await client.evmCall({ from: evmAddressFromPubKey(xonly), to: addr, data: "0x" } as never);
  console.log("[evm] contract", addr, "call ->", JSON.stringify(call).slice(0, 200));
}

main().catch((e) => { console.error("[evm] failed:", e); process.exit(1); });
