/**
 * Global fee index accounting (docs/PLAN.md Phase 3). Standard index
 * pattern: one global index accrues per block; each CDP just remembers the
 * index value at the moment it last had its debt settled (mint, repay,
 * commitState), and its current debt-with-fees is a single multiplication —
 * never accrue per-position.
 */

export const STABILITY_FEE_APR_BPS = 200n; // 2%
export const BLOCKS_PER_YEAR = 52_560n; // ~10-minute blocks
export const INDEX_PRECISION = 1_000_000_000_000n; // 1e12 fixed-point

export function initialFeeIndex(): bigint {
  return INDEX_PRECISION;
}

/** Simple (non-compounding within a single call) per-block accrual — fine at demo cadence; call often enough that the difference from compounding is negligible. */
export function accrueFeeIndex(
  currentIndex: bigint,
  blocksElapsed: bigint,
  aprBps: bigint = STABILITY_FEE_APR_BPS,
): bigint {
  if (blocksElapsed <= 0n) return currentIndex;
  const increment = (currentIndex * aprBps * blocksElapsed) / (10_000n * BLOCKS_PER_YEAR);
  return currentIndex + increment;
}

/** A CDP's current debt including accrued stability fee since it last settled. */
export function debtWithFees(principal: bigint, cdpIndexAtSettle: bigint, currentGlobalIndex: bigint): bigint {
  if (principal === 0n) return 0n;
  return (principal * currentGlobalIndex) / cdpIndexAtSettle;
}
