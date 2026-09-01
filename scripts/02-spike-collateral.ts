/**
 * Phase 2 exit criteria (revised — see docs/BACKGROUND.md): confirm the
 * bitcoind-verified collateral model works, and record the live validator
 * quorum status. Ledger-level VTXO transfers ("locking" via a cooperative-leaf
 * spend) need a real 5-of-7 quorum; the hosted daemon reports only 1 live
 * validator, so that path is currently unusable — this script proves the
 * fallback (reading collateral straight off Bitcoin) instead, and surfaces
 * quorum status so the engine can decide when the cooperative path is safe
 * to attempt.
 */
import "dotenv/config";
import { WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import {
  resolveNetworkConfig,
  createTachiClient,
  createBitcoinRpcClient,
  assertTachiReachable,
  createProtocolVault,
  deposit,
  getVaultBalanceSats,
  checkQuorum,
} from "@satusd/tachi-kit";

async function main() {
  const config = resolveNetworkConfig("regtest");
  const tachi = createTachiClient(config);
  await assertTachiReachable(tachi, config);
  console.log("[collateral-spike] daemon healthy, chain id confirmed");

  const quorum = await checkQuorum(tachi);
  console.log(
    `[collateral-spike] quorum: ${quorum.liveValidators}/${quorum.totalKnown} live, ` +
      `need ${quorum.threshold} -> hasQuorum=${quorum.hasQuorum}`,
  );
  if (!quorum.hasQuorum) {
    console.log(
      "[collateral-spike] cooperative leaf is NOT usable right now (confirms docs/BACKGROUND.md's finding). " +
        "Falling back to bitcoind-verified collateral tracking.",
    );
  }

  const mnemonic = process.env.DEMO_MNEMONIC;
  if (!mnemonic) throw new Error("DEMO_MNEMONIC is not set — copy .env.example to .env");

  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: "regtest", rpc });
  const userWallet = aggregator.addAccount({ addressType: "p2wpkh" });
  await userWallet.sync();

  // Fresh receive-key index — vaults are atomic (one deposit per vault); reuse
  // the index from other spike scripts and depositToVault refuses it.
  const vault = await createProtocolVault(config, { userWallet, userKeyIndex: 3 });
  console.log(`[collateral-spike] vault: ${vault.p2tr.address}`);

  const before = await getVaultBalanceSats(rpc, vault.p2tr.address);
  console.log(`[collateral-spike] balance before deposit: ${before} sats`);

  const depositResult = await deposit({ vault, userWallet, rpc, amountSats: 250_000n, feeRateSatVb: 2 });
  console.log(`[collateral-spike] deposit txid: ${depositResult.txid}`);
  await rpc.call<string[]>("generatetoaddress", [1, userWallet.receiveAddress]);

  const after = await getVaultBalanceSats(rpc, vault.p2tr.address);
  console.log(`[collateral-spike] balance after deposit: ${after} sats`);

  if (after !== before + 250_000n) {
    throw new Error(`expected balance to increase by 250000 sats, got ${before} -> ${after}`);
  }

  console.log("[collateral-spike] PASS — collateral tracked correctly via bitcoind, no quorum required");
}

main().catch((err) => {
  console.error("[collateral-spike] failed:", err);
  process.exit(1);
});
