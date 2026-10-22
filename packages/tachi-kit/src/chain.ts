import type { BitcoinCoreRpcClient } from "@tachibtc/taurus-wallet-aggregator";
import type { NetworkConfig } from "./net.js";

/**
 * Network-aware block/confirmation helpers so every script and server runs
 * unchanged on both networks.
 *
 *   regtest — local bitcoind, we mine blocks on demand (`generatetoaddress`).
 *   signet  — Tachi's hosted bitcoind proxy. Mining, `testmempoolaccept`
 *             and `listunspent` are refused ("method not permitted"), and
 *             blocks arrive every ~10 minutes, so every "mine N" becomes
 *             "wait for N real blocks".
 */

const DEFAULT_POLL_MS = 15_000;

export interface WaitOptions {
  readonly pollMs?: number;
  readonly log?: (msg: string) => void;
}

export function canMine(config: NetworkConfig): boolean {
  return config.network === "regtest";
}

/**
 * The demo wallet's mnemonic. On signet prefer `DEMO_MNEMONIC_SIGNET` — the
 * regtest default is the public BIP-39 test vector, and anything funded on a
 * public network under that phrase can be swept by anyone.
 */
export function demoMnemonic(config: NetworkConfig): string {
  const m =
    config.network === "signet"
      ? (process.env.DEMO_MNEMONIC_SIGNET ?? process.env.DEMO_MNEMONIC)
      : process.env.DEMO_MNEMONIC;
  if (!m) {
    throw new Error(
      config.network === "signet"
        ? "DEMO_MNEMONIC_SIGNET is not set — run `pnpm signet:wallet` to create and fund one"
        : "DEMO_MNEMONIC is not set — copy .env.example to .env",
    );
  }
  return m;
}

/**
 * Loan term / exit CSV for demos. `DEMO_CSV_BLOCKS` wins; otherwise 144 on
 * regtest (blocks are free) and 3 on signet (~30 minutes of real blocks).
 */
export function demoCsvBlocks(config: NetworkConfig, regtestDefault = 144): number {
  const fromEnv = process.env.DEMO_CSV_BLOCKS;
  if (fromEnv) {
    const n = Number(fromEnv);
    if (!Number.isInteger(n) || n < 1 || n > 65_535) throw new Error(`DEMO_CSV_BLOCKS must be in [1, 65535], got ${fromEnv}`);
    return n;
  }
  return config.network === "signet" ? 3 : regtestDefault;
}

/**
 * Demo collateral size. `DEMO_DEPOSIT_SATS` wins; otherwise the caller's
 * regtest default (coins are free there) or 300,000 sats on signet, where
 * coins come from a faucet.
 */
export function demoDepositSats(config: NetworkConfig, regtestDefault: bigint): bigint {
  const fromEnv = process.env.DEMO_DEPOSIT_SATS;
  if (fromEnv) return BigInt(fromEnv);
  return config.network === "signet" ? 300_000n : regtestDefault;
}

export async function getTipHeight(rpc: BitcoinCoreRpcClient): Promise<number> {
  return rpc.call<number>("getblockcount", []);
}

/** Regtest: mine up to `height`. Signet: wait until the chain reaches it. */
export async function waitForHeight(
  config: NetworkConfig,
  rpc: BitcoinCoreRpcClient,
  height: number,
  mineTo: string,
  opts: WaitOptions = {},
): Promise<number> {
  let tip = await getTipHeight(rpc);
  if (tip >= height) return tip;
  if (canMine(config)) {
    await rpc.call("generatetoaddress", [height - tip, mineTo]);
    return getTipHeight(rpc);
  }
  const log = opts.log ?? console.log;
  log(`[signet] waiting for block ${height} (tip ${tip}, ~${(height - tip) * 10} min)...`);
  while (tip < height) {
    await sleep(opts.pollMs ?? DEFAULT_POLL_MS);
    const next = await getTipHeight(rpc);
    if (next !== tip) log(`[signet] block ${next}`);
    tip = next;
  }
  return tip;
}

/** Regtest: mine `n` blocks. Signet: wait for `n` new blocks. */
export async function advanceBlocks(
  config: NetworkConfig,
  rpc: BitcoinCoreRpcClient,
  n: number,
  mineTo: string,
  opts: WaitOptions = {},
): Promise<number> {
  const tip = await getTipHeight(rpc);
  return waitForHeight(config, rpc, tip + n, mineTo, opts);
}

/** Confirmation count for any txid (0 while in the mempool). */
export async function getConfirmations(rpc: BitcoinCoreRpcClient, txid: string): Promise<number> {
  const tx = await rpc.call<{ confirmations?: number }>("getrawtransaction", [txid, true]);
  return tx.confirmations ?? 0;
}

/**
 * Block until `txid` has at least `minConf` confirmations. Regtest mines the
 * blocks; signet polls. Returns the height the tx confirmed in.
 */
export async function waitForConfirmation(
  config: NetworkConfig,
  rpc: BitcoinCoreRpcClient,
  txid: string,
  mineTo: string,
  opts: WaitOptions & { minConf?: number } = {},
): Promise<number> {
  const minConf = opts.minConf ?? 1;
  let conf = await getConfirmations(rpc, txid);
  if (conf < minConf && canMine(config)) {
    await rpc.call("generatetoaddress", [minConf - conf, mineTo]);
    conf = await getConfirmations(rpc, txid);
  }
  if (conf < minConf) {
    const log = opts.log ?? console.log;
    log(`[signet] waiting for ${txid.slice(0, 16)}… to confirm (~10 min per block)...`);
    while (conf < minConf) {
      await sleep(opts.pollMs ?? DEFAULT_POLL_MS);
      conf = await getConfirmations(rpc, txid);
    }
  }
  return (await getTipHeight(rpc)) - conf + 1;
}

/**
 * Height at which a tx spending a CSV-locked output of `fundingTxid` becomes
 * relayable: next block height >= confHeight + csv, i.e. tip >= confHeight + csv - 1.
 * `null` while the funding tx is unconfirmed.
 */
export async function csvMatureTip(rpc: BitcoinCoreRpcClient, fundingTxid: string, csvBlocks: number): Promise<number | null> {
  const conf = await getConfirmations(rpc, fundingTxid);
  if (conf === 0) return null;
  const confHeight = (await getTipHeight(rpc)) - conf + 1;
  return confHeight + csvBlocks - 1;
}

/**
 * Would the network accept `txHex` right now? Regtest uses
 * `testmempoolaccept` (no side effects). Signet's proxy refuses that method,
 * so this **broadcasts** — only call it when you expect a rejection, or when
 * broadcasting on acceptance is what you want anyway.
 */
export async function probeAcceptance(
  config: NetworkConfig,
  rpc: BitcoinCoreRpcClient,
  txHex: string,
): Promise<{ allowed: boolean; reason: string; broadcastTxid?: string }> {
  if (canMine(config)) {
    const [r] = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [[txHex]]);
    return { allowed: r.allowed, reason: r["reject-reason"] ?? "" };
  }
  try {
    const txid = await rpc.call<string>("sendrawtransaction", [txHex]);
    return { allowed: true, reason: "", broadcastTxid: txid };
  } catch (err) {
    return { allowed: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Block-explorer link for humans; null on regtest. */
export function explorerTxUrl(config: NetworkConfig, txid: string): string | null {
  return config.network === "signet" ? `https://mempool.space/signet/tx/${txid}` : null;
}

export function explorerAddressUrl(config: NetworkConfig, address: string): string | null {
  return config.network === "signet" ? `https://mempool.space/signet/address/${address}` : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
