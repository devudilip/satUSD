import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import type { BitcoinCoreRpcClient } from "@tachibtc/taurus-wallet-aggregator";
import type { PriceFeed } from "@satusd/tachi-kit";
import { createHttpMusigExchange } from "./musig-server.js";
import { registerCdpRoutes } from "./routes.js";
import type { CdpEngine } from "./cdp.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

export interface BuildServerOptions {
  /** Mounts /cdp routes when supplied. Omitted by spike 06, which only needs the MuSig2 exchange. */
  readonly cdp?: { readonly cdpEngine: CdpEngine; readonly priceFeed: PriceFeed; readonly rpc: BitcoinCoreRpcClient };
  /** Serves packages/engine/public (the dashboard) at "/". Default true. */
  readonly serveDashboard?: boolean;
}

export function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ status: "ok" }));

  if (options.serveDashboard ?? true) {
    app.register(fastifyStatic, { root: PUBLIC_DIR });
  }

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
