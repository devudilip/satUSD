#!/bin/sh
# Entrypoint for Dockerfile.hosted: private regtest node + vault app in one container.
set -e

# bitcoind RPC stays on localhost — only the app's port is exposed.
bitcoind -regtest -daemon -server=1 -txindex=1 -fallbackfee=0.0001 \
  -rpcbind=127.0.0.1 -rpcallowip=127.0.0.1 -rpcport=18443 \
  -rpcuser="$BITCOIN_RPC_USER" -rpcpassword="$BITCOIN_RPC_PASSWORD"

cli() { bitcoin-cli -regtest -rpcport=18443 -rpcuser="$BITCOIN_RPC_USER" -rpcpassword="$BITCOIN_RPC_PASSWORD" "$@"; }
i=0
until cli getblockchaininfo >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "bitcoind did not start"; exit 1; }
  sleep 1
done
echo "[hosted] bitcoind ready"

pnpm bootstrap

# Render / Railway / Fly hand the app its port in $PORT.
export APP_PORT="${PORT:-${APP_PORT:-4120}}"
exec pnpm app
