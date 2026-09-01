import {
  buildVtxoPsbt,
  verifyVtxoPsbt,
  signVtxoPsbtAsUser,
  finalizeVtxoPsbt,
  buildTachiTxDeposit,
  buildTachiTxTransfer,
  signTachiTx,
  broadcastTachiTx,
  getAccountNonce,
  vtxoIdFromDeposit,
  waitForVtxoCommit,
  type Vault,
  type VtxoInput,
  type VtxoOutput,
  type TaprootSigner,
  type TachiTx,
} from "@tachibtc/taurus-vault-core";
import type { NetworkConfig } from "./net.js";

/**
 * Nonces are sequential per account (docs/BACKGROUND.md §7); concurrent calls
 * for the same account must not fetch/consume the same nonce twice. This is a
 * per-process serializer — one queue per pubkey hex — sufficient for a single
 * engine instance. A multi-instance deployment needs a shared lock instead.
 */
const nonceQueues = new Map<string, Promise<unknown>>();

async function withNonceLock<T>(pubkeyHex: string, fn: () => Promise<T>): Promise<T> {
  const prior = nonceQueues.get(pubkeyHex) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  nonceQueues.set(
    pubkeyHex,
    run.catch(() => undefined),
  );
  return run;
}

export interface RegisterDepositArgs {
  readonly userSigner: TaprootSigner & { publicKey: Buffer };
  readonly amountSats: bigint;
  readonly feeSats?: bigint;
}

export interface RegisterDepositResult {
  readonly tx: TachiTx;
  readonly vtxoId: Buffer;
}

/**
 * Register an L1 deposit on the Tachi VTXO ledger — step 6 of the canonical
 * sequence (docs/BACKGROUND.md §7): build the deposit envelope, sign, broadcast,
 * and wait for it to commit. Call this after the Bitcoin-layer deposit
 * (`depositToVault`) has confirmed.
 */
export async function registerDeposit(
  config: NetworkConfig,
  args: RegisterDepositArgs,
): Promise<RegisterDepositResult> {
  const pubkeyHex = args.userSigner.publicKey.toString("hex");
  return withNonceLock(pubkeyHex, async () => {
    const nonce = await getAccountNonce(args.userSigner.publicKey, { baseUrl: config.tachiUrl });
    const draft = buildTachiTxDeposit({
      userXOnly: args.userSigner.publicKey,
      amountSats: args.amountSats,
      nonce,
      feeSats: args.feeSats,
    });
    const signed = await signTachiTx(draft, args.userSigner);
    await broadcastTachiTx(signed, {
      url: `${config.tachiUrl}/tachi_txBroadcastSync`,
      allowInsecureHttp: config.network === "regtest",
    });
    const vtxoId = vtxoIdFromDeposit(signed, 0);
    await waitForVtxoCommit(vtxoId, {
      baseUrl: config.tachiUrl,
      allowInsecureHttp: config.network === "regtest",
    });
    return { tx: signed, vtxoId };
  });
}

export interface TransferVtxoArgs {
  readonly vault: Vault;
  readonly userSigner: TaprootSigner & { publicKey: Buffer };
  readonly inputs: readonly VtxoInput[];
  readonly outputs: readonly VtxoOutput[];
  readonly feeSats: bigint;
  readonly maxFeeSats: bigint;
}

export interface TransferVtxoResult {
  readonly tx: TachiTx;
}

/**
 * The canonical VTXO PSBT + transfer sequence (docs/BACKGROUND.md §7, steps
 * 5 and 7), wrapped as one call: build -> verify -> sign -> finalize the PSBT,
 * then wrap it in a TachiTx, sign, and broadcast. Used both to lock a VTXO to a
 * vault (outputs directed at `vault.p2tr.address`) and to unlock it (outputs
 * directed elsewhere).
 */
export async function transferVtxo(
  config: NetworkConfig,
  args: TransferVtxoArgs,
): Promise<TransferVtxoResult> {
  const pubkeyHex = args.userSigner.publicKey.toString("hex");
  return withNonceLock(pubkeyHex, async () => {
    const verifyOptions = { maxFeeSats: args.maxFeeSats };
    const built = buildVtxoPsbt({
      vault: args.vault,
      inputs: args.inputs,
      outputs: args.outputs,
      feeSats: args.feeSats,
    });
    verifyVtxoPsbt(built.psbt, args.vault, verifyOptions);
    await signVtxoPsbtAsUser(built.psbt, args.userSigner, args.vault, verifyOptions);
    finalizeVtxoPsbt(built.psbt, args.vault, verifyOptions);

    const nonce = await getAccountNonce(args.userSigner.publicKey, { baseUrl: config.tachiUrl });
    const draft = buildTachiTxTransfer({
      vault: args.vault,
      inputs: args.inputs,
      outputs: args.outputs,
      feeSats: args.feeSats,
      nonce,
      psbt: built.psbt,
    });
    const signed = await signTachiTx(draft, args.userSigner);
    await broadcastTachiTx(signed, {
      url: `${config.tachiUrl}/tachi_txBroadcastSync`,
      allowInsecureHttp: config.network === "regtest",
    });
    return { tx: signed };
  });
}
