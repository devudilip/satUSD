# Questions for the Tachi team

Context for whoever answers: we're building satUSD (BTC-backed stablecoin,
Bounty #2, Institutional Bitcoin track) on `tachi-sdk-ts@0.2.1` /
`taurus-vault-core@0.3.4` / `taurus-wallet-aggregator@0.4.5` against
`rpc-regtest.tachibtc.com`. Everything below came from hands-on testing against
that live daemon on 2026-08-31/09-01, not guessing from docs.

## 1. Is there an unpublished SatVM/EVM endpoint for hackathon participants?

We read every page of docs.tachibtc.com and the full public SDK surface — no
mention of EVM, SatVM, contract deployment, or asset issuance anywhere. Just
confirming there's nothing unpublished/gated we're missing, since it would
materially simplify our architecture if it exists.

## 2. How do we get cooperative-leaf signatures for a plain VTXO transfer?

We followed the documented flow exactly: `buildVtxoPsbt` → `verifyVtxoPsbt` →
`signVtxoPsbtAsUser` → `finalizeVtxoPsbt`. Finalize throws:

    input[0] has 0 valid node signatures on the cooperative leaf, needs at least 5

We see a dedicated cosign endpoint for refunds (`POST /tachi_signTransaction` /
`cosignRefund`), but nothing equivalent for a plain transfer built via
`buildVtxoPsbt`. Is quorum cosigning for a non-refund transfer only available
via the `tachi/vault/v1` libp2p gossip topic? Is there a REST equivalent we're
missing, or is the quickstart's transfer example (First VTXO in 30 Minutes)
missing a step?

## 3. Validator liveness signals disagree — which one should we trust?

Polled repeatedly against `rpc-regtest.tachibtc.com`:

- `GET /health` → `{"validators": 1}`, consistently
- `TachiClient.getLiveValidators()` → `7/7`
- `GET /tachi_validatorsPower` → all 7 actively voting (real CometBFT consensus set)

What does `/health`'s `validators` field actually measure? Should we be
gating anything on it, or is `getLiveValidators()` the right liveness check?

## 4. Tachi mempool's minimum ledger fee

`buildTachiTxDeposit` defaults `feeSats` to `0n` per its own doc comment
("deposits carry no Bitcoin-layer fee"), but broadcasting with `feeSats: 0n`
gets rejected: `tachi mempool rejected VTXO (code=8): fee below minimum`.
`10n` worked. Is there a documented minimum, or should we always call
`GET /tachi_feeEstimate` first? Does a deposit actually need feeSats > 0, or is
that error specific to how we built the tx?

## 5. `bitcoind -txindex=1` requirement

Not in the quickstart's `bitcoind` startup command, but `depositToVault`'s
PSBT builder needs it — without it, `getrawtransaction` fails with error -5
("No such mempool transaction") looking up the funding UTXO's previous
transaction. Worth adding to the quickstart docs for the next person.

## 6. Any timeline for more live validators on the hosted regtest/signet daemons?

Given #2/#3, cooperative-leaf paths (fast transfers, fast withdrawals) aren't
usable for us right now regardless of root cause. If more validators are
coming online soon, that changes our timeline for building on the cooperative
path vs. relying solely on the exit leaf.
