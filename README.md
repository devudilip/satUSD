# satUSD

**A BTC-backed stable asset on Tachi. Lock native Bitcoin in a TAURUS vault, mint
satUSD against it, redeem it back — over-collateralized, provably enforceable, and
provably reserved on Bitcoin L1.**

> OP_Freedom Hackathon · Institutional Bitcoin track · Bounty #2

No wrapped BTC. No bridge. Your collateral is a Taproot output on Bitcoin. The
protocol is a real co-signer on it, not a bystander — that's what makes
liquidation real, not a promise. And **before you ever get a loan, you're
already holding a fully signed transaction that gets every satoshi back to
you, unilaterally, once the term is up** — even if this protocol disappears
entirely.

---

## Honest architecture statement

Tachi markets **SatVM** as a multi-runtime execution environment (Script, EVM, WASM,
SVM, ABCI). As of 2026-08-31, **there is no developer-facing SatVM or EVM.** The
entire public developer surface is Bitcoin Taproot vaults plus the Tachi VTXO ledger.
Tachi's own tutorial states the architecture contains no smart contracts, EVM, or
SatVM. See [`docs/BACKGROUND.md`](docs/BACKGROUND.md) for the full evidence.

So satUSD is built the way the platform actually supports today:

```
Bitcoin regtest/signet        Tachi ledger              satUSD engine         Next.js app
──────────────────────        ────────────              ─────────────         ───────────
P2TR vault, MuSig2   ───────► HAT proof per tx    ─────► collateral channel───► Mint / Repay
  owner (you+us)              RIP anchored to L1         LTV + liq price       Position health
  coop leaf: quorum-          quorum cosigns             satUSD balance        Proof-of-reserves
    cosigned refund             pre-signed refunds       pre-signed exit_tx    Liquidation feed
  exit leaf: your key,          (Track B, see
    CSV term, presigned         COLLATERAL-MODEL.md)
```

- **Custody is a joint Bitcoin key, not a single one.** Each CDP is its own P2TR
  vault whose owner key is a **MuSig2 aggregate of your key and the protocol's**
  (BIP-327) — see [`docs/COLLATERAL-MODEL.md`](docs/COLLATERAL-MODEL.md). A
  cooperative leaf (quorum-cosigned) and an exit leaf (CSV timelock) both spend
  through that joint key, so neither of us can move your BTC alone — but unlike a
  single-key vault, the protocol *can* enforce a pre-agreed liquidation, because
  it's a genuine co-signer.
