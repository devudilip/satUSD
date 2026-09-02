import { createHash } from "node:crypto";

/**
 * Append-only, hash-chained ledger — every CDP mutation (open, mint, repay,
 * accrue, liquidate, close) is a record here. State is always a fold over
 * the log, never mutated in place. Periodically anchored to the Tachi ledger
 * (anchor.ts) so history is tamper-evident independent of trusting this process.
 */

export interface LedgerRecord<T = unknown> {
  readonly seq: number;
  readonly prevHash: string;
  readonly timestamp: number;
  readonly payload: T;
  readonly hash: string;
}

const GENESIS_HASH = "0".repeat(64);

/** Deterministic JSON: sorted object keys, bigint encoded as a tagged string so it round-trips unambiguously. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Buffer || value instanceof Uint8Array) return `hex:${Buffer.from(value).toString("hex")}`;
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function hashRecord(seq: number, prevHash: string, timestamp: number, payload: unknown): string {
  const bytes = stableStringify({ seq, prevHash, timestamp, payload });
  return createHash("sha256").update(bytes).digest("hex");
}

export class Ledger<T = unknown> {
  private readonly records: LedgerRecord<T>[] = [];

  append(payload: T, timestamp: number = Date.now()): LedgerRecord<T> {
    const seq = this.records.length;
    const prevHash = seq === 0 ? GENESIS_HASH : this.records[seq - 1].hash;
    const hash = hashRecord(seq, prevHash, timestamp, payload);
    const record: LedgerRecord<T> = { seq, prevHash, timestamp, payload, hash };
    this.records.push(record);
    return record;
  }

  get(seq: number): LedgerRecord<T> | undefined {
    return this.records[seq];
  }

  get length(): number {
    return this.records.length;
  }

  get latestHash(): string {
    return this.records.length === 0 ? GENESIS_HASH : this.records[this.records.length - 1].hash;
  }

  all(): readonly LedgerRecord<T>[] {
    return this.records;
  }

  /** Recompute every hash from scratch and confirm the chain is unmutated. */
  verify(): boolean {
    let prevHash = GENESIS_HASH;
    for (const record of this.records) {
      const expected = hashRecord(record.seq, prevHash, record.timestamp, record.payload);
      if (expected !== record.hash || record.prevHash !== prevHash) return false;
      prevHash = record.hash;
    }
    return true;
  }
}
