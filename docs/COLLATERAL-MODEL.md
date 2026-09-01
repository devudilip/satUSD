# Collateral Model v2 — pre-committed, self-custodial collateral on Tachi

> **Status: VERIFIED against live `rpc-regtest.tachibtc.com` on 2026-09-01.**
> Evidence: `scripts/03-spike-refund-cosign.ts` (in the satusd worktree). Every
> claim below is tagged **VERIFIED** (ran it) or **ASSUMED** (SDK docs say so, not
> yet run). This document supersedes the "no forced liquidation is possible"
> conclusion in `BACKGROUND.md` — that conclusion was one step short.

## 0. TL;DR

Tachi **does** support programmable, pre-committed collateral today — through
the refund/commitment machinery in `@tachibtc/taurus-vault-core`, not through
SatVM. The full flow works on the hosted regtest:

```
L1 deposit → onboard ledger VTXO → TxVaultOpen (registerVault)
  → buildRefundPsbt( to_local(user) + extra output(PROTOCOL) )
  → signRefundPsbtAsUser → cosignRefund  ← 5-of-7 validators SIGNED IT
  → finalizeRefundPsbt → hold → broadcast to bitcoind on liquidation → MINED
```

Verified log (regtest, 2026-09-01):
```
[refund] VAULT REGISTERED id= 7cb191bd… committed= true code= 0
[refund] COSIGN OK — daemon reported 5 partials, attached 5
[refund] testmempoolaccept: allowed: true, vsize: 310
[refund] BROADCAST + MINED: 11b7aaaf6555aa359f48d21ca222724b8e3496da5521d39114da39a6b5979c08
[refund] PASS — pre-signed liquidation payout to bcrt1qdre38… settled on Bitcoin
         without the user's key at broadcast time
```

And the multi-state result that dictates the security model:
```
[refund] state 1 (user 150000 / protocol 49000) COSIGNED: 5 partials
[refund] state 2 (user 100000 / protocol 99000) COSIGNED: 5 partials
[refund] state 2 (user 120000 / protocol 79000) COSIGNED: 5 partials   ← same state #, different split
[refund] listVaults record: {"state":"open","latestStateNum":0, …}      ← daemon tracks no state
[refund] BROADCAST + MINED state B
[refund] stale state A accepted? false missing-inputs                   ← only Bitcoin's double-spend rule protects
```

**Consequences:**

1. A validator quorum will cosign **any** refund the vault owner signs, for any
   split, any number of times. There is no state-number enforcement, no
   "latest state" tracking, no penalty enforcement live today
   (`latestStateNum` is always 0; `TxVaultStateAdvance` is defined but not wired).
2. Therefore a **single-key borrower vault cannot secure a lender**: the borrower
   can always cosign a refund paying 100% to themselves, instantly. And after the
   CSV delay they can exit unilaterally regardless.
3. Therefore the **owner key of a collateral vault must be a joint key**
   (MuSig2 2-of-2, borrower + protocol), with the borrower's exit guaranteed by a
   **pre-signed exit transaction**, and the lender's protection by a
   **pre-signed liquidation refund**. That is Track B below, and it is the design
   both products build.

Why this is the strongest possible pitch: it is *exactly* "SatVM-based
programmable collateral and repayment logic" (the bounty's optional item),
implemented with the primitives Tachi actually ships, and it keeps the
"kill the protocol, user still gets their BTC" demo intact.

---

## 1. The TAURUS vault security model, as it exists today

| Fact | Status |
|---|---|
| Vault = P2TR, NUMS key path, two leaves: cooperative (`owner CHECKSIGVERIFY` + M-of-N quorum), exit (`CSV` + `owner CHECKSIG`) | VERIFIED |
| Nobody but the owner key can ever move funds | VERIFIED (script) |
| The owner can always move funds: cooperatively now, unilaterally after CSV | VERIFIED |
| `POST /tachi_signTransaction` cosigns a **refund** (cooperative spend to a `to_local` + extra outputs) | VERIFIED |
| Cosign requires the vault to be **registered** (`TxVaultOpen`); otherwise 400 "no vault opened for the funding outpoint" | VERIFIED |
| Registration needs a ledger VTXO owned by the owner key to pay the open fee; onboard one with `buildTachiTxDeposit` first; `feeSats: 10n` (0 is rejected) | VERIFIED |
| Daemon cosigns unlimited states, no monotonicity, `latestStateNum` stays 0 | VERIFIED |
| Plain `buildVtxoPsbt` transfers have no cosign route → `finalizeVtxoPsbt` fails "0 valid node signatures". **Use refunds, not transfers, for every L1-settling spend.** | VERIFIED (by satusd agent) |
| `csvBlocks` is caller-chosen at `createVault` and committed in the open payload | ASSUMED (docs: default 1008; `toSelfDelayForBalance` tiers exist) |
| `to_local` self-exit key must equal the vault owner key ("pinned") | ASSUMED (docs) |
| A MuSig2 aggregate key is accepted as the owner key | ASSUMED — it is just a 33-byte key; the daemon verifies BIP-340 against it. **Spike 04 verifies.** |

