/**
 * Keeper bot — exactly what a third party would run, using nothing but
 * `POST /cdp/:id/liquidate`. It has no in-process access to the engine, no
 * knowledge of the oracle price, no privileged path at all: it just tries
 * the public endpoint for every open CDP on an interval, and the endpoint's
 * own price check (routes.ts) refuses anything not actually liquidatable.
 * A dumb, safe keeper is the point — the safety lives entirely server-side.
 */
export interface RunKeeperOptions {
  readonly engineUrl: string;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly onAttempt?: (cdpId: string, result: { liquidated: boolean; detail: unknown }) => void;
}

export async function runKeeper(opts: RunKeeperOptions): Promise<void> {
  const pollIntervalMs = opts.pollIntervalMs ?? 2_000;
  while (!opts.signal?.aborted) {
    const res = await fetch(`${opts.engineUrl}/cdp`);
    const { cdps } = (await res.json()) as { cdps: Array<{ id: string; status: string }> };
    for (const cdp of cdps) {
      if (cdp.status !== "open") continue;
      const attempt = await fetch(`${opts.engineUrl}/cdp/${encodeURIComponent(cdp.id)}/liquidate`, { method: "POST" });
      const detail = await attempt.json();
      opts.onAttempt?.(cdp.id, { liquidated: attempt.ok, detail });
    }
    await sleep(pollIntervalMs, opts.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function main() {
  const engineUrl = process.env.ENGINE_URL ?? "http://127.0.0.1:4001";
  console.log(`[keeper] watching ${engineUrl}/cdp, polling every 2s`);
  await runKeeper({
    engineUrl,
    onAttempt: (cdpId, { liquidated, detail }) => {
      if (liquidated) console.log(`[keeper] LIQUIDATED ${cdpId}:`, detail);
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[keeper] failed:", err);
    process.exit(1);
  });
}
