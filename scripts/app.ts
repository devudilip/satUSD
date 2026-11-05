/**
 * `pnpm app` — the satUSD vault app: a Maker-style UI over the real engine.
 *
 *   http://localhost:4120          open a vault, deposit BTC, generate / pay back
 *                                  satUSD, close, or exit alone; move the oracle
 *                                  price and watch the keeper liquidate.
 *   http://localhost:4120/#/tx/…   built-in explorer: every transaction the app
 *                                  makes, decoded from bitcoind and labelled,
 *                                  plus the vault's record on Tachi's ledger.
 *
 * Everything is real: vaults are TAURUS P2TR outputs, liquidation states are
 * cosigned by Tachi's 5-of-7 validators, every txid is on the chain.
 * Demo simplification (same as `pnpm demo`): both MuSig2 halves — borrower
 * and protocol — are held in this one process, and the price is a dev feed.
 */
import "dotenv/config";
import { WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import { buildServer } from "@satusd/engine/server.js";
import { CdpEngine, type CdpEvent } from "@satusd/engine/cdp.js";
import { Ledger } from "@satusd/engine/ledger.js";
import { runKeeper } from "@satusd/engine/keeper.js";
import {
  resolveNetworkConfig,
  createTachiClient,
  createBitcoinRpcClient,
  assertTachiReachable,
  checkQuorum,
  getVaultBalanceSats,
  DevPriceFeed,
  demoMnemonic,
  demoCsvBlocks,
  canMine,
  getTipHeight,
  csvMatureTip,
  waitForHeight,
  getConfirmations,
  collateralRatioBps,
  MIN_MINT_RATIO_BPS,
  DELINQUENCY_RATIO_BPS,
} from "@satusd/tachi-kit";
import { createDemoOwnerSigner } from "./lib/demo-signer.js";

const PORT = Number(process.env.APP_PORT ?? 4120);
const HOST = process.env.APP_HOST ?? "127.0.0.1"; // 0.0.0.0 inside a container
const LLTV_BPS = DELINQUENCY_RATIO_BPS; // 130% — liquidation threshold
const PENALTY_BPS = 800n; // 8%
const STABILITY_FEE_APR = "2%";
const START_PRICE = 10_000_000n; // $100,000.00 / BTC
const BURN_ADDRESS_REGTEST = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080"; // mined coinbases go nowhere useful

type Kind = "open" | "deposit" | "exit_signed" | "generate" | "payback" | "price" | "liquidate" | "close" | "exit" | "block";
interface Activity {
  readonly at: number;
  readonly kind: Kind;
  readonly vaultId?: string;
  readonly title: string;
  readonly detail?: string;
  readonly txid?: string;
}
interface VaultMeta {
  readonly no: number;
  readonly openedAt: number;
  depositTxid: string;
  exitTxid?: string;
  closeTxid?: string;
  liquidationTxid?: string;
  exited: boolean;
}
type TxRole = "deposit" | "liquidation" | "close" | "exit";

const j = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

async function main() {
  const config = resolveNetworkConfig();
  const CSV_BLOCKS = demoCsvBlocks(config);
  const tachi = createTachiClient(config);
  await assertTachiReachable(tachi, config);
  const quorum = await checkQuorum(tachi);

  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(demoMnemonic(config), { network: config.network, rpc });
  const wallet = aggregator.addAccount({ addressType: "p2wpkh" });
  const treasury = aggregator.addAccount({ addressType: "p2wpkh", account: 1 });
  await Promise.all([wallet.sync(), treasury.sync()]);

  // Addresses are remembered, not re-read: an HD wallet's receive address
  // advances once it's paid, and the explorer must still label old outputs.
  const PAYOUT_ADDRESS = treasury.receiveAddress;
  const walletAddrs = new Set<string>([wallet.receiveAddress, wallet.changeAddress]);
  const priceFeed = new DevPriceFeed(START_PRICE);
  const ledger = new Ledger<CdpEvent>();
  const engine = new CdpEngine({
    config,
    ledger,
    protocolPayoutAddress: PAYOUT_ADDRESS,
    lltvBps: LLTV_BPS,
    penaltyBps: PENALTY_BPS,
    mintFeeBps: 0n, // Maker-style: no mint fee, debt = what you generate
  });

  const meta = new Map<string, VaultMeta>();
  const txRoles = new Map<string, { role: TxRole; vaultId: string }>();
  const activity: Activity[] = [];
  let satusdBalanceCents = 0n;
  let walletBtcSats = wallet.balance.confirmed;
  let treasuryBtcSats = treasury.balance.confirmed;
  const log = (a: Omit<Activity, "at">) => activity.unshift({ at: Date.now(), ...a });
  log({ kind: "price", title: `Connected to Tachi ${config.chainId}`, detail: `${quorum.liveValidators}/${quorum.totalKnown} validators live, threshold ${quorum.threshold}` });

  // One action at a time: MuSig2 rounds and validator cosigns are sequential.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const mineOne = async (why: string) => {
    if (!canMine(config)) return;
    const [hash] = await rpc.call<string[]>("generatetoaddress", [1, BURN_ADDRESS_REGTEST]);
    const height = await getTipHeight(rpc);
    log({ kind: "block", title: `Block ${height} mined`, detail: `${why} · ${hash.slice(0, 16)}…` });
  };
  const refreshBalances = async () => {
    await Promise.all([wallet.sync(), treasury.sync()]);
    walletAddrs.add(wallet.receiveAddress);
    walletAddrs.add(wallet.changeAddress);
    walletBtcSats = wallet.balance.confirmed;
    treasuryBtcSats = treasury.balance.confirmed;
  };
  const vaultName = (id: string) => `Vault #${meta.get(id)?.no ?? "?"}`;

  const { app } = buildServer({ cdp: { cdpEngine: engine, priceFeed, rpc } });

  // ---------- state ----------
  const vaultView = (id: string, price: bigint) => {
    const cdp = engine.get(id)!;
    const m = meta.get(id)!;
    const sats = cdp.channel.funding.valueSats;
    const debt = cdp.principalUsdCents;
    const crBps = collateralRatioBps(sats, debt, price);
    const liqPrice = debt > 0n ? (debt * LLTV_BPS * 100_000_000n) / (10_000n * sats) : null;
    const maxDebt = (sats * price * 10_000n) / (100_000_000n * MIN_MINT_RATIO_BPS);
    const status = m.exited ? "exited" : cdp.status;
    return {
      id,
      no: m.no,
      name: vaultName(id),
      status,
      vaultAddress: cdp.channel.vault.p2tr.address,
      ownerKey: cdp.channel.vault.userKey.xOnly.toString("hex"),
      tachiVaultId: cdp.channel.vaultId,
      csvBlocks: cdp.channel.vault.p2tr.exitLeaf.csvBlocks,
      collateralSats: sats,
      collateralUsdCents: (sats * price) / 100_000_000n,
      debtUsdCents: debt,
      collateralRatioBps: crBps,
      liquidationPriceUsdCents: liqPrice,
      maxGenerateUsdCents: maxDebt > debt ? maxDebt - debt : 0n,
      exitTxHeld: cdp.exitTxDelivered,
      state: cdp.latestState
        ? {
            n: cdp.latestState.n,
            lenderShareSats: cdp.latestState.shareSats,
            priceLiqUsdCents: cdp.latestState.priceLiqUsdCents,
            liquidationTxidToBe: cdp.latestState.refundTxid,
          }
        : null,
      depositTxid: m.depositTxid,
      liquidationTxid: m.liquidationTxid ?? null,
      closeTxid: m.closeTxid ?? null,
      exitTxid: m.exitTxid ?? null,
      openedAt: m.openedAt,
    };
  };

  app.get("/api/state", async () => {
    const { btcUsdCents: price } = await priceFeed.getPrice();
    const vaults = engine.all().map((c) => vaultView(c.id, price));
    const open = vaults.filter((v) => v.status === "open");
    return j({
      network: config.network,
      chainId: config.chainId,
      tachiUrl: config.tachiUrl,
      quorum,
      tipHeight: await getTipHeight(rpc),
      priceUsdCents: price,
      params: { minRatioBps: MIN_MINT_RATIO_BPS, liquidationRatioBps: LLTV_BPS, penaltyBps: PENALTY_BPS, stabilityFee: STABILITY_FEE_APR, termBlocks: CSV_BLOCKS },
      wallet: { address: wallet.receiveAddress, btcSats: walletBtcSats, satusdCents: satusdBalanceCents },
      treasury: { address: PAYOUT_ADDRESS, btcSats: treasuryBtcSats },
      totals: {
        collateralSats: open.reduce((s, v) => s + v.collateralSats, 0n),
        debtUsdCents: open.reduce((s, v) => s + v.debtUsdCents, 0n),
      },
      vaults,
      activity: activity.slice(0, 60),
      ledger: { records: ledger.length, verifies: ledger.verify() },
    });
  });

  // ---------- actions ----------
  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) =>
    reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });

  app.post<{ Body: { depositSats: string; generateUsdCents?: string } }>("/api/vaults", async (req, reply) => {
    try {
      return await exclusive(async () => {
        const depositSats = BigInt(req.body.depositSats);
        const generate = BigInt(req.body.generateUsdCents ?? "0");
        if (depositSats < 10_000n) throw new Error("minimum deposit is 10,000 sats");
        await wallet.sync();
        walletAddrs.add(wallet.receiveAddress);
        walletAddrs.add(wallet.changeAddress);
        const signer = createDemoOwnerSigner();
        const cdp = await engine.open({
          ownerSigner: signer.ownerSigner,
          ownerIndividualPub: signer.borrowerPub,
          borrowerReturnAddress: wallet.receiveAddress,
          funderWallet: wallet,
          rpc,
          amountSats: depositSats,
          csvBlocks: CSV_BLOCKS,
        });
        const no = meta.size + 1;
        meta.set(cdp.id, { no, openedAt: Date.now(), depositTxid: cdp.channel.funding.txid, exited: false });
        txRoles.set(cdp.channel.funding.txid, { role: "deposit", vaultId: cdp.id });
        log({ kind: "open", vaultId: cdp.id, title: `Vault #${no} opened`, detail: `TAURUS vault ${cdp.channel.vault.p2tr.address.slice(0, 18)}… · registered on Tachi ledger` });
        log({ kind: "deposit", vaultId: cdp.id, title: `Deposited ${fmtBtc(depositSats)} BTC`, txid: cdp.channel.funding.txid });
        engine.confirmExitTxDelivered(cdp.id);
        log({ kind: "exit_signed", vaultId: cdp.id, title: "Exit transaction signed and handed to you", detail: `Spendable by you alone after ${CSV_BLOCKS} blocks — before any satUSD exists` });
        await mineOne("confirms the deposit");
        if (generate > 0n) await doGenerate(cdp.id, generate);
        await refreshBalances();
        return { id: cdp.id };
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  const doGenerate = async (id: string, cents: bigint) => {
    const { btcUsdCents } = await priceFeed.getPrice();
    const { issuedUsdCents, state } = await engine.mint(id, cents, btcUsdCents);
    satusdBalanceCents += issuedUsdCents;
    log({
      kind: "generate",
      vaultId: id,
      title: `Generated ${fmtUsd(issuedUsdCents)} satUSD`,
      detail: `Liquidation state n=${state.n} signed by you + protocol, cosigned by 5/7 Tachi validators · lender share ${state.shareSats} sats · txid-to-be ${state.refundTxid.slice(0, 16)}…`,
    });
  };

  app.post<{ Params: { id: string }; Body: { usdCents: string } }>("/api/vaults/:id/generate", async (req, reply) => {
    try {
      return await exclusive(async () => {
        await doGenerate(req.params.id, BigInt(req.body.usdCents));
        return { ok: true };
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: { usdCents: string } }>("/api/vaults/:id/payback", async (req, reply) => {
    try {
      return await exclusive(async () => {
        const cents = BigInt(req.body.usdCents);
        if (cents > satusdBalanceCents) throw new Error(`you only hold ${fmtUsd(satusdBalanceCents)} satUSD`);
        const state = await engine.repay(req.params.id, cents);
        satusdBalanceCents -= cents;
        log({
          kind: "payback",
          vaultId: req.params.id,
          title: `Paid back ${fmtUsd(cents)} satUSD`,
          detail: state ? `New liquidation state n=${state.n} cosigned · lender share now ${state.shareSats} sats` : "Debt is zero — the vault can be closed",
        });
        return { ok: true };
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/vaults/:id/close", async (req, reply) => {
    try {
      return await exclusive(async () => {
        const txid = await engine.close(req.params.id, rpc);
        meta.get(req.params.id)!.closeTxid = txid;
        txRoles.set(txid, { role: "close", vaultId: req.params.id });
        log({ kind: "close", vaultId: req.params.id, title: `${vaultName(req.params.id)} closed — BTC returned`, txid });
        await mineOne("confirms the close");
        await refreshBalances();
        return { txid };
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/vaults/:id/exit", async (req, reply) => {
    try {
      return await exclusive(async () => {
        const id = req.params.id;
        const cdp = engine.get(id);
        if (!cdp) throw new Error("no such vault");
        if (cdp.status !== "open" || meta.get(id)!.exited) throw new Error("vault is no longer open — its coins have already moved");
        const matureTip = await csvMatureTip(rpc, cdp.channel.funding.txid, CSV_BLOCKS);
        if (matureTip === null) throw new Error("deposit not confirmed yet");
        if (!canMine(config) && (await getTipHeight(rpc)) < matureTip) {
          throw new Error(`term not over: exit becomes valid at block ${matureTip + 1}`);
        }
        log({ kind: "block", vaultId: id, title: `Waiting out the ${CSV_BLOCKS}-block term`, detail: `regtest: mining to block ${matureTip}` });
        await waitForHeight(config, rpc, matureTip, BURN_ADDRESS_REGTEST);
        const txid = await rpc.call<string>("sendrawtransaction", [cdp.channel.exitTxHex]);
        const m = meta.get(id)!;
        m.exited = true;
        m.exitTxid = txid;
        txRoles.set(txid, { role: "exit", vaultId: id });
        log({ kind: "exit", vaultId: id, title: `${vaultName(id)}: exit broadcast by you alone`, detail: "No engine, no protocol signature, no Tachi validators — only the pre-signed exit tx", txid });
        await mineOne("confirms the exit");
        await refreshBalances();
        return { txid };
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Body: { usdCents: string } }>("/api/price", async (req, reply) => {
    try {
      const cents = BigInt(req.body.usdCents);
      if (cents <= 0n) throw new Error("price must be positive");
      priceFeed.setPrice(cents);
      log({ kind: "price", title: `Oracle price set to ${fmtUsd(cents)} / BTC`, detail: "dev price feed" });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/mine", async () => {
    await mineOne("manual");
    await refreshBalances();
    return { ok: true };
  });

  // ---------- explorer ----------
  const labelFor = (address: string | undefined): string | null => {
    if (!address) return null;
    if (walletAddrs.has(address)) return "Your wallet";
    if (address === PAYOUT_ADDRESS) return "Protocol treasury (lender share)";
    for (const c of engine.all()) {
      if (c.channel.vault.p2tr.address === address) return `${vaultName(c.id)} (TAURUS vault)`;
      if (c.channel.toLocal.address === address) return `${vaultName(c.id)} borrower remainder (to_local, delayed)`;
    }
    return null;
  };

  app.get<{ Params: { txid: string } }>("/api/tx/:txid", async (req, reply) => {
    try {
      const tx = await rpc.call<any>("getrawtransaction", [req.params.txid, true]);
      const tip = await getTipHeight(rpc);
      const conf = tx.confirmations ?? 0;
      const role = txRoles.get(tx.txid);
      const inputs = await Promise.all(
        tx.vin.map(async (vin: any) => {
          if (!vin.txid) return { coinbase: true };
          const prev = await rpc.call<any>("getrawtransaction", [vin.txid, true]);
          const out = prev.vout[vin.vout];
          const w: string[] = vin.txinwitness ?? [];
          const scriptPath = w.length >= 3 && /^c[01]/.test(w[w.length - 1]);
          let path: Record<string, unknown> | null = null;
          if (scriptPath) {
            const script = w[w.length - 2];
            const sigs = w.slice(0, -2);
            const isExit = script.length / 2 < 60;
            path = isExit
              ? { name: "Exit path", meaning: `Owner key alone after a ${vin.sequence}-block relative timelock (CSV). No validators.`, signatures: sigs.filter((s) => s.length === 128).length, scriptBytes: script.length / 2 }
              : {
                  name: "Cooperative path",
                  meaning: "Owner (MuSig2: borrower + protocol) AND 5-of-7 Tachi validators",
                  ownerSignatures: 1,
                  validatorSignatures: sigs.filter((s) => s.length === 128).length - 1,
                  validatorSlots: sigs.length - 1,
                  scriptBytes: script.length / 2,
                  ownerKey: script.slice(2, 66),
                };
          }
          return {
            prevTxid: vin.txid,
            prevVout: vin.vout,
            sequence: vin.sequence,
            valueSats: Math.round(out.value * 1e8),
            address: out.scriptPubKey.address,
            label: labelFor(out.scriptPubKey.address) ?? (role?.role === "deposit" ? "Your wallet" : null),
            witnessItems: w.map((x) => x.length / 2),
            path,
          };
        }),
      );
      const outputs = tx.vout.map((o: any) => ({
        n: o.n,
        valueSats: Math.round(o.value * 1e8),
        address: o.scriptPubKey.address,
        type: o.scriptPubKey.type,
        label: labelFor(o.scriptPubKey.address) ?? (role?.role === "deposit" ? "Your wallet (change)" : null),
      }));
      const inSum = inputs.reduce((s: number, i: any) => s + (i.valueSats ?? 0), 0);
      const outSum = outputs.reduce((s: number, o: any) => s + o.valueSats, 0);
      let tachiRecord: unknown = null;
      if (role?.role === "deposit") {
        const ownerKey = engine.get(role.vaultId)!.channel.vault.userKey.xOnly.toString("hex");
        tachiRecord = await fetchTachiRecords(config.tachiUrl, ownerKey).catch(() => null);
      }
      return j({
        txid: tx.txid,
        role: role?.role ?? null,
        vault: role ? vaultName(role.vaultId) : null,
        vaultId: role?.vaultId ?? null,
        confirmations: conf,
        blockHeight: conf > 0 ? tip - conf + 1 : null,
        vsize: tx.vsize,
        feeSats: inputs.every((i: any) => !i.coinbase) ? inSum - outSum : null,
        inputs,
        outputs,
        tachiRecord,
        hex: tx.hex,
      });
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/vaults/:id/onchain", async (req, reply) => {
    const cdp = engine.get(req.params.id);
    if (!cdp) return reply.code(404).send({ error: "no such vault" });
    const ownerKey = cdp.channel.vault.userKey.xOnly.toString("hex");
    const [balance, conf, tachiRecords] = await Promise.all([
      getVaultBalanceSats(rpc, cdp.channel.vault.p2tr.address).catch(() => null),
      getConfirmations(rpc, cdp.channel.funding.txid).catch(() => 0),
      fetchTachiRecords(config.tachiUrl, ownerKey).catch(() => null),
    ]);
    return j({ balanceSatsViaBitcoind: balance, depositConfirmations: conf, tachiRecords, tachiLink: `${config.tachiUrl}/tachi_addressTransactions?address=${ownerKey}` });
  });

  app.get("/app", async (_req, reply) => reply.redirect("/app.html"));

  await app.listen({ port: PORT, host: HOST });

  // The keeper is a separate actor using only the public /cdp API.
  const engineUrl = `http://127.0.0.1:${PORT}`;
  void runKeeper({
    engineUrl,
    pollIntervalMs: 1_500,
    onAttempt: (cdpId, { liquidated, detail }) => {
      if (!liquidated) return;
      const txid = (detail as { txid: string }).txid;
      const m = meta.get(cdpId);
      if (m) m.liquidationTxid = txid;
      txRoles.set(txid, { role: "liquidation", vaultId: cdpId });
      log({ kind: "liquidate", vaultId: cdpId, title: `${vaultName(cdpId)} liquidated by keeper`, detail: "Broadcast the liquidation tx signed at generate time — the same txid announced then", txid });
      void exclusive(async () => {
        await mineOne("confirms the liquidation");
        await refreshBalances();
      });
    },
  }).catch((err) => console.error("[app] keeper stopped:", err));

  console.log(`\n  satUSD app  →  http://localhost:${PORT}/app.html`);
  console.log(`  network ${config.network} (${config.chainId}), Tachi quorum ${quorum.liveValidators}/${quorum.totalKnown}, term ${CSV_BLOCKS} blocks\n`);
}

async function fetchTachiRecords(tachiUrl: string, ownerKey: string) {
  const res = await fetch(`${tachiUrl}/tachi_addressTransactions?address=${ownerKey}`);
  const body = (await res.json()) as any;
  const r = body.result ?? body;
  return (r.transactions ?? []).map((t: any) => ({
    hash: t.tx_hash,
    type: t.type,
    state: t.state,
    height: t.height,
    feeSats: t.fee,
    time: t.time,
    bitcoinInput: t.vin?.[0] ? { txid: t.vin[0].txid, vout: t.vin[0].vout, valueSats: t.vin[0].value_sats } : null,
    outputs: (t.vout ?? []).map((o: any) => ({ owner: o.owner, amount: o.amount ?? o.value_sats })),
  }));
}

function fmtBtc(sats: bigint): string {
  return (Number(sats) / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}
function fmtUsd(cents: bigint): string {
  return `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

main().catch((err) => {
  console.error("[app] failed:", err);
  process.exit(1);
});
