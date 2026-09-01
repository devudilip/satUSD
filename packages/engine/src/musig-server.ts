import type { FastifyInstance } from "fastify";
import type { MusigExchange } from "@satusd/tachi-kit";

/**
 * The engine's server-side half of the interactive MuSig2 exchange
 * (docs/COLLATERAL-MODEL.md §4, Task 4). The engine holds one secret and
 * needs the borrower's live cooperation for every signature; since the
 * engine can't open an outbound connection to an arbitrary borrower device,
 * it publishes what it's waiting for and the borrower's CLI/web client
 * polls `GET /musig/pending` and answers via `POST /musig/nonce` /
 * `POST /musig/partial`.
 *
 * One session at a time per exchange instance — matches how `commitment.ts`
 * actually uses a signer (one PSBT signature at a time, never concurrent).
 * A real multi-channel engine should key sessions by channel id; this is the
 * minimal version for the first CLI-driven spike.
 */
export function createHttpMusigExchange(): { exchange: MusigExchange; routes: (app: FastifyInstance) => void } {
  type Phase = "nonce" | "partial";
  interface PendingRound {
    readonly sighashHex: string;
    readonly phase: Phase;
    readonly enginePublicNonceHex: string;
    resolve(remoteValue: Buffer): void;
  }
  let pending: PendingRound | null = null;
  // Persists across the nonce->partial transition, independent of `pending`
  // (which the route handlers null out the instant they resolve it) — the
  // borrower needs the engine's public nonce again in the partial-sig round
  // to recompute the same aggregate nonce.
  const enginePublicNonceBySighash = new Map<string, string>();

  const exchange: MusigExchange = {
    exchangeNonce(localPublicNonce, sighash) {
      const sighashHex = sighash.toString("hex");
      const enginePublicNonceHex = localPublicNonce.toString("hex");
      enginePublicNonceBySighash.set(sighashHex, enginePublicNonceHex);
      return new Promise<Buffer>((resolve) => {
        pending = { sighashHex, phase: "nonce", enginePublicNonceHex, resolve };
      });
    },
    exchangePartialSig(_localPartialSig, sighash) {
      const sighashHex = sighash.toString("hex");
      const enginePublicNonceHex = enginePublicNonceBySighash.get(sighashHex);
      if (!enginePublicNonceHex) {
        return Promise.reject(new Error(`exchangePartialSig called for ${sighashHex} with no prior nonce round`));
      }
      enginePublicNonceBySighash.delete(sighashHex);
      return new Promise<Buffer>((resolve) => {
        pending = { sighashHex, phase: "partial", enginePublicNonceHex, resolve };
      });
    },
  };

  function routes(app: FastifyInstance): void {
    app.get("/musig/pending", async () => {
      if (!pending) return { phase: "none" as const };
      return { phase: pending.phase, sighash: pending.sighashHex, enginePublicNonce: pending.enginePublicNonceHex };
    });

    app.post<{ Body: { sighash: string; publicNonce: string } }>("/musig/nonce", async (req, reply) => {
      if (!pending || pending.phase !== "nonce" || pending.sighashHex !== req.body.sighash) {
        return reply.code(409).send({ error: "no matching pending nonce round" });
      }
      const { resolve } = pending;
      pending = null;
      resolve(Buffer.from(req.body.publicNonce, "hex"));
      return { ok: true };
    });

    app.post<{ Body: { sighash: string; partialSig: string } }>("/musig/partial", async (req, reply) => {
      if (!pending || pending.phase !== "partial" || pending.sighashHex !== req.body.sighash) {
        return reply.code(409).send({ error: "no matching pending partial-sig round" });
      }
      const { resolve } = pending;
      pending = null;
      resolve(Buffer.from(req.body.partialSig, "hex"));
      return { ok: true };
    });
  }

  return { exchange, routes };
}