---

## 2. Track A — borrower-key vault + pre-signed liquidation (VERIFIED, insufficient alone)

```
        Bitcoin L1                                 held off-chain by the protocol
 ┌──────────────────────┐    refund_N (fully signed: borrower + 5/7 quorum)
 │ vault P2TR (borrower)│ ─────────────────────────────────────────────►  broadcast on liquidation
 │  coop: borrower+quorum│      out[0]  to_local(borrower)  = collateral − share_N
 │  exit: CSV + borrower │      out[1]  PROTOCOL payout     = share_N
 └──────────────────────┘
```

- **Works today** (spike 03). The protocol holds `refund_N`; broadcasting it settles
  the liquidation on Bitcoin with no borrower interaction.
- **Fatal limit:** the borrower can cosign `refund_X` paying everything to
  themselves at any time (§1). The protocol's claim is a *promise*, not a lock.
- Use only as a stepping stone: all code paths are identical to Track B except
  the signer. Ship it only if Track B slips, **and disclose the limit explicitly**.

## 3. Track B — joint-key vault + pre-signed exit + pre-signed liquidation (BUILD THIS)

```
 owner key P_agg = MuSig2( P_borrower , P_protocol )        (BIP-327, @scure/btc-signer/musig2.js)

        Bitcoin L1                              pre-signed at OPEN, both parties sign once
 ┌──────────────────────┐
 │ vault P2TR (P_agg)   │──── exit_tx ────────► borrower's own address      HELD BY BORROWER
 │  coop: P_agg + quorum│      (exit leaf, CSV=term, agg-signed)             valid after CSV, no protocol needed
 │  exit: CSV + P_agg   │
 └──────────────────────┘──── refund_N ───────► out[0] to_local(P_agg) = collateral − share_N   HELD BY PROTOCOL
                                                out[1] protocol payout = share_N                  broadcast on liquidation
                                └── child: to_local self-exit → borrower address (agg-signed, pre-signed with refund_N)
```

**Why this is correct:**

| Threat | Defense |
|---|---|
| Borrower walks with collateral while in debt | Every cooperative spend needs `P_agg` → protocol's partial signature. Borrower cannot refund to themselves. |
| Borrower exits unilaterally before repaying | Exit leaf also needs `P_agg`. The only exit the borrower holds is `exit_tx`, valid **after CSV** — so **loan term = CSV**. |
| Protocol disappears / turns hostile | Borrower holds `exit_tx`, fully signed at open. Broadcast after CSV, with nobody's help. **This is the "kill the engine" demo.** |
| Protocol seizes without cause | It can only broadcast `refund_N`, whose split was signed by the borrower. Bounded to `share_N`. Made harmless by §5 (oracle gate). |
| Protocol broadcasts an old, worse-for-borrower state | Bitcoin's double-spend rule: only one refund confirms. Protocol should hold **only the latest**; §5 removes the incentive entirely. Daemon-side penalties are not live (§1), so do not rely on them. |
| Validators censor | Exit path needs no validators. Liquidation needs cosign *at state creation only*, not at broadcast. |

**Term = CSV.** Pick `csvBlocks` at `createVault` per loan (**demo: 144**, ~1 day;
production tiers 1008/4320). Rollover = at term end, cooperative refund into a
fresh vault (new funding outpoint, new CSV window) — the moment the protocol can
require repayment or re-underwriting. This is how Firefish-style term loans work.

### 3.1 Open (both parties online — one interactive MuSig2 session per signature)

