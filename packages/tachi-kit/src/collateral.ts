import type { BitcoinCoreRpcClient } from "@tachibtc/taurus-wallet-aggregator";
import type { TachiClient } from "@tachibtc/tachi-sdk-ts";
import { getLockedVtxos, type LockedVtxosResult, type Vault } from "@tachibtc/taurus-vault-core";
import type { NetworkConfig } from "./net.js";

/**
 * Collateral tracking model.
 *
 * A collateral channel's actual custody guarantee (docs/COLLATERAL-MODEL.md
 * §3, Track B) lives on Bitcoin — the MuSig2 joint vault, the pre-signed exit
 * tx, the pre-signed liquidation refund — none of which this module builds
 * (see `commitment.ts`). What this module gives is a second, independent
 * read of "is the collateral really there": `getVaultBalanceSats` checks
 * Bitcoin directly via `scantxoutset`, the same way Phase 1's spike verified
 * a deposit, with no dependency on the Tachi ledger or its validator quorum.
 * Use it for proof-of-reserves and as a cross-check against `commitment.ts`'s
 * own bookkeeping — never as a substitute for holding the pre-signed exit tx
 * or refund correctly. `checkQuorum` is a pre-flight for the cooperative
 * paths `commitment.ts` uses (`registerVault`, `cosignRefund`) — real, not a
 * fallback (see `docs/COLLATERAL-MODEL.md` §1 for what was verified live).
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
