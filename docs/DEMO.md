# satUSD — 5-Minute Demo Script

Run on **regtest** so blocks can be mined on demand. Have `TACHI_NETWORK=signet`
ready in a second terminal to show the same app against public signet.

**The thesis, stated up front and proven at the end:** *the protocol is a real
co-signer on your collateral — that's what makes liquidation real — and you're
still holding a fully signed transaction that gets every satoshi back to you,
unilaterally, even if we disappear.*

See [`COLLATERAL-MODEL.md`](COLLATERAL-MODEL.md) for the design this demo
proves; every beat below maps to a script that already runs green against
live regtest.

---

### 0:00 — Frame it (20s)

> "satUSD is a stablecoin backed by native Bitcoin, with a joint Bitcoin key
> instead of a smart contract — because Tachi doesn't have one. I'll mint
> against it, crash the price and watch a real liquidation happen, then kill
> our own servers and show the borrower still gets their Bitcoin back."

### 0:20 — Native BTC custody, jointly held (40s)

- `openCollateral()` → show the **P2TR address on Bitcoin regtest**
- Show the tap tree: NUMS-disabled key path, cooperative leaf (quorum-cosigned),
  exit leaf (CSV timelock) — **both spend through a MuSig2 key that's you and us
  together**, not either alone
- Deposit BTC, mine a block, confirm the balance via `bitcoind` `scantxoutset` —
  independent of the Tachi ledger's validator quorum for something this basic
- **Before anything else happens**, show the borrower receiving `exitTxHex` —
  a fully agg-signed transaction, held on their side, right now, with zero
  satUSD issued yet

> "That's a Taproot output on Bitcoin, and the borrower already has their exit
> in hand. Nothing was wrapped, nothing was bridged, and nothing was minted
> before they had it."

### 1:00 — Mint (50s)

- `cdpEngine.confirmExitTxDelivered()` then `mint()` — the engine physically
  refuses to mint before that call happens (`packages/engine/src/cdp.ts`)
- Mint against the vault → position opens comfortably over 150% CR
- Show the committed liquidation state: the split (`shareSats` /
  `priceLiqUsdCents`), and — this is the beat to linger on — **the exact txid
  that will hit Bitcoin if this position is ever liquidated, announced right
  now, before the price has moved at all**

> "That number is real. If this position ever crosses 130%, that's the txid
> that fires — not 'trust our liquidation engine,' the actual transaction hash."

### 1:50 — Proof of reserves (60s) — *the credibility beat*

- Open `/reserves`: every CDP's vault address, live Bitcoin balance, current
  state number, and its **liquidation txid-to-be**
- Press **"Verify it yourself"** → recomputed **client-side from public RPC, with
  zero calls to our server** → matches

> "You don't have to trust our backend for any of this — not the balance, not
> the liquidation number, not the transaction that will fire."

- Download the JSON attestation

### 2:50 — Real liquidation (60s)

- Drop the oracle price past the 130% threshold (`DevPriceFeed.setPrice`)
- The **keeper bot — a separate process, nothing but `POST /cdp/:id/liquidate`,
  no in-process access, no privileged path** — is already polling; its next
  attempt succeeds
- The engine's own price check (`routes.ts`) is what decided, not the keeper —
  a keeper hitting this endpoint on a *healthy* position just gets refused
- Show the broadcast txid on screen — **it's the same one announced at mint time**
- `pnpm demo:liquidate` runs this whole beat end to end and asserts the match itself

> "Nobody signed anything just now. That refund was cosigned when the loan
> opened. The keeper just told Bitcoin to accept a transaction that was
> already fully valid."

### 3:50 — Repay / close (30s)

- On a *different*, healthy CDP: repay the debt, then close → a final
  agg-signed state pays the full remaining balance back to the borrower's own
  wallet, broadcast for real
- Note honestly: closing needs the borrower's cooperation too (same as any
  state) — neither side can close a channel alone

### 4:20 — ⭐ Unilateral exit (60s) — *the closer*

> "Now the part no wrapped-BTC stablecoin can do — even though we were a real
> co-signer on this vault the entire time."

1. **Kill the engine process on stage**, and the borrower's MuSig2 responder
   process too. Show both gone — no cooperation is possible from here.
2. `pnpm demo:exit` (`scripts/05-spike-exit-presigned.ts`):
   - prints the exit leaf's CSV term
   - `describeTapscript(exitLeaf.script)` for the audience
   - notes the owner key is the MuSig2 aggregate — say so plainly
3. Mine past the term
4. Broadcast the borrower's already-held `exitTxHex` — **bytes signed once, at
   open, days ago on stage-time; broadcasting needs no signature from anyone,
   now, ever**
5. Show the BTC landing in the borrower's own wallet

> "The protocol is dead, and the borrower still has their Bitcoin — not
> despite the protocol being a real co-signer, but with it having been one the
> whole time. That's the difference between this and a promise."

### 5:20 — Close (20s)

- Flip to `TACHI_NETWORK=signet`, show the app live against `tachi-signet-1`
- State the architecture honestly: Tachi has no developer-facing SatVM or EVM
  today. This is programmable collateral built from the primitives Tachi does
  ship — TAURUS vaults, a MuSig2 owner key, quorum-cosigned commitments,
  HAT/RIP-anchored ledger entries — not a fabricated contract story.

---

## Pre-flight

- [ ] `bitcoind -regtest` running (**`-txindex=1`**); wallet funded; 101+ blocks mined
- [ ] `pnpm spike` passes — SDK path is live
- [ ] `pnpm test` green
- [ ] `pnpm demo:liquidate` rehearsed end to end — confirm the announced and
      broadcast txids match on the actual run, not just in principle
- [ ] `pnpm demo:exit` **rehearsed with the engine AND the borrower's MuSig2
      responder both actually killed**
- [ ] Mining the CSV term timed (pre-mine most of it, mine the last few live)
- [ ] Signet terminal ready
- [ ] Every UI money figure has a working proof/txid link — judges will click one

## If something breaks

- **Cooperative path fails / validators down** → pivot straight to the exit demo. It
  needs no validators, and it is the stronger story anyway.
- **Ledger unreachable** → run against a local snapshot, say so plainly, and show
  the exit demo, which only needs Bitcoin.
- **Never** claim a component works if it does not. The honest-architecture framing is
  the whole pitch; one overstatement costs more than any missing feature.