1. `P_agg = musig2.keyAggExport(keyAggregate(sortKeys([P_b, P_p])))` (33-byte compressed for the daemon).
2. `vault = createVault({ network, userPubkey: P_agg_compressed, csvBlocks: TERM, validators })`.
3. Borrower funds the vault on L1 (`depositToVault` from *their* wallet), mine/wait.
4. Onboard ledger VTXO for `P_agg` (`buildTachiTxDeposit`, `feeSats: 10n`) — agg-signed.
5. `registerVault({ vault, outpoint, userSigner: aggSigner, inputs, outputs, feeSats: 10n, confirm })`.
6. **Pre-sign `exit_tx`**: `buildUnilateralExitPsbt({ vault, funding, outputs: [borrowerAddr] })` →
   `signUnilateralExitPsbtAsUser(aggSigner)` → `finalizeUnilateralExitPsbt` → **give hex to borrower**.
   *Borrower must receive this before the protocol issues any loan asset.*
7. **Commit state 1** (§3.2) with `share_1` = liquidation payout at open.
8. Only now: mint satUSD / release loan asset.

### 3.2 Commit a state (every borrow / repay / add-collateral / accrual checkpoint)

```ts
const toLocal = buildToLocalP2trOutput({ network, nodePubkeys: vault.p2tr.cooperativeLeaf.nodeKeysCompressed,
  threshold: vault.p2tr.cooperativeLeaf.threshold, userDelayedPubkey: vault.userKey.xOnly,
  toSelfDelay: vault.p2tr.exitLeaf.csvBlocks });
const hint = encodeStateHint(n, deriveStateObfuscator(P_agg_compressed, quorumAggregateKey(nodeKeysCompressed)));
const { psbt } = buildRefundPsbt({ vault, funding, toLocal, userValueSats: collateral - share_n,
  extraOutputs: [{ address: PROTOCOL_PAYOUT, valueSats: share_n }], feeSats,
  sequence: hint.sequence, locktime: hint.locktime });
const verify = { maxFeeSats, toLocal, expectedUserValueSats: collateral - share_n, expectedDelayedPubkey: vault.userKey.xOnly };
await signRefundPsbtAsUser(psbt, aggSigner, vault, verify);       // MuSig2 round
await cosignRefund(psbt, vault, { url: `${TACHI}/tachi_signTransaction`, timeoutMs: 90_000 });
const refundHex = finalizeRefundPsbt(psbt, vault, verify);        // HOLD, do not broadcast
// child: pre-sign the to_local self-exit so the borrower can claim out[0] after liquidation without the protocol
```
Store `{ n, share_n, refundHex, childHex, price_liq, hatProofOfCosign? }` in the engine ledger.
**Delete `refund_{n-1}`** from hot storage.

### 3.3 Liquidation (deterministic engine; AI has no path here)

`LTV > LLTV` → `sendrawtransaction(refund_n)`. Done. Anyone with the hex can do it
(keeper bot). Show the txid in the UI. After confirmation: `share_n` sits at the
protocol payout address (or in the oracle-gated output, §5); borrower's remainder
sits in `to_local`, claimable via the pre-signed child after `toSelfDelay`.

### 3.4 Repay / close

Debt → 0: commit a **close refund**: `out[0] to_local = 0?` — no: build a refund
with `extraOutputs: [{ address: borrowerAddr, valueSats: collateral - fee }]` and
`userValueSats` at the daemon floor (`DAEMON_MIN_TO_LOCAL_SATS = 330`), cosign,
broadcast. Or roll into a new vault. Either way the borrower's key is required, so
the protocol cannot "close" without them, and vice-versa.

### 3.5 The share formula

```
share_n = min( collateral , ceil( debt_n × (1 + penalty) / P_liq_n ) )      // all bigint sats
P_liq_n = debt_n / (collateral × LLTV)                                        // price at which LTV == LLTV
```
Use `P_liq`, not spot: by construction the tx is broadcast when spot ≈ `P_liq`.
Gap risk (spot < P_liq at broadcast) is what the penalty buffer and the
over-collateralization are for. Re-commit when `|Δdebt| > 0.5%` (interest) or on
any principal/collateral change.

## 4. The MuSig2 signer (tachi-kit `musig.ts`)

`@scure/btc-signer/musig2.js` — audited, BIP-327. Wrap it as a `TaprootSigner`:

```ts
interface TaprootSigner { publicKey: Buffer; sign(h): Buffer; signSchnorr(h): Buffer | Promise<Buffer> }
```
- `publicKey` = `P_agg` compressed (33 bytes; SDK derives x-only itself).
- `signSchnorr(sighash)` = interactive session: nonceGen (both) → exchange pubnonces →
  `Session` → partial sigs → `partialSigAgg`. One round trip over the engine's HTTP
  API per signature (borrower side runs in the web app / CLI, protocol side in the engine).
