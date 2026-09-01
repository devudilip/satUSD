/**
 * Spike 06 — Task 4: the MuSig2 exchange over real HTTP, not an in-process
 * shortcut. Starts the engine's Fastify server (packages/engine/src/server.ts)
 * on loopback, runs the borrower's responder (scripts/borrower.ts) as a
 * concurrent task polling and answering over actual HTTP requests, and drives
 * openCollateral + commitState through it — same commitment.ts entry points
 * as spike 05, now with a real two-process-shaped signing protocol instead
 * of a single function holding both secrets.
 */
import "dotenv/config";
import { WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { IndividualPubkey } from "@scure/btc-signer/musig2.js";
import { buildServer } from "@satusd/engine";
import {
  resolveNetworkConfig,
  createTachiClient,
  createBitcoinRpcClient,
  assertTachiReachable,
  checkQuorum,
  createAggSigner,
  openCollateral,
  commitState,
} from "@satusd/tachi-kit";
import { runBorrowerResponder } from "./borrower.js";

const CSV_BLOCKS = 144;
const DEPOSIT = 300_000n;
const LLTV_BPS = 13_000n;
const PENALTY_BPS = 800n;
const PORT = 4101;

async function main() {
  const config = resolveNetworkConfig("regtest");
  const tachi = createTachiClient(config);
  await assertTachiReachable(tachi, config);
  console.log("[http-musig] quorum:", await checkQuorum(tachi));

  const { app, musigExchange } = buildServer();
  await app.listen({ port: PORT, host: "127.0.0.1" });
  const engineUrl = `http://127.0.0.1:${PORT}`;
  console.log(`[http-musig] engine listening on ${engineUrl}`);

  const mnemonic = process.env.DEMO_MNEMONIC!;
  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: "regtest", rpc });
  const funderWallet = aggregator.addAccount({ addressType: "p2wpkh" });
  await funderWallet.sync();

  const protocolSecret = Buffer.from(randomPrivateKeyBytes());
  const borrowerSecret = Buffer.from(randomPrivateKeyBytes());
  const protocolPub = Buffer.from(IndividualPubkey(protocolSecret) as Uint8Array);
  const borrowerPub = Buffer.from(IndividualPubkey(borrowerSecret) as Uint8Array);

  // The borrower runs as an independently polling responder against the
  // engine's real HTTP endpoints — this is scripts/borrower.ts run in
  // process here for a self-contained spike; the CLI entry point at the
  // bottom of that file is identical logic runnable as its own process.
  const borrowerAbort = new AbortController();
  const borrowerTask = runBorrowerResponder({
    engineUrl,
    secret: borrowerSecret,
    remotePub: protocolPub,
    signal: borrowerAbort.signal,
    onRound: (phase, sighashHex) => console.log(`[http-musig] borrower answered ${phase} for ${sighashHex.slice(0, 16)}...`),
  });
  borrowerTask.catch((err) => {
    if (!borrowerAbort.signal.aborted) console.error("[http-musig] borrower responder crashed:", err);
  });

  const protocolOwnerSigner = createAggSigner({
    localSecret: protocolSecret,
    remotePub: borrowerPub,
    exchange: musigExchange,
  });

  try {
    const channel = await openCollateral(config, {
      ownerSigner: protocolOwnerSigner,
      borrowerReturnAddress: funderWallet.receiveAddress,
      funderWallet,
      rpc,
      amountSats: DEPOSIT,
      csvBlocks: CSV_BLOCKS,
    });
    console.log("[http-musig] channel open (agg-signed over real HTTP):", channel.vault.p2tr.address);
    console.log("[http-musig] exit_tx pre-signed, length:", channel.exitTxHex.length, "hex chars");

    const state = await commitState(config, {
      channel,
      n: 1n,
      collateralSats: DEPOSIT,
      debtUsdCents: 100_000n,
      lltvBps: LLTV_BPS,
      penaltyBps: PENALTY_BPS,
      protocolPayoutAddress: funderWallet.changeAddress,
    });
    console.log("[http-musig] state committed over HTTP, share:", state.shareSats, "priceLiq:", state.priceLiqUsdCents);

    // Kill the borrower responder AND the engine server — from here on
    // nothing in this script talks to either.
    borrowerAbort.abort();
    await app.close();
    console.log("[http-musig] --- BORROWER RESPONDER STOPPED, ENGINE SERVER CLOSED ---");

    const tooEarly = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [
      [channel.exitTxHex],
    ]);
    console.log("[http-musig] exit_tx before CSV matures:", tooEarly[0].allowed, tooEarly[0]["reject-reason"] ?? "");
    if (tooEarly[0].allowed) throw new Error("exit_tx should not be valid yet");

    await rpc.call("generatetoaddress", [CSV_BLOCKS, funderWallet.receiveAddress]);
    const txid = await rpc.call<string>("sendrawtransaction", [channel.exitTxHex]);
    await rpc.call("generatetoaddress", [1, funderWallet.receiveAddress]);
    console.log("[http-musig] exit_tx broadcast after engine+borrower-responder shutdown, txid:", txid);

    console.log("[http-musig] PASS — real HTTP MuSig2 exchange (open + commitState), exit_tx works independently after");
  } finally {
    borrowerAbort.abort();
    if (app.server.listening) await app.close();
  }
}

main().catch((err) => {
  console.error("[http-musig] failed:", err);
  process.exit(1);
});