- **You get an unconditional exit anyway.** At open, before any loan asset is
  released, you receive a fully agg-signed `exit_tx` — spendable by broadcasting it
  alone, no protocol cooperation, once the loan term (the exit leaf's CSV delay)
  has passed. If we vanish, that's what you use. Verified live, engine process
  killed mid-flow: [`scripts/05-spike-exit-presigned.ts`](scripts/05-spike-exit-presigned.ts).
- **We get real enforcement anyway.** Every time your position's debt changes, we
  jointly sign a fresh liquidation refund (`commitState`) — quorum-cosigned, held,
  never broadcast unless you actually cross the liquidation threshold. Verified
  live: [`scripts/03-spike-refund-cosign.ts`](scripts/03-spike-refund-cosign.ts).
- **Collateral is also verified directly against Bitcoin**, independent of any of
  the above, via `bitcoind` `scantxoutset` — a second, quorum-free check for
  proof-of-reserves, never the custody mechanism itself.
- **Protocol logic runs off-chain**, deterministically, in an append-only hash-chained
  ledger whose state roots are broadcast to the Tachi ledger — tamper-evident history.
- **satUSD is a protocol-issued balance**, keyed to your Schnorr x-only pubkey,
  transferable by signed transfer. It is **not** a native token, because Tachi has
  no asset-issuance primitive. We say so rather than pretending otherwise.

What we can prove that a wrapped-BTC stablecoin cannot: **kill the protocol and the
user still gets their Bitcoin back — even though the protocol was a real co-signer
the whole time.** That is the demo.

---

## Mechanics

| Parameter | Value |
|---|---|
| Minimum collateral ratio to mint | 150% |
| Liquidation threshold (LLTV) | 130% |
| Liquidation penalty | 8% |
| Loan term (exit leaf CSV) | demo: 144 blocks (~1 day); production tiers 1008/4320 |
| Mint fee | 0.1% |
| Stability fee | 2% APR, accrued per block |

- **Open** — deposit BTC into a MuSig2 vault (you + protocol) → the borrower
  receives a fully agg-signed `exit_tx` before anything else happens → only then
  does the engine issue satUSD.
- **Borrow / repay / accrue** — every change to your debt commits a fresh
  liquidation refund (`commitState`): quorum-cosigned, split between your
  revocable remainder and the protocol's liquidation share, held and never
  broadcast unless actually triggered.
- **Liquidation is real** — cross the 130% threshold, and the held refund for
  your current state gets broadcast. Deterministic, no judgment call: anyone
  with the hex can do it, including a keeper bot using only the public API. The
  txid is the receipt, shown on `/reserves` next to your position before it
  ever happens.
- **Redeem / close** — debt at zero, commit a final state paying your full
  remaining balance back to you and broadcast it. Requires your cooperation
  (same as any state), but so does the protocol's — neither of us can close a
  channel unilaterally.
- **The unconditional fallback** — your `exit_tx`, held since open, always
  works after the CSV term, no cooperation needed, whether or not we're still
  running.
- **Peg defense** is arbitrage. If satUSD trades under $1, existing borrowers
  are incentivized to buy it cheap and repay their own debt for more BTC value
  than they spent. If it trades over $1, new borrowers are incentivized to mint
  and sell.

## Proof of reserves

The `/reserves` page is the centerpiece, and it is designed so that **you do not have
to trust our server**:

- every protocol vault P2TR address with its live Bitcoin balance, read through the
  bitcoind proxy
- total vault BTC sats (verified via `bitcoind`) vs total satUSD issued → live
  global collateral ratio
- per-mint HAT proof and the RIP anchoring it to Bitcoin L1, each with its txid
- every open position's current state number and its **liquidation txid-to-be** —
  the hash of the exact refund that fires if it crosses the threshold, visible
  before it ever happens
- a **"verify it yourself"** button that re-derives the entire figure client-side from
  public RPC only
- a downloadable JSON attestation

---

## Quick start

**Docker (simplest — one command, fresh regtest, no local bitcoind):**

```bash
docker compose up --build
```

Runs bitcoind (regtest) and the engine together, bootstraps a funded wallet,
then runs [`pnpm demo`](#the-whole-story-one-run) — open a CDP, mint, real
liquidation, kill the engine, borrower exits alone. While it's running, open
**http://localhost:4110** to watch the live dashboard update through each
step. Verified from a completely fresh chain, no local state required.

**Local (for iterating on individual pieces):**

```bash
# Tachi's hosted regtest has no bitcoind attached — run one locally
bitcoind -regtest -daemon -rpcuser=tachi -rpcpassword=tachi \
  -rpcport=18443 -fallbackfee=0.0001 -txindex=1

pnpm install
pnpm bootstrap        # create wallet, mature its coinbases, fund the demo mnemonic
pnpm spike            # prove vault + deposit against live regtest
pnpm spike:collateral # prove bitcoind-verified collateral tracking
pnpm demo             # the whole story — see below
```

### The whole story, one run

`pnpm demo` ([`scripts/full-demo.ts`](scripts/full-demo.ts)) walks every beat
in [`docs/DEMO.md`](docs/DEMO.md) in sequence, printing real regtest artifacts
at each step — nothing mocked, nothing precomputed:

open a CDP (borrower gets `exit_tx` before anything else) → mint → a
proof-of-reserves JSON snapshot with the **liquidation txid-to-be**, announced
before any price move → crash the price → a keeper bot using nothing but the
public API actually liquidates it, and the broadcast txid is asserted to
match what was announced → a second CDP → **kill the engine entirely** → its
borrower alone broadcasts the pre-signed `exit_tx`, no cooperation possible.

While it runs, open **http://localhost:4110** (or whatever port you set) for
the live dashboard — same-origin static page served by the engine itself, no
build step, polling `GET /cdp` every 1.5s. It turns red and says so plainly
once the engine is killed, which is the correct behavior for that step, not a bug.

| Command | What it does |
|---|---|
| `pnpm test` | Vitest over the pure risk math — no network |
| `pnpm spike` | Creates a vault, deposits, prints txid + HAT proof |
| `pnpm spike:collateral` | Confirms bitcoind-verified collateral tracking |
| `npx tsx scripts/03-spike-refund-cosign.ts` | Registers a vault, cosigns a quorum-backed refund, mines it |
| `npx tsx scripts/04-spike-musig-vault.ts` | MuSig2 owner key, pre-signed exit tx, cosigned refund — Track B end to end |
| `npx tsx scripts/06-spike-http-musig.ts` | Same, but the MuSig2 exchange runs over real HTTP (`scripts/borrower.ts`) |
| `pnpm demo` | The whole story in one run, with the live dashboard — see above |
| `pnpm demo:liquidate` | Just the liquidation beat, standalone |
| `pnpm demo:exit` | Just the exit beat — **engine and borrower responder both stopped**, standalone |
| `pnpm verify:reserves` | Recomputes proof-of-reserves from public RPC only |

Flip to signet with `TACHI_NETWORK=signet`. Signet gives judges independently
verifiable reserves; regtest gives you mineable blocks for the liquidation and exit
demos. **Demo on regtest, prove on signet.**

---

## Docs

| Doc | Contents |
|---|---|
| [`docs/AGENT-BRIEF.md`](docs/AGENT-BRIEF.md) | **Start here.** Orientation for whoever picks this up |
| [`docs/BACKGROUND.md`](docs/BACKGROUND.md) | Tachi research, verified live-infra probes, open questions |
| [`docs/COLLATERAL-MODEL.md`](docs/COLLATERAL-MODEL.md) | The Track B design: MuSig2 joint vaults, pre-signed exit + liquidation |
| [`docs/TACHI-API.md`](docs/TACHI-API.md) | SDK + RPC cheat sheet, only what's confirmed to exist |
| [`docs/PLAN.md`](docs/PLAN.md) | Phased build plan, file by file |
| [`docs/DEMO.md`](docs/DEMO.md) | The 5-minute demo script |
| [`docs/TACHI-TEAM-QUESTIONS.md`](docs/TACHI-TEAM-QUESTIONS.md) | Open questions for the Tachi team |
| [`docs/SUBMISSION.md`](docs/SUBMISSION.md) | What was proven, what was faked (nothing), what's next |

Sibling project: [`../kosen`](../kosen) — BTC lending market (Bounty #4).
Shared conventions: [`../SHARED-CONTEXT.md`](../SHARED-CONTEXT.md).
