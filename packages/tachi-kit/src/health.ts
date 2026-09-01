/**
 * Pure CDP risk math — collateral ratio, mint eligibility, liquidation share
 * and price. No network calls, no I/O. All money values are bigint:
 * collateral in sats, debt and price in USD cents.
 *
 * Liquidation is real, not soft (see docs/COLLATERAL-MODEL.md): a MuSig2
 * joint owner key (borrower + protocol) with a pre-signed exit tx (the
 * borrower's guarantee) and a pre-signed, quorum-cosigned liquidation refund
 * (the protocol's enforcement) — verified live in scripts/03 and
 * scripts/04-spike-musig-vault.ts. `shareForLiquidation` computes the split
 * a refund state commits to.
 */

export const SATS_PER_BTC = 100_000_000n;
export const BPS_DENOMINATOR = 10_000n;

/** Minimum collateral ratio to mint or to avoid blocking further mints, in bps (150.00%). */
export const MIN_MINT_RATIO_BPS = 15_000n;

/** Below this ratio a CDP is marked delinquent, in bps (130.00%). */
export const DELINQUENCY_RATIO_BPS = 13_000n;

/** Value of `collateralSats` at `btcPriceUsdCents` per BTC, in USD cents. */
export function collateralValueUsdCents(collateralSats: bigint, btcPriceUsdCents: bigint): bigint {
  return (collateralSats * btcPriceUsdCents) / SATS_PER_BTC;
}

/**
 * Collateral ratio in basis points (15000 = 150%). `null` when `debtUsdCents`
 * is zero — an undrawn or fully repaid CDP has no ratio to speak of, not an
 * infinite one, and callers should treat `null` as "not at risk."
 */
export function collateralRatioBps(
  collateralSats: bigint,
  debtUsdCents: bigint,
  btcPriceUsdCents: bigint,
): bigint | null {
  if (debtUsdCents === 0n) return null;
  const valueUsdCents = collateralValueUsdCents(collateralSats, btcPriceUsdCents);
  return (valueUsdCents * BPS_DENOMINATOR) / debtUsdCents;
}

/** Whether the CDP's current ratio is at or above the mint floor (150%). */
export function canMint(collateralSats: bigint, debtUsdCents: bigint, btcPriceUsdCents: bigint): boolean {
  const ratioBps = collateralRatioBps(collateralSats, debtUsdCents, btcPriceUsdCents);
  return ratioBps === null || ratioBps >= MIN_MINT_RATIO_BPS;
}

/** Whether the CDP's current ratio is below the delinquency threshold (130%). */
export function isDelinquent(collateralSats: bigint, debtUsdCents: bigint, btcPriceUsdCents: bigint): boolean {
  const ratioBps = collateralRatioBps(collateralSats, debtUsdCents, btcPriceUsdCents);
  return ratioBps !== null && ratioBps < DELINQUENCY_RATIO_BPS;
}

/**
 * BTC/USD price (cents per BTC) at which this CDP's ratio would hit exactly
 * `thresholdBps`. `null` when there is no debt (no price makes an undrawn CDP
 * delinquent) or no collateral (already delinquent at every price).
 */
export function priceForRatioUsdCents(
  collateralSats: bigint,
  debtUsdCents: bigint,
  thresholdBps: bigint = DELINQUENCY_RATIO_BPS,
): bigint | null {
  if (debtUsdCents === 0n || collateralSats === 0n) return null;
  return (thresholdBps * debtUsdCents * SATS_PER_BTC) / (BPS_DENOMINATOR * collateralSats);
}

/**
 * The liquidation split a refund state should commit to (docs/COLLATERAL-MODEL.md §3.5):
 *
 *   priceLiq = debt / (collateral × lltv)                     — price at which ratio == lltv
 *   share    = min(collateral, ceil(debt × (1 + penalty) / priceLiq))
 *
 * `share` is what the protocol's refund output pays out; the rest goes to
 * the borrower's `to_local`. Uses `priceLiq`, not spot — the tx is meant to
 * be broadcast when spot has reached it, and the penalty buffer plus
 * over-collateralization absorb the gap if spot has moved past it by then.
 * `null` when there is no debt or no collateral (nothing to liquidate).
 */
export function shareForLiquidation(
  debtUsdCents: bigint,
  collateralSats: bigint,
  lltvBps: bigint,
  penaltyBps: bigint,
): { shareSats: bigint; priceLiqUsdCents: bigint } | null {
  const priceLiqUsdCents = priceForRatioUsdCents(collateralSats, debtUsdCents, lltvBps);
  if (priceLiqUsdCents === null || priceLiqUsdCents === 0n) return null;
  const numerator = debtUsdCents * (BPS_DENOMINATOR + penaltyBps) * SATS_PER_BTC;
  const denominator = BPS_DENOMINATOR * priceLiqUsdCents;
  const shareSats = (numerator + denominator - 1n) / denominator; // ceil division
  return { shareSats: shareSats > collateralSats ? collateralSats : shareSats, priceLiqUsdCents };
}
