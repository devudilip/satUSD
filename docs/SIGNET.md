# Running on signet

`TACHI_NETWORK=signet` is the default in `.env.example`. Everything runs
against Tachi's public signet deployment, so no local bitcoind is needed.

| | regtest | signet |
|---|---|---|
| Tachi ledger | `rpc-regtest.tachibtc.com` (`tachi-regtest-1`) | `rpc-signet.tachibtc.com` (`tachi-signet-1`) |
| Bitcoin node | your local bitcoind | Tachi's hosted proxy on the same URL |
| Blocks | mined on demand | real, about every 10 minutes |
| Coins | `pnpm bootstrap` mines them | a faucet |
| Demo term (exit CSV) | 144 blocks | 3 blocks (about 30 minutes) |
| Demo deposit | 300,000 sats | 300,000 sats |
| Verify | `bitcoin-cli` | any signet explorer, e.g. mempool.space/signet |

## Steps

```bash
pnpm install
pnpm signet:wallet   # creates DEMO_MNEMONIC_SIGNET in .env, prints the address
```

Fund the printed address from https://faucet.tachibtc.com with at least
0.01 sBTC. Wait one block, then re-run `pnpm signet:wallet` until it says ready.

```bash
pnpm demo:signet     # the whole story on public signet, about an hour
```

`pnpm demo:regtest` still runs the original one-minute regtest version.

## What changes on signet

- **Blocks are waited for, not mined.** The tachi-kit helpers in
  `packages/tachi-kit/src/chain.ts` mine on regtest and poll on signet, so the
  scripts are identical on both networks.
- **The proxy refuses some RPCs.** `generatetoaddress`, `testmempoolaccept`
  and `listunspent` return "method not permitted". The "exit is not valid
  yet" check therefore really broadcasts on signet, and is only run while
  the timelock cannot have matured.
- **`scantxoutset` is shared.** Bitcoin Core runs one scan at a time per
  node, and every hackathon team uses the same node. The kit's RPC client
  retries "Scan already in progress" for up to two minutes.
- **Use a private mnemonic.** The regtest phrase is the public BIP-39 test
  vector, and anyone can sweep coins sent to it on a public network.

## Overrides

| Variable | Default | Effect |
|---|---|---|
| `DEMO_CSV_BLOCKS` | 144 regtest, 3 signet | Loan term and exit timelock |
| `DEMO_DEPOSIT_SATS` | 300,000 on signet | Collateral per vault |

The numbered spike scripts (`01`–`06`) stay pinned to regtest. They check
mempool acceptance repeatedly without broadcasting, which signet's proxy
cannot do.
