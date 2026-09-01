# satUSD — 5-Minute Demo Script

Run on **regtest** so blocks can be mined on demand. Have `TACHI_NETWORK=signet`
ready in a second terminal to show the same app against public signet.

**The thesis, stated up front and proven at the end:** *your Bitcoin is yours even if
we disappear.*

---

### 0:00 — Frame it (20s)

> "satUSD is a stablecoin backed by native Bitcoin. Not wrapped BTC, not a bridge,
> not a custodian. And I'll finish by killing our own servers and showing the user
> still gets their Bitcoin back."

### 0:20 — Native BTC custody (40s)

- `createVault()` → show the **P2TR address on Bitcoin regtest**
- Show the tap tree: NUMS-disabled key path, cooperative 5-of-7 leaf, exit leaf
- `depositToVault(0.5 BTC)`, mine a block
- Show the balance confirmed via `bitcoind` `scantxoutset` — no dependency on the
  Tachi ledger's validator quorum for something this basic

> "That's a Taproot output on Bitcoin. Nothing was wrapped and nothing was bridged."

### 1:00 — Mint (50s)

- Mint 20,000 satUSD against 0.5 BTC → position opens at **250% CR**
- Show the live LTV and liquidation price
- Click through to the **HAT proof** for the mint, and the RIP anchoring it to L1

### 1:50 — Proof of reserves (60s) — *the credibility beat*

- Open `/reserves`: every protocol vault address, live Bitcoin balances, total locked
  sats vs satUSD supply, global CR
- Press **"Verify it yourself"** → recomputed **client-side from public RPC, with zero
  calls to our server** → matches

> "You don't have to trust our backend. Your browser just recomputed it from public
> Bitcoin and Tachi RPC."

- Download the JSON attestation

### 2:50 — Delinquency, honestly (60s)

- Drop the oracle price → position falls below **130%**
- Risk feed lights up; CDP is marked **delinquent** — new mints blocked, stability
  fee escalates. **No BTC moves. Nobody's collateral gets seized.**
- Say why, on stage: "TAURUS vaults need the owner's own signature on every spend,
  cooperative or exit, no exception. That's the same guarantee that makes the exit
  demo work in 90 seconds — we can't build MakerDAO-style forced liquidation on it
  without giving that guarantee up. So we didn't fake one."
- The **keeper bot is a separate process using only the public API** — it watches
  prices and flags delinquency; it has no more power than anyone else because none
  exists to grant it
- `/reserves` reports delinquent debt plainly, right next to healthy collateral

### 3:50 — Redeem (30s)

- Repay, redeem the remainder → the exact backing VTXOs unlock → BTC returns to the
  **user's own vault**, not ours

### 4:20 — ⭐ Unilateral exit (60s) — *the closer*

> "Now the part no wrapped-BTC stablecoin can do."

1. **Kill the engine process on stage.** Show the app failing — the protocol is gone.
2. `pnpm demo:exit`:
   - prints `exitLeaf.csvBlocks` → **1008**
   - asserts `exitLeaf.userKey === vault.userKey.xOnly` → **it is the user's own key**
   - `describeTapscript(exitLeaf.script)`
3. Mine 1008 blocks
4. The user sweeps their vault **with their key alone** — no validators, no protocol
5. Show the BTC landing in the user's own P2WPKH wallet

> "The protocol is dead and the user still has their Bitcoin. That's what
> self-custodial collateral actually means."

### 5:20 — Close (20s)

- Flip to `TACHI_NETWORK=signet`, show the app live against `tachi-signet-1`
- State the architecture honestly: Tachi has no developer-facing SatVM or EVM today,
  so protocol logic runs off-chain, deterministically, with Bitcoin-anchored proofs
  and a hash-chained ledger — and custody stays on Bitcoin the whole time.

---

## Pre-flight

- [ ] `bitcoind -regtest` running; wallet funded; 101+ blocks mined
- [ ] `pnpm spike` passes — SDK path is live
- [ ] `pnpm test` green
- [ ] `pnpm demo:liquidate` rehearsed end to end
- [ ] `pnpm demo:exit` **rehearsed with the engine actually killed**
- [ ] Mining 1008 blocks timed (pre-mine to ~1000 and mine the last few live)
- [ ] Signet terminal ready
- [ ] Every UI money figure has a working proof/txid link — judges will click one

## If something breaks

- **Cooperative path fails / validators down** → pivot straight to the exit demo. It
  needs no validators, and it is the stronger story anyway.
- **Ledger unreachable** → run against a local snapshot, say so plainly, and show
  the exit demo, which only needs Bitcoin.
- **Never** claim a component works if it does not. The honest-architecture framing is
  the whole pitch; one overstatement costs more than any missing feature.
