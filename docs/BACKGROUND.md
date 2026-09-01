# Background: Tachi, and what is actually buildable on it

> This document is the result of first-hand research against Tachi's live
> infrastructure on 2026-08-31. Every claim marked **VERIFIED** was probed
> directly. Read this before writing any code.

## 1. The hackathon

**OP_Freedom Hackathon** by Tachi — https://tachibtc.com/hackathon

- Format: online. Teams: solo or 2–4. Start: 2026-07-04 (tentative).
- 11 bounties, USD $500 each paid in sats. $5,000 follow-on grants.
  $10,000 contributor roles. Mentorship + demo showcase.
- Registration: https://forms.gle/m4yg43Czqgn1TesF6
- Docs: https://docs.tachibtc.com

### Tracks
1. **Institutional Bitcoin** — custody, credit, stablecoins, yield, lending
2. **AI** — agentic payments, data marketplaces, verifiable agent identity
3. **Bitcoin-Centric Narratives** — mining yield, liquidity mgmt, merchant payments

### Bounties
| # | Track | Focus |
|---|---|---|
| 1 | Institutional | TAURUS-based self-custody wallet |
| **2** | **Institutional** | **BTC-backed stablecoin protocol** ← this repo family |
| 3 | Institutional | Yield optimizer |
| **4** | **Institutional** | **Lending / borrowing protocol** ← this repo family |
| 5 | Institutional | STRC digital credit issuance |
| 6 | AI | x402 micropayment SDK for agents |
| 7 | AI | BTC-settled data marketplace |
| 8 | AI | Nostr-based agent identity & logs |
| 9 | Bitcoin-Centric | Mining-backed yield vaults |
| 10 | Bitcoin-Centric | Cross-chain liquidity management |
| 11 | Bitcoin-Centric | Merchant payments |

### Submission requirements (all projects)
- **Native BTC only** — no wrapped tokens, no bridges
- **Self-custody** with unilateral exit guarantees
- User-facing dashboards and clear UX
- Proof-of-reserves or verifiable on-chain mechanics where applicable

---

## 2. What Tachi is

Tachi bills itself as **"Bitcoin's Agentic Execution Layer"** — smart contracts and
yield on self-custodial Bitcoin without bridges, wrapped tokens, or custodians.

Five-tier architecture:
1. **Onboarding** via TAURUS (threshold-aggregated signature vaults)
2. **Virtualization** into VTXOs (virtual UTXOs)
3. **High-speed execution** across native Bitcoin apps
4. **Proof aggregation** into RIPs (Recursive Inclusion Proofs)
5. **L1 settlement** anchored to Bitcoin mainnet

Component glossary:

| Name | What it is |
|---|---|
| **TAURUS** | Native-BTC self-custody vaults: Taproot P2TR with timelocked exit |
| **VTXO** | Virtual UTXO — off-chain balance unit on the Tachi ledger |
| **HAT** | Hash-Accumulated Transaction proof — a verifiable receipt per off-chain tx |
| **RIP** | Recursive Inclusion Proof — aggregates HATs, anchored to Bitcoin L1 |
| **SatVM** | Claimed multi-runtime VM: Script, EVM, WASM, SVM, ABCI |
| **x402** | Native-sat payment rails for machine-to-machine payments |

---

## 3. ⚠️ THE CRITICAL FINDING — there is no SatVM/EVM for developers

**Tachi's marketing describes SatVM as a multi-runtime execution environment
(Script/EVM/WASM/SVM/ABCI) running "directly on actual Satoshis". There is no
developer-facing SatVM or EVM surface today.**

Evidence (**VERIFIED**, 2026-08-31):

- Every page of `docs.tachibtc.com` was read: Getting Started, Getting Started (Go),
  First VTXO in 30 Minutes, Tutorial, API Reference, API Reference (Go),
  RPC Reference, Taurus Vault Core. **Zero mentions** of EVM, SatVM, smart contracts,
  contract deployment, asset issuance, token creation, or x402.
