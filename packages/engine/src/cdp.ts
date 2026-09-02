import type { BitcoinCoreRpcClient } from "@tachibtc/taurus-wallet-aggregator";
import {
  openCollateral,
  commitState,
  broadcastLiquidation,
  closeChannel,
  canMint,
  type NetworkConfig,
  type CollateralChannel,
  type CommittedState,
  type OpenCollateralArgs,
} from "@satusd/tachi-kit";
import { debtWithFees, initialFeeIndex } from "./fees.js";
import { Ledger } from "./ledger.js";

/**
 * A CDP *is* a collateral channel (`commitment.ts`) plus the engine's own
 * debt bookkeeping on top. This module owns the safety-critical sequencing
 * COLLATERAL-MODEL.md §3.1 requires: `mint` refuses to run until the
 * borrower has confirmed durably holding `exitTxHex` — enforced here, not
 * left as a comment for the caller to remember.
 */

export interface CdpRecord {
  readonly id: string; // vault address
  readonly ownerIndividualPub: string; // hex — the borrower's own key, the satUSD identity
  readonly channel: CollateralChannel;
  exitTxDelivered: boolean;
  principalUsdCents: bigint;
  feeIndexAtSettle: bigint;
  latestState: CommittedState | null;
  status: "open" | "closed" | "liquidated";
}

export type CdpEvent =
  | { readonly type: "open"; readonly cdpId: string; readonly exitTxHex: string; readonly amountSats: bigint }
  | { readonly type: "exit_tx_delivered"; readonly cdpId: string }
  | { readonly type: "mint"; readonly cdpId: string; readonly amountUsdCents: bigint; readonly feeUsdCents: bigint; readonly issuedUsdCents: bigint; readonly stateNum: bigint }
  | { readonly type: "repay"; readonly cdpId: string; readonly amountUsdCents: bigint; readonly stateNum: bigint | null }
  | { readonly type: "accrue"; readonly cdpId: string; readonly newPrincipalUsdCents: bigint; readonly stateNum: bigint }
  | { readonly type: "close"; readonly cdpId: string; readonly txid: string }
  | { readonly type: "liquidate"; readonly cdpId: string; readonly txid: string; readonly stateNum: bigint };

export interface CdpEngineOptions {
  readonly config: NetworkConfig;
  readonly ledger: Ledger<CdpEvent>;
  readonly protocolPayoutAddress: string;
  readonly lltvBps: bigint;
  readonly penaltyBps: bigint;
  readonly mintFeeBps?: bigint;
  /** Re-commit threshold on `accrue`, in bps of principal — COLLATERAL-MODEL.md §3.5 default: 0.5%. */
  readonly accrueRecommitThresholdBps?: bigint;
}

export class CdpEngine {
  private readonly cdps = new Map<string, CdpRecord>();
  private readonly config: NetworkConfig;
  private readonly ledger: Ledger<CdpEvent>;
  private readonly protocolPayoutAddress: string;
  private readonly lltvBps: bigint;
  private readonly penaltyBps: bigint;
  private readonly mintFeeBps: bigint;
  private readonly accrueRecommitThresholdBps: bigint;

  constructor(opts: CdpEngineOptions) {
    this.config = opts.config;
    this.ledger = opts.ledger;
    this.protocolPayoutAddress = opts.protocolPayoutAddress;
    this.lltvBps = opts.lltvBps;
    this.penaltyBps = opts.penaltyBps;
    this.mintFeeBps = opts.mintFeeBps ?? 10n; // 0.1%
    this.accrueRecommitThresholdBps = opts.accrueRecommitThresholdBps ?? 50n; // 0.5%
  }

  /** Open a channel. No satUSD is issued here — see `confirmExitTxDelivered` and `mint`. */
  async open(args: OpenCollateralArgs & { ownerIndividualPub: Buffer }): Promise<CdpRecord> {
    const channel = await openCollateral(this.config, args);
    const record: CdpRecord = {
      id: channel.vault.p2tr.address,
      ownerIndividualPub: args.ownerIndividualPub.toString("hex"),
      channel,
      exitTxDelivered: false,
      principalUsdCents: 0n,
      feeIndexAtSettle: initialFeeIndex(),
      latestState: null,
      status: "open",
    };
    this.cdps.set(record.id, record);
    this.ledger.append({ type: "open", cdpId: record.id, exitTxHex: channel.exitTxHex, amountSats: args.amountSats });
    return record;
  }

  /**
   * Call once the borrower has durably stored `channel.exitTxHex` on their
   * own side — their wallet, their disk, wherever they'll actually be able
   * to read it back from later. `mint` refuses until this has happened.
   */
  confirmExitTxDelivered(cdpId: string): void {
    const cdp = this.require(cdpId);
    cdp.exitTxDelivered = true;
    this.ledger.append({ type: "exit_tx_delivered", cdpId });
  }

