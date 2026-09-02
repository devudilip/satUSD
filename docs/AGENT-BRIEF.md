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
2. [`COLLATERAL-MODEL.md`](COLLATERAL-MODEL.md) — **mandatory.** The actual custody
   and liquidation design (Track B). Supersedes an earlier "soft liquidation" pivot
   that turned out to be one step short — `BACKGROUND.md` points to this where it applies.
3. [`TACHI-API.md`](TACHI-API.md) — the SDK/RPC cheat sheet. Only what is confirmed
   to exist.
4. [`PLAN.md`](PLAN.md) — phased build plan.
5. [`DEMO.md`](DEMO.md) — the demo you are building toward. Read it early; it tells
   you what actually matters.
6. [`../README.md`](../README.md) — the product framing, already written.

## The one thing to internalize

**Tachi has no developer-facing SatVM or EVM.** Do not go looking for a chain ID, a
Solidity deployment path, or an asset-issuance call — none exist, and the docs
confirm it. Protocol logic runs **off-chain and deterministically**; HAT/RIP proofs
make it verifiable.

**Custody is a MuSig2 joint key (you + protocol), not a single-key vault.** A
single-key TAURUS vault genuinely cannot secure a lender — the owner can always
cosign a refund paying themselves everything, or wait out the CSV and exit
unilaterally (`BACKGROUND.md`'s SUPERSEDED note has the full story). Making the
owner key a joint MuSig2 aggregate fixes that: real liquidation enforcement for
the protocol, and a real unconditional exit for the borrower — a fully agg-signed
`exit_tx`, handed over once at open, broadcastable by them alone after the loan
term with nobody's further cooperation. See `COLLATERAL-MODEL.md` §3 for the full
design; `scripts/03` through `scripts/06` prove every piece of it live.

Collateral is also verified directly against each vault's real Bitcoin balance
(`bitcoind scantxoutset`) as an independent, quorum-free cross-check for
proof-of-reserves — never the custody mechanism itself.

**Do not hide any of this.** The README states it plainly and that is deliberate.

## Build order, compressed

1. **Spike first.** No product code until you have created a vault, deposited BTC,
   and verified the balance via bitcoind on live regtest. The SDKs are v0.x.
2. **Build the ending early.** The pre-signed `exit_tx` from `openCollateral` —
   engine killed, loan term mined, borrower alone broadcasts it. It is the demo
   that wins the bounty. Draft it early (`scripts/05-spike-exit-presigned.ts`
   already proves the mechanism) and never let it break.
3. Then: engine (CDP = collateral channel, `commitment.ts`) → UI → proof-of-reserves.

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

(Q2, "does VTXO `locked` allow third-party escrow," was the wrong question —
see `BACKGROUND.md`. Plain ledger-level locking doesn't work via the public
API regardless of who initiates it, but the *fallback* it proposed — a 2-of-2
vault — turned out to be exactly right, just achieved as a MuSig2 owner key
rather than a transfer destination. See `COLLATERAL-MODEL.md`.)

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
