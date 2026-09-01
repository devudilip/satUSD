# Agent Brief — satUSD

You are building **satUSD**, a BTC-collateralized stable asset for the Tachi
OP_Freedom Hackathon (Institutional Bitcoin track, **Bounty #2**).

This repo is **self-contained**. A second agent is independently building
[`../kosen`](../../kosen) (Bounty #4, lending). You do not need to coordinate with them
beyond one thing: **you own `packages/tachi-kit`**, which they vendor from you. Keep
its public surface stable — see [`../../SHARED-CONTEXT.md`](../../SHARED-CONTEXT.md).

## Read in this order

1. [`BACKGROUND.md`](BACKGROUND.md) — **mandatory.** Tachi research and verified
   live-infrastructure probes. It contains the finding that dictates the architecture.
2. [`TACHI-API.md`](TACHI-API.md) — the SDK/RPC cheat sheet. Only what is confirmed
   to exist.
3. [`PLAN.md`](PLAN.md) — phased build plan.
4. [`DEMO.md`](DEMO.md) — the demo you are building toward. Read it early; it tells
   you what actually matters.
5. [`../README.md`](../README.md) — the product framing, already written.

## The one thing to internalize

**Tachi has no developer-facing SatVM or EVM.** Do not go looking for a chain ID, a
Solidity deployment path, or an asset-issuance call — none exist, and the docs
confirm it. Protocol logic runs **off-chain and deterministically**; custody stays on
Bitcoin in TAURUS Taproot vaults; collateral is verified directly against each
vault's real Bitcoin balance (`bitcoind scantxoutset`), **not** the Tachi ledger's
VTXO `locked` flag — that path needs cooperative-leaf validator signatures the
public API has no documented way to collect (see `BACKGROUND.md`). HAT/RIP proofs
make everything verifiable.

**There is also no forced liquidation, by design.** Every TAURUS vault spending
path requires the owner's own signature, unconditionally — that's what makes the
exit-leaf self-custody guarantee real, and it means nothing can seize a
borrower's BTC. Liquidation here is soft: delinquency flag, blocked mints,
escalated fee. See `BACKGROUND.md` and the README's Mechanics section.

**Do not hide any of this.** The README states it plainly and that is deliberate.

## Build order, compressed

1. **Spike first.** No product code until you have created a vault, deposited BTC,
   and verified the balance via bitcoind on live regtest. The SDKs are v0.x.
2. **Build the ending early.** `scripts/unilateral-exit.ts` — engine killed, 1008
   blocks mined, user sweeps their own BTC. It is the demo that wins the bounty.
   Draft it in Phase 2 and never let it break.
3. Then: engine → soft delinquency tracking → UI → proof-of-reserves.

## Rules

- No wrapped BTC, no bridge, no custodian. Ever.
- Every money number in the UI links to a HAT/RIP proof or a Bitcoin txid.
- Money math is `bigint` sats. No floats anywhere near a balance.
- The ledger is append-only and hash-chained; state is a fold over the log.
- The keeper bot uses only the public API — no privileged access. That is the point.
- Report honestly. If something does not work, say so in the README.

## Open question

Ask the Tachi team early: Telegram `@tachi_btc` / `team@tachibtc.com`.

**Q1 — Is there an unpublished SatVM/EVM endpoint for hackathon participants?**
If yes, stop and escalate; the architecture gets materially simpler.

(Q2, "does VTXO `locked` allow third-party escrow," was resolved as moot —
see `BACKGROUND.md`. Neither self- nor third-party ledger-level locking works
via the public API right now, so collateral tracking doesn't depend on the
answer either way.)

## First commands

```bash
bitcoind -regtest -daemon -rpcuser=tachi -rpcpassword=tachi \
  -rpcport=18443 -fallbackfee=0.0001 -txindex=1
pnpm install
pnpm bootstrap
pnpm spike        # must pass before anything else
```

## If you get stuck

- SDK behaves unexpectedly → inspect the published types in
  `node_modules/@tachibtc/*/dist/index.d.ts`. The npm packages are the real spec;
  the docs site is thinner.
- Route 404s → route names are camelCase with a `tachi_` prefix
  (`tachi_listVtxos`, not `tachi_vtxos`). See `TACHI-API.md`.
- Regtest bitcoind proxy 404s → expected. Tachi's hosted regtest has no bitcoind;
  use your local node.
- Nonce errors → nonces are sequential per account; serialize them in the engine.
