# syntax=docker/dockerfile:1
# Ops Pulse SPA (apps/web) built with Node and served by Nginx, both on Red Hat UBI 9.
# Build context: the repository root, e.g.
#   docker build -f deploy/docker/web.Dockerfile -t ops-pulse/web:local .

ARG NODE_BUILDER_IMAGE=registry.access.redhat.com/ubi9/nodejs-22:1
ARG NGINX_IMAGE=registry.access.redhat.com/ubi9/nginx-126:1

# ---- build: Vite production bundle ----------------------------------------------------------
FROM ${NODE_BUILDER_IMAGE} AS build
WORKDIR /opt/app-root/src
COPY --chown=1001:0 apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=1001:0 apps/web/ ./
RUN npm run build

# ---- runtime: Nginx, static files owned by root and read-only for the nginx user -------------
FROM ${NGINX_IMAGE} AS runtime
ARG APP_VERSION=0.0.0-local
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="ops-pulse-web" \
      org.opencontainers.image.description="Ops Pulse SPA (React 19, Vite, ECharts) served by Nginx" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="UNLICENSED"

USER 0
# Replace the image's main config: ours runs unprivileged with pid and temp files under /tmp,
# so the container also works with a read-only root filesystem (docker-compose.prod.yml).
COPY deploy/nginx/nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/ops-pulse.conf /etc/nginx/conf.d/ops-pulse.conf
COPY deploy/nginx/snippets/ /etc/nginx/snippets/
COPY --from=build /opt/app-root/src/dist /usr/share/nginx/ops-pulse
# No `nginx -t` here: the upstream host `api` only resolves on the Compose network.
RUN rm -f /etc/nginx/conf.d/default.conf \
 && chmod -R a+rX,go-w /usr/share/nginx/ops-pulse /etc/nginx
USER 1001

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD ["curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:8080/healthz"]

CMD ["nginx", "-g", "daemon off;"]