  /** Returns the satUSD amount actually issued (after the mint fee) alongside the committed state. */
  async mint(
    cdpId: string,
    amountUsdCents: bigint,
    btcPriceUsdCents: bigint,
  ): Promise<{ issuedUsdCents: bigint; state: CommittedState }> {
    const cdp = this.require(cdpId);
    if (!cdp.exitTxDelivered) {
      throw new Error(
        `refusing to mint against ${cdpId}: borrower has not confirmed receiving exit_tx (COLLATERAL-MODEL.md §3.1)`,
      );
    }
    if (cdp.status !== "open") throw new Error(`cdp ${cdpId} is not open`);
    if (amountUsdCents <= 0n) throw new Error("mint amount must be positive");

    const collateralSats = cdp.channel.funding.valueSats;
    const newPrincipal = cdp.principalUsdCents + amountUsdCents;
    if (!canMint(collateralSats, newPrincipal, btcPriceUsdCents)) {
      throw new Error(`mint would breach the 150% minimum collateral ratio for ${cdpId}`);
    }

    const feeUsdCents = (amountUsdCents * this.mintFeeBps) / 10_000n;
    const issuedUsdCents = amountUsdCents - feeUsdCents;
    cdp.principalUsdCents = newPrincipal;
    const state = await this.mustCommit(cdp);
    this.ledger.append({ type: "mint", cdpId, amountUsdCents, feeUsdCents, issuedUsdCents, stateNum: state.n });
    return { issuedUsdCents, state };
  }

  /** Repay debt. If the position fully closes out (principal hits zero), no new liquidation state is committed — use `close` next. */
  async repay(cdpId: string, amountUsdCents: bigint): Promise<CommittedState | null> {
    const cdp = this.require(cdpId);
    if (cdp.status !== "open") throw new Error(`cdp ${cdpId} is not open`);
    if (amountUsdCents <= 0n) throw new Error("repay amount must be positive");
    const newPrincipal = cdp.principalUsdCents - amountUsdCents;
    if (newPrincipal < 0n) throw new Error(`repay of ${amountUsdCents} exceeds principal ${cdp.principalUsdCents}`);
    cdp.principalUsdCents = newPrincipal;
    const state = newPrincipal === 0n ? null : await this.mustCommit(cdp);
    this.ledger.append({ type: "repay", cdpId, amountUsdCents, stateNum: state?.n ?? null });
    return state;
  }

  /**
   * Roll the stability fee into principal. Only re-commits a state (a real
   * MuSig2 round + cosign) when the change exceeds `accrueRecommitThresholdBps`
   * — COLLATERAL-MODEL.md §3.5 default 0.5% — so routine per-block accrual
   * doesn't spam the cosign endpoint. Principal itself always updates.
   */
  async accrue(cdpId: string, globalFeeIndex: bigint): Promise<CommittedState | null> {
    const cdp = this.require(cdpId);
    if (cdp.status !== "open" || cdp.principalUsdCents === 0n) return null;
    const newPrincipal = debtWithFees(cdp.principalUsdCents, cdp.feeIndexAtSettle, globalFeeIndex);
    const delta = newPrincipal - cdp.principalUsdCents;
    if (delta === 0n) return null;
    const deltaAbs = delta < 0n ? -delta : delta;
    const deltaBps = (deltaAbs * 10_000n) / cdp.principalUsdCents;

    cdp.principalUsdCents = newPrincipal;
    cdp.feeIndexAtSettle = globalFeeIndex;
    if (deltaBps < this.accrueRecommitThresholdBps) return null;

    const state = await this.mustCommit(cdp);
    this.ledger.append({ type: "accrue", cdpId, newPrincipalUsdCents: newPrincipal, stateNum: state.n });
    return state;
  }

  /** Debt must already be zero (see `repay`). Broadcasts the final state paying the full balance back to the borrower. */
  async close(cdpId: string, rpc: BitcoinCoreRpcClient): Promise<string> {
    const cdp = this.require(cdpId);
    if (cdp.principalUsdCents !== 0n) {
      throw new Error(`cannot close ${cdpId}: outstanding principal ${cdp.principalUsdCents}`);
    }
    const txid = await closeChannel(this.config, cdp.channel, rpc);
    cdp.status = "closed";
    this.ledger.append({ type: "close", cdpId, txid });
    return txid;
  }

  /**
   * Broadcast the CDP's latest held refund. Deterministic — the split was
   * fixed when `mustCommit` last ran; this function makes no judgment call,
   * which is why a keeper bot with only public API access can safely call it.
   */
  async liquidate(cdpId: string, rpc: BitcoinCoreRpcClient): Promise<string> {
    const cdp = this.require(cdpId);
    if (!cdp.latestState) throw new Error(`cdp ${cdpId} has no committed liquidation state`);
    const txid = await broadcastLiquidation(rpc, cdp.latestState.refundHex);
    cdp.status = "liquidated";
    this.ledger.append({ type: "liquidate", cdpId, txid, stateNum: cdp.latestState.n });
    return txid;
  }

  get(cdpId: string): CdpRecord | undefined {
    return this.cdps.get(cdpId);
  }

  all(): readonly CdpRecord[] {
    return [...this.cdps.values()];
  }

  private require(cdpId: string): CdpRecord {
    const cdp = this.cdps.get(cdpId);
    if (!cdp) throw new Error(`no such CDP: ${cdpId}`);
    return cdp;
  }

  private async mustCommit(cdp: CdpRecord): Promise<CommittedState> {
    const n = (cdp.latestState?.n ?? 0n) + 1n;
    const state = await commitState(this.config, {
      channel: cdp.channel,
      n,
      collateralSats: cdp.channel.funding.valueSats,
      debtUsdCents: cdp.principalUsdCents,
      lltvBps: this.lltvBps,
      penaltyBps: this.penaltyBps,
      protocolPayoutAddress: this.protocolPayoutAddress,
    });
    // Overwriting `latestState` here is the "delete the previous refundHex
    // from hot storage" step COLLATERAL-MODEL.md §3.2 asks for — nothing
    // else in this record ever held the old one.
    cdp.latestState = state;
    return state;
  }
}
