# Questions for the Tachi team

Context for whoever answers: we're building satUSD (BTC-backed stablecoin,
Bounty #2, Institutional Bitcoin track) on `tachi-sdk-ts@0.2.1` /
`taurus-vault-core@0.3.4` / `taurus-wallet-aggregator@0.4.5` against
`rpc-regtest.tachibtc.com`. Everything below came from hands-on testing
against that live daemon, not guessing from docs — most of it verified as
recently as 2026-09-02. A few questions from our first pass turned out to be
things we answered ourselves (kept at the bottom, resolved, for context) —
these are the ones still open.

## 1. Is there an unpublished SatVM/EVM endpoint for hackathon participants?

We read every page of docs.tachibtc.com and the full public SDK surface — no
mention of EVM, SatVM, contract deployment, or asset issuance anywhere. Just
confirming there's nothing unpublished/gated we're missing, since it would
materially simplify our architecture if it exists.

## 2. Is a MuSig2 aggregate key an intended/supported way to use a vault owner key?

We built a vault with `createVault({ userPubkey: P_agg })` where `P_agg` is a
BIP-327 MuSig2 aggregate of two individual keys (borrower + our protocol),
instead of a single wallet-derived key. It works end to end — `registerVault`,
`cosignRefund`, and a pre-signed unilateral exit all succeed against the live
daemon (`scripts/04-spike-musig-vault.ts`). Nothing in the docs or SDK
mentions this as a supported pattern one way or the other. Is it deliberately
supported (any gotchas to know about — daemon-side quorum re-derivation,
mainnet acceptance, anything checked beyond "is this 33 bytes and does it
verify"), or did we get lucky that the daemon doesn't distinguish an
aggregate key from any other compressed pubkey? We're building real product
logic on this working, so we'd like to know if it's load-bearing on purpose.

## 3. Is the lack of refund state-number enforcement intentional or a gap?

The refund/`to_local` commitment machinery has state numbers
(`encodeStateHint`/`decodeStateHint`) that look designed for monotonic,
BOLT-3-style ordering with stale-state penalties. Live testing shows the
daemon cosigns *any* refund state, any split, any number of times, in any
order — `latestStateNum` in `listVaults` stays `0` regardless
(`scripts/03-spike-refund-cosign.ts`). We're relying on Bitcoin's own
double-spend rule as the only real backstop (only one state can ever
confirm), not on daemon-side staleness enforcement. Is monotonicity
enforcement planned, or is "the client is responsible for only ever holding
the latest state" the intended model permanently?

## 4. How do we get cooperative-leaf signatures for a plain VTXO transfer?

Resolved for our purposes (we use the refund path instead — see #2 above)
but still an open question about the platform: `buildVtxoPsbt` →
`verifyVtxoPsbt` → `signVtxoPsbtAsUser` → `finalizeVtxoPsbt` throws `input[0]
has 0 valid node signatures on the cooperative leaf, needs at least 5` — no
step anywhere in the documented flow collects the quorum's partials for a
plain (non-refund) transfer. Is this only reachable via the `tachi/vault/v1`
libp2p gossip topic, or is there a REST equivalent we're missing?

## 5. `bitcoind -txindex=1` requirement

Not in the quickstart's `bitcoind` startup command, but `depositToVault`'s
PSBT builder needs it — without it, `getrawtransaction` fails with error -5
("No such mempool transaction") looking up the funding UTXO's previous
transaction. Worth adding to the quickstart docs for the next person.

---

## Resolved ourselves (kept for context, no reply needed)

**Tachi mempool's minimum ledger fee.** `buildTachiTxDeposit` defaults
`feeSats` to `0n`, but the mempool rejects that (`fee below minimum`); `10n`
works. We just always pass a small nonzero fee now.

**Validator liveness signals disagreeing.** `/health` reports `validators: 1`
persistently while `getLiveValidators()` and `/tachi_validatorsPower` both
show a healthy 7/7. Turned out not to matter in practice — `getLiveValidators()`
is what predicts whether cosigning actually works, and it's been reliably 7/7
across every session we've tested. Still don't know what `/health`'s field
measures, but we no longer gate anything on it.

**More live validators coming online.** Moot — 7/7 has been consistently
available via `getLiveValidators()`.
