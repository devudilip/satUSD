import {
  IndividualPubkey,
  sortKeys,
  keyAggregate,
  keyAggExport,
  nonceGen,
  nonceAggregate,
  Session,
} from "@scure/btc-signer/musig2.js";

/**
 * MuSig2 (BIP-327) joint signing — see docs/COLLATERAL-MODEL.md §4.
 *
 * Verified live in scripts/04-spike-musig-vault.ts: `createVault` accepts a
 * MuSig2 aggregate key as the owner key, and both the pre-signed exit tx and
 * a quorum-cosigned refund work when signed through it.
 */

/** The MuSig2 aggregate of a set of individual (compressed) pubkeys. */
export interface AggregateKey {
  /** 32-byte x-only aggregate key — what goes into `createVault({ userPubkey })`. */
  readonly xOnly: Buffer;
  /** 33-byte compressed aggregate key. */
  readonly compressed: Buffer;
  /** The input pubkeys in the canonical sorted order `Session`/`partialSigAgg` require. */
  readonly publicKeys: readonly Buffer[];
}

/** Aggregate individual compressed pubkeys into one MuSig2 output key. Pure, no signing. */
export function aggregateKey(pubs: readonly Buffer[]): AggregateKey {
  const sorted = sortKeys([...pubs]) as unknown as Buffer[];
  const ctx = keyAggregate(sorted);
  const xOnly = Buffer.from(keyAggExport(ctx) as Uint8Array);
  const compressed = Buffer.from((ctx.aggPublicKey as { toBytes(compressed: boolean): Uint8Array }).toBytes(true));
  return { xOnly, compressed, publicKeys: sorted };
}

/**
 * One two-party MuSig2 round, transport-agnostic: send our contribution, get
 * back theirs. In-process for a spike or test; an HTTP round trip in
 * production (`POST /musig/nonce`, `POST /musig/partial` — the engine-side
 * and borrower-side of this are wired up separately, not here).
 */
export interface MusigExchange {
  exchangeNonce(localPublicNonce: Buffer, sighash: Buffer): Promise<Buffer>;
  exchangePartialSig(localPartialSig: Buffer, sighash: Buffer): Promise<Buffer>;
}

export interface CreateAggSignerArgs {
  /** This party's own secret key. Never shared with `exchange`. */
  readonly localSecret: Buffer;
  /** The other party's compressed public key. */
  readonly remotePub: Buffer;
  /** Carries this party's nonce/partial-sig contributions to the other party and back. */
  readonly exchange: MusigExchange;
}

/**
 * Structurally a `TaprootSigner` (satisfies it wherever one is expected —
 * `createVault`, `signRefundPsbtAsUser`, etc.), but declared standalone
 * rather than intersected with it: `TaprootSigner = Signer | SignerAsync` is
 * a union with incompatible `sign` return types, and intersecting a concrete
 * object type with that union makes `signSchnorr` uncallable at the type
 * level for callers of this module. `sign` returns `never` (always throws),
 * which is assignable to every return position either union member expects.
 */
export interface AggSigner {
  readonly publicKey: Buffer;
  /** 32-byte x-only form of `publicKey` — what `createVault({ userPubkey })` commits to. */
  readonly xOnly: Buffer;
  sign(hash: Uint8Array, lowR?: boolean): never;
  signSchnorr(hash: Buffer): Promise<Buffer>;
}

/**
 * A `TaprootSigner` backed by an interactive two-party MuSig2 session.
 * `signSchnorr` runs a full nonce-then-partial-sig round trip against
 * `exchange` every time it's called — this signer alone can never produce a
 * valid signature; it always needs the remote party's live cooperation.
 *
 * Both parties calling `createAggSigner` (each with their own `localSecret`
 * and the other's `remotePub`) independently compute the identical aggregate
 * key, since `aggregateKey`'s sort is canonical — there's no "who goes first."
 */
export function createAggSigner(args: CreateAggSignerArgs): AggSigner {
  const localPub = Buffer.from(IndividualPubkey(args.localSecret) as Uint8Array);
  const agg = aggregateKey([localPub, args.remotePub]);
  const localIndex = agg.publicKeys.findIndex((p) => p.equals(localPub));
  if (localIndex === -1) throw new Error("local pubkey missing from its own aggregate — sortKeys mismatch");

  async function signSchnorr(sighash: Buffer): Promise<Buffer> {
    const msg = sighash;
    const localNonce = nonceGen(localPub, args.localSecret, agg.xOnly, msg);
    const remotePublicNonce = await args.exchange.exchangeNonce(Buffer.from(localNonce.public), sighash);
    const aggNonce = nonceAggregate([localNonce.public, remotePublicNonce]) as Uint8Array;
    const session = new Session(aggNonce, agg.publicKeys as Buffer[], msg);
    const localPartial = session.sign(localNonce.secret, args.localSecret);
    const remotePartial = await args.exchange.exchangePartialSig(Buffer.from(localPartial), sighash);

    const partials: Uint8Array[] = [];
    partials[localIndex] = localPartial;
    partials[localIndex === 0 ? 1 : 0] = remotePartial;
    const finalSig = session.partialSigAgg(partials);
    return Buffer.from(finalSig as Uint8Array);
  }

  return {
    publicKey: agg.compressed,
    xOnly: agg.xOnly,
    sign(): never {
      throw new Error("ECDSA is not supported on a MuSig2 owner key — Taproot script-path spends only");
    },
    signSchnorr,
  };
}

/** A minimal FIFO async handoff — one value in, one value out, in order. */
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(v: T) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.items.push(value);
  }

  async pop(): Promise<T> {
    const value = this.items.shift();
    if (value !== undefined) return value;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * An in-process `MusigExchange` pair for tests and spikes, where both
 * secrets are locally known. Never use this in production — it defeats the
 * entire point of the interactive protocol (see `createAggSigner`'s doc
 * comment). Each side's `signSchnorr` must be driven concurrently (e.g. via
 * `Promise.all`) — each is waiting on the other's contribution to proceed.
 */
export function createInProcessExchangePair(): [MusigExchange, MusigExchange] {
  const nonceAtoB = new AsyncQueue<Buffer>();
  const nonceBtoA = new AsyncQueue<Buffer>();
  const partialAtoB = new AsyncQueue<Buffer>();
  const partialBtoA = new AsyncQueue<Buffer>();

  const sideA: MusigExchange = {
    async exchangeNonce(local) {
      nonceAtoB.push(local);
      return nonceBtoA.pop();
    },
    async exchangePartialSig(local) {
      partialAtoB.push(local);
      return partialBtoA.pop();
    },
  };
  const sideB: MusigExchange = {
    async exchangeNonce(local) {
      nonceBtoA.push(local);
      return nonceAtoB.pop();
    },
    async exchangePartialSig(local) {
      partialBtoA.push(local);
      return partialAtoB.pop();
    },
  };
  return [sideA, sideB];
}
