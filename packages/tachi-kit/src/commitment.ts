import type { BitcoinCoreRpcClient, Wallet } from "@tachibtc/taurus-wallet-aggregator";
import {
  createVault,
  verifyVaultP2tr,
  depositToVault,
  registerVault,
  buildUnilateralExitPsbt,
  signUnilateralExitPsbtAsUser,
  finalizeUnilateralExitPsbt,
  buildToLocalP2trOutput,
  buildRefundPsbt,
  signRefundPsbtAsUser,
  cosignRefund,
  finalizeRefundPsbt,
  RefundCosignError,
  encodeStateHint,
  deriveStateObfuscator,
  quorumAggregateKey,
  type Vault,
  type VaultEvent,
  type VaultEventSubscription,
  type ToLocalP2trOutput,
} from "@tachibtc/taurus-vault-core";
import type { NetworkConfig } from "./net.js";
import { registerDeposit } from "./vtxo.js";
import { shareForLiquidation } from "./health.js";
import type { AggSigner } from "./musig.js";
import { watchVault } from "./events.js";

/**
 * Collateral channels — docs/COLLATERAL-MODEL.md §3, Track B. Verified live
 * end to end in scripts/03-spike-refund-cosign.ts and
 * scripts/04-spike-musig-vault.ts.
 *
 * A `CollateralChannel` is one CDP's vault: owner key is a MuSig2 aggregate
 * of the borrower's and the protocol's individual keys (build with
 * `createAggSigner` from musig.ts before calling `openCollateral`), so every
 * cooperative spend needs both, and the exit leaf needs the aggregate too —
 * which is why the borrower must hold a fully pre-signed `exitTxHex` before
 * any loan asset is released. That signature is the *only* thing the
 * protocol ever needs to give the borrower for their unilateral-exit
 * guarantee to hold.
 */

const LEDGER_FEE = 10n; // Tachi mempool's minimum ledger fee — 0 is rejected

export interface OpenCollateralArgs {
  /** The joint owner signer — build with `createAggSigner({ localSecret: protocolSecret, remotePub: borrowerPub, exchange })` first. */
  readonly ownerSigner: AggSigner;
  /** Where the borrower's exit tx and refund `to_local` remainder ultimately pay out to. */
  readonly borrowerReturnAddress: string;
  /** Wallet funding the L1 deposit — typically the borrower's own P2WPKH wallet. */
  readonly funderWallet: Wallet;
  readonly rpc: BitcoinCoreRpcClient;
  readonly amountSats: bigint;
  /** Loan term in blocks — also the exit leaf's CSV delay (see COLLATERAL-MODEL.md §3: "term = CSV"). */
  readonly csvBlocks: number;
  readonly exitFeeSats?: bigint;
}

export interface CollateralChannel {
  readonly vault: Vault;
  readonly ownerSigner: AggSigner;
  readonly funding: { readonly txid: string; readonly vout: number; readonly valueSats: bigint; readonly scriptPubKey: string };
  readonly vaultId: string;
  /** Fully signed, ready to broadcast unilaterally once `csvBlocks` has matured. Give this to the borrower. */
  readonly exitTxHex: string;
  readonly borrowerReturnAddress: string;
  readonly toLocal: ToLocalP2trOutput;
  readonly stateObfuscator: Buffer;
}

/**
 * Open a collateral channel (docs/COLLATERAL-MODEL.md §3.1): build the joint
 * vault, fund it on L1, onboard + register it on the Tachi ledger, and
 * pre-sign the borrower's exit tx. **Release no loan asset until the caller
 * has durably handed `exitTxHex` to the borrower** — everything up to that
 * point still needs the protocol's cooperation; after it, the borrower's
 * unilateral guarantee is real.
 */
