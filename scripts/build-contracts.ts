/**
 * `pnpm contracts:build` — compile contracts/*.sol with solc-js for Tachi EVM
 * (Cancun) and write ABI + bytecode to contracts/out/satusd.json, which the
 * app loads at runtime. The output is committed so the app needs no compiler.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
// @ts-expect-error solc ships no types
import solc from "solc";

const dir = new URL("../contracts/", import.meta.url);
const sources: Record<string, { content: string }> = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sol"))) {
  sources[f] = { content: readFileSync(new URL(f, dir), "utf8") };
}

const out = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources,
      settings: {
        evmVersion: "cancun", // Tachi EVM is Cancun; newer solc defaults to Prague
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      },
    }),
  ),
);

const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
for (const e of out.errors ?? []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);

const artifacts: Record<string, { abi: unknown; bytecode: string }> = {};
for (const file of Object.keys(out.contracts)) {
  for (const [name, c] of Object.entries<any>(out.contracts[file])) {
    artifacts[name] = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
  }
}
mkdirSync(new URL("out/", dir), { recursive: true });
writeFileSync(new URL("out/satusd.json", dir), JSON.stringify({ compiler: solc.version(), evmVersion: "cancun", contracts: artifacts }, null, 2) + "\n");
for (const [n, a] of Object.entries(artifacts)) console.log(`[contracts] ${n}: ${(a.bytecode.length - 2) / 2} bytes`);
