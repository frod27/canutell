# CANUTELL game server (docs/ALPHA.md). Build from the repo root:
#   docker build -f apps/server/Dockerfile -t canutell-server .
# Runs as one long-lived process: matches live in memory, so run exactly one instance (not serverless).

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @canutell/server...
RUN pnpm --filter @canutell/server build

FROM node:22-slim
WORKDIR /app
COPY --from=build /repo/apps/server/dist ./dist
ENV NODE_ENV=production \
    CANUTELL_MIGRATIONS_DIR=/app/dist/migrations \
    PORT=8787 \
    HOST=::
EXPOSE 8787
USER node
# `node dist/db-cli.mjs <migrate|status|invite|report|integrity|…>` runs the operator CLI in the same image.
CMD ["node", "--enable-source-maps", "dist/server.mjs"]
