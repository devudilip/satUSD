/**
 * Smoke test for the satUSD contracts on Tachi EVM (regtest): deploy, open a
 * vault record, mint, pay back, transfer, refuse an unsafe mint, crash the
 * price, liquidate. No Bitcoin node needed — the vault fields are dummies.
 *
 *   pnpm evm:smoke
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { resolveNetworkConfig } from "@satusd/tachi-kit";
import { SatUsdEvm } from "./lib/satusd-evm.js";

const hex32 = () => randomBytes(32).toString("hex");

async function main() {
  const config = resolveNetworkConfig("regtest");
  const evm = new SatUsdEvm(config, `smoke-${Date.now()}`);
  console.log("operator", evm.operator.address, "user", evm.user.address);

  const { token, manager } = await evm.deploy(10_000_000n); // $100,000 / BTC
  console.log("SatUSD      ", evm.token, evm.txUrl(token.hash), "gas", token.receipt.gas_used);
  console.log("VaultManager", evm.manager, evm.txUrl(manager.hash), "gas", manager.receipt.gas_used);

  const id = hex32();
  const r1 = await evm.openVault(id, 100_000_000n, hex32(), hex32());
  console.log("openVault   ", evm.txUrl(r1.hash));
  const r2 = await evm.generate(id, 5_000_000n, hex32()); // $50,000 against 1 BTC = 200%
  console.log("generate    ", evm.txUrl(r2.hash), "balance $", Number(await evm.balanceCents(evm.user.address)) / 100);

  try {
    await evm.generate(id, 2_000_000n, hex32()); // would be 142% < 150%
    throw new Error("unsafe mint was accepted");
  } catch (e) {
    console.log("unsafe mint refused:", (e as Error).message);
  }

  const r3 = await evm.payBack(id, 1_000_000n);
  console.log("payBack     ", evm.txUrl(r3.hash), "debt $", Number((await evm.vault(id)).debtCents) / 100);
  const r4 = await evm.transfer(evm.operator.address, 50_000n);
  console.log("transfer    ", evm.txUrl(r4.hash), "operator holds $", Number(await evm.balanceCents(evm.operator.address)) / 100);

  try {
    await evm.liquidate(id, hex32());
    throw new Error("healthy vault was liquidated");
  } catch (e) {
    console.log("healthy liquidation refused:", (e as Error).message);
  }
  await evm.setPrice(5_000_000n); // $50,000 → 125%
  const r5 = await evm.liquidate(id, hex32());
  const v = await evm.vault(id);
  console.log("liquidate   ", evm.txUrl(r5.hash), "status", v.status, "supply $", Number(await evm.totalSupplyCents()) / 100);
  console.log("contract    ", evm.addressUrl(evm.manager));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("[smoke] failed:", e);
  process.exit(1);
});