export async function openCollateral(config: NetworkConfig, args: OpenCollateralArgs): Promise<CollateralChannel> {
  const vault = await createVault({
    network: config.network,
    userPubkey: args.ownerSigner.publicKey,
    csvBlocks: args.csvBlocks,
    validators: { endpoint: `${config.tachiUrl}/tachi_validators` },
  });
  verifyVaultP2tr(vault.p2tr);

  const dep = await depositToVault({
    vault,
    userWallet: args.funderWallet,
    rpc: args.rpc,
    amountSats: args.amountSats,
    feeRateSatVb: 2,
  });
  const raw = await args.rpc.call<{ vout: { n: number; scriptPubKey: { hex: string } }[] }>("getrawtransaction", [
    dep.txid,
    true,
  ]);
  const spk = vault.p2tr.output.toString("hex");
  const vout = raw.vout.find((o) => o.scriptPubKey.hex === spk);
  if (!vout) throw new Error(`deposit ${dep.txid} has no output paying the vault — is it confirmed yet?`);

  const onboard = await registerDeposit(config, {
    userSigner: args.ownerSigner,
    amountSats: args.amountSats,
    feeSats: LEDGER_FEE,
  });
  const reg = await registerVault({
    vault,
    outpoint: { fundingTxid: Buffer.from(dep.txid, "hex").reverse(), fundingVout: vout.n },
    userSigner: args.ownerSigner,
    inputs: [{ vtxoId: onboard.vtxoId, txid: dep.txid, vout: vout.n, valueSats: args.amountSats }],
    outputs: [{ owner: Buffer.from(vault.userKey.xOnly), amount: args.amountSats - LEDGER_FEE }],
    feeSats: LEDGER_FEE,
    broadcast: { url: `${config.tachiUrl}/tachi_txBroadcastSync` },
    account: { baseUrl: config.tachiUrl },
    confirm: { baseUrl: config.tachiUrl, overallTimeoutMs: 90_000 },
  });
  if (!reg.commit?.committed) {
    throw new Error(`vault registration did not commit: code=${reg.commit?.code} log=${reg.commit?.log ?? ""}`);
  }

  const funding = { txid: dep.txid, vout: vout.n, valueSats: args.amountSats, scriptPubKey: spk };
  const exitFeeSats = args.exitFeeSats ?? 1_000n;
  const exitBuilt = buildUnilateralExitPsbt({
    vault,
    funding,
    outputs: [{ address: args.borrowerReturnAddress, valueSats: args.amountSats - exitFeeSats }],
    feeSats: exitFeeSats,
  });
  const exitVerify = {
    maxFeeSats: exitFeeSats * 5n,
    expectedUserKey: vault.p2tr.exitLeaf.userKey,
    minCsvBlocks: args.csvBlocks,
  };
  await signUnilateralExitPsbtAsUser(exitBuilt.psbt, args.ownerSigner, vault, exitVerify);
  const exitTxHex = finalizeUnilateralExitPsbt(exitBuilt.psbt, vault, exitVerify);

  const toLocal = buildToLocalP2trOutput({
    network: config.network,
    nodePubkeys: vault.p2tr.cooperativeLeaf.nodeKeysCompressed,
    threshold: vault.p2tr.cooperativeLeaf.threshold,
    userDelayedPubkey: vault.userKey.xOnly,
    toSelfDelay: vault.p2tr.exitLeaf.csvBlocks,
  });
  const stateObfuscator = deriveStateObfuscator(
    args.ownerSigner.publicKey,
    quorumAggregateKey(vault.p2tr.cooperativeLeaf.nodeKeysCompressed),
  );

  return {
    vault,
    ownerSigner: args.ownerSigner,
    funding,
    vaultId: reg.vaultIdHex,
    exitTxHex,
    borrowerReturnAddress: args.borrowerReturnAddress,
    toLocal,
    stateObfuscator,
  };
}

export interface CommitStateArgs {
  readonly channel: CollateralChannel;
  /** Monotonically increasing per channel — see docs/COLLATERAL-MODEL.md §1 on why the daemon can't enforce this for you. */
  readonly n: bigint;
  readonly collateralSats: bigint;
  readonly debtUsdCents: bigint;
  readonly lltvBps: bigint;
  readonly penaltyBps: bigint;
  readonly protocolPayoutAddress: string;
  readonly feeSats?: bigint;
}

export interface CommittedState {
  readonly n: bigint;
  /** Cosigned refund tx, hex — hold it, broadcast only on liquidation. */
  readonly refundHex: string;
  readonly shareSats: bigint;
  readonly priceLiqUsdCents: bigint;
}

/**
 * Commit a new state (docs/COLLATERAL-MODEL.md §3.2): every borrow, repay,
 * add-collateral, or accrual checkpoint. Both parties (via `ownerSigner`)
 * sign a refund that pays `shareSats` to the protocol and the remainder to
 * the borrower's revocable `to_local`, and the validator quorum cosigns it.
 * The result is held, never broadcast unless liquidation actually happens —
 * broadcasting a superseded state risks the daemon's stale-state penalty
 * (not live today per §1, but do not build around relying on that).
 * **Delete the previous state's `refundHex` from hot storage once this
 * returns** — only ever hold the latest.
 */
