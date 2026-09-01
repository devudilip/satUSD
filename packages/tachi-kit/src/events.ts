import {
  subscribeVaultEvents,
  type VaultEvent,
  type VaultEventSubscription,
} from "@tachibtc/taurus-vault-core";
import type { NetworkConfig } from "./net.js";

/**
 * Live vault events over the daemon's WebSocket hub. Thin wrapper over
 * `subscribeVaultEvents` — see its own doc comment for the signet
 * WebSocket-upgrade caveat (regtest streams fine; signet's gateway drops the
 * upgrade as of the version probed in docs/BACKGROUND.md). No reconnect
 * logic: a dropped socket calls `onClose`, and the caller must re-query
 * current state on reconnect (`listVaults`, `getTachiTx`) — events published
 * while disconnected are gone for good.
 */
export function watchVault(
  config: NetworkConfig,
  vaultAddress: string,
  onEvent: (event: VaultEvent) => void,
  options?: { readonly onError?: (error: Error) => void; readonly onClose?: () => void },
): VaultEventSubscription {
  const wsUrl = config.tachiUrl.replace(/^http/, "ws") + "/tachi_ws";
  return subscribeVaultEvents({
    url: wsUrl,
    vault: vaultAddress,
    onEvent,
    onError: options?.onError,
    onClose: options?.onClose,
    allowInsecureHttp: config.network === "regtest",
  });
}

/**
 * Classify a `breach` event's relevance to a channel we're watching: is this
 * our vault, and does it look like a stale (superseded) state being
 * replayed? `event.breach.classification` is the daemon's own read; this
 * just narrows it into three plain outcomes for a UI or alerting path to
 * branch on. Do not treat `legitimate`/`anomalous` as safe to ignore without
 * looking — `anomalous` in particular means the daemon couldn't classify it
 * confidently.
 */
export type BreachClassification = "stale" | "legitimate" | "anomalous" | "not-a-breach";

export function classifyBreach(event: VaultEvent): BreachClassification {
  if (event.event !== "breach" || !event.breach) return "not-a-breach";
  const c = event.breach.classification;
  if (c === "stale" || c === "legitimate" || c === "anomalous") return c;
  return "anomalous";
}