- The official Tutorial page states outright that the architecture contains
  **no smart contracts, EVM, or SatVM** — it relies on native Bitcoin primitives
  (P2TR tapscript, multisig, CSV timelocks) with all logic executing client-side.
- The TypeScript SDK's full exported surface (§5) contains no contract, script
  compilation, or asset-issuance functions.
- Web search finds no public Tachi GitHub org, no SatVM SDK, no chain ID, no faucet.

### What this means for architecture

**There is nowhere on-chain to put protocol logic.** Both products must be:

> Native BTC custody (TAURUS P2TR vaults) + VTXO settlement on the Tachi ledger
> + a deterministic **off-chain protocol engine** + Bitcoin-anchored HAT/RIP proofs
> surfaced as proof-of-reserves.

**Do not hide this. State it plainly in the README and in the demo.** Judges reward
an honest architecture that works over a fabricated contract story. The compensating
strength is that we can prove something wrapped-BTC competitors cannot: *the user
recovers their Bitcoin unilaterally even if our entire protocol disappears.*

### OPEN QUESTION #1
Ask the Tachi team (Telegram / team@tachibtc.com) whether an unpublished SatVM or
EVM endpoint exists for hackathon participants. If yes, escalate immediately — the
architecture gets materially simpler and the plan should be rewritten around it.

---

## 4. TAURUS vault — the custody primitive

A TAURUS vault is a **Bitcoin P2TR (Taproot) address** with:

- **Key path: deliberately disabled.** Uses a BIP-341 NUMS (nothing-up-my-sleeve)
  internal key, so there is provably no alternate spending route.
- **Two-leaf tap tree:**
  1. **Cooperative leaf** — user signature + **5-of-7 validator multisig**, no
     timelock. Instant settlement when all parties agree.
  2. **Exit leaf** — user signature alone after a **1008-block relative CSV
     timelock**. Unilateral withdrawal even if every validator vanishes.

**Capital can never be permanently locked.** This is the guarantee both products are
built on, and it is the single most demoable property of the platform.

Deposit flow: create vault (validator keys fetched automatically from the KDHT
endpoint) → sync a P2WPKH wallet → `depositToVault({amountSats, feeRateSatVb})` →
funds land in the P2TR address with both spending paths live.

### Third-party integration
Protocols build on top by using the predictable P2TR derivation and the dual-path
structure: cooperative settlement for fast protocol actions, exit leaves as the
non-custodial guarantee for users.

---

## 5. Live infrastructure — VERIFIED probes

All of the following were executed directly on 2026-08-31.

### npm packages (all public and installable)
| Package | Latest |
|---|---|
| `@tachibtc/tachi-sdk-ts` | `0.2.1` — "TypeScript SDK for Tachi BTC daemon RPC" |
| `@tachibtc/taurus-vault-core` | `0.3.4` — taproot/p2tr/multisig/vtxo |
| `@tachibtc/taurus-wallet-aggregator` | `0.4.5` |

Maintainer: `tachibtc-admin` / `devsecops@tachibtc.com`. All are **v0.x** — expect
undocumented edges and breaking changes. Pin exact versions.

### Endpoints
```
regtest ledger : https://rpc-regtest.tachibtc.com
signet  ledger : https://rpc-signet.tachibtc.com
```

`GET /health` → `{"status":"ok","validators":1}` on both.

`GET /tachi_stats` (regtest):
```json
{"height":583495,"total_transactions":897,"total_accounts":0,
 "current_epoch":583495,"node_count":7,"chain_id":"tachi-regtest-1",
 "latest_block_time":1788176283,"total_supply_sat":6099091865,"vtxo_count":574}
```

`GET /tachi_stats` (signet):
```json
{"height":584761,"total_transactions":28,"current_epoch":584761,
 "node_count":7,"chain_id":"tachi-signet-1","total_supply_sat":73224,"vtxo_count":10}
```

