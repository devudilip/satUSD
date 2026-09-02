/**
 * The whole story, one run, matching docs/DEMO.md beat for beat:
 *
 *   open -> mint -> proof-of-reserves snapshot (liquidation txid-to-be) ->
 *   price crash -> real liquidation via a public-API-only keeper ->
 *   a second CDP -> kill the engine -> borrower alone broadcasts exit_tx
 *
 * Everything printed here is a real regtest artifact — vault addresses,
 * signatures, txids — nothing mocked. Run with `pnpm demo`.
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
} from "@satusd/tachi-kit";
import { createDemoOwnerSigner } from "./lib/demo-signer.js";

const CSV_BLOCKS = 144; // demo term — production tiers 1008/4320, see COLLATERAL-MODEL.md §3
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
  const config = resolveNetworkConfig("regtest");
  const tachi = createTachiClient(config);
  await assertTachiReachable(tachi, config);
  console.log("daemon healthy, quorum:", await checkQuorum(tachi));

  const mnemonic = process.env.DEMO_MNEMONIC!;
  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: "regtest", rpc });
  const funderWallet = aggregator.addAccount({ addressType: "p2wpkh" });
  await funderWallet.sync();
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
  await rpc.call("generatetoaddress", [1, funderWallet.receiveAddress]);
  const verifiedBalance = await getVaultBalanceSats(rpc, cdpA.channel.vault.p2tr.address);
  console.log(
    JSON.stringify(
      {
        vaultAddress: cdpA.channel.vault.p2tr.address,
        balanceSatsViaBitcoind: verifiedBalance.toString(),
        principalUsdCents: cdpA.principalUsdCents.toString(),
        currentStateNum: state.n.toString(),
        liquidationTxidToBe: state.refundTxid,
      },
      null,
      2,
    ),
  );
  console.log("^ that txid is announced now. It either matches the real liquidation later, or something is wrong.");

  section("4. Crash the price — watch a public-API-only keeper actually liquidate");
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
  await rpc.call("generatetoaddress", [1, funderWallet.receiveAddress]);
  console.log("LIQUIDATED:", liquidatedTxid, "— exactly the txid announced in step 3, confirmed on-chain");
  console.log(`ledger has ${ledger.length} records, chain verifies: ${ledger.verify()}`);

  section("5. A second CDP — this one for the exit demo");
  await funderWallet.sync(); // refresh the UTXO set — CDP-A's deposit spent from it
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

  section("6. Kill the engine. No cooperation is possible from here.");
  await app.close();
  console.log("--- ENGINE PROCESS GONE ---");

  const tooEarly = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [[exitTxHex]]);
  console.log("exit_tx before the term matures:", tooEarly[0].allowed, tooEarly[0]["reject-reason"] ?? "");
  if (tooEarly[0].allowed) throw new Error("exit_tx should not be valid yet");

  await rpc.call("generatetoaddress", [CSV_BLOCKS, funderWallet.receiveAddress]);
  const exitTxid = await rpc.call<string>("sendrawtransaction", [exitTxHex]);
  await rpc.call("generatetoaddress", [1, funderWallet.receiveAddress]);
  console.log("borrower broadcast alone, no engine, no protocol, txid:", exitTxid);

  section("PASS");
  console.log("Every number above is a real regtest artifact. Nothing was mocked.");
  console.log({ liquidationTxid: liquidatedTxid, exitTxid });
}

main().catch((err) => {
  console.error("[full-demo] failed:", err);
  process.exit(1);
});
