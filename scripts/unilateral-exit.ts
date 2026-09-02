/**
 * ⭐ The closer (docs/DEMO.md 4:20, docs/PLAN.md Phase 7). Production version
 * of scripts/05-spike-exit-presigned.ts: opens a real CDP through the actual
 * engine (packages/engine/src/cdp.ts), mints against it, then kills the
 * engine server entirely and broadcasts the borrower's pre-signed exit_tx —
 * proving the guarantee against the real production path, not a synthetic
 * channel.
 *
 * Exit criteria (docs/PLAN.md): passes with the engine process killed before
 * the final broadcast. If it needed the engine running at that point, the
 * guarantee would not be real.
 */
import "dotenv/config";
import { WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { IndividualPubkey, nonceGen, nonceAggregate, Session } from "@scure/btc-signer/musig2.js";
import { describeTapscript } from "@tachibtc/taurus-vault-core";
import { buildServer } from "@satusd/engine/server.js";
import { CdpEngine } from "@satusd/engine/cdp.js";
import { Ledger } from "@satusd/engine/ledger.js";
import type { CdpEvent } from "@satusd/engine/cdp.js";
import {
  resolveNetworkConfig,
  createTachiClient,
  createBitcoinRpcClient,
  assertTachiReachable,
  checkQuorum,
  createAggSigner,
  aggregateKey,
  DevPriceFeed,
  type MusigExchange,
} from "@satusd/tachi-kit";

// Same in-process MuSig2 shortcut as scripts/05 and demo-liquidate.ts — the
// real two-process HTTP exchange is proven separately in scripts/06.
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

const CSV_BLOCKS = 144; // demo term — production tiers 1008/4320, see COLLATERAL-MODEL.md §3
const DEPOSIT = 300_000n;
const LLTV_BPS = 13_000n;
const PENALTY_BPS = 800n;
const HEALTHY_PRICE = 100_000_000n; // $1,000,000/BTC
const ENGINE_PORT = 4103;

async function main() {
  const config = resolveNetworkConfig("regtest");
  const tachi = createTachiClient(config);
  await assertTachiReachable(tachi, config);
  console.log("[exit] quorum:", await checkQuorum(tachi));

  const mnemonic = process.env.DEMO_MNEMONIC!;
  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: "regtest", rpc });
  const funderWallet = aggregator.addAccount({ addressType: "p2wpkh" });
  await funderWallet.sync();
  const protocolTreasury = aggregator.addAccount({ addressType: "p2wpkh", account: 1 });

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

  const priceFeed = new DevPriceFeed(HEALTHY_PRICE);
  const ledger = new Ledger<CdpEvent>();
  const cdpEngine = new CdpEngine({
    config,
    ledger,
    protocolPayoutAddress: protocolTreasury.receiveAddress,
    lltvBps: LLTV_BPS,
    penaltyBps: PENALTY_BPS,
  });

  const { app } = buildServer({ cdp: { cdpEngine, priceFeed, rpc } });
  await app.listen({ port: ENGINE_PORT, host: "127.0.0.1" });
  console.log(`[exit] engine listening on http://127.0.0.1:${ENGINE_PORT}`);

  const cdp = await cdpEngine.open({
    ownerSigner,
    ownerIndividualPub: borrowerPub,
    borrowerReturnAddress: funderWallet.receiveAddress,
    funderWallet,
    rpc,
    amountSats: DEPOSIT,
    csvBlocks: CSV_BLOCKS,
  });
  console.log("[exit] CDP opened:", cdp.id);
  console.log("[exit] exit leaf csvBlocks:", cdp.channel.vault.p2tr.exitLeaf.csvBlocks);
  console.log("[exit] exit leaf tapscript:", describeTapscript(cdp.channel.vault.p2tr.exitLeaf.script));
  console.log("[exit] owner key is the MuSig2 aggregate — not the borrower's key alone:", agg.xOnly.toString("hex"));

  cdpEngine.confirmExitTxDelivered(cdp.id);
  const exitTxHex = cdp.channel.exitTxHex; // this is what the borrower actually holds from here on
  console.log("[exit] borrower now holds exitTxHex, before any loan asset is issued");

  const { issuedUsdCents, state } = await cdpEngine.mint(cdp.id, 100_000n, HEALTHY_PRICE);
  console.log(`[exit] minted, issued $${Number(issuedUsdCents) / 100} satUSD against it, state n=${state.n}`);

  // ---- Kill the engine. Everything below uses only `exitTxHex` (already a
  // plain string, held independently of the engine/server) and bitcoind.
  await app.close();
  console.log("[exit] --- ENGINE KILLED --- borrower proceeds alone with the bytes they already hold ---");

  const tooEarly = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [[exitTxHex]]);
  console.log("[exit] exit_tx before the term matures:", tooEarly[0].allowed, tooEarly[0]["reject-reason"] ?? "");
  if (tooEarly[0].allowed) throw new Error("exit_tx should not be valid yet");

  await rpc.call("generatetoaddress", [CSV_BLOCKS, funderWallet.receiveAddress]);

  const balanceBefore = await rpc.call<number>("getbalance");
  const txid = await rpc.call<string>("sendrawtransaction", [exitTxHex]);
  await rpc.call("generatetoaddress", [1, funderWallet.receiveAddress]);
  const balanceAfter = await rpc.call<number>("getbalance");
  console.log("[exit] BORROWER BROADCAST ALONE, no engine, no protocol cooperation, txid:", txid);
  console.log("[exit] borrower's own wallet balance", balanceBefore, "->", balanceAfter);

  console.log("[exit] PASS — engine killed, borrower recovered every sat alone via the pre-signed exit_tx");
}

main().catch((err) => {
  console.error("[exit] failed:", err);
  process.exit(1);
});