Note `health` reports `validators: 1` while `node_count` is 7 and
`/tachi_validators` returns 7 pubkeys. The cooperative leaf needs 5-of-7. Confirm
liveness before relying on the cooperative path; the exit path always works.

### Bitcoin JSON-RPC proxy (`POST /` with JSON-RPC 1.0)
- **signet: WORKS.** `getblockchaininfo` → real signet, height 320122, not pruned.
- **regtest: 404** — `{"error":{"code":-1,"message":"bitcoin: getblockchaininfo:
  http 404: 404 page not found"}}`. No bitcoind attached to the hosted regtest.
  **You must run `bitcoind -regtest` locally**, exactly as the quickstart does.

### VTXO object shape (`GET /tachi_listVtxos?page=1&page_size=1`)
```json
{"vtxos":[{"id":"35b60b9e...ed72",
           "owner":"6267b312...338f",
           "amount":10000,
           "spent":false,
           "height":583148,
           "script":"",
           "locked":false}],
 "total":1007,"page":1,"page_size":1,"total_pages":1007}
```

**`locked` and `script` are the two fields that make these products possible.**
Combined with the SDK's `getLockedVtxos(vault)`, the ledger has a native concept of
**a VTXO locked to a vault**. That is our collateral escrow primitive.

### VERIFIED — Phase 1 spike passed (2026-08-31)

`pnpm bootstrap && pnpm spike` (see `docs/PLAN.md` Phase 1) ran end to end against
live `rpc-regtest.tachibtc.com` plus a local `bitcoind -regtest`: `createVault`
produced a real P2TR address, `depositToVault` broadcast a real regtest txid, and
`scantxoutset` confirmed the deposit landed on the vault address after one mined
block. The exit leaf's `csvBlocks` is `1008` and `exitLeaf.userKey` does equal
`vault.userKey.xOnly`, exactly as this document claims below.

One correction to the quickstart: `-txindex=1` is required on local `bitcoind`.
Without it, `depositToVault`'s PSBT builder fails with `getrawtransaction` error
-5 ("No such mempool transaction") when it looks up the funding UTXO's previous
transaction — bitcoind's default index doesn't cover non-wallet transactions. All
bitcoind commands in this repo's docs now include the flag.

### VERIFIED — no forced liquidation is possible, by design (2026-08-31)

Read the full `taurus-vault-core` type surface — every leaf, `buildRefundPsbt`,
the BOLT-3-style commitment/state-hint machinery — to resolve this precisely.

