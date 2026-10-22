/**
 * The whole story, one run, matching docs/DEMO.md beat for beat:
 *
 *   open -> mint -> proof-of-reserves snapshot (liquidation txid-to-be) ->
 *   price crash -> real liquidation via a public-API-only keeper ->
 *   a second CDP -> kill the engine -> borrower alone broadcasts exit_tx
 *
 * Everything printed here is a real on-chain artifact — vault addresses,
 * signatures, txids — nothing mocked. Runs on whichever network
 * TACHI_NETWORK selects: `pnpm demo` (regtest, blocks mined on demand, ~1 min)
 * or `pnpm demo:signet` (public signet via Tachi's hosted node — real
 * ~10-minute blocks, roughly an hour end to end).
 */
import "dotenv/config";
import { WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import { describeTapscript } from "@tachibtc/taurus-vault-core";
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
  getVaultBalanceSats,
  DevPriceFeed,
  demoMnemonic,
  demoCsvBlocks,
  waitForConfirmation,
  waitForHeight,
  csvMatureTip,
  probeAcceptance,
  getTipHeight,
  explorerTxUrl,
} from "@satusd/tachi-kit";
import { createDemoOwnerSigner } from "./lib/demo-signer.js";

const DEPOSIT = 300_000n;
const LLTV_BPS = 13_000n;
const PENALTY_BPS = 800n;
const HEALTHY_PRICE = 100_000_000n; // $1,000,000/BTC
const CRASH_PRICE = 40_000_000n; // $400,000/BTC — under the ~$433,333 liquidation price
const ENGINE_PORT = 4110;

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  section("0. Connect");
  const config = resolveNetworkConfig();
  // Demo term — production tiers 1008/4320 (COLLATERAL-MODEL.md §3). 144 on regtest, 3 on signet.
  const CSV_BLOCKS = demoCsvBlocks(config);
  const link = (txid: string) => explorerTxUrl(config, txid) ?? txid;
  console.log(`network: ${config.network} (${config.chainId}), demo term: ${CSV_BLOCKS} blocks`);
  const tachi = createTachiClient(config);
  await assertTachiReachable(tachi, config);
  console.log("daemon healthy, quorum:", await checkQuorum(tachi));

  const mnemonic = demoMnemonic(config);
  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: config.network, rpc });
  const funderWallet = aggregator.addAccount({ addressType: "p2wpkh" });
  await funderWallet.sync();
  const needed = 2n * DEPOSIT + 10_000n; // two CDPs plus L1 fees
  if (funderWallet.balance.confirmed < needed) {
    throw new Error(
      `demo wallet ${funderWallet.receiveAddress} has ${funderWallet.balance.confirmed} confirmed sats, needs ${needed}. ` +
        (config.network === "signet" ? "Run `pnpm signet:wallet` and fund it from https://faucet.tachibtc.com." : "Run `pnpm bootstrap`."),
    );
  }
  const protocolTreasury = aggregator.addAccount({ addressType: "p2wpkh", account: 1 });

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
  console.log("engine listening:", engineUrl);

  section("1. Open a CDP — the borrower's exit_tx before anything else");
  const signerA = createDemoOwnerSigner();
  const cdpA = await cdpEngine.open({
    ownerSigner: signerA.ownerSigner,
    ownerIndividualPub: signerA.borrowerPub,
    borrowerReturnAddress: funderWallet.receiveAddress,
    funderWallet,
    rpc,
    amountSats: DEPOSIT,
    csvBlocks: CSV_BLOCKS,
  });
  console.log("vault:", cdpA.channel.vault.p2tr.address);
  console.log("owner key (MuSig2 aggregate, not either party alone):", cdpA.channel.vault.userKey.xOnly.toString("hex"));
  console.log("exit leaf:", describeTapscript(cdpA.channel.vault.p2tr.exitLeaf.script));
  console.log("borrower now holds a fully agg-signed exit_tx. Zero satUSD exists yet.");
  cdpEngine.confirmExitTxDelivered(cdpA.id);

  section("2. Mint");
  const { issuedUsdCents, state } = await cdpEngine.mint(cdpA.id, 100_000n, HEALTHY_PRICE);
  console.log(`minted, issued $${Number(issuedUsdCents) / 100} satUSD`);
  console.log(`committed state n=${state.n}: share ${state.shareSats} sats at priceLiq $${Number(state.priceLiqUsdCents) / 100}/BTC`);

  section("3. Proof of reserves — nothing here requires trusting the engine");
  // scantxoutset only sees confirmed UTXOs, not mempool — mine the deposit in
  // first, or this legitimately (if confusingly) reads back 0.
  await waitForConfirmation(config, rpc, cdpA.channel.funding.txid, funderWallet.receiveAddress);
  const verifiedBalance = await getVaultBalanceSats(rpc, cdpA.channel.vault.p2tr.address);
  console.log(
    JSON.stringify(
      {
        vaultAddress: cdpA.channel.vault.p2tr.address,
        balanceSatsViaBitcoind: verifiedBalance.toString(),
        principalUsdCents: cdpA.principalUsdCents.toString(),
        currentStateNum: state.n.toString(),
        depositTx: link(cdpA.channel.funding.txid),
        liquidationTxidToBe: state.refundTxid,
      },
      null,
      2,
    ),
  );
  console.log("^ that txid is announced now. It either matches the real liquidation later, or something is wrong.");

  section("4. A second CDP — this one for the exit demo");
  // Refresh the UTXO set: CDP-A's deposit spent from it, and its change is
  // only visible to scantxoutset once confirmed (step 3 waited for that).
  await funderWallet.sync();
  const signerB = createDemoOwnerSigner();
  const cdpB = await cdpEngine.open({
    ownerSigner: signerB.ownerSigner,
    ownerIndividualPub: signerB.borrowerPub,
    borrowerReturnAddress: funderWallet.receiveAddress,
    funderWallet,
    rpc,
    amountSats: DEPOSIT,
    csvBlocks: CSV_BLOCKS,
  });
  cdpEngine.confirmExitTxDelivered(cdpB.id);
  const exitTxHex = cdpB.channel.exitTxHex;
  await cdpEngine.mint(cdpB.id, 50_000n, HEALTHY_PRICE);
  console.log("second CDP opened and minted against, healthy, exit_tx already held by its borrower");
  console.log("vault:", cdpB.channel.vault.p2tr.address, "deposit:", link(cdpB.channel.funding.txid));


  section("5. Crash the price — watch a public-API-only keeper actually liquidate");
  const keeperAbort = new AbortController();
  let liquidatedTxid: string | null = null;
  const keeperTask = runKeeper({
    engineUrl,
    pollIntervalMs: 1_000,
    signal: keeperAbort.signal,
    onAttempt: (cdpId, { liquidated, detail }) => {
      if (cdpId !== cdpA.id) return;
      console.log(`keeper attempt: liquidated=${liquidated}`, detail);
      if (liquidated) liquidatedTxid = (detail as { txid: string }).txid;
    },
  });
  keeperTask.catch((err) => {
    if (!keeperAbort.signal.aborted) console.error("keeper crashed:", err);
  });

  priceFeed.setPrice(CRASH_PRICE);
  console.log(`price crashed to $${Number(CRASH_PRICE) / 100}/BTC — keeper is polling, no one told it to check now`);

  const deadline = Date.now() + 30_000;
  while (!liquidatedTxid && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  keeperAbort.abort();

  if (!liquidatedTxid) throw new Error("keeper did not liquidate within 30s");
  if (liquidatedTxid !== state.refundTxid) {
    throw new Error(`txid mismatch: announced ${state.refundTxid}, broadcast ${liquidatedTxid}`);
  }
  console.log("LIQUIDATED:", link(liquidatedTxid), "— exactly the txid announced in step 3");
  const liqHeight = await waitForConfirmation(config, rpc, liquidatedTxid, funderWallet.receiveAddress);
  console.log(`confirmed on-chain in block ${liqHeight}`);
  console.log(`ledger has ${ledger.length} records, chain verifies: ${ledger.verify()}`);

  section("6. Kill the engine. No cooperation is possible from here.");
  await app.close();
  console.log("--- ENGINE PROCESS GONE ---");

  await waitForConfirmation(config, rpc, cdpB.channel.funding.txid, funderWallet.receiveAddress);
  const matureTip = (await csvMatureTip(rpc, cdpB.channel.funding.txid, CSV_BLOCKS))!;
  if ((await getTipHeight(rpc)) < matureTip) {
    const tooEarly = await probeAcceptance(config, rpc, exitTxHex);
    console.log("exit_tx before the term matures — accepted?", tooEarly.allowed, tooEarly.reason);
    if (tooEarly.allowed) throw new Error("exit_tx should not be valid yet");
  } else {
    console.log("(term already matured while waiting for blocks — skipping the too-early check)");
  }

  await waitForHeight(config, rpc, matureTip, funderWallet.receiveAddress);
  const exitTxid = await rpc.call<string>("sendrawtransaction", [exitTxHex]);
  console.log("borrower broadcast alone, no engine, no protocol:", link(exitTxid));
  const exitHeight = await waitForConfirmation(config, rpc, exitTxid, funderWallet.receiveAddress);
  console.log(`exit confirmed in block ${exitHeight}`);

  section("PASS");
  console.log(`Every number above is a real ${config.network} artifact. Nothing was mocked.`);
  console.log({ liquidationTxid: liquidatedTxid, exitTxid });
}

main().catch((err) => {
  console.error("[full-demo] failed:", err);
  process.exit(1);
});
