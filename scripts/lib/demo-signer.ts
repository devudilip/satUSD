/**
 * Shared by every demo/spike script that needs a joint MuSig2 owner signer
 * without standing up the real two-process HTTP exchange (that's proven
 * separately in scripts/06-spike-http-musig.ts + scripts/borrower.ts).
 *
 * Both secrets live in this one process — never do this in production, it
 * defeats the entire point of MuSig2 (see musig.ts's own doc comments).
 */
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { IndividualPubkey, nonceGen, nonceAggregate, Session } from "@scure/btc-signer/musig2.js";
import { createAggSigner, aggregateKey, type AggSigner, type MusigExchange } from "@satusd/tachi-kit";

function createLocalCounterpartyExchange(
  counterpartSecret: Buffer,
  counterpartPub: Buffer,
  sortedPublicKeys: Buffer[],
  aggXOnly: Buffer,
): MusigExchange {
  const pending = new Map<string, { secretNonce: Uint8Array; publicNonce: Uint8Array; initiatorPublicNonce: Buffer }>();
  return {
    async exchangeNonce(initiatorPublicNonce, sighash) {
      const nonce = nonceGen(counterpartPub, counterpartSecret, aggXOnly, sighash);
      pending.set(sighash.toString("hex"), { secretNonce: nonce.secret, publicNonce: nonce.public, initiatorPublicNonce });
      return Buffer.from(nonce.public);
    },
    async exchangePartialSig(_initiatorPartialSig, sighash) {
      const key = sighash.toString("hex");
      const entry = pending.get(key);
      if (!entry) throw new Error("exchangePartialSig called before exchangeNonce for this sighash");
      pending.delete(key);
      const aggNonce = nonceAggregate([entry.initiatorPublicNonce, entry.publicNonce]) as Uint8Array;
      const session = new Session(aggNonce, sortedPublicKeys, sighash);
      const myPartial = session.sign(entry.secretNonce, counterpartSecret);
      return Buffer.from(myPartial as Uint8Array);
    },
  };
}

export interface DemoOwnerSigner {
  readonly protocolSecret: Buffer;
  readonly borrowerSecret: Buffer;
  readonly protocolPub: Buffer;
  readonly borrowerPub: Buffer;
  readonly ownerSigner: AggSigner;
}

/** Fresh random borrower + protocol keypair, wired into one in-process AggSigner. */
export function createDemoOwnerSigner(): DemoOwnerSigner {
  const protocolSecret = Buffer.from(randomPrivateKeyBytes());
  const borrowerSecret = Buffer.from(randomPrivateKeyBytes());
  const protocolPub = Buffer.from(IndividualPubkey(protocolSecret) as Uint8Array);
  const borrowerPub = Buffer.from(IndividualPubkey(borrowerSecret) as Uint8Array);
  const agg = aggregateKey([protocolPub, borrowerPub]);
  const ownerSigner = createAggSigner({
    localSecret: protocolSecret,
    remotePub: borrowerPub,
    exchange: createLocalCounterpartyExchange(borrowerSecret, borrowerPub, agg.publicKeys as Buffer[], agg.xOnly),
  });
  return { protocolSecret, borrowerSecret, protocolPub, borrowerPub, ownerSigner };
}