**The cooperative leaf's script is `<userPubkey> OP_CHECKSIGVERIFY <node quorum>
OP_CHECKSIGADD ... OP_NUMEQUAL`.** The `CHECKSIGVERIFY` on the vault owner's key
is unconditional and comes first — no configuration of the node quorum (real
Tachi validators or a substituted key) removes it. The exit leaf is user-only by
definition. **There is no third spending path.** So no party other than the vault
owner can ever move funds out of a TAURUS vault, full stop — this isn't an
implementation gap, it's what "unilateral exit" / self-custody means.

The refund/`to_local`/commitment system (`buildRefundPsbt`, `encodeStateHint`,
etc.) looked like a possible escape hatch — it lets the user pre-sign a payout
and pay an extra output to a third party. It isn't one: state numbers are
monotonic and the daemon does "stale-state filtering," so pre-signing multiple
alternative future payouts (a liquidation "ladder" keyed to price bands) risks
the watchtower treating a later-broadcast lower state as a stale replay and
sweeping the *entire* balance to the quorum as a penalty — worse than doing
nothing. The only way this machinery gives real teeth is continuous, live
bilateral state updates while the borrower stays online — full payment-channel
engineering, and it still only binds engaged borrowers.

**Consequence for satUSD:** liquidation is soft (delinquency flag, blocked mints,
escalated fee — see `PLAN.md` Phase 4 and the README's Mechanics section), not
seizure. The same holds for Liquity-style forced redemption against a specific
CDP — it has the identical forced-custody requirement MakerDAO's liquidation
does, and Tachi doesn't offer it either. Peg defense is arbitrage-only.

This also settles Open Question #2 below in the strong direction: even genuine
third-party VTXO "locking" (if it worked) wouldn't matter, because the underlying
Bitcoin vault never grants seize power regardless.

### VERIFIED — cooperative-leaf VTXO transfers do not work via the documented public API, root cause unclear (2026-08-31)

Attempted the exact canonical sequence from §7 live: `createVault` → deposit →
register the deposit as a VTXO → `buildVtxoPsbt` → `verifyVtxoPsbt` →
`signVtxoPsbtAsUser` → `finalizeVtxoPsbt`, transferring the VTXO to the vault's
own address. `finalizeVtxoPsbt` throws `input[0] has 0 valid node signatures on
the cooperative leaf, needs at least 5` — expected, since nothing in that
sequence, or anywhere in the public REST/SDK surface for a plain transfer,
actually collects the quorum's partial signatures. The refund path has a
dedicated cosign endpoint (`POST /tachi_signTransaction` / `cosignRefund`); a
plain `buildVtxoPsbt` transfer has no equivalent exposed.

**This is not simply "not enough live validators."** The signals disagree:
`GET /health` reports `validators: 1` (consistently, polled repeatedly);
`TachiClient.getLiveValidators()` reports `7/7`; `GET /tachi_validatorsPower`
(the real CometBFT consensus set) shows all 7 actively voting. Whatever
`/health`'s `validators` field measures, it isn't validator-quorum-for-cosigning
— but the more likely explanation for the actual failure is a genuine gap in
the documented flow: **there's no step, anywhere in the quickstart or the
public API, that gathers node partials for a non-refund transfer.** They may
only be obtainable via the `tachi/vault/v1` libp2p gossip topic — a much
heavier integration than a REST call, and out of scope here.

**Consequence:** ledger-level VTXO "locking" (a transfer whose destination is
a vault address) is not currently usable through the public API, for whichever
of these reasons. `packages/tachi-kit/src/collateral.ts` tracks collateral by
reading the vault's real BTC balance via `bitcoind` (`scantxoutset`) instead —
verified working in `scripts/02-spike-collateral.ts` — and redemption relies on
the exit leaf (always works, no quorum) rather than the cooperative refund.
`checkQuorum()` is kept as a startup/pre-flight check so the cooperative path
can be attempted opportunistically without ever being load-bearing.

### OPEN QUESTION #2 — RESOLVED (moot), 2026-08-31
Does `locked` permit **third-party** escrow (the protocol locks a user's VTXO), or
only self-locking by the owner?

Turned out to be the wrong question. Neither works via the public API right now
— see the VERIFIED note above. Ledger-level VTXO transfer of *any* kind (self or
third-party) needs cooperative-leaf node signatures that aren't obtainable
through documented REST calls, so it doesn't matter which locking model would
have been chosen. The 2-of-2 fallback originally proposed below has the same
problem — it's still a cooperative-leaf spend, still blocked. Used instead:
bitcoind-verified collateral (`getVaultBalanceSats`), no ledger transfer needed.

<details>
<summary>Original question and fallback, for the record</summary>

**Fallback if third-party locking is not supported:** collateral becomes a VTXO sent
to a 2-of-2 protocol/user TAURUS vault. Same self-custody guarantees (the user still
holds an exit leaf), more PSBT plumbing. This fallback is known-good — do not block
on the answer, just budget an extra day if it lands.

</details>

### Route naming (**VERIFIED** — camelCase, `tachi_` prefix)
| Route | Works |
|---|---|
| `GET /health` | yes |
| `GET /tachi_stats` | yes |
| `GET /tachi_supply` | yes → `{total_supply_sat, vtxo_count}` |
| `GET /tachi_validators` | yes → 7 validators with `pub_key_hex`, `peer_id` |
| `GET /tachi_listVtxos?page&page_size` | yes |
| `GET /tachi_mempool` | yes → `{transactions:[],count:0}` |
| `GET /tachi_feeEstimate` | yes → `{min_fee_sat:1,avg_fee_sat:0,recommended_fee_sat:1}` |
| `GET /tachi_listTransactions` | yes (empty body observed) |
| `POST /tachi_txBroadcastSync` | documented in quickstart |
| `GET /tachi_vtxos`, `/tachi_blocks`, `/tachi_watchtowerStatus` | **404 — wrong names** |

Prefer the SDK over raw HTTP; the RPC Reference page documents only the bitcoind
proxy and explicitly redirects you to the TypeScript wrapper.

---

## 6. TypeScript SDK surface (`@tachibtc/tachi-sdk-ts`)

`TachiClient({ baseUrl, fetch?, timeoutMs?, maxResponseBytes? })` covers 46 of the
daemon's 47 RPC routes.

**Health** `getHealth` `getStatus` `getNodeInfo`
**Validators** `getPeerInfo` `getValidators` `getValidatorCount` `getLiveValidators` `waitForValidatorsReady(expected?)` `getValidatorsPower`
**VTXO** `getVtxo(id)` `listVtxos(params?)` `getAddressVtxos(address, includeSpent?)` **`getLockedVtxos(vault)`**
**Vault** `listVaults(user, {page,page_size,apiKey})` `signTransaction(refund: RefundTx)`
**Transactions** `broadcastTxAsync(tx)` `broadcastTxSync(tx)` **`getTransaction(hash, {hat, rip, vtxoId, originEpoch, finalEpoch})`** `getRawTransaction(hash)` `listTransactions(opts?)` `decodeTransaction(tx)` `validateTransaction(tx)` `getAddressTransactions(address, {pageSize, beforeHeight})`
**Address** `getAddress` `getBalance` `getNonce`
**Blocks** `getBlockByHeight` `getBlock({height|hash})` `getBlockHash` `getBlockHeader` `listBlocks`
**Epochs** `getEpoch({id|hash})` `listEpochs` `getConsensusState`
**Network** `getNetInfo` `getStats` `getSupply` `search(q)`
**Mempool** `getMempool` `getMempoolByAddress` `getFeeEstimate`
**Protocol** `query(params)` `bitcoinRPC(request)`
**Watchtower** `getWatchtowerStatus()` `getWatchtowerReceipts({vault?, state?})` → L1 spend observations
**Live events** `watch({address?|vault?|vaultId?|blocks?|validators?}, {signal, WebSocket, maxQueuedEvents})` → async generator

Four of these carry disproportionate weight:
- **`getLockedVtxos(vault)`** — read side of collateral escrow
- **`getTransaction(hash, {hat, rip})`** — the proof objects behind proof-of-reserves
- **`watch({vault})`** — real-time liquidation monitoring without polling
- **`getWatchtowerReceipts({vault, state})`** — detect users attempting L1 exits

**Confirmed absent:** asset issuance, token creation, contract deployment/execution,
script compilation, multi-party vault state beyond basic locking.

A Go SDK (`tachi-sdk-go`) exists with the same surface.

---

## 7. The canonical VTXO sequence

From the official "First VTXO in 30 Minutes" quickstart. Every collateral movement
in both products goes through this. Wrap it once; never inline it.

```bash
# local regtest bitcoind (required — hosted regtest has no bitcoind)
bitcoind -regtest -daemon -rpcuser=tachi -rpcpassword=tachi \
  -rpcport=18443 -fallbackfee=0.0001 -txindex=1
