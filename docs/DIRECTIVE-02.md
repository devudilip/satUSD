# Directive 02 — satUSD (2026-09-01)

Supersedes `AGENT-BRIEF.md` where they conflict. Read `COLLATERAL-MODEL.md` first.

## What you built — reviewed

Checked in your worktree `claude/doc-analysis-planning-1a5f22`:

**Good — keep all of it**
- `tachi-kit/net.ts`, `vault.ts`, `vtxo.ts` (nonce serializer is right), `health.ts` + 20 passing tests, typecheck clean.
- `scripts/00`, `01`, `02` — real spikes against live regtest; `-txindex=1` and `feeSats: 10n` discoveries.
- `docs/TACHI-TEAM-QUESTIONS.md` — the best artifact in either repo. Send it.
- Honest, evidence-tagged edits to `BACKGROUND.md`.

**Wrong — revert the pivot**
- You concluded "no forced liquidation is possible, by design" and pivoted the
  product to soft liquidation + bitcoind-only collateral tracking. **The cosign
  path works.** You were one step short: the daemon's 400 was *"no vault opened
  for the funding outpoint"* — `registerVault` (a `TxVaultOpen`) must precede
  `cosignRefund`. With that, 5-of-7 partials come back and the refund mines.
  Proof: `scripts/03-spike-refund-cosign.ts` (added to your worktree). Run it:
  `SPIKE_KEY_INDEX=20 npx tsx scripts/03-spike-refund-cosign.ts`.
- Your `finalizeVtxoPsbt` failure was real, but the conclusion "cooperative leaf
  is unusable" was too broad: **transfers** have no cosign route; **refunds** do.
  Every L1-settling spend in this product is a refund.
- Your deeper point ("the vault owner can always move funds") is correct and is
  *why the owner key must be a MuSig2 joint key* — see `COLLATERAL-MODEL.md` §1–§3.
  `TACHI-TEAM-QUESTIONS.md` #2 and #3 are now answered; #4/#5 stand; add
  "is a MuSig2 aggregate accepted as the owner key?" as #7.

**Housekeeping**
- Nothing is committed on your branch. Commit now (`git add -A && git commit`),
  then commit per phase.

## Next tasks, in order

1. **Commit.** Then run spike 03 yourself and read its output.
2. **Spike 04 — joint-key vault** (`scripts/04-spike-musig-vault.ts`), per
   `COLLATERAL-MODEL.md` §3.1 + §4. `pnpm add @scure/btc-signer@2.4.1`. Two
   in-process keypairs (borrower, protocol) are fine for the spike; the interactive
   exchange comes in step 4. Acceptance: `registerVault` committed with `P_agg`;
   `exit_tx` pre-signed and `testmempoolaccept` allows it after mining `csvBlocks`
   (use `csvBlocks: 144`); `cosignRefund` → 5 partials; refund mined.
   **If the daemon rejects `P_agg`** (unexpected): Track A + explicit disclosure. Do not stall.
3. **tachi-kit `commitment.ts` + `musig.ts`** exactly with the §6 signatures — kosen
   vendors these names. `collateral.ts`: keep `getVaultBalanceSats` (proof-of-reserves
   read) and `checkQuorum`; delete the module comment claiming the cooperative path
   is unusable. `events.ts`: `subscribeVaultEvents({ vault })` → breach/spend events.
4. **MuSig2 exchange over HTTP**: engine exposes `POST /musig/nonce` and
   `/musig/partial`; the borrower side is a CLI first (`scripts/borrower.ts`), web later.
5. **Engine** (`packages/engine`): CDP = collateral channel. `open` (§3.1) → mint only
   after the borrower holds `exit_tx`; `mint`/`repay`/`accrue` → `commitState`;
   `liquidate` = broadcast latest refund (keeper bot uses only the public API);
   `redeem`/`close` (§3.4). Append-only hash-chained ledger; anchor state roots to
   the Tachi ledger (`buildTachiTxDeposit`-style envelope or a VTXO transfer memo — pick
   whatever commits; document it).
6. **Docs**: in `BACKGROUND.md` replace the "no forced liquidation" section with a
   pointer to `COLLATERAL-MODEL.md`; in `README.md` restore real liquidation in
   Mechanics; keep the honest-architecture statement.
7. **Demos** (`DEMO.md`): the closer is now "kill the engine → borrower broadcasts
   the pre-signed `exit_tx` after 144 blocks → BTC at their address." Liquidation demo
   = price drop → keeper broadcasts `refund_n` → txid on screen. Proof-of-reserves
   page: every CDP shows its vault address, L1 balance, current `n`, and the
   **liquidation txid-to-be** (hash of `refund_n`) — borrowers can see the exact tx.
8. Tell kosen when `packages/tachi-kit/src/commitment.ts` lands. Their
   `scripts/sync-kit.sh` reads `../satusd/packages/tachi-kit` — that is the *main*
   checkout, but your work is in the worktree. Either merge your branch to `main`
   at each milestone, or they point `sync-kit.sh` at your worktree path.

## Do not

- Do not build Liquity-style redemptions against specific CDPs; peg defense is
  par redemption of *your own* CDP + arbitrage. Say so.
- Do not rely on daemon-side stale-state penalties — they are not live (§1).
- Do not let the AI (none here) or any non-deterministic path near `liquidate`.
