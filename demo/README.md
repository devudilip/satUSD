# satUSD — demo

**Video (2:11):** [satusd-demo.mp4](https://github.com/devudilip/satUSD/raw/main/demo/satusd-demo.mp4) — click to play in the browser.

Recorded 2026-10-03 from a live `pnpm demo` run against `rpc-regtest.tachibtc.com` plus a local `bitcoind -regtest`. Every txid shown is real.

## Screenshots

| | |
|---|---|
| ![](01-dashboard-liquidated.png) Engine dashboard — first CDP liquidated by a public-API keeper; the liquidation txid matches the one announced at mint | ![](02-dashboard-two-cdps-engine-killed.png) Second CDP open, engine killed for the exit demo |
| ![](04-how-it-works.png) How it works | ![](05-terminal-liquidation.png) Live transcript: open → mint → proof of reserves → crash → liquidation |
| ![](06-terminal-exit.png) The closer: engine gone, borrower broadcasts the pre-signed exit | ![](07-proven.png) What was proven |
