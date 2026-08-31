# Tachi API Cheat Sheet

Only what is **confirmed to exist**. Probed 2026-08-31 — see [`BACKGROUND.md`](BACKGROUND.md) §5.

## Install (pin — everything is v0.x)

```bash
pnpm add @tachibtc/tachi-sdk-ts@0.2.1 \
         @tachibtc/taurus-vault-core@0.3.4 \
         @tachibtc/taurus-wallet-aggregator@0.4.5
```

The published `dist/index.d.ts` in each package is the real spec — richer than the
docs site. Read it when in doubt.

## Networks

| | regtest | signet |
|---|---|---|
| Ledger RPC | `https://rpc-regtest.tachibtc.com` | `https://rpc-signet.tachibtc.com` |
| `chain_id` | `tachi-regtest-1` | `tachi-signet-1` |
| bitcoind proxy (`POST /`) | **404 — run local bitcoind** | **works** |
| Blocks | mine on demand | ~10 min |
| Use for | liquidation + exit demos | judge-verifiable reserves |

```bash
bitcoind -regtest -daemon -rpcuser=tachi -rpcpassword=tachi \
  -rpcport=18443 -fallbackfee=0.0001
bitcoin-cli -regtest -rpcuser=tachi -rpcpassword=tachi createwallet dev
bitcoin-cli -regtest -rpcuser=tachi -rpcpassword=tachi -generate 101
```

## HTTP routes — VERIFIED

camelCase with a `tachi_` prefix. Guessing names gets you a 404.

| Route | Returns |
|---|---|
| `GET /health` | `{status, validators}` |
| `GET /tachi_stats` | `{height, total_transactions, current_epoch, node_count, chain_id, latest_block_time, total_supply_sat, vtxo_count}` |
| `GET /tachi_supply` | `{total_supply_sat, vtxo_count}` |
| `GET /tachi_validators` | 7 validators: `{peer_id, pub_key_hex, host?, p2p_port?, rpc_addr?}` |
| `GET /tachi_listVtxos?page&page_size` | `{vtxos[], total, page, page_size, total_pages}` |
| `GET /tachi_mempool` | `{transactions[], count}` |
| `GET /tachi_feeEstimate` | `{min_fee_sat, avg_fee_sat, recommended_fee_sat}` |
| `GET /tachi_listTransactions` | list |
| `POST /tachi_txBroadcastSync` | broadcast a signed Tachi tx |
| `POST /` | Bitcoin JSON-RPC 1.0 proxy `{id, jsonrpc, method, params}` |

**404 (wrong names):** `tachi_vtxos`, `tachi_blocks`, `tachi_watchtowerStatus`.

## VTXO object

```json
{"id":"35b60b9e…","owner":"6267b312…","amount":10000,
 "spent":false,"height":583148,"script":"","locked":false}
```

`owner` is a Schnorr **x-only pubkey** — use it as the single user identity across the
whole system. `amount` is sats. **`locked` is the collateral escrow primitive.**

## `TachiClient` — the methods that matter

```ts
const tachi = new TachiClient({ baseUrl, timeoutMs });
```

**Collateral** `getLockedVtxos(vault)` · `getVtxo(id)` · `listVtxos(params?)` ·
`getAddressVtxos(address, includeSpent?)`
**Proofs** `getTransaction(hash, { hat, rip, vtxoId, originEpoch, finalEpoch })` ← the
HAT/RIP receipts behind proof-of-reserves
**Live events** `watch({ address?|vault?|vaultId?|blocks?|validators? }, { signal })` →
async generator. Use instead of polling.
**Watchtower** `getWatchtowerStatus()` · `getWatchtowerReceipts({ vault?, state? })` →
L1 spend observations; detects users attempting exits
**Vaults** `listVaults(user, { page, page_size, apiKey })` · `signTransaction(refund)`
**Accounts** `getAddress` · `getBalance` · `getNonce` ← nonces are sequential; serialize
**Tx** `broadcastTxSync` · `broadcastTxAsync` · `getRawTransaction` · `listTransactions`
· `decodeTransaction` · `validateTransaction` · `getAddressTransactions(address,
{ pageSize, beforeHeight })` ← the feature source for Kōsen's credit scoring
**Chain** `getBlockByHeight` · `getBlock` · `getBlockHash` · `getBlockHeader` ·
`listBlocks` · `getEpoch` · `listEpochs` · `getConsensusState`
**Health** `getHealth` · `getStatus` · `getNodeInfo` · `getStats` · `getSupply` ·
`search(q)` · `getMempool` · `getFeeEstimate` · `bitcoinRPC(request)`
**Validators** `getValidators` · `getLiveValidators` · `getValidatorCount` ·
`waitForValidatorsReady(expected?)` · `getValidatorsPower` · `getPeerInfo`

