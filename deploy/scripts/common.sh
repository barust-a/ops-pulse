#!/usr/bin/env bash
# Shared helpers for deploy.sh, rollback.sh and backup-db.sh. Source it; do not run it.
#
# Layout on a server (docs/ops/installation.md):
#   /opt/ops-pulse/deploy/compose/.env          secrets and settings, mode 600, root-owned
#   /opt/ops-pulse/.deploy/release.env          OPS_PULSE_TAG of the running release
#   /opt/ops-pulse/.deploy/previous.env         OPS_PULSE_TAG of the release before it

# Exported so a script exec'd from another one (rollback.sh → deploy.sh) sees the same paths.
OPS_PULSE_HOME="${OPS_PULSE_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export OPS_PULSE_HOME
export COMPOSE_DIR="$OPS_PULSE_HOME/deploy/compose"
export STATE_DIR="$OPS_PULSE_HOME/.deploy"
# OPS_PULSE_LOCAL=1: laptop mode, base Compose file only (images built locally, demo seed).
OPS_PULSE_LOCAL="${OPS_PULSE_LOCAL:-0}"

log() {
  printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${0##*/}" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

compose() {
  local files=(-f "$COMPOSE_DIR/docker-compose.yml")
  if [[ "$OPS_PULSE_LOCAL" != "1" ]]; then
    files+=(-f "$COMPOSE_DIR/docker-compose.prod.yml")
  fi
  docker compose --project-directory "$COMPOSE_DIR" "${files[@]}" "$@"
}

require_prerequisites() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed"
  [[ -f "$COMPOSE_DIR/.env" ]] || die "missing $COMPOSE_DIR/.env (start from .env.example)"
}

# Reads OPS_PULSE_TAG from a release file without sourcing it (it is data, not code).
tag_from_file() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  sed -n 's/^OPS_PULSE_TAG=\([A-Za-z0-9._-]\{1,128\}\)$/\1/p' "$file" | tail -n 1
}