bitcoin-cli -regtest -rpcuser=tachi -rpcpassword=tachi createwallet dev
bitcoin-cli -regtest -rpcuser=tachi -rpcpassword=tachi -generate 101  # mature coinbase

npm install @tachibtc/taurus-vault-core @tachibtc/taurus-wallet-aggregator
```

```ts
// 1. wallet
const rpc = new BitcoinCoreRpcClient({ url: "https://rpc-regtest.tachibtc.com/" });
const aggregator = WalletAggregator.fromMnemonic(MNEMONIC, { network: "regtest", rpc });
const userWallet = aggregator.addAccount({ addressType: "p2wpkh" });

// 2. vault (validator keys fetched automatically)
const vault = await createVault({
  network: "regtest",
  userWallet,
  validators: { endpoint: "https://rpc-regtest.tachibtc.com/tachi_validators" },
});
verifyVaultP2tr(vault.p2tr);

// 3. deposit
await userWallet.sync();
const deposit = await depositToVault({
  vault, userWallet, rpc, amountSats: 100_000n, feeRateSatVb: 2,
});

// 4. schnorr signer
const keystore = Keystore.fromMnemonic(MNEMONIC, "", getNetwork("regtest"), "p2wpkh", 0);
const node = keystore.signerFor(false, 0);
const userSigner = {
  publicKey:  Buffer.from(node.publicKey),
  sign:       (h) => Buffer.from(node.sign(h)),
  signSchnorr:(h) => Buffer.from(node.signSchnorr!(h)),
};

