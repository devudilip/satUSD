import { TachiClient } from "@tachibtc/tachi-sdk-ts";
import { BitcoinCoreRpcClient } from "@tachibtc/taurus-wallet-aggregator";

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

export function createBitcoinRpcClient(config: NetworkConfig): BitcoinCoreRpcClient {
  return new BitcoinCoreRpcClient({
    url: config.bitcoinRpc.url,
    username: config.bitcoinRpc.username,
    password: config.bitcoinRpc.password,
  });
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
