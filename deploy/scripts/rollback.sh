#!/usr/bin/env bash
# Rolls Ops Pulse back to the previous release (or to the tag given), without touching the
# database schema: migrations are expand-only within a release, so the previous image runs on
# the current schema (docs/migration/migration-plan.md). Restoring data is a separate,
# deliberate step (docs/ops/maintenance.md, "Restore").
#
#   rollback.sh              # back to .deploy/previous.env
#   rollback.sh 3f9c2ab1     # to an explicit image tag
set -euo pipefail

# shellcheck source=deploy/scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

target="${1:-}"
if [[ -z "$target" ]]; then
  target="$(tag_from_file "$STATE_DIR/previous.env" || true)"
  [[ -n "$target" ]] || die "no previous release recorded in $STATE_DIR/previous.env; pass a tag"
fi

current="$(tag_from_file "$STATE_DIR/release.env" || true)"
[[ "$target" != "$current" ]] || die "release $target is already running"

log "rolling back from ${current:-unknown} to $target"
exec "$(dirname "${BASH_SOURCE[0]}")/deploy.sh" --tag "$target" --skip-migrate