// 5. PSBT: build → verify → sign → finalize
const built = buildVtxoPsbt({
  vault,
  inputs:  [{ txid: deposit.txid, vout: 0, valueSats: 100_000n,
              scriptPubKey: vault.p2tr.output.toString("hex") }],
  outputs: [{ address: "bcrt1p...", valueSats: 40_000n },
            { address: vault.p2tr.address, valueSats: 59_000n }],
  feeSats: 1_000n,
});
const feeOpts = { maxFeeSats: 10_000n };
verifyVtxoPsbt(built.psbt, vault, feeOpts);
await signVtxoPsbtAsUser(built.psbt, userSigner, vault, feeOpts);
finalizeVtxoPsbt(built.psbt, vault, feeOpts);

// 6. register the deposit on the Tachi ledger
const depositDraft = buildTachiTxDeposit({
  userXOnly: userSigner.publicKey, amountSats: 100_000n, nonce: 0n, feeSats: 2n,
});
const depositTachi = await signTachiTx(depositDraft, userSigner);
await broadcastTachiTx(depositTachi, { url: `${TACHI_URL}/tachi_txBroadcastSync` });
const vtxoId = vtxoIdFromDeposit(depositTachi, 0);
await waitForVtxoCommit(vtxoId, { baseUrl: TACHI_URL, overallTimeoutMs: 60_000,
                                  pollIntervalMs: 1_500 });

// 7. broadcast the transfer
const draft = buildTachiTxTransfer({
  vault,
  inputs: [{ txid: deposit.txid, vout: 0, valueSats: 100_000n,
             scriptPubKey: vault.p2tr.output.toString("hex"), vtxoId }],
  outputs: built.outputs, feeSats: 1_000n, nonce: 1n, psbt: built.psbt,
});
await broadcastTachiTx(await signTachiTx(draft, userSigner),
                       { url: `${TACHI_URL}/tachi_txBroadcastSync` });
```

**Nonces are sequential per account** — the engine must track them or concurrent
operations will collide.

### Inspecting the exit path (the money shot in both demos)
```ts
const { exitLeaf, exitControlBlock } = vault.p2tr;
exitLeaf.csvBlocks;                                  // 1008
exitLeaf.userKey.equals(vault.userKey.xOnly);        // true — it is YOUR key
describeTapscript(exitLeaf.script);
```

---

## 8. Sources

- https://tachibtc.com/hackathon
- https://tachibtc.com
- https://docs.tachibtc.com (Getting Started, Go Getting Started, VTXO Quickstart,
  Tutorial, API Reference, Go API Reference, RPC Reference, Taurus Vault Core)
- npm registry: `@tachibtc/*`
- Direct HTTP probes of `rpc-regtest.tachibtc.com` and `rpc-signet.tachibtc.com`
