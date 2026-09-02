import { isDelinquent } from "@satusd/tachi-kit";
import type { CdpRecord } from "./cdp.js";

/**
 * Deterministic liquidation check — no judgment call, nothing AI-adjacent
 * belongs anywhere near this. Below 130% (LLTV), the CDP's already-held
 * refund is eligible to broadcast. `CdpEngine.liquidate` does the actual
 * broadcast; this just answers "should it."
 */
export function shouldLiquidate(cdp: CdpRecord, btcPriceUsdCents: bigint): boolean {
  if (cdp.status !== "open") return false;
  if (!cdp.latestState) return false; // nothing committed yet — e.g. no debt minted
  return isDelinquent(cdp.channel.funding.valueSats, cdp.principalUsdCents, btcPriceUsdCents);
}
