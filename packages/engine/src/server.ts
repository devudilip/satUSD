import Fastify from "fastify";
import { createHttpMusigExchange } from "./musig-server.js";

/**
 * Minimal engine entry point. CDP routes land in Phase 3 (engine/cdp.ts,
 * ledger.ts, fees.ts); this exists first to carry the MuSig2 HTTP exchange
 * (Task 4) so scripts/06-spike-http-musig.ts and scripts/borrower.ts have
 * something real to talk to.
 */
export function buildServer() {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ status: "ok" }));

  const musig = createHttpMusigExchange();
  musig.routes(app);

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
