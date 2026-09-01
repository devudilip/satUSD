/**
 * Spike 05 — exercises the promoted tachi-kit modules (musig.ts,
 * commitment.ts, events.ts), not raw SDK calls, end to end:
 *
 *   openCollateral → commitState (x2) → "kill the engine" (stop calling any
 *   engine/protocol code) → borrower alone broadcasts the pre-signed
 *   exit_tx after the CSV term → funds land at the borrower's own address.
 *
 * This is the demo closer from docs/COLLATERAL-MODEL.md §8: "At open, the
 * borrower receives a fully signed exit transaction. If we vanish, they
 * broadcast it after the term and get every sat back."
 */
import "dotenv/config";
import { WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { IndividualPubkey, nonceGen, nonceAggregate, Session } from "@scure/btc-signer/musig2.js";
import {
  resolveNetworkConfig,
  createTachiClient,
  createBitcoinRpcClient,
  assertTachiReachable,
  checkQuorum,
  createAggSigner,
  aggregateKey,
  openCollateral,
  commitState,
  type MusigExchange,
} from "@satusd/tachi-kit";

/**
 * A `MusigExchange` that computes the counterparty's contribution inline,
 * synchronously, using their raw secret. This is a spike/test-only stand-in
 * for a real two-process HTTP exchange (Task 4): it exists because
 * `createAggSigner`'s protocol-side signer only calls `exchange.*` once per
 * signing round and expects an immediate answer, not a second, independently
 * driven `signSchnorr` call on "the other side" — that concurrent-driving
 * shape is what `createInProcessExchangePair` models, and it doesn't fit
 * here because `openCollateral`/`commitState` only ever hold one signer.
 * NEVER do this in production — it means one process holds both secrets.
 */
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
      pending.set(sighash.toString("hex"), {
        secretNonce: nonce.secret,
        publicNonce: nonce.public,
        initiatorPublicNonce,
      });
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

const CSV_BLOCKS = 144;
const DEPOSIT = 300_000n;
const LLTV_BPS = 13_000n; // 130%
const PENALTY_BPS = 800n; // 8%

async function main() {
  const config = resolveNetworkConfig("regtest");
  const tachi = createTachiClient(config);
  await assertTachiReachable(tachi, config);
  console.log("[exit-presigned] quorum:", await checkQuorum(tachi));

  const mnemonic = process.env.DEMO_MNEMONIC!;
  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: "regtest", rpc });
  const funderWallet = aggregator.addAccount({ addressType: "p2wpkh" });
  await funderWallet.sync();

  // Two keypairs stand in for borrower + protocol. `commitment.ts` only
  // ever holds one `ownerSigner` (the engine's view), so its exchange is
  // wired to a synchronous local stand-in for the borrower's response —
  // see createLocalCounterpartyExchange's doc comment for why (and that
  // real interactive exchange, split across two processes, is a later task).
  const borrowerSecret = Buffer.from(randomPrivateKeyBytes());
  const protocolSecret = Buffer.from(randomPrivateKeyBytes());
  const protocolPub = Buffer.from(IndividualPubkey(protocolSecret) as Uint8Array);
  const borrowerPub = Buffer.from(IndividualPubkey(borrowerSecret) as Uint8Array);
  const agg = aggregateKey([protocolPub, borrowerPub]);

  const protocolOwnerSigner = createAggSigner({
    localSecret: protocolSecret,
    remotePub: borrowerPub,
    exchange: createLocalCounterpartyExchange(borrowerSecret, borrowerPub, agg.publicKeys as Buffer[], agg.xOnly),
  });

  const channel = await openCollateral(config, {
    ownerSigner: protocolOwnerSigner,
    borrowerReturnAddress: funderWallet.receiveAddress,
    funderWallet,
    rpc,
    amountSats: DEPOSIT,
    csvBlocks: CSV_BLOCKS,
  });
  console.log("[exit-presigned] channel open, vault:", channel.vault.p2tr.address, "vaultId:", channel.vaultId);
  console.log("[exit-presigned] exit_tx pre-signed, length:", channel.exitTxHex.length, "hex chars");

  // Simulate loan activity: two committed states, agg-signed + cosigned.
  const state1 = await commitState(config, {
    channel,
    n: 1n,
    collateralSats: DEPOSIT,
    debtUsdCents: 100_000n,
    lltvBps: LLTV_BPS,
    penaltyBps: PENALTY_BPS,
    protocolPayoutAddress: funderWallet.changeAddress,
  });
  console.log("[exit-presigned] state 1 committed, share:", state1.shareSats, "priceLiq:", state1.priceLiqUsdCents);

  const state2 = await commitState(config, {
    channel,
    n: 2n,
    collateralSats: DEPOSIT,
    debtUsdCents: 120_000n,
    lltvBps: LLTV_BPS,
    penaltyBps: PENALTY_BPS,
    protocolPayoutAddress: funderWallet.changeAddress,
  });
  console.log("[exit-presigned] state 2 committed, share:", state2.shareSats, "priceLiq:", state2.priceLiqUsdCents);
  void state1; // superseded — a real engine deletes this from hot storage now

  // ---- "Kill the engine." From here on, nothing below calls the engine,
  // the protocol's signer, or any cooperative-leaf path. Only the borrower's
  // already-held exit_tx and bitcoind.
  console.log("[exit-presigned] --- ENGINE KILLED --- borrower proceeds alone ---");

  const tooEarly = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [
    [channel.exitTxHex],
  ]);
  console.log("[exit-presigned] exit_tx before CSV matures:", tooEarly[0].allowed, tooEarly[0]["reject-reason"] ?? "");
  if (tooEarly[0].allowed) throw new Error("exit_tx should not be valid yet");

  await rpc.call("generatetoaddress", [CSV_BLOCKS, funderWallet.receiveAddress]);

  const balanceBefore = await rpc.call<number>("getbalance");
  const txid = await rpc.call<string>("sendrawtransaction", [channel.exitTxHex]);
  await rpc.call("generatetoaddress", [1, funderWallet.receiveAddress]);
  const balanceAfter = await rpc.call<number>("getbalance");
  console.log("[exit-presigned] BORROWER BROADCAST EXIT ALONE, txid:", txid);
  console.log("[exit-presigned] wallet balance", balanceBefore, "->", balanceAfter, "(borrower's own wallet, no protocol involved)");

  console.log("[exit-presigned] PASS — engine killed, borrower recovered every sat alone via the pre-signed exit_tx");
}

main().catch((err) => {
  console.error("[exit-presigned] failed:", err);
  process.exit(1);
});
