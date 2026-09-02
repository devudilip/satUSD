import Fastify from "fastify";
import type { BitcoinCoreRpcClient } from "@tachibtc/taurus-wallet-aggregator";
import type { PriceFeed } from "@satusd/tachi-kit";
import { createHttpMusigExchange } from "./musig-server.js";
import { registerCdpRoutes } from "./routes.js";
import type { CdpEngine } from "./cdp.js";

export interface BuildServerOptions {
  /** Mounts /cdp routes when supplied. Omitted by spike 06, which only needs the MuSig2 exchange. */
  readonly cdp?: { readonly cdpEngine: CdpEngine; readonly priceFeed: PriceFeed; readonly rpc: BitcoinCoreRpcClient };
}

export function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ status: "ok" }));

  const musig = createHttpMusigExchange();
  musig.routes(app);

  if (options.cdp) registerCdpRoutes(app, options.cdp);

  return { app, musigExchange: musig.exchange };
}

async function main() {
  const { app } = buildServer();
  const port = Number(process.env.PORT ?? 4001);
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`[engine] listening on http://127.0.0.1:${port}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[engine] failed to start:", err);
    process.exit(1);
  });
}
