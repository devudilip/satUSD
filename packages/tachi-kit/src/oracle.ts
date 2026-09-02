/**
 * BTC/USD price feed. No live external oracle is wired up (out of scope for
 * this build) — `DevPriceFeed` is a controllable in-memory stand-in, real
 * enough that `engine/liquidation.ts` and the mint-eligibility checks in
 * `health.ts` never need to know the difference. The staleness guard is the
 * part that matters: minting must halt on a stale feed regardless of which
 * feed implementation is behind `PriceFeed`.
 */

export interface PriceQuote {
  readonly btcUsdCents: bigint;
  readonly timestampMs: number;
}

export interface PriceFeed {
  getPrice(): Promise<PriceQuote>;
}

export const DEFAULT_MAX_STALENESS_MS = 5 * 60_000;

export class StalePriceError extends Error {
  constructor(
    public readonly ageMs: number,
    public readonly maxStalenessMs: number,
  ) {
    super(`price feed stale: ${ageMs}ms old, max ${maxStalenessMs}ms`);
  }
}

/** Throws `StalePriceError` if `quote` is older than `maxStalenessMs`. Call before every mint. */
export function assertFresh(quote: PriceQuote, maxStalenessMs = DEFAULT_MAX_STALENESS_MS, now = Date.now()): void {
  const ageMs = now - quote.timestampMs;
  if (ageMs > maxStalenessMs) throw new StalePriceError(ageMs, maxStalenessMs);
}

/**
 * In-memory price feed for regtest/demo use. `setPrice` is how the scripted
 * demo price drop happens — gate any caller of it behind an explicit dev
 * flag; it must never be reachable from a production mint/liquidation path.
 */
export class DevPriceFeed implements PriceFeed {
  private current: PriceQuote;

  constructor(initialBtcUsdCents: bigint) {
    this.current = { btcUsdCents: initialBtcUsdCents, timestampMs: Date.now() };
  }

  async getPrice(): Promise<PriceQuote> {
    return this.current;
  }

  setPrice(btcUsdCents: bigint): void {
    this.current = { btcUsdCents, timestampMs: Date.now() };
  }
}
