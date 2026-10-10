# syntax=docker/dockerfile:1
# Ops Pulse REST API (apps/api) on Red Hat UBI 9.
# Build context: the repository root, e.g.
#   docker build -f deploy/docker/api.Dockerfile -t ops-pulse/api:local .
# The same image runs the API, the migrator and the seed (see deploy/compose/docker-compose.yml).

ARG NODE_BUILDER_IMAGE=registry.access.redhat.com/ubi9/nodejs-22:1
ARG NODE_RUNTIME_IMAGE=registry.access.redhat.com/ubi9/nodejs-22-minimal:1

# ---- build: full toolchain, dev dependencies, TypeScript compile ----------------------------
FROM ${NODE_BUILDER_IMAGE} AS build
WORKDIR /opt/app-root/src
COPY --chown=1001:0 apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=1001:0 apps/api/ ./
RUN npm run build

# ---- runtime: minimal image, production dependencies only, non-root --------------------------
FROM ${NODE_RUNTIME_IMAGE} AS runtime
ARG APP_VERSION=0.0.0-local
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="ops-pulse-api" \
      org.opencontainers.image.description="Ops Pulse REST API (Express 5, TypeScript)" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="UNLICENSED"

WORKDIR /opt/app-root/src
ENV NODE_ENV=production \
    PORT=3000 \
    APP_VERSION=${APP_VERSION} \
    MIGRATIONS_DIR=/opt/app-root/src/db/migrations \
    NPM_CONFIG_UPDATE_NOTIFIER=false

USER 1001
COPY --chown=1001:0 apps/api/package.json apps/api/package-lock.json ./
# --ignore-scripts: no install hook of a production dependency runs at build time.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build --chown=1001:0 /opt/app-root/src/dist ./dist
COPY --chown=1001:0 db/migrations ./db/migrations

EXPOSE 3000
# Node itself probes the health endpoint: the minimal image ships no curl guarantee.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/server.js"]
