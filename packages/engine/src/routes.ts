import type { FastifyInstance } from "fastify";
import type { BitcoinCoreRpcClient } from "@tachibtc/taurus-wallet-aggregator";
import type { PriceFeed } from "@satusd/tachi-kit";
import type { CdpEngine } from "./cdp.js";
import { shouldLiquidate } from "./liquidation.js";

/**
 * Public CDP routes. `POST /cdp/:id/liquidate` is deliberately safe to
 * expose with no auth: it re-checks `shouldLiquidate` against the current
 * price itself before broadcasting anything, so calling it early or
 * repeatedly on a healthy position just gets refused. That's what "the
 * keeper bot uses only the public API — no privileged access" means in
 * practice: this route *is* the entire privilege, and everyone has it.
 *
 * The raw `refundHex` is intentionally never returned here — publishing a
 * fully pre-signed, already-cosigned transaction would let anyone broadcast
 * it regardless of whether the position is actually unhealthy. Liquidation
 * always goes through this endpoint's own check, never a leaked hex.
 */
export function registerCdpRoutes(
  app: FastifyInstance,
  deps: { readonly cdpEngine: CdpEngine; readonly priceFeed: PriceFeed; readonly rpc: BitcoinCoreRpcClient },
): void {
  app.get("/cdp", async () => {
    return { cdps: deps.cdpEngine.all().map(publicView) };
  });

  app.get<{ Params: { id: string } }>("/cdp/:id", async (req, reply) => {
    const cdp = deps.cdpEngine.get(req.params.id);
    if (!cdp) return reply.code(404).send({ error: "no such CDP" });
    return publicView(cdp);
  });

  app.post<{ Params: { id: string } }>("/cdp/:id/liquidate", async (req, reply) => {
    const cdp = deps.cdpEngine.get(req.params.id);
    if (!cdp) return reply.code(404).send({ error: "no such CDP" });
    const price = await deps.priceFeed.getPrice();
    if (!shouldLiquidate(cdp, price.btcUsdCents)) {
      return reply.code(409).send({ error: "not liquidatable at the current price", btcUsdCents: price.btcUsdCents.toString() });
    }
    const txid = await deps.cdpEngine.liquidate(req.params.id, deps.rpc);
    return { txid };
  });
}

function publicView(cdp: ReturnType<CdpEngine["all"]>[number]) {
  return {
    id: cdp.id,
    ownerIndividualPub: cdp.ownerIndividualPub,
    vaultAddress: cdp.channel.vault.p2tr.address,
    collateralSats: cdp.channel.funding.valueSats.toString(),
    principalUsdCents: cdp.principalUsdCents.toString(),
    exitTxDelivered: cdp.exitTxDelivered,
    status: cdp.status,
    latestState: cdp.latestState
      ? {
          n: cdp.latestState.n.toString(),
          shareSats: cdp.latestState.shareSats.toString(),
          priceLiqUsdCents: cdp.latestState.priceLiqUsdCents.toString(),
          // The liquidation txid-to-be — safe to publish (see commitment.ts's
          // CommittedState doc comment). refundHex itself never leaves the engine.
          liquidationTxidToBe: cdp.latestState.refundTxid,
        }
      : null,
  };
}
