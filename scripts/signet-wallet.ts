/**
 * `pnpm signet:wallet` — the signet equivalent of 00-bootstrap-regtest.
 *
 * Signet coins can't be mined on demand, so this:
 *   1. creates a private DEMO_MNEMONIC_SIGNET in .env if there isn't one
 *      (never fund the public "test … junk" phrase on a public network),
 *   2. prints the funding address and its current balance.
 *
 * Fund the address from https://faucet.tachibtc.com (or any signet faucet).
 * The full demo spends 2 × 300,000 sats plus fees — ask for at least 0.01 sBTC.
 */
import "dotenv/config";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { WalletAggregator, generateMnemonic } from "@tachibtc/taurus-wallet-aggregator";
import { resolveNetworkConfig, createBitcoinRpcClient, explorerAddressUrl } from "@satusd/tachi-kit";

const ENV_PATH = new URL("../.env", import.meta.url);
const NEEDED_SATS = 700_000n;

async function main() {
  const config = resolveNetworkConfig("signet");
  let mnemonic = process.env.DEMO_MNEMONIC_SIGNET;
  if (!mnemonic) {
    mnemonic = generateMnemonic(128);
    const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
    const sep = existing.endsWith("\n") || existing === "" ? "" : "\n";
    appendFileSync(ENV_PATH, `${sep}\n# Private signet demo wallet — created by pnpm signet:wallet. Testnet coins only.\nDEMO_MNEMONIC_SIGNET="${mnemonic}"\n`);
    console.log("[signet] created a new DEMO_MNEMONIC_SIGNET and saved it to .env");
  }

  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: "signet", rpc });
  const funder = aggregator.addAccount({ addressType: "p2wpkh" });
  await funder.sync();
  const { confirmed, unconfirmed } = funder.balance;

  console.log("[signet] funding address:", funder.receiveAddress);
  console.log("[signet] explorer:", explorerAddressUrl(config, funder.receiveAddress));
  console.log(`[signet] balance: ${confirmed} sats confirmed, ${unconfirmed} unconfirmed`);
  if (confirmed < NEEDED_SATS) {
    console.log(`[signet] need at least ${NEEDED_SATS} confirmed sats for the full demo.`);
    console.log("[signet] fund it at https://faucet.tachibtc.com, wait one block, then re-run this.");
    process.exitCode = 2;
  } else {
    console.log("[signet] ready — run `pnpm demo:signet`");
  }
}

main().catch((err) => {
  console.error("[signet] failed:", err);
  process.exit(1);
});
