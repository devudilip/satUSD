# satUSD — Build Plan

**Prerequisite:** read [`BACKGROUND.md`](BACKGROUND.md), then
[`COLLATERAL-MODEL.md`](COLLATERAL-MODEL.md) — the actual custody/liquidation
design (Track B: MuSig2 joint vaults). An earlier "soft liquidation" pivot
(delinquency flags, no BTC ever seized) turned out to be one step short of
what's actually possible; `BACKGROUND.md`'s SUPERSEDED note has the story.
Phases 1–2 below predate that correction and are still accurate; Phase 2b and
everything after assume Track B.

## Guiding principle

**Build the ending first.** The unilateral-exit demo — killing the engine and
having a borrower sweep their own BTC via a pre-signed transaction, unconditionally
— is the moment that wins this bounty. Everything else is table stakes. Never cut it.

---

## Repo layout

```
satusd/
  packages/
    tachi-kit/          # shared Tachi/Bitcoin layer — ALSO vendored into ../kosen
      src/{net,vault,vtxo,collateral,health,musig,commitment,events}.ts
      test/{health,musig}.test.ts
    engine/             # Fastify service: collateral channels, mint/repay, liquidation
      src/{server,musig-server,cdp,ledger,fees,liquidation,keeper,anchor}.ts
    web/                # Next.js 15 App Router
      app/{page,mint,position,reserves,liquidations}/
  scripts/
    00-bootstrap-regtest.ts
    01-spike-vault.ts
    02-spike-collateral.ts
    03-spike-refund-cosign.ts
    04-spike-musig-vault.ts
    05-spike-exit-presigned.ts
    06-spike-http-musig.ts
    borrower.ts             # CLI-first borrower-side MuSig2 responder
    demo-liquidate.ts
    verify-reserves.ts
  .env.example
```

`packages/tachi-kit` is authored here and copied verbatim into `kosen`. Treat its
public surface as a contract — see [`../../SHARED-CONTEXT.md`](../../SHARED-CONTEXT.md).

---

## Phase 1 — Spike: prove the platform works

**Goal: no product code until BTC has moved.** The SDKs are v0.x; validate before
committing.

- `pnpm init`, TypeScript, Vitest, pnpm workspaces
- `scripts/00-bootstrap-regtest.ts` — local `bitcoind -regtest`, create wallet, mine
  101 blocks (matures the first coinbase), fund the demo mnemonic
- `tachi-kit/net.ts` — `TachiClient` + `BitcoinCoreRpcClient`, network config object
  keyed by `TACHI_NETWORK`, and a startup assertion on `getHealth()` + `chain_id`
- `tachi-kit/vault.ts` — wrap `createVault`, `verifyVaultP2tr`, `depositToVault`
- `scripts/01-spike-vault.ts` — create a vault, print the P2TR address, deposit
  100,000 sats, mine a block, confirm the deposit

**Exit criteria:** a real regtest txid, and the vault address visible on-chain.
**If this phase fails,** the SDKs are broken — raise it with the Tachi team
immediately rather than working around it.

## Phase 2 — collateral tracking + risk math