export async function commitState(config: NetworkConfig, args: CommitStateArgs): Promise<CommittedState> {
  const share = shareForLiquidation(args.debtUsdCents, args.collateralSats, args.lltvBps, args.penaltyBps);
  if (!share) throw new Error("cannot commit a liquidation state with zero debt or zero collateral");

  const hint = encodeStateHint(args.n, args.channel.stateObfuscator);
  const feeSats = args.feeSats ?? 1_000n;
  const userValueSats = args.channel.funding.valueSats - share.shareSats - feeSats;
  const built = buildRefundPsbt({
    vault: args.channel.vault,
    funding: args.channel.funding,
    toLocal: args.channel.toLocal,
    userValueSats,
    extraOutputs: [{ address: args.protocolPayoutAddress, valueSats: share.shareSats }],
    feeSats,
    sequence: hint.sequence,
    locktime: hint.locktime,
  });
  const verify = {
    maxFeeSats: feeSats * 5n,
    toLocal: args.channel.toLocal,
    expectedUserValueSats: userValueSats,
    expectedDelayedPubkey: args.channel.vault.userKey.xOnly,
  };
  await signRefundPsbtAsUser(built.psbt, args.channel.ownerSigner, args.channel.vault, verify);
  try {
    await cosignRefund(built.psbt, args.channel.vault, {
      url: `${config.tachiUrl}/tachi_signTransaction`,
      timeoutMs: 90_000,
    });
  } catch (e) {
    if (e instanceof RefundCosignError) {
      throw new Error(`refund cosign failed: status=${e.status} msg=${e.message}`);
    }
    throw e;
  }
  const refundHex = finalizeRefundPsbt(built.psbt, args.channel.vault, verify);

  return { n: args.n, refundHex, shareSats: share.shareSats, priceLiqUsdCents: share.priceLiqUsdCents };
}

/**
 * Liquidate (docs/COLLATERAL-MODEL.md §3.3): broadcast the held refund.
 * Deterministic, no judgment call — anyone with the hex can do this (a
 * keeper bot, using only the public API). The txid is the receipt.
 */
export async function broadcastLiquidation(rpc: BitcoinCoreRpcClient, refundHex: string): Promise<string> {
  return rpc.call<string>("sendrawtransaction", [refundHex]);
}

/**
 * Close a channel (docs/COLLATERAL-MODEL.md §3.4): debt is zero, commit a
 * final state paying the full remaining balance back to the borrower and
 * broadcast it. Requires the owner signer (both parties), same as any other
 * state — the protocol cannot close a channel without the borrower either.
 */
export async function closeChannel(
  config: NetworkConfig,
  channel: CollateralChannel,
  rpc: BitcoinCoreRpcClient,
  feeSats = 1_000n,
): Promise<string> {
  const hint = encodeStateHint(0xffff_ffff_ffffn, channel.stateObfuscator); // terminal state number
  const built = buildRefundPsbt({
    vault: channel.vault,
    funding: channel.funding,
    toLocal: channel.toLocal,
    userValueSats: channel.funding.valueSats - feeSats,
    feeSats,
    sequence: hint.sequence,
    locktime: hint.locktime,
  });
  const verify = {
    maxFeeSats: feeSats * 5n,
    toLocal: channel.toLocal,
    expectedUserValueSats: channel.funding.valueSats - feeSats,
    expectedDelayedPubkey: channel.vault.userKey.xOnly,
  };
  await signRefundPsbtAsUser(built.psbt, channel.ownerSigner, channel.vault, verify);
  await cosignRefund(built.psbt, channel.vault, { url: `${config.tachiUrl}/tachi_signTransaction`, timeoutMs: 90_000 });
  const closeHex = finalizeRefundPsbt(built.psbt, channel.vault, verify);
  return rpc.call<string>("sendrawtransaction", [closeHex]);
}

/**
 * Watch a channel's vault for L1 activity — breach receipts, incoming
 * spends. See events.ts for the classification helper and the
 * WebSocket-availability caveat (regtest works, signet's gateway drops the
 * upgrade as of the daemon version probed in docs/BACKGROUND.md).
 */
export function watchChannel(
  config: NetworkConfig,
  channel: CollateralChannel,
  onEvent: (event: VaultEvent) => void,
  onError?: (error: Error) => void,
): VaultEventSubscription {
  return watchVault(config, channel.vault.p2tr.address, onEvent, { onError });
}
