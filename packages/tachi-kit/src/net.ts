import { TachiClient } from "@tachibtc/tachi-sdk-ts";
import { BitcoinCoreRpcClient } from "@tachibtc/taurus-wallet-aggregator";
import { Address, OutScript, Transaction, TEST_NETWORK } from "@scure/btc-signer";

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export type TachiNetwork = "regtest" | "signet";

export interface NetworkConfig {
  readonly network: TachiNetwork;
  readonly tachiUrl: string;
  readonly chainId: string;
  readonly bitcoinRpc: {
    readonly url: string;
    readonly username?: string;
    readonly password?: string;
  };
}

const NETWORKS: Record<TachiNetwork, NetworkConfig> = {
  regtest: {
    network: "regtest",
    tachiUrl: process.env.TACHI_URL_REGTEST ?? "https://rpc-regtest.tachibtc.com",
    chainId: "tachi-regtest-1",
    bitcoinRpc: {
      url: process.env.BITCOIN_RPC_URL ?? "http://127.0.0.1:18443",
      username: process.env.BITCOIN_RPC_USER ?? "tachi",
      password: process.env.BITCOIN_RPC_PASSWORD ?? "tachi",
    },
  },
  signet: {
    network: "signet",
    tachiUrl: process.env.TACHI_URL_SIGNET ?? "https://rpc-signet.tachibtc.com",
    chainId: "tachi-signet-1",
    // signet's hosted bitcoind proxy works — POST / on the ledger URL itself.
    bitcoinRpc: { url: process.env.TACHI_URL_SIGNET ?? "https://rpc-signet.tachibtc.com" },
  },
};

export function resolveNetworkConfig(network = process.env.TACHI_NETWORK): NetworkConfig {
  if (network !== "regtest" && network !== "signet") {
    throw new Error(`TACHI_NETWORK must be "regtest" or "signet", got: ${network ?? "<unset>"}`);
  }
  return NETWORKS[network];
}

export function createTachiClient(config: NetworkConfig): TachiClient {
  return new TachiClient({ baseUrl: config.tachiUrl, timeoutMs: 30_000 });
}

/**
 * Bitcoin Core runs one `scantxoutset` at a time per node. On signet the node
 * is Tachi's shared hosted proxy, so any other user's scan makes ours fail
 * with "Scan already in progress". The wallet aggregator retries for ~14s;
 * this client retries every scan (the aggregator's and the kit's own
 * balance reads) for up to ~2 minutes before giving up.
 */
const SCAN_BUSY_RETRY_MS = 3_000;
const SCAN_BUSY_MAX_WAIT_MS = 120_000;

/**
 * The wallet aggregator learns its coins from `scantxoutset`, which only sees
 * the confirmed UTXO set. On signet that means a second deposit made before
 * the first confirms re-selects the coin the first one spent ("rejecting
 * replacement"), and can't see the first one's change. So this client keeps a
 * mempool view of its own broadcasts: coins they spent are hidden from scans,
 * and outputs they pay to a scanned address are added as spendable.
 */
interface PendingOutput {
  readonly txid: string;
  readonly vout: number;
  readonly sats: bigint;
  readonly scriptHex: string;
  readonly address: string;
}

interface ScanUnspent {
  txid: string;
  vout: number;
  scriptPubKey: string;
  desc: string;
  amount: number;
  height: number;
  coinbase?: boolean;
}

class SharedNodeRpcClient extends BitcoinCoreRpcClient {
  private readonly spent = new Set<string>();
  private readonly pending = new Map<string, PendingOutput>();

  constructor(
    opts: ConstructorParameters<typeof BitcoinCoreRpcClient>[0],
    private readonly btcNetwork: typeof TEST_NETWORK,
  ) {
    super(opts);
  }

