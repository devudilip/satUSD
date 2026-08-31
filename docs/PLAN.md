# satUSD — Build Plan

**Prerequisite:** read [`BACKGROUND.md`](BACKGROUND.md) first. It contains the
architecture-defining finding (no SatVM/EVM) and every verified fact about Tachi's
live infrastructure.

## Guiding principle

**Build the ending first.** Phase 7 — killing the engine and having a user sweep
their own BTC via the 1008-block exit leaf — is the moment that wins this bounty.
Everything else is table stakes. If a phase slips, cut features, never cut Phase 7.

---

## Repo layout

```
satusd/
  packages/
    tachi-kit/          # shared Tachi/Bitcoin layer — ALSO vendored into ../kosen
      src/{net,vault,vtxo,collateral,oracle,proofs,reserves,events,health}.ts
      test/health.test.ts
    engine/             # Fastify service: CDP ledger, mint/redeem, liquidation
      src/{server,cdp,ledger,fees,liquidation,keeper,anchor}.ts
    web/                # Next.js 15 App Router
      app/{page,mint,position,reserves,liquidations}/
  scripts/
    00-bootstrap-regtest.ts
    01-spike-vault.ts
    unilateral-exit.ts
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

## Phase 2 — VTXO movement + the collateral primitive

- `tachi-kit/vtxo.ts` — the canonical 7-call sequence from `BACKGROUND.md` §7, as
  one function. **Includes nonce management** — nonces are sequential per account and
  concurrent operations will collide without a serializer.
- `tachi-kit/collateral.ts` — `lock()`, `unlock()`, `seize()`; read side via
  `getLockedVtxos(vault)`
- **Resolve OPEN QUESTION #2 here.** Does `locked` permit *third-party* escrow, or
  only self-locking? Write a test that attempts to lock a VTXO the protocol does not
  own. If it fails, switch to the fallback: collateral is a VTXO sent to a 2-of-2
  protocol/user TAURUS vault. Same guarantees, more PSBT plumbing, ~1 extra day.
- `tachi-kit/health.ts` — pure LTV / collateral-ratio / liquidation-price math.
  **No network calls.** This is the most heavily tested file in the repo; both
  products' risk logic sits on it.
- `test/health.test.ts` — boundary cases: exactly 150%, exactly 130%, zero debt,
  dust collateral, price = 0, integer/rounding safety (use bigint sats throughout)

**Exit criteria:** a VTXO locked and unlocked on the live ledger; `pnpm test` green.

## Phase 3 — Engine: CDPs, mint, redeem

- `engine/ledger.ts` — append-only, hash-chained records `{prev_hash, seq, payload}`.
  Never mutate; state is a fold over the log.
- `engine/cdp.ts` — open, add collateral, mint, repay, redeem, close. Stores
  `{owner_xonly, vtxoIds, principal, feeIndex, hatProof}`.
- `engine/fees.ts` — global fee index accrued per block at 2% APR; per-CDP debt is
  `principal * (globalIndex / cdpIndex)`. Standard index accounting — do not accrue
  per-position.
- `engine/anchor.ts` — periodically broadcast the ledger state root to the Tachi
  ledger so history is tamper-evident
- Mint fee 0.1%; enforce min CR 150% on mint and on withdrawal
- satUSD balances keyed to the owner's Schnorr x-only pubkey — same identity as the
  VTXO `owner` field, so there is one identity across the whole system
- Fastify routes + typed client for the web app

**Exit criteria:** mint → redeem round-trips, and BTC returns to the user's vault.

## Phase 4 — Risk: oracle, liquidation, keeper

- `tachi-kit/oracle.ts` — BTC/USD, signed and timestamped, **with a staleness guard**
  that halts minting when the feed is stale. A manual override is required for the
  demo price drop; keep it behind an explicit dev flag.
- `engine/liquidation.ts` — deterministic. Below 130%, auction the locked VTXOs;
  keeper pays satUSD, receives BTC at an 8% discount, surplus returns to the borrower.
- `engine/keeper.ts` — standalone bot, exactly like a third party would run it. Do not
  privilege it with internal access; it uses the public API. That is the point.
- `tachi-kit/events.ts` — `tachi.watch({vault})` for live position updates instead of
  polling
- `scripts/demo-liquidate.ts` — scripted price drop through the band; asserts the
  position closes and the protocol is whole

**Exit criteria:** `pnpm demo:liquidate` closes an underwater position end to end.

## Phase 5 — Web app

Next.js 15 App Router + Tailwind + shadcn/ui.

1. **Dashboard** — total BTC locked, satUSD supply, global CR, BTC price
2. **Mint** — deposit slider with live LTV / liquidation-price preview
3. **My position** — health gauge, accrued fee, add collateral / repay / redeem
4. **Liquidations** — live at-risk positions, auction feed, keeper view

**Every money number links to a HAT/RIP proof or a Bitcoin txid.** No exceptions —
this is what "verifiable" means to a judge, and it is checked on stage.

## Phase 6 — Proof of reserves

The differentiator. Make it excellent.

- `tachi-kit/proofs.ts` — `getTransaction(hash, {hat, rip})` → typed receipt objects
- `tachi-kit/reserves.ts` — sum locked VTXOs vs issued liabilities
- `/reserves` page: every protocol vault P2TR address with its live Bitcoin balance
  (via the bitcoind proxy), total locked sats vs satUSD supply, live global CR,
  per-mint HAT proof + anchoring RIP with txids
- **"Verify it yourself"** — a client-side recomputation from public RPC only, with
  **zero calls to our server**. This is the whole point; do not shortcut it by
  proxying through the engine.
- Downloadable JSON attestation
- `scripts/verify-reserves.ts` — the same computation in CI, asserting it matches the UI

## Phase 7 — The unilateral exit ⭐

**Build a first draft of this in Phase 2 and keep it working.** It is the demo.

- `scripts/unilateral-exit.ts`:
  1. **Stop the engine service entirely** — simulate total protocol failure
  2. Print `exitLeaf.csvBlocks` (1008) and assert
     `exitLeaf.userKey.equals(vault.userKey.xOnly)` — *it is the user's own key*
  3. `describeTapscript(exitLeaf.script)` for the audience
  4. Mine 1008 blocks
  5. Sweep the vault using the exit leaf, **with the user's key alone**
  6. Assert the BTC lands in the user's own P2WPKH wallet

**Exit criteria:** it passes with the engine process killed. If it needs the engine
running, self-custody is not real and the claim must be withdrawn.

## Phase 8 — Ship

- README with the honest architecture section (already drafted)
- Demo video following [`DEMO.md`](DEMO.md)
- `TACHI_NETWORK=signet` boot check against `tachi-signet-1`
- Submission writeup: what was proven, what was faked (nothing), what is next

---

## Testing

| Command | Scope |
|---|---|
| `pnpm test` | Pure math: `health.ts`, fee index, liquidation triggers. No network. |
| `pnpm spike` | Live regtest: vault, deposit, VTXO transfer, HAT proof |
| `pnpm demo:liquidate` | Price drop → liquidation → protocol whole |
| `pnpm demo:exit` | Engine stopped → 1008 blocks → user sweeps own BTC |
| `pnpm verify:reserves` | Reserves recomputed from public RPC only |

Manual: full mint → redeem in the browser, then `TACHI_NETWORK=signet` and confirm
the app boots against `tachi-signet-1`.

---

## Risks

| Risk | Mitigation |
|---|---|
| SDKs are v0.x, thinly documented | Phase 1 is a pure spike before any product code. Pin exact versions. |
| Hosted regtest has no bitcoind (404) | Run `bitcoind -regtest` locally. Already in bootstrap. |
| Third-party VTXO locking may not be supported | Phase 2 resolves it. Fallback: 2-of-2 protocol/user vault, ~1 extra day. |
| Cooperative leaf needs 5-of-7 validators; `/health` reports `validators: 1` | Check `getLiveValidators()` at startup and degrade loudly. The exit path always works. |
| Nonce collisions under concurrency | Serialize per-account nonces in the engine from Phase 2. |
| Judges expect on-chain contracts | Lead with the honest architecture section and the exit demo. |