- `sign` (ECDSA) → throw; nothing on the taproot paths needs it.
- **A secret nonce is used exactly once.** Never reuse across sighashes.
- Every message that gets agg-signed must be verified by **both** parties before
  signing (`verifyRefundPsbt`, `verifyUnilateralExitPsbt`) — the borrower's client
  must refuse a refund whose `share_n` exceeds the engine's published formula.

**Spike 04 acceptance:** `createVault({ userPubkey: P_agg })` → deposit → onboard →
`registerVault` committed → pre-signed `exit_tx` passes `testmempoolaccept` after
mining `csvBlocks` → `cosignRefund` returns 5 partials → refund mined. If the daemon
rejects the aggregate owner key (unexpected), fall back to Track A and disclose.

## 5. Stretch — oracle-gated protocol payout ("programmable collateral", the winner)

Replace `PROTOCOL_PAYOUT` (a plain address) with a custom P2TR:

```
leaf 1:  <P_oracle> CHECKSIGVERIFY <P_protocol> CHECKSIG      // claim only with an oracle attestation
leaf 2:  <csv_grace> CHECKSEQUENCEVERIFY DROP <P_borrower> CHECKSIG   // else it returns to the borrower
```
The oracle signs the *claim transaction* only if its signed price feed shows
`price ≤ P_liq_n` at broadcast height. Now the protocol may broadcast `refund_n`
whenever it likes, but **cannot take anything without a valid liquidation**; a
wrongful broadcast just returns the funds to the borrower. This is a two-leaf
Taproot output built with `bitcoinjs-lib` exactly like the SDK's own leaf builders
(`buildExitScript` is the template). The oracle keypair is a separate service
(same trust class as the price feed everything already depends on). Do this after
Track B is demoable — it is ~150 lines and turns "bounded trust" into "no trust".

## 6. What tachi-kit must expose (both repos vendor this)

```
commitment.ts
  openCollateral({ borrowerPub, protocolSigner, borrowerSigner, amountSats, csvBlocks })
      → { vault, funding, vaultId, exitTxHex }                   // §3.1 steps 1–6
  commitState({ channel, n, collateralSats, debtSats, lltvWad, penaltyBps, priceWad })
      → { refundHex, childHex, shareSats, priceLiq }             // §3.2
  broadcastLiquidation(channel, refundHex) → txid                // §3.3
  closeChannel(channel, toAddress) → txid                        // §3.4
  watchChannel(channel, onEvent)      // subscribeVaultEvents({ vault }) — breach/spend events, classification
musig.ts
  createAggSigner({ localSecret, remotePub, exchange }) → TaprootSigner   // §4
  aggregateKey(pubs) → { xOnly, compressed }
oracle-gate.ts (stretch)
  buildOracleGatedOutput({ oraclePub, protocolPub, borrowerPub, csvGrace, network })
health.ts (existing, pure)  +  shareForLiquidation(debt, collateral, lltv, penalty) → { share, priceLiq }
```

## 7. Test matrix

| Script | Proves | Status |
|---|---|---|
| `03-spike-refund-cosign.ts` | Track A end-to-end, multi-state | **PASS** 2026-09-01 |
| `04-spike-musig-vault.ts` | Track B open + pre-signed exit + cosigned liquidation with `P_agg` | todo — **first task** |
| `05-spike-exit-presigned.ts` | engine killed → borrower broadcasts `exit_tx` after CSV → funds at borrower address | todo |
| `06-spike-oracle-gate.ts` | claim with oracle sig succeeds; claim without fails; borrower reclaims after grace | stretch |
| `test/health.test.ts` | `shareForLiquidation` boundaries, bigint safety | extend |

## 8. What to tell judges (all true)

- "Collateral is native BTC in a Taproot vault with a joint key. Neither we nor the
  borrower can move it alone."
- "At open, the borrower receives a fully signed exit transaction. If we vanish,
  they broadcast it after the term and get every sat back. We'll kill our servers
  and show it."
- "Liquidation is a transaction the borrower signed at open and Tachi's validator
  quorum cosigned. When LTV crosses the line, anyone can broadcast it. No custodian,
  no bridge, no wrapped BTC — and no trust in us to *execute* the liquidation."
- "Tachi has no developer-facing SatVM today. This is programmable collateral built
  from the primitives Tachi ships: TAURUS vaults, quorum-cosigned commitments,
  HAT/RIP-anchored ledger entries."
