/**
 * Borrower-side MuSig2 responder — Task 4, docs/COLLATERAL-MODEL.md §4. The
 * CLI-first counterpart to the engine's `POST /musig/nonce` /
 * `POST /musig/partial` (packages/engine/src/musig-server.ts): polls
 * `GET /musig/pending` and answers whatever round the engine is waiting on,
 * using only the borrower's own secret — never sent anywhere.
 *
 * Run standalone: `BORROWER_SECRET_HEX=... ENGINE_URL=... npx tsx scripts/borrower.ts`
 * Or import `runBorrowerResponder` directly (used by scripts/06-spike-http-musig.ts).
 */
import { IndividualPubkey, nonceGen, nonceAggregate, Session } from "@scure/btc-signer/musig2.js";
import { aggregateKey } from "@satusd/tachi-kit";

export interface BorrowerResponderOptions {
  readonly engineUrl: string;
  readonly secret: Buffer;
  /** The engine's individual (non-aggregate) compressed pubkey. */
  readonly remotePub: Buffer;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  /** Called once per round serviced, for visibility — optional. */
  readonly onRound?: (phase: "nonce" | "partial", sighashHex: string) => void;
}

type Pending = { phase: "none" } | { phase: "nonce" | "partial"; sighash: string; enginePublicNonce: string };

/**
 * Poll the engine and answer signing rounds until `signal` aborts. Never
 * returns on its own — the borrower stays available for as long as their
 * channel might need a cooperative signature (open, each commitState).
 */
export async function runBorrowerResponder(opts: BorrowerResponderOptions): Promise<void> {
  const pub = Buffer.from(IndividualPubkey(opts.secret) as Uint8Array);
  const agg = aggregateKey([pub, opts.remotePub]);
  const pollIntervalMs = opts.pollIntervalMs ?? 200;

  // Remembers this side's secret nonce between the nonce round and the
  // partial-sig round for a given sighash — mirrors what the engine's
  // musig-server.ts holds server-side for its own contribution.
  const ourNonces = new Map<string, { secretNonce: Uint8Array; publicNonce: Uint8Array }>();

  while (!opts.signal?.aborted) {
    const res = await fetch(`${opts.engineUrl}/musig/pending`);
    const pendingResult = (await res.json()) as Pending;

    if (pendingResult.phase === "none") {
      await sleep(pollIntervalMs, opts.signal);
      continue;
    }

    const sighash = Buffer.from(pendingResult.sighash, "hex");

    if (pendingResult.phase === "nonce") {
      const nonce = nonceGen(pub, opts.secret, agg.xOnly, sighash);
      ourNonces.set(pendingResult.sighash, { secretNonce: nonce.secret, publicNonce: nonce.public });
      await fetch(`${opts.engineUrl}/musig/nonce`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sighash: pendingResult.sighash, publicNonce: Buffer.from(nonce.public).toString("hex") }),
      });
      opts.onRound?.("nonce", pendingResult.sighash);
      continue;
    }

    // phase === "partial"
    const ours = ourNonces.get(pendingResult.sighash);
    if (!ours) {
      // We haven't seen the nonce round for this sighash (e.g. we started
      // mid-session) — nothing useful to submit yet; back off and re-poll.
      await sleep(pollIntervalMs, opts.signal);
      continue;
    }
    const enginePublicNonce = Buffer.from(pendingResult.enginePublicNonce, "hex");
    const aggNonce = nonceAggregate([enginePublicNonce, ours.publicNonce]) as Uint8Array;
    const session = new Session(aggNonce, agg.publicKeys as Buffer[], sighash);
    const partial = session.sign(ours.secretNonce, opts.secret);
    ourNonces.delete(pendingResult.sighash);
    await fetch(`${opts.engineUrl}/musig/partial`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sighash: pendingResult.sighash, partialSig: Buffer.from(partial as Uint8Array).toString("hex") }),
    });
    opts.onRound?.("partial", pendingResult.sighash);
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
  const secretHex = process.env.BORROWER_SECRET_HEX;
  const remotePubHex = process.env.ENGINE_PUB_HEX;
  if (!secretHex || !remotePubHex) {
    throw new Error("set BORROWER_SECRET_HEX and ENGINE_PUB_HEX (the engine's individual compressed pubkey)");
  }
  console.log(`[borrower] responding to ${engineUrl} until interrupted (Ctrl+C)`);
  await runBorrowerResponder({
    engineUrl,
    secret: Buffer.from(secretHex, "hex"),
    remotePub: Buffer.from(remotePubHex, "hex"),
    onRound: (phase, sighashHex) => console.log(`[borrower] answered ${phase} round for ${sighashHex.slice(0, 16)}...`),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[borrower] failed:", err);
    process.exit(1);
  });
}
