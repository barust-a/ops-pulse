#!/usr/bin/env bash
# Deploys one Ops Pulse release with Docker Compose and checks it works.
#
#   deploy.sh --tag 3f9c2ab1          # server: pull registry images for that tag
#   deploy.sh --local                 # laptop: build images from the working tree
#   deploy.sh --tag v0.1.0 --skip-migrate   # used by rollback.sh
#
# Steps: pull (or build) → start postgres → run migrations → start api, then web, waiting for
# their health checks → smoke-test through Nginx → record the release for rollback.sh.
# Exit code 0 only when the smoke test passed.
set -euo pipefail

# shellcheck source=deploy/scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
}

tag=""
skip_migrate=0
wait_timeout_s="${DEPLOY_WAIT_TIMEOUT_S:-180}"

while (($# > 0)); do
  case "$1" in
    --tag)
      [[ $# -ge 2 ]] || die "--tag needs a value"
      tag="$2"
      shift 2
      ;;
    --local)
      OPS_PULSE_LOCAL=1
      shift
      ;;
    --skip-migrate)
      skip_migrate=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
done

require_prerequisites

if [[ "$OPS_PULSE_LOCAL" == "1" ]]; then
  export OPS_PULSE_TAG="${tag:-local}"
  log "building images from the working tree (tag $OPS_PULSE_TAG)"
  compose build
else
  [[ -n "$tag" ]] || die "--tag is required on a server (commit short SHA or vX.Y.Z)"
  [[ "$tag" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || die "invalid tag: $tag"
  export OPS_PULSE_TAG="$tag"
  log "pulling images for tag $OPS_PULSE_TAG"
  compose pull --quiet
fi

log "starting postgres"
compose up -d --wait --wait-timeout "$wait_timeout_s" postgres

if [[ "$skip_migrate" == "1" ]]; then
  log "skipping migrations (rollback: the schema stays expanded, see docs/migration)"
else
  log "applying database migrations"
  compose run --rm --no-deps migrate
fi

log "starting api"
compose up -d --no-deps --wait --wait-timeout "$wait_timeout_s" api
log "starting web"
compose up -d --no-deps --wait --wait-timeout "$wait_timeout_s" web

web_port="$(sed -n 's/^WEB_PORT=\([0-9]\{1,5\}\)$/\1/p' "$COMPOSE_DIR/.env" | tail -n 1)"
base_url="http://127.0.0.1:${web_port:-8080}"

log "smoke test on $base_url"
curl -fsS --max-time 10 "$base_url/healthz" >/dev/null || die "web /healthz failed"
health="$(curl -fsS --max-time 10 "$base_url/api/v1/health")" || die "api /api/v1/health failed"
grep -q '"status":"ok"' <<<"$health" || die "api health is not ok: $health"
grep -q '"db":"up"' <<<"$health" || die "api reports the database down: $health"
index_html="$(curl -fsS --max-time 10 "$base_url/")" || die "the SPA index.html was not served"
grep -qi '<script type="module"' <<<"$index_html" || die "the response at / is not the SPA index.html"

if [[ "$OPS_PULSE_LOCAL" != "1" ]]; then
  mkdir -p "$STATE_DIR"
  current="$(tag_from_file "$STATE_DIR/release.env" || true)"
  if [[ -n "$current" && "$current" != "$OPS_PULSE_TAG" ]]; then
    printf 'OPS_PULSE_TAG=%s\n' "$current" >"$STATE_DIR/previous.env"
  fi
  printf 'OPS_PULSE_TAG=%s\n' "$OPS_PULSE_TAG" >"$STATE_DIR/release.env"
fi

log "release $OPS_PULSE_TAG is live: $health"
