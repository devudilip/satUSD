/**
 * Pure CDP risk math — collateral ratio, mint eligibility, delinquency,
 * delinquency price. No network calls, no I/O. All money values are bigint:
 * collateral in sats, debt and price in USD cents.
 *
 * Liquidation is soft (see docs/BACKGROUND.md and PLAN.md Phase 4): TAURUS
 * vaults require the owner's own signature on every spending path, so there is
 * no seizure math here — only the delinquency threshold that gates new mints
 * and escalates the stability fee.
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
