import { describe, it, expect } from "vitest";
import { Ledger, stableStringify } from "../src/ledger.js";

describe("Ledger", () => {
  it("chains hashes and verifies", () => {
    const ledger = new Ledger<{ note: string }>();
    ledger.append({ note: "open" });
    ledger.append({ note: "mint" });
    ledger.append({ note: "close" });
    expect(ledger.length).toBe(3);
    expect(ledger.verify()).toBe(true);
    expect(ledger.get(0)!.prevHash).toBe("0".repeat(64));
    expect(ledger.get(1)!.prevHash).toBe(ledger.get(0)!.hash);
    expect(ledger.get(2)!.prevHash).toBe(ledger.get(1)!.hash);
    expect(ledger.latestHash).toBe(ledger.get(2)!.hash);
  });

  it("detects a tampered payload", () => {
    const ledger = new Ledger<{ amount: bigint }>();
    ledger.append({ amount: 100n });
    ledger.append({ amount: 200n });
    expect(ledger.verify()).toBe(true);
    // Mutate a record in place — simulates tampering with stored history.
    (ledger.get(0) as { payload: { amount: bigint } }).payload.amount = 999n;
    expect(ledger.verify()).toBe(false);
  });

  it("detects a spliced-in record with a forged prevHash", () => {
    const ledger = new Ledger<{ n: number }>();
    ledger.append({ n: 1 });
    ledger.append({ n: 2 });
    const records = ledger.all() as unknown as { prevHash: string }[];
    records[1].prevHash = "f".repeat(64);
    expect(ledger.verify()).toBe(false);
  });

  it("hashes bigint and object-key order deterministically", () => {
    const a = stableStringify({ b: 2n, a: 1n });
    const b = stableStringify({ a: 1n, b: 2n });
    expect(a).toBe(b);
    expect(a).toContain("bigint:1");
    expect(a).toContain("bigint:2");
  });

  it("empty ledger's latestHash is genesis", () => {
    const ledger = new Ledger();
    expect(ledger.latestHash).toBe("0".repeat(64));
    expect(ledger.verify()).toBe(true);
  });
});
