import { describe, it, expect } from "vitest";
import { initialFeeIndex, accrueFeeIndex, debtWithFees, INDEX_PRECISION, BLOCKS_PER_YEAR } from "../src/fees.js";

describe("fee index accrual", () => {
  it("starts at the precision constant", () => {
    expect(initialFeeIndex()).toBe(INDEX_PRECISION);
  });

  it("does not change with zero blocks elapsed", () => {
    expect(accrueFeeIndex(INDEX_PRECISION, 0n)).toBe(INDEX_PRECISION);
  });

  it("accrues roughly 2% over a full year of blocks", () => {
    const index = accrueFeeIndex(INDEX_PRECISION, BLOCKS_PER_YEAR, 200n);
    const growthBps = ((index - INDEX_PRECISION) * 10_000n) / INDEX_PRECISION;
    expect(growthBps).toBe(200n);
  });

  it("debt scales with the index ratio", () => {
    const openIndex = INDEX_PRECISION;
    const laterIndex = accrueFeeIndex(openIndex, BLOCKS_PER_YEAR, 200n); // +2%
    const debt = debtWithFees(100_000n, openIndex, laterIndex);
    expect(debt).toBe(102_000n); // 100,000 * 1.02
  });

  it("zero principal stays zero regardless of index movement", () => {
    const laterIndex = accrueFeeIndex(INDEX_PRECISION, BLOCKS_PER_YEAR);
    expect(debtWithFees(0n, INDEX_PRECISION, laterIndex)).toBe(0n);
  });

  it("unchanged index leaves debt unchanged", () => {
    expect(debtWithFees(50_000n, INDEX_PRECISION, INDEX_PRECISION)).toBe(50_000n);
  });
});
