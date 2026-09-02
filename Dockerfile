# satUSD — engine + dashboard, containerized for a simple local demo.
# bitcoind runs as its own service (see docker-compose.yml) — Tachi's hosted
# regtest has no bitcoind attached, so a local one is required regardless of
# how you run this (docs/BACKGROUND.md).
FROM node:22-slim

RUN corepack enable

WORKDIR /app

# Install first, from just the manifests, so dependency layers cache across
# rebuilds when only source files change.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/tachi-kit/package.json packages/tachi-kit/package.json
COPY packages/engine/package.json packages/engine/package.json
RUN pnpm install --frozen-lockfile

COPY . .

ENV TACHI_NETWORK=regtest
EXPOSE 4110

CMD ["sh", "-c", "pnpm bootstrap && pnpm demo"]