### Not available — do not look for these
Asset issuance · token creation · contract deployment or execution · EVM · SatVM ·
script compilation · x402 · multi-party vault state beyond basic locking.

## TAURUS vault

P2TR, NUMS-disabled key path, two-leaf tap tree:
- **cooperative leaf** — user + **5-of-7 validators**, no timelock → instant settlement
- **exit leaf** — user's key alone after **1008-block CSV** → unilateral withdrawal

```ts
const vault = await createVault({
  network: "regtest",
  userWallet,
  validators: { endpoint: `${TACHI_URL}/tachi_validators` },
});
verifyVaultP2tr(vault.p2tr);

await userWallet.sync();
const deposit = await depositToVault({
  vault, userWallet, rpc, amountSats: 100_000n, feeRateSatVb: 2,
});

// exit path — the demo
const { exitLeaf, exitControlBlock } = vault.p2tr;
exitLeaf.csvBlocks;                             // 1008
exitLeaf.userKey.equals(vault.userKey.xOnly);   // true — the USER's key
describeTapscript(exitLeaf.script);
```

`/health` may report `validators: 1` while `node_count` is 7. Check
`getLiveValidators()` before relying on the cooperative path. **The exit path always
works** — that is the guarantee.

## Canonical VTXO sequence

Seven calls, in order. Wrap once in `tachi-kit/vtxo.ts`; never inline.

```ts
buildVtxoPsbt({ vault, inputs, outputs, feeSats })
verifyVtxoPsbt(psbt, vault, { maxFeeSats })
await signVtxoPsbtAsUser(psbt, userSigner, vault, feeOpts)
finalizeVtxoPsbt(psbt, vault, feeOpts)

// register the deposit on the ledger
const draft = buildTachiTxDeposit({ userXOnly, amountSats, nonce, feeSats });
await broadcastTachiTx(await signTachiTx(draft, userSigner),
                       { url: `${TACHI_URL}/tachi_txBroadcastSync` });
const vtxoId = vtxoIdFromDeposit(depositTachi, 0);
await waitForVtxoCommit(vtxoId, { baseUrl: TACHI_URL, overallTimeoutMs: 60_000,
                                  pollIntervalMs: 1_500 });

// transfer
buildTachiTxTransfer({ vault, inputs: [{ …, vtxoId }], outputs, feeSats, nonce, psbt })
```

Signer shape:
```ts
const keystore = Keystore.fromMnemonic(MNEMONIC, "", getNetwork(net), "p2wpkh", 0);
const node = keystore.signerFor(false, 0);
const userSigner = {
  publicKey:   Buffer.from(node.publicKey),
  sign:        (h) => Buffer.from(node.sign(h)),
  signSchnorr: (h) => Buffer.from(node.signSchnorr!(h)),
};
```

## Gotchas

1. **Nonces are sequential per account** — serialize, or concurrent ops collide.
2. **Regtest bitcoind proxy 404s** — run a local node.
3. **Route names are camelCase** with a `tachi_` prefix.
4. **All amounts are `bigint` sats** — never floats.
5. **v0.x SDKs** — pin exact versions; expect breaking changes.
6. **`allowInsecureHttp: true`** appears in the quickstart's broadcast options; needed
   in some local setups.
