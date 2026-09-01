import { describe, it, expect } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { IndividualPubkey, sortKeys } from "@scure/btc-signer/musig2.js";
import { aggregateKey, createAggSigner, createInProcessExchangePair } from "../src/musig.js";

function keypair() {
  const secret = Buffer.from(randomPrivateKeyBytes());
  const pub = Buffer.from(IndividualPubkey(secret) as Uint8Array);
  return { secret, pub };
}

describe("aggregateKey", () => {
  it("is order-independent", () => {
    const a = keypair();
    const b = keypair();
    const forward = aggregateKey([a.pub, b.pub]);
    const backward = aggregateKey([b.pub, a.pub]);
    expect(forward.xOnly.toString("hex")).toBe(backward.xOnly.toString("hex"));
    expect(forward.compressed.toString("hex")).toBe(backward.compressed.toString("hex"));
  });

  it("matches sortKeys' canonical ordering", () => {
    const a = keypair();
    const b = keypair();
    const expected = (sortKeys([a.pub, b.pub]) as Buffer[]).map((p) => p.toString("hex"));
    const actual = aggregateKey([a.pub, b.pub]).publicKeys.map((p) => p.toString("hex"));
    expect(actual).toEqual(expected);
  });
});

describe("createAggSigner + createInProcessExchangePair", () => {
  it("both parties independently derive the identical aggregate key", () => {
    const a = keypair();
    const b = keypair();
    const [exchangeA, exchangeB] = createInProcessExchangePair();
    const signerA = createAggSigner({ localSecret: a.secret, remotePub: b.pub, exchange: exchangeA });
    const signerB = createAggSigner({ localSecret: b.secret, remotePub: a.pub, exchange: exchangeB });
    expect(signerA.publicKey.toString("hex")).toBe(signerB.publicKey.toString("hex"));
    expect(signerA.xOnly.toString("hex")).toBe(signerB.xOnly.toString("hex"));
  });

  it("produces a signature that verifies against the aggregate x-only key", async () => {
    const a = keypair();
    const b = keypair();
    const [exchangeA, exchangeB] = createInProcessExchangePair();
    const signerA = createAggSigner({ localSecret: a.secret, remotePub: b.pub, exchange: exchangeA });
    const signerB = createAggSigner({ localSecret: b.secret, remotePub: a.pub, exchange: exchangeB });

    const sighash = Buffer.from(randomPrivateKeyBytes()); // any 32-byte message stands in for a real sighash
    const [sigA, sigB] = await Promise.all([signerA.signSchnorr(sighash), signerB.signSchnorr(sighash)]);

    expect(sigA.toString("hex")).toBe(sigB.toString("hex"));
    expect(sigA.length).toBe(64);
    expect(schnorr.verify(sigA, sighash, signerA.xOnly)).toBe(true);
  });

  it("a signature over one message does not verify against another", async () => {
    const a = keypair();
    const b = keypair();
    const [exchangeA, exchangeB] = createInProcessExchangePair();
    const signerA = createAggSigner({ localSecret: a.secret, remotePub: b.pub, exchange: exchangeA });
    const signerB = createAggSigner({ localSecret: b.secret, remotePub: a.pub, exchange: exchangeB });

    const sighash = Buffer.from(randomPrivateKeyBytes());
    const otherMessage = Buffer.from(randomPrivateKeyBytes());
    const [sigA] = await Promise.all([signerA.signSchnorr(sighash), signerB.signSchnorr(sighash)]);

    expect(schnorr.verify(sigA, otherMessage, signerA.xOnly)).toBe(false);
  });

  it("throws on the ECDSA path — Taproot script-path spends only", () => {
    const a = keypair();
    const b = keypair();
    const [exchangeA] = createInProcessExchangePair();
    const signerA = createAggSigner({ localSecret: a.secret, remotePub: b.pub, exchange: exchangeA });
    expect(() => signerA.sign(Buffer.alloc(32))).toThrow();
  });
});
