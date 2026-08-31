# satUSD

**A BTC-backed stable asset on Tachi. Lock native Bitcoin in a TAURUS vault, mint
satUSD against it, redeem it back — over-collateralized, liquidatable, and provably
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
P2TR TAURUS vault    ───────► VTXO (locked=true) ─────► CDP record      ────► Mint / Redeem
  coop 5-of-7 leaf            HAT proof per tx          LTV + liq price       Position health
  exit CSV 1008 blocks        RIP anchored to L1        satUSD balance        Proof-of-reserves
                                                        liquidation engine    Liquidation feed
```

- **Custody is on Bitcoin.** A P2TR address with a NUMS-disabled key path and a
  two-leaf tap tree: a cooperative 5-of-7 validator leaf for instant settlement, and
  an exit leaf spendable by your key alone after 1008 blocks.
- **Settlement is on the Tachi ledger.** Collateral is VTXOs with `locked: true`.
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
| Liquidation threshold | < 130% |
| Liquidation penalty | 8% |
| Mint fee | 0.1% |
| Stability fee | 2% APR, accrued per block |

- **Mint** — deposit BTC → TAURUS vault → VTXOs locked to the protocol vault →
  engine issues satUSD and records `{vtxoIds, principal, feeIndex, hatProof}`.
- **Redeem** — burn satUSD + accrued fee → engine releases exactly the VTXOs backing
  it → you co-sign the release PSBT → BTC returns to your own vault.
- **Liquidation** — below 130%, the locked VTXOs are auctioned to keepers. The keeper
  pays satUSD, receives BTC at a discount, surplus returns to the borrower.
- **Peg defense** — redemption at par against the healthiest CDPs (Liquity-style).
  That, not a promise, is what holds $1: arbitrageurs enforce it.

## Proof of reserves

The `/reserves` page is the centerpiece, and it is designed so that **you do not have
to trust our server**:

- every protocol vault P2TR address with its live Bitcoin balance, read through the
  bitcoind proxy
- total locked VTXO sats vs total satUSD issued → live global collateral ratio
- per-mint HAT proof and the RIP anchoring it to Bitcoin L1, each with its txid
- a **"verify it yourself"** button that re-derives the entire figure client-side from
  public RPC only
- a downloadable JSON attestation

---

## Quick start

```bash
# Tachi's hosted regtest has no bitcoind attached — run one locally
bitcoind -regtest -daemon -rpcuser=tachi -rpcpassword=tachi \
  -rpcport=18443 -fallbackfee=0.0001

pnpm install
pnpm bootstrap        # create wallet, mine 101 blocks, fund the demo mnemonic
pnpm spike            # prove vault + deposit + VTXO transfer against live regtest
pnpm dev              # engine + web app
```

| Command | What it does |
|---|---|
| `pnpm test` | Vitest over the pure risk math — no network |
| `pnpm spike` | Creates a vault, deposits, transfers a VTXO, prints txid + HAT proof |
| `pnpm demo:liquidate` | Scripted price drop through the liquidation band |
| `pnpm demo:exit` | **Engine stopped**, mine 1008 blocks, user sweeps their own BTC |
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
| [`docs/TACHI-API.md`](docs/TACHI-API.md) | SDK + RPC cheat sheet, only what's confirmed to exist |
| [`docs/PLAN.md`](docs/PLAN.md) | Phased build plan, file by file |
| [`docs/DEMO.md`](docs/DEMO.md) | The 5-minute demo script |

Sibling project: [`../kosen`](../kosen) — BTC lending market (Bounty #4).
Shared conventions: [`../SHARED-CONTEXT.md`](../SHARED-CONTEXT.md).
