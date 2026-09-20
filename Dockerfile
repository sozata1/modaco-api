# syntax=docker/dockerfile:1
#
# One image, three services (api / projector / ingestion-worker). They share the same
# compiled workspace, so separate images would only fragment the layer cache; the
# services differ by `command` in compose.
#
# Node 22 matches the AWS Lambda `nodejs22.x` runtime major, so the ingestion handlers
# run on the same runtime locally and in Lambda.

FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache tini
ENV NODE_OPTIONS=--enable-source-maps

# ── Dependencies ────────────────────────────────────────────────────────────
# Only the manifests are copied, so a source change does not invalidate the npm layer.
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/core/package.json     packages/core/
COPY packages/db/package.json       packages/db/
COPY apps/api/package.json          apps/api/
COPY apps/projector/package.json    apps/projector/
COPY apps/ingestion/package.json    apps/ingestion/
COPY bench/package.json             bench/
RUN --mount=type=cache,target=/root/.npm npm ci

# ── Build ───────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
COPY bench bench
RUN npm run build

# ── Production dependencies only ────────────────────────────────────────────
FROM deps AS prod-deps
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ── Runtime image ───────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build     /app/package.json ./package.json
COPY --from=build     /app/packages     ./packages
COPY --from=build     /app/apps         ./apps
# tini as PID 1 forwards signals properly. Graceful shutdown depends on it: with
# npm or sh in between, SIGTERM is swallowed and the container is killed instead.
ENTRYPOINT ["/sbin/tini", "--"]
USER node
CMD ["node", "apps/api/dist/server.js"]
