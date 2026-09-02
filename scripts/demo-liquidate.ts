/**
 * Phase 3/4 exit criteria: the real engine, end to end. Opens a CDP, mints
 * against it, runs a standalone keeper bot against nothing but the public
 * HTTP API, drops the price through the 130% threshold, and watches the
 * keeper trigger a real on-chain liquidation with no engine-internal access
 * and no judgment call on its part — routes.ts's own price check is what
 * decides, every time it's asked.
 *
 * MuSig2 signing here uses the synchronous local-counterparty shortcut from
 * scripts/05 (both secrets known to this one process) — the real two-process
 * HTTP exchange is already proven separately in scripts/06-spike-http-musig.ts;
 * this script's job is proving the engine/liquidation/keeper machinery.
 */
import "dotenv/config";
import { WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { IndividualPubkey, nonceGen, nonceAggregate, Session } from "@scure/btc-signer/musig2.js";
import { buildServer } from "@satusd/engine/server.js";
import { CdpEngine } from "@satusd/engine/cdp.js";
import { Ledger } from "@satusd/engine/ledger.js";
import { runKeeper } from "@satusd/engine/keeper.js";
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

const CSV_BLOCKS = 144;
const DEPOSIT = 300_000n; // 0.003 BTC
const LLTV_BPS = 13_000n; // 130%
const PENALTY_BPS = 800n; // 8%
const HEALTHY_PRICE = 100_000_000n; // $1,000,000/BTC — deliberately high so a small mint is very safe
const ENGINE_PORT = 4102;

async function main() {
  const config = resolveNetworkConfig("regtest");
  const tachi = createTachiClient(config);
  await assertTachiReachable(tachi, config);
  console.log("[demo-liquidate] quorum:", await checkQuorum(tachi));

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
  const engineUrl = `http://127.0.0.1:${ENGINE_PORT}`;
  console.log(`[demo-liquidate] engine listening on ${engineUrl}`);

  const cdp = await cdpEngine.open({
    ownerSigner,
    ownerIndividualPub: borrowerPub,
    borrowerReturnAddress: funderWallet.receiveAddress,
    funderWallet,
    rpc,
    amountSats: DEPOSIT,
    csvBlocks: CSV_BLOCKS,
  });
  console.log("[demo-liquidate] CDP opened:", cdp.id);

  cdpEngine.confirmExitTxDelivered(cdp.id);

  // At $1,000,000/BTC, 0.003 BTC is worth $3,000. Mint $1,000 -> ~300% CR, healthy.
  const { issuedUsdCents, state } = await cdpEngine.mint(cdp.id, 100_000n, HEALTHY_PRICE);
  console.log(`[demo-liquidate] minted, issued $${Number(issuedUsdCents) / 100} satUSD, state n=${state.n}`);
  console.log(`[demo-liquidate] committed share ${state.shareSats} sats at priceLiq ${state.priceLiqUsdCents} cents/BTC`);

  const keeperAbort = new AbortController();
  let liquidatedTxid: string | null = null;
  const keeperTask = runKeeper({
    engineUrl,
    pollIntervalMs: 1_000,
    signal: keeperAbort.signal,
    onAttempt: (cdpId, { liquidated, detail }) => {
      console.log(`[keeper] attempted ${cdpId}: liquidated=${liquidated}`, detail);
      if (liquidated && cdpId === cdp.id) liquidatedTxid = (detail as { txid: string }).txid;
    },
  });
  keeperTask.catch((err) => {
    if (!keeperAbort.signal.aborted) console.error("[demo-liquidate] keeper crashed:", err);
  });

  console.log("[demo-liquidate] keeper running against the public API only, watching for the price drop...");

  // Crash the price: at $1,000,000/BTC the position was ~300% CR ($3,000
  // collateral / $1,000 debt). Drop to a price where the SAME collateral is
  // worth less than 130% of the debt: collateral value must fall under $1,300
  // -> price under $1,300 / 0.003 BTC ≈ $433,333/BTC (matches priceLiqUsdCents
  // printed above, 43,333,333 cents/BTC).
  priceFeed.setPrice(40_000_000n); // $400,000/BTC — safely under the ~$433,333 threshold

  const deadline = Date.now() + 30_000;
  while (!liquidatedTxid && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  keeperAbort.abort();
  await app.close();

  if (!liquidatedTxid) throw new Error("keeper did not liquidate the CDP within 30s");
  console.log("[demo-liquidate] LIQUIDATED, txid:", liquidatedTxid);

  await rpc.call("generatetoaddress", [1, funderWallet.receiveAddress]);
  const tx = await rpc.call<{ confirmations?: number }>("getrawtransaction", [liquidatedTxid, true]);
  if (!tx.confirmations || tx.confirmations < 1) throw new Error("liquidation txid did not confirm");
  console.log("[demo-liquidate] confirmed on-chain, confirmations:", tx.confirmations);

  console.log(`[demo-liquidate] ledger has ${ledger.length} records, chain verifies: ${ledger.verify()}`);
  console.log("[demo-liquidate] PASS — engine + keeper (public API only) closed an underwater position for real");
}

main().catch((err) => {
  console.error("[demo-liquidate] failed:", err);
  process.exit(1);
});
