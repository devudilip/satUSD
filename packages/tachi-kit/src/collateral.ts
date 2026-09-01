import type { BitcoinCoreRpcClient } from "@tachibtc/taurus-wallet-aggregator";
import type { TachiClient } from "@tachibtc/tachi-sdk-ts";
import { getLockedVtxos, type LockedVtxosResult, type Vault } from "@tachibtc/taurus-vault-core";
import type { NetworkConfig } from "./net.js";

/**
 * Collateral tracking model.
 *
 * Verified live (docs/BACKGROUND.md): the cooperative leaf needs a real 5-of-7
 * validator quorum, and the hosted daemons report only 1 live validator today —
 * `finalizeVtxoPsbt` fails with "0 valid node signatures ... needs at least 5"
 * for any ledger-level VTXO transfer. That path is currently unusable, and it
 * isn't something we can fix from here.
 *
 * So collateral is tracked the same way Phase 1's spike verified a deposit:
 * read the vault's real BTC balance straight off Bitcoin via `scantxoutset`.
 * This needs no quorum, no cooperative leaf, and matches the project's
 * "verify it yourself" proof-of-reserves stance. `getLockedCollateral` (the
 * VTXO-ledger read) is kept as an optional, best-effort cross-check — never the
 * source of truth — for whenever more validators come online.
 */

/** The vault's confirmed BTC balance, read directly from Bitcoin via `scantxoutset`. No quorum required. */
export async function getVaultBalanceSats(rpc: BitcoinCoreRpcClient, vaultAddress: string): Promise<bigint> {
  const scan = await rpc.call<{ success: boolean; total_amount: number }>("scantxoutset", [
    "start",
    [`addr(${vaultAddress})`],
  ]);
  if (!scan.success) throw new Error(`scantxoutset did not succeed for ${vaultAddress}`);
  return BigInt(Math.round(scan.total_amount * 1e8));
}

export interface QuorumStatus {
  readonly liveValidators: number;
  readonly totalKnown: number;
  readonly threshold: number;
  readonly hasQuorum: boolean;
}

/**
 * Whether the cooperative-leaf validator quorum is currently reachable.
 * Check this before attempting any cooperative-leaf spend (a ledger VTXO
 * transfer, or a refund cosign) and degrade to the exit leaf if it's false —
 * the exit leaf never needs a quorum. Do not gate minting or the bitcoind-based
 * collateral check on this; they don't need it.
 */
export async function checkQuorum(tachi: TachiClient, threshold = 5): Promise<QuorumStatus> {
  const live = await tachi.getLiveValidators();
  return {
    liveValidators: live.count,
    totalKnown: live.total_known,
    threshold,
    hasQuorum: live.count >= threshold,
  };
}

/**
 * Best-effort read of VTXOs the Tachi ledger has recorded as locked to a
 * vault. Informational only — see the module note above. Do not use this as
 * the source of truth for whether collateral is actually present; use
 * `getVaultBalanceSats`.
 */
export async function getLockedCollateral(config: NetworkConfig, vault: Vault): Promise<LockedVtxosResult> {
  return getLockedVtxos(vault.p2tr.address, {
    baseUrl: config.tachiUrl,
    allowInsecureHttp: config.network === "regtest",
  });
}
