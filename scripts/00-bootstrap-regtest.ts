/**
 * Bootstrap local regtest: create a bitcoind wallet, mine enough blocks to
 * mature the demo wallet's whole coinbase set, and fund it.
 *
 * Requires bitcoind running locally — Tachi's hosted regtest has no bitcoind
 * attached (see docs/BACKGROUND.md §5):
 *
 *   bitcoind -regtest -daemon -rpcuser=tachi -rpcpassword=tachi \
 *     -rpcport=18443 -fallbackfee=0.0001 -txindex=1
 *
 * Mining exactly 101 blocks to one address matures only the *first* of them
 * (COINBASE_MATURITY = 100) — the other 100 stay immature. On a chain with
 * a lot of prior history that's invisible (coin selection has plenty of old,
 * mature UTXOs to pick from), but on a genuinely fresh chain (a clean Docker
 * container, say) coin selection can pick one of the immature ones and
 * `sendrawtransaction` fails with `bad-txns-premature-spend-of-coinbase`.
 * Mining 100 more blocks afterward matures the entire original batch.
 */
import "dotenv/config";
import { BitcoinCoreRpcClient, WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import { resolveNetworkConfig } from "@satusd/tachi-kit";

async function main() {
  const config = resolveNetworkConfig("regtest");
  const rpc = new BitcoinCoreRpcClient({
    url: config.bitcoinRpc.url,
    username: config.bitcoinRpc.username,
    password: config.bitcoinRpc.password,
  });

  console.log(`[bootstrap] connecting to bitcoind at ${config.bitcoinRpc.url}`);

  try {
    await rpc.call("createwallet", ["dev"]);
    console.log("[bootstrap] created wallet: dev");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("already exists") || message.includes("Database already exists")) {
      console.log("[bootstrap] wallet 'dev' already exists, continuing");
    } else {
      throw err;
    }
  }

  const mnemonic = process.env.DEMO_MNEMONIC;
  if (!mnemonic) throw new Error("DEMO_MNEMONIC is not set — copy .env.example to .env");

  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: "regtest", rpc });
  const demoWallet = aggregator.addAccount({ addressType: "p2wpkh" });
  const demoAddress = demoWallet.receiveAddress;
  console.log(`[bootstrap] demo wallet receive address: ${demoAddress}`);

  const blockHashes = await rpc.call<string[]>("generatetoaddress", [101, demoAddress]);
  console.log(`[bootstrap] mined ${blockHashes.length} blocks, matured first coinbase`);

  // Mature the rest of that batch too — see the module comment above. Mine to
  // a *different* address, or this just creates a fresh batch of immature
  // coinbases for the demo wallet chasing its own tail.
  const throwawayAddress = aggregator.addAccount({ addressType: "p2wpkh", account: 99 }).receiveAddress;
  await rpc.call<string[]>("generatetoaddress", [100, throwawayAddress]);
  console.log("[bootstrap] mined 100 more blocks (to a throwaway address), entire initial batch now matured");

  await demoWallet.sync();
  console.log(`[bootstrap] demo wallet balance: ${demoWallet.balance.confirmed} sats confirmed`);
  console.log("[bootstrap] done");
}

main().catch((err) => {
  console.error("[bootstrap] failed:", err);
  process.exit(1);
});