**Revised from the original VTXO-transfer plan.** OPEN QUESTION #2 turned out
to be the wrong question — see `BACKGROUND.md`'s VERIFIED notes. Ledger-level
VTXO transfers (locking or unlocking, self or third-party) need cooperative-leaf
node signatures that aren't obtainable through the documented public API at
all, for either of two possible reasons (validator-liveness signals disagree,
and there's no exposed step for collecting non-refund cosign partials). So
collateral is tracked off Bitcoin directly instead — no ledger transfer needed.

- `tachi-kit/vtxo.ts` — the canonical 7-call sequence from `BACKGROUND.md` §7, as
  one function, kept for when the cooperative path is usable. **Includes nonce
  management** — nonces are sequential per account and concurrent operations
  will collide without a serializer.
- `tachi-kit/collateral.ts` — `getVaultBalanceSats()` reads a vault's real BTC
  balance via `bitcoind` `scantxoutset` (no quorum required — this is what
  Phase 1's spike already proved). `checkQuorum()` reports live validator count
  so the cooperative path can be attempted opportunistically later, never
  load-bearing. `getLockedCollateral()` (the VTXO-ledger read) is kept as an
  optional, best-effort cross-check only. No `seize()` — nothing can move a
  borrower's BTC without their own signature (see Phase 4).
- `tachi-kit/health.ts` — pure LTV / collateral-ratio / delinquency-price math.
  **No network calls.** This is the most heavily tested file in the repo; both
  products' risk logic sits on it.
- `test/health.test.ts` — boundary cases: exactly 150%, exactly 130%, zero debt,
  dust collateral, price = 0, integer/rounding safety (use bigint sats throughout)

**Exit criteria:** `scripts/02-spike-collateral.ts` confirms a vault's balance is
tracked correctly via bitcoind across a deposit, with no quorum involved;
`pnpm test` green.

## Phase 2b — Track B: MuSig2 joint vaults, pre-signed exit + liquidation — DONE

A single-key vault (owner = the borrower alone) can't secure a lender: the
owner can always cosign a refund paying themselves 100%, or wait out the CSV
and exit unilaterally. `COLLATERAL-MODEL.md` §1–§3 has the full analysis.
Fix: make the owner key a MuSig2 aggregate (borrower + protocol, BIP-327).
Every piece verified live, in order:

- `scripts/03-spike-refund-cosign.ts` — registers a vault, cosigns a
  quorum-backed refund (`buildRefundPsbt`/`cosignRefund`), broadcasts and
  mines it. Establishes the refund path works at all (a plain `buildVtxoPsbt`
  transfer does not — see `BACKGROUND.md`).
- `scripts/04-spike-musig-vault.ts` — the one previously-unverified assumption:
  does the daemon accept a MuSig2 aggregate as the vault's owner key?
  **Yes.** Full flow: agg-signed deposit onboarding, `registerVault`, a
  pre-signed `exit_tx` correctly rejected before the CSV term and accepted
  after mining it, a cosigned refund that broadcasts and mines.
- `tachi-kit/musig.ts` — `aggregateKey` (pure), `createAggSigner` (a
  `TaprootSigner` backed by an interactive two-party MuSig2 session, transport
  via a `MusigExchange` interface). Network-free unit tests verify signatures
  against `@noble/curves`' `schnorr.verify`.
- `tachi-kit/commitment.ts` — `openCollateral` / `commitState` /
  `broadcastLiquidation` / `closeChannel` / `watchChannel`: the collateral
  channel abstraction the engine builds on. `health.ts` gained
  `shareForLiquidation` (the liquidation split formula).
- `tachi-kit/events.ts` — `watchVault`/`classifyBreach`, wrapping
  `subscribeVaultEvents`.
- `scripts/05-spike-exit-presigned.ts` — proves the promoted modules (not raw
  SDK calls): open → two committed states → **kill the engine** → borrower
  alone broadcasts the pre-signed `exit_tx` after the term. This is the demo.
- `packages/engine/src/musig-server.ts` + `scripts/borrower.ts` — the
  interactive exchange over real HTTP (`GET /musig/pending`,
  `POST /musig/nonce`, `POST /musig/partial`), not an in-process shortcut.
- `scripts/06-spike-http-musig.ts` — the same open + commitState flow, signed
  over real loopback HTTP requests, then both the engine server and the
  borrower's responder process are shut down and the exit tx still works.

**Exit criteria (met):** every script above passes live against
`rpc-regtest.tachibtc.com`.

## Phase 3 — Engine: collateral channels, mint, repay

A CDP *is* a `CollateralChannel` (`commitment.ts`) — this phase wires the
engine's own bookkeeping and HTTP surface around it, not a parallel data model.

- `engine/ledger.ts` — append-only, hash-chained records `{prev_hash, seq, payload}`.
  Never mutate; state is a fold over the log.
- `engine/cdp.ts` — `open` (§3.1: build the channel via `openCollateral`, hand
  the borrower `exitTxHex`, **release no loan asset until that hand-off is
  durable**), `mint`/`repay`/`accrue` (each re-commits a state via
  `commitState`, keyed by `n`; delete the previous state's `refundHex` from
  hot storage once the new one lands), `close` (§3.4). Stores
  `{owner_xonly, channel, latestState: {n, refundHex, shareSats, priceLiqUsdCents}}`.
- `engine/fees.ts` — global fee index accrued per block at 2% APR; per-CDP debt is
  `principal * (globalIndex / cdpIndex)`. Standard index accounting — do not accrue
  per-position. A debt change past the `commitState` re-commit threshold
  (§3.5: `|Δdebt| > 0.5%`) triggers a fresh state.
- `engine/anchor.ts` — periodically broadcast the ledger state root to the Tachi
  ledger so history is tamper-evident
- Mint fee 0.1%; enforce min CR 150% on mint and on withdrawal
- satUSD balances keyed to the owner's Schnorr x-only pubkey — same identity as the
  VTXO `owner` field, so there is one identity across the whole system
- Fastify routes (extends `musig-server.ts`'s app) + typed client for the web app

**Exit criteria:** open → mint → repay → close round-trips over the real HTTP
MuSig2 exchange, and BTC returns to the borrower's own wallet.

## Phase 4 — Risk: oracle, liquidation, keeper

Liquidation is real (Phase 2b), not soft — this phase is the trigger logic
around `broadcastLiquidation`, not a delinquency flag.

- `tachi-kit/oracle.ts` — BTC/USD, signed and timestamped, **with a staleness guard**
  that halts minting when the feed is stale. A manual override is required for the
  demo price drop; keep it behind an explicit dev flag.
- `engine/liquidation.ts` — deterministic. `LTV > LLTV` (130%) → broadcast the
  CDP's latest held `refundHex` (`broadcastLiquidation`). The txid is the
  receipt. No judgment call, nothing AI-adjacent gets near this path.
- `engine/keeper.ts` — standalone bot, exactly like a third party would run
  it: watches oracle prices, and when a CDP crosses the threshold, calls
  `broadcastLiquidation` with the hex the engine already published for that
  CDP (see the `/reserves` "liquidation txid-to-be" line in Phase 6). No
  privileged access — anyone with the hex can do this; the bot is a
  convenience, not a permission.
- `tachi-kit/events.ts` — `watchVault({vault})` for live position updates
  instead of polling.
- `scripts/demo-liquidate.ts` — scripted price drop through the 130% band;
  asserts the held refund broadcasts and mines, and the protocol's share
  matches `shareForLiquidation`'s prediction.

**Exit criteria:** `pnpm demo:liquidate` closes an underwater position end to
end, with a real Bitcoin txid, no borrower cooperation required at broadcast time.

## Phase 5 — Web app

Next.js 15 App Router + Tailwind + shadcn/ui.

1. **Dashboard** — total BTC locked, satUSD supply, global CR, BTC price
2. **Mint** — deposit slider with live LTV / liquidation-price preview
3. **My position** — health gauge, accrued fee, add collateral / repay / redeem
4. **Liquidations** — live at-risk positions, each with its **liquidation
   txid-to-be** (the hash of the held refund that fires if it crosses 130%),
   and a keeper view showing the actual broadcast once it happens

**Every money number links to a HAT/RIP proof or a Bitcoin txid.** No exceptions —
this is what "verifiable" means to a judge, and it is checked on stage.

## Phase 6 — Proof of reserves

The differentiator. Make it excellent.

- `tachi-kit/proofs.ts` — `getTransaction(hash, {hat, rip})` → typed receipt objects
- `tachi-kit/reserves.ts` — sum vault BTC balances (bitcoind `scantxoutset`, same
  as `collateral.ts`) vs issued liabilities
- `/reserves` page: every protocol vault P2TR address with its live Bitcoin balance
  (via the bitcoind proxy), total vault sats vs satUSD supply, live global CR,
  per-mint HAT proof + anchoring RIP with txids
- **"Verify it yourself"** — a client-side recomputation from public RPC only, with
  **zero calls to our server**. This is the whole point; do not shortcut it by
  proxying through the engine.
- Downloadable JSON attestation
- `scripts/verify-reserves.ts` — the same computation in CI, asserting it matches the UI

## Phase 7 — The unilateral exit ⭐ — largely DONE (Phase 2b)

**`scripts/05-spike-exit-presigned.ts` already proves the mechanism end to
end** — this phase is turning that into the actual demo script and wiring it
to a real CDP opened through the engine, not just the spike's synthetic channel.

- `scripts/unilateral-exit.ts` (production demo version of spike 05):
  1. Open a real CDP through the engine (borrower gets `exitTxHex` before any
     satUSD is minted, per `commitment.ts`'s contract)
  2. Mint, and optionally commit a state or two, so the demo isn't trivial
  3. **Stop the engine service entirely** — simulate total protocol failure
  4. Print the exit leaf's CSV term and `describeTapscript(exitLeaf.script)`
     for the audience — note the owner key is the MuSig2 aggregate, and say so
  5. Mine past the term
  6. Broadcast the borrower's already-held `exitTxHex` — **no engine, no
     protocol cooperation, no signing at this point, just broadcasting bytes
     signed once at open**
  7. Assert the BTC lands in the borrower's own wallet

**Exit criteria:** it passes with the engine process (and the borrower's HTTP
responder) both killed before step 6. If it needs either running at that
point, the guarantee isn't real and the claim must be withdrawn.

## Phase 8 — Ship

- README with the honest architecture section (already drafted)
- Demo video following [`DEMO.md`](DEMO.md)
- `TACHI_NETWORK=signet` boot check against `tachi-signet-1`
- Submission writeup: what was proven, what was faked (nothing), what is next

---

## Testing

| Command | Scope |
|---|---|
| `pnpm test` | Pure math: `health.ts` (incl. `shareForLiquidation`), `musig.ts` signature verification, fee index. No network. |
| `pnpm spike` | Live regtest: vault, deposit, bitcoind-verified balance |
| `scripts/03` – `scripts/06` | Live regtest: refund cosign, MuSig2 vault, promoted modules, real HTTP exchange — see Phase 2b |
| `pnpm demo:liquidate` | Price drop → held refund broadcasts → protocol whole |
| `pnpm demo:exit` | Engine + borrower responder both stopped → term mined → borrower alone broadcasts pre-signed `exit_tx` |
| `pnpm verify:reserves` | Reserves recomputed from public RPC only |

Manual: full mint → redeem in the browser, then `TACHI_NETWORK=signet` and confirm
the app boots against `tachi-signet-1`.

---

## Risks

| Risk | Mitigation |
|---|---|
| SDKs are v0.x, thinly documented | Phase 1 is a pure spike before any product code. Pin exact versions. |
| Hosted regtest has no bitcoind (404) | Run `bitcoind -regtest` locally. Already in bootstrap. |
| Ledger-level VTXO locking doesn't work via the public API — **confirmed in Phase 2**, not a blocker | Not needed. Custody is the MuSig2 owner key + pre-signed exit/refund (Phase 2b); `bitcoind`-verified balance is a proof-of-reserves cross-check only. |
| Cooperative leaf needs 5-of-7 validators for refund cosigning | **Not a risk — verified working**, repeatedly, across scripts/03–06. `checkQuorum()` is a pre-flight, not a fallback trigger. |
| Nonce collisions under concurrency | Serialize per-account nonces in the engine — already done in `vtxo.ts`'s per-pubkey queue, reused by `commitment.ts`. |
| `openCollateral`'s two-round MuSig2 exchange over HTTP adds real latency/failure modes (nonce round then partial-sig round, twice — once for the deposit-registration sig, once for the vault-open sig, once for the exit-tx sig, once per `commitState`) | `scripts/06-spike-http-musig.ts` exercises this live over real loopback HTTP; keep the borrower responder's polling interval short for the demo, and treat a stalled exchange as a hard error, not a silent retry — a half-open session shouldn't ever leave the borrower without their `exitTxHex`. |
| A CDP's `n` (state number) bookkeeping goes wrong — commits reordered, hot storage not pruned | The daemon enforces nothing here (Phase 2b's SUPERSEDED note) — Bitcoin's own double-spend rule is the only real backstop. Engine must track `n` monotonically per channel and delete superseded `refundHex` on every successful `commitState`; test this directly, don't just trust the happy path. |
| Judges expect on-chain contracts | Lead with the honest architecture section: no EVM, but a real 2-of-2 co-signed vault with enforceable liquidation and a genuine unconditional exit — the exit demo, with the engine actually killed on stage. |
