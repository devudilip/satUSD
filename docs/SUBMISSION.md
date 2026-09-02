# satUSD — Submission Writeup

OP_Freedom Hackathon · Institutional Bitcoin track · Bounty #2 (BTC-backed
stablecoin protocol)

## What this is

A BTC-backed stable asset where collateral custody is a **MuSig2 joint
Bitcoin key** (borrower + protocol) instead of a smart contract — because
Tachi has no developer-facing SatVM or EVM (verified,
[`docs/BACKGROUND.md`](BACKGROUND.md) §3). Every cooperative spend needs
both parties, which is what makes liquidation real; every borrower holds a
fully pre-signed exit transaction from the moment they open a position,
which is what makes the self-custody guarantee real too. Full design:
[`docs/COLLATERAL-MODEL.md`](COLLATERAL-MODEL.md).

## What was proven, live, against real infrastructure

Everything below ran against `rpc-regtest.tachibtc.com` (the live hosted
Tachi daemon) plus a local `bitcoind -regtest` — not mocked, not simulated.
Each line is a script in this repo you can run yourself.

| Claim | Proof |
|---|---|
| Vault creation, deposit, on-chain balance | `pnpm spike` |
| Collateral tracked independent of the Tachi ledger's validator quorum | `pnpm spike:collateral` |
| A quorum-cosigned refund broadcasts and mines | `scripts/03-spike-refund-cosign.ts` |
| A MuSig2 aggregate key works as a vault owner key (the one open question going in) | `scripts/04-spike-musig-vault.ts` |
| The promoted `tachi-kit` modules (not raw SDK calls) reproduce all of the above | `scripts/05-spike-exit-presigned.ts` |
| The MuSig2 exchange over real HTTP, not an in-process shortcut | `scripts/06-spike-http-musig.ts` + `scripts/borrower.ts` |
| The real engine: open → mint → a keeper (public API only) → real liquidation → confirmed on-chain | `pnpm demo:liquidate` |
| Engine and borrower's signer both killed → borrower alone recovers every sat | `pnpm demo:exit` |
| The liquidation txid announced at mint time exactly matches what actually broadcasts | `pnpm demo` (asserts this itself) |
| The whole story, one run, with a live dashboard | `pnpm demo`, or `docker compose up --build` from a completely fresh chain |
| Pure risk/fee/ledger math | `pnpm test` — 41 tests, `packages/tachi-kit` + `packages/engine` |

## What was faked

Nothing. Every txid printed by any script in this repo is real and checkable
against the regtest chain it ran on. Where something didn't work, it's
documented as not working — see `docs/BACKGROUND.md`'s VERIFIED/SUPERSEDED
notes for the two places an initial approach turned out wrong (plain VTXO
transfers don't cosign; a single-key vault can't secure a lender) and what
replaced each.

## What's genuinely soft or missing

- **No web UI beyond the dashboard.** `packages/engine/public/index.html` is
  a real, live, same-origin dashboard (`GET /cdp`, polled) — but there's no
  mint/repay/open flow a user could click through, no wallet integration, no
  `/reserves` page with the "verify it yourself" client-side recomputation
  described in the README. `docs/PLAN.md` Phases 5–6 were not built.
- **No live external price oracle.** `tachi-kit/oracle.ts` has the interface
  and staleness guard; `DevPriceFeed` (dev-only, explicit) is what every demo
  actually uses.
- **The MuSig2 signing shortcut.** Every demo script except `scripts/06` and
  the Docker/`pnpm demo` run keeps both the borrower's and the protocol's
  secret in one process for simplicity. The real two-process HTTP exchange
  (`musig-server.ts` + `borrower.ts`) is proven separately and is what a real
  deployment would use — `pnpm demo` under Docker *does* exercise it for the
  open/mint flow.
- **Anchoring to the Tachi ledger** (periodic ledger-state-root broadcast,
  `engine/anchor.ts`) was planned (`docs/PLAN.md` Phase 3) but not built —
  the hash-chained ledger (`engine/ledger.ts`) is real and tested, just not
  yet anchored externally.
- **Fixed-term loans, not open-ended CDPs.** The loan term equals the exit
  leaf's CSV delay (demo: 144 blocks; production tiers 1008/4320,
  `COLLATERAL-MODEL.md` §3). Rollover past term end isn't implemented.
- **Signet.** Everything above ran on regtest. `TACHI_NETWORK=signet` is
  wired into `net.ts`'s config, but the demos haven't been run against it in
  this session — regtest is what gives mineable blocks for a fast liquidation
  demo; signet is what would give judges independently checkable, non-mineable
  reserves. "Demo on regtest, prove on signet" (README) describes the intent,
  not something exercised end-to-end here.

## Two real findings for the Tachi team

Sent, with full technical detail, in [`docs/TACHI-TEAM-QUESTIONS.md`](TACHI-TEAM-QUESTIONS.md):
whether a MuSig2 aggregate owner key is an intentionally supported pattern
(nothing in the docs says either way, and the whole design depends on it),
and whether the refund state machinery's lack of monotonicity enforcement is
permanent or a gap.

## What's next, in order

1. Signet run-through — confirm the same flows work against `tachi-signet-1`
2. The web app (Phases 5–6): mint/position/reserves pages, wallet
   integration, the client-side "verify it yourself" recomputation
3. `engine/anchor.ts` — anchor ledger state roots to the Tachi ledger
4. Term rollover — cooperative refund into a fresh vault at term end
5. The oracle-gated stretch design (`COLLATERAL-MODEL.md` §5) — a
   two-leaf output that lets the protocol broadcast a liquidation claim
   *whenever it likes*, but only actually take anything with a valid
   oracle attestation; a wrongful claim just returns funds to the borrower.
   Turns "bounded trust" into "no trust."