  override async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const result = await this.callRetrying<T>(method, params);
    if (method === "sendrawtransaction" && typeof params[0] === "string") this.track(params[0], String(result));
    if (method === "scantxoutset" && params[0] === "start") return this.patchScan(result, params[1]) as T;
    return result;
  }

  private async callRetrying<T>(method: string, params: unknown[]): Promise<T> {
    const deadline = Date.now() + SCAN_BUSY_MAX_WAIT_MS;
    for (;;) {
      try {
        return await super.call<T>(method, params);
      } catch (err) {
        const busy = method === "scantxoutset" && /scan already in progress/i.test(String((err as Error)?.message));
        if (!busy || Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, SCAN_BUSY_RETRY_MS));
      }
    }
  }

  private track(rawHex: string, txid: string): void {
    let tx: Transaction;
    try {
      tx = Transaction.fromRaw(Buffer.from(rawHex, "hex"), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
    } catch {
      return;
    }
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      if (!input.txid || input.index === undefined) continue;
      const key = `${toHex(input.txid)}:${input.index}`;
      this.spent.add(key);
      this.pending.delete(key);
    }
    for (let n = 0; n < tx.outputsLength; n++) {
      const out = tx.getOutput(n);
      if (!out.script || out.amount === undefined) continue;
      let address: string;
      try {
        address = Address(this.btcNetwork).encode(OutScript.decode(out.script));
      } catch {
        continue;
      }
      this.pending.set(`${txid}:${n}`, { txid, vout: n, sats: out.amount, scriptHex: toHex(out.script), address });
    }
  }

  private patchScan(result: unknown, descriptors: unknown): unknown {
    const r = result as { unspents?: ScanUnspent[]; total_amount?: number; height?: number } | null;
    if (!r || !Array.isArray(r.unspents)) return result;
    const live = r.unspents.filter((u) => !this.spent.has(`${u.txid}:${u.vout}`));
    const seen = new Set(live.map((u) => `${u.txid}:${u.vout}`));
    const wanted = new Set<string>();
    for (const d of Array.isArray(descriptors) ? descriptors : []) {
      const desc = typeof d === "string" ? d : (d as { desc?: string })?.desc;
      const m = desc && /^addr\(([^)]+)\)/.exec(desc);
      if (m) wanted.add(m[1]!);
    }
    for (const [key, p] of this.pending) {
      if (seen.has(key) || !wanted.has(p.address)) continue;
      live.push({ txid: p.txid, vout: p.vout, scriptPubKey: p.scriptHex, desc: `addr(${p.address})`, amount: Number(p.sats) / 1e8, height: r.height ?? 0, coinbase: false });
    }
    const total = live.reduce((s, u) => s + Math.round(u.amount * 1e8), 0);
    return { ...r, unspents: live, total_amount: total / 1e8 };
  }
}

const REGTEST_NETWORK = { ...TEST_NETWORK, bech32: "bcrt" };

export function createBitcoinRpcClient(config: NetworkConfig): BitcoinCoreRpcClient {
  return new SharedNodeRpcClient(
    {
      url: config.bitcoinRpc.url,
      username: config.bitcoinRpc.username,
      password: config.bitcoinRpc.password,
    },
    config.network === "regtest" ? REGTEST_NETWORK : TEST_NETWORK,
  );
}

/**
 * Startup assertion — fail fast if the daemon is unreachable or on the wrong
 * chain, rather than deriving vault scripts against a validator set that
 * doesn't match what the daemon will accept.
 */
export async function assertTachiReachable(
  tachi: TachiClient,
  config: NetworkConfig,
): Promise<void> {
  const health = await tachi.getHealth();
  if (health.status !== "ok") {
    throw new Error(`Tachi daemon at ${config.tachiUrl} reported status: ${health.status}`);
  }
  const stats = await tachi.getStats();
  if (stats.chain_id !== config.chainId) {
    throw new Error(
      `Chain id mismatch: expected "${config.chainId}", daemon at ${config.tachiUrl} reported "${stats.chain_id}"`,
    );
  }
}
