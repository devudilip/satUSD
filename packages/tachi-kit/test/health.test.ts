import { describe, it, expect } from "vitest";
import {
  SATS_PER_BTC,
  MIN_MINT_RATIO_BPS,
  DELINQUENCY_RATIO_BPS,
  collateralValueUsdCents,
  collateralRatioBps,
  canMint,
  isDelinquent,
  priceForRatioUsdCents,
  shareForLiquidation,
} from "../src/health.js";

const ONE_BTC = SATS_PER_BTC;
const PRICE_60K = 6_000_000n; // $60,000.00 in cents

describe("collateralValueUsdCents", () => {
  it("values 1 BTC at the given price", () => {
    expect(collateralValueUsdCents(ONE_BTC, PRICE_60K)).toBe(PRICE_60K);
  });

  it("rounds down for dust collateral (1 sat)", () => {
    // 1 sat * $60,000 / 1e8 sats = 0.0006 cents, floors to 0
    expect(collateralValueUsdCents(1n, PRICE_60K)).toBe(0n);
  });

  it("is zero at price zero", () => {
    expect(collateralValueUsdCents(ONE_BTC, 0n)).toBe(0n);
  });
});

describe("collateralRatioBps", () => {
  it("is null when there is no debt", () => {
    expect(collateralRatioBps(ONE_BTC, 0n, PRICE_60K)).toBeNull();
    expect(collateralRatioBps(0n, 0n, 0n)).toBeNull();
  });

  it("computes exactly 150% at the mint floor", () => {
    const collateralValueCents = 6_000_000n; // $60,000
    const debtUsdCents = 4_000_000n; // $40,000 -> 60000/40000 = 150%
    expect(collateralRatioBps(ONE_BTC, debtUsdCents, PRICE_60K)).toBe(15_000n);
    expect(collateralValueUsdCents(ONE_BTC, PRICE_60K)).toBe(collateralValueCents);
  });

  it("computes exactly 130% at the delinquency threshold", () => {
    const collateralSats = ONE_BTC;
    const price = 130_000n; // value = 130,000 cents
    const debtUsdCents = 100_000n;
    expect(collateralRatioBps(collateralSats, debtUsdCents, price)).toBe(13_000n);
  });

  it("is zero when price is zero and debt is nonzero", () => {
    expect(collateralRatioBps(ONE_BTC, 100n, 0n)).toBe(0n);
  });

  it("rounds down for dust collateral against nonzero debt", () => {
    expect(collateralRatioBps(1n, 1n, PRICE_60K)).toBe(0n);
  });
});

describe("canMint", () => {
  it("allows minting with no existing debt", () => {
    expect(canMint(ONE_BTC, 0n, PRICE_60K)).toBe(true);
    expect(canMint(0n, 0n, 0n)).toBe(true);
  });

  it("allows minting at exactly the 150% floor", () => {
    expect(canMint(ONE_BTC, 4_000_000n, PRICE_60K)).toBe(true);
  });

  it("blocks minting one bps below the floor", () => {
    // 149.99% : debt slightly above the 150% break-even
    const debtJustAbove = 4_000_000n + 1n;
    const ratio = collateralRatioBps(ONE_BTC, debtJustAbove, PRICE_60K);
    expect(ratio! < MIN_MINT_RATIO_BPS).toBe(true);
    expect(canMint(ONE_BTC, debtJustAbove, PRICE_60K)).toBe(false);
  });

  it("blocks minting at price zero with outstanding debt", () => {
    expect(canMint(ONE_BTC, 100n, 0n)).toBe(false);
  });
});

describe("isDelinquent", () => {
  it("is not delinquent with no debt", () => {
    expect(isDelinquent(ONE_BTC, 0n, PRICE_60K)).toBe(false);
  });

  it("is not delinquent exactly at 130% (threshold is strict <)", () => {
    expect(isDelinquent(ONE_BTC, 100_000n, 130_000n)).toBe(false);
  });

  it("is delinquent one bps below 130%", () => {
    // push debt up by 1 cent so the ratio drops just under the threshold
    expect(isDelinquent(ONE_BTC, 100_001n, 130_000n)).toBe(true);
  });

  it("is delinquent at price zero with outstanding debt", () => {
    expect(isDelinquent(ONE_BTC, 100n, 0n)).toBe(true);
  });

  it("is delinquent for dust collateral against nonzero debt", () => {
    expect(isDelinquent(1n, 1n, PRICE_60K)).toBe(true);
  });
});

describe("priceForRatioUsdCents", () => {
  it("is null with no debt or no collateral", () => {
    expect(priceForRatioUsdCents(ONE_BTC, 0n)).toBeNull();
    expect(priceForRatioUsdCents(0n, 1_000n)).toBeNull();
  });

  it("round-trips: ratio at the computed price equals the threshold", () => {
    const collateralSats = ONE_BTC;
    const debtUsdCents = 4_000_000n;
    const price = priceForRatioUsdCents(collateralSats, debtUsdCents, DELINQUENCY_RATIO_BPS);
    expect(price).not.toBeNull();
    expect(collateralRatioBps(collateralSats, debtUsdCents, price!)).toBe(DELINQUENCY_RATIO_BPS);
  });

  it("defaults to the delinquency threshold", () => {
    const collateralSats = ONE_BTC;
    const debtUsdCents = 4_000_000n;
    expect(priceForRatioUsdCents(collateralSats, debtUsdCents)).toBe(
      priceForRatioUsdCents(collateralSats, debtUsdCents, DELINQUENCY_RATIO_BPS),
    );
  });
});

describe("shareForLiquidation", () => {
  it("is null with no debt or no collateral", () => {
    expect(shareForLiquidation(0n, ONE_BTC, DELINQUENCY_RATIO_BPS, 800n)).toBeNull();
    expect(shareForLiquidation(1_000n, 0n, DELINQUENCY_RATIO_BPS, 800n)).toBeNull();
  });

  it("computes an exact split with no rounding", () => {
    // lltv 200%, no penalty: priceLiq = 100,000 cents; share = 50,000,000 sats exactly
    const result = shareForLiquidation(50_000n, ONE_BTC, 20_000n, 0n);
    expect(result).not.toBeNull();
    expect(result!.priceLiqUsdCents).toBe(100_000n);
    expect(result!.shareSats).toBe(50_000_000n);
  });

  it("rounds up on an inexact split", () => {
    const result = shareForLiquidation(100_000n, ONE_BTC, DELINQUENCY_RATIO_BPS, 800n);
    expect(result).not.toBeNull();
    expect(result!.priceLiqUsdCents).toBe(130_000n);
    // 108,000,000,000,000,000 / 1,300,000,000 = 83,076,923.07... -> ceils up
    expect(result!.shareSats).toBe(83_076_924n);
  });

  it("caps the share at the full collateral, never more", () => {
    const result = shareForLiquidation(100_000n, ONE_BTC, DELINQUENCY_RATIO_BPS, 50_000n);
    expect(result).not.toBeNull();
    expect(result!.shareSats).toBe(ONE_BTC);
  });
});
