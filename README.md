# satUSD

**A BTC-backed stable asset on Tachi. Lock native Bitcoin in a TAURUS vault, mint
satUSD against it, redeem it back — over-collateralized, self-custodial, and provably
reserved on Bitcoin L1.**

> OP_Freedom Hackathon · Institutional Bitcoin track · Bounty #2

No wrapped BTC. No bridge. No custodian. Your collateral is a Taproot output on
Bitcoin that **you can always sweep with your own key alone** — even if this
protocol disappears entirely.

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
P2TR TAURUS vault    ───────► HAT proof per tx    ─────► CDP record      ────► Mint / Redeem
  coop 5-of-7 leaf            RIP anchored to L1         LTV + liq price       Position health
  exit CSV 1008 blocks        (balance read via          satUSD balance        Proof-of-reserves
                                bitcoind, not the        delinquency tracking  Delinquency feed
                                ledger's locked flag)
```

- **Custody is on Bitcoin.** A P2TR address with a NUMS-disabled key path and a
  two-leaf tap tree: a cooperative 5-of-7 validator leaf for instant settlement, and
  an exit leaf spendable by your key alone after 1008 blocks.
- **Collateral is verified directly against Bitcoin**, not the Tachi ledger's VTXO
  `locked` flag. We found live (see [`docs/BACKGROUND.md`](docs/BACKGROUND.md)) that
  ledger-level VTXO transfers need cooperative-leaf validator signatures the public
  API has no documented way to collect — so the engine reads each vault's real BTC
  balance via `bitcoind` instead, the same way Phase 1's spike verifies a deposit.
  No dependency on validator-quorum liveness for something as basic as "is the
  collateral there."
- **Protocol logic runs off-chain**, deterministically, in an append-only hash-chained
  ledger whose state roots are broadcast to the Tachi ledger — tamper-evident history.
- **satUSD is a protocol-issued balance**, keyed to your Schnorr x-only pubkey (the
  same identity as the VTXO `owner` field), transferable by signed transfer. It is
  **not** a native token, because Tachi has no asset-issuance primitive. We say so
  rather than pretending otherwise.

What we can prove that a wrapped-BTC stablecoin cannot: **kill the protocol and the
user still gets their Bitcoin back.** That is the demo.

---

## Mechanics

| Parameter | Value |
|---|---|
| Minimum collateral ratio | 150% |
| Delinquency threshold | < 130% |
| Delinquent stability fee | 8% APR (escalated) |
| Mint fee | 0.1% |
| Base stability fee | 2% APR, accrued per block |

- **Mint** — deposit BTC → your own CDP vault → engine confirms the balance via
  `bitcoind` and issues satUSD, recording `{vaultAddress, principal, feeIndex,
  hatProof}`.
- **Redeem** — burn satUSD + accrued fee → sweep your own vault via the exit leaf
  (works unconditionally, no quorum) → BTC returns to your own wallet. Fast
  cooperative redemption is attempted opportunistically when the validator quorum
  is live, but is never required.
- **Liquidation is soft, by design, not by omission.** TAURUS vaults require the
  owner's own signature on every spending path — cooperative *or* exit — with no
  exception. That is the self-custody guarantee this whole project is built on, and
  it means **no third party, including us, can ever move your BTC without your
  signature.** So there is no seizure mechanism: it would require exactly the kind
  of programmable, non-owner custody Tachi does not have (see
  [`docs/BACKGROUND.md`](docs/BACKGROUND.md)). Below 130% CR, a CDP is marked
  **delinquent**: new mints against it are blocked and its stability fee escalates.
  It stays delinquent — visible, not hidden — until the borrower repays. If they
  never do, it is real bad debt, reported plainly on `/reserves`. A keeper bot
  watches prices and flags delinquent CDPs using only the public API, same as
  everyone else — it has no special power because none exists to grant it.
- **Peg defense** is arbitrage, not force. If satUSD trades under $1, existing
  borrowers are incentivized to buy it cheap and repay their own debt for more BTC
  value than they spent. If it trades over $1, new borrowers are incentivized to
  mint and sell. Both directions work on each borrower's own collateral, by their
  own choice — nothing here ever touches collateral that isn't the actor's own.

## Proof of reserves

The `/reserves` page is the centerpiece, and it is designed so that **you do not have
to trust our server**:

- every protocol vault P2TR address with its live Bitcoin balance, read through the
  bitcoind proxy
- total vault BTC sats (verified via `bitcoind`) vs total satUSD issued → live
  global collateral ratio
- per-mint HAT proof and the RIP anchoring it to Bitcoin L1, each with its txid
- a **"verify it yourself"** button that re-derives the entire figure client-side from
  public RPC only
- a downloadable JSON attestation

---

## Quick start

```bash
# Tachi's hosted regtest has no bitcoind attached — run one locally
bitcoind -regtest -daemon -rpcuser=tachi -rpcpassword=tachi \
  -rpcport=18443 -fallbackfee=0.0001 -txindex=1

pnpm install
pnpm bootstrap        # create wallet, mine 101 blocks, fund the demo mnemonic
pnpm spike            # prove vault + deposit against live regtest
pnpm spike:collateral # prove bitcoind-verified collateral tracking
pnpm dev              # engine + web app
```

| Command | What it does |
|---|---|
| `pnpm test` | Vitest over the pure risk math — no network |
| `pnpm spike` | Creates a vault, deposits, transfers a VTXO, prints txid + HAT proof |
| `pnpm demo:liquidate` | Scripted price drop → CDP marked delinquent, fee escalates, mint blocked |
| `pnpm demo:exit` | **Engine stopped**, mine 1008 blocks, user sweeps their own BTC |
| `pnpm verify:reserves` | Recomputes proof-of-reserves from public RPC only |

Flip to signet with `TACHI_NETWORK=signet`. Signet gives judges independently
verifiable reserves; regtest gives you mineable blocks for the delinquency and exit
demos. **Demo on regtest, prove on signet.**

---

## Docs

| Doc | Contents |
|---|---|
| [`docs/AGENT-BRIEF.md`](docs/AGENT-BRIEF.md) | **Start here.** Orientation for whoever picks this up |
| [`docs/BACKGROUND.md`](docs/BACKGROUND.md) | Tachi research, verified live-infra probes, open questions |
| [`docs/TACHI-API.md`](docs/TACHI-API.md) | SDK + RPC cheat sheet, only what's confirmed to exist |
| [`docs/PLAN.md`](docs/PLAN.md) | Phased build plan, file by file |
| [`docs/DEMO.md`](docs/DEMO.md) | The 5-minute demo script |

Sibling project: [`../kosen`](../kosen) — BTC lending market (Bounty #4).
Shared conventions: [`../SHARED-CONTEXT.md`](../SHARED-CONTEXT.md).
