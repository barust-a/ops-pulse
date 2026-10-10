#!/usr/bin/env bash
# Dumps the ops_pulse database (pg_dump custom format), checks the dump is readable, and deletes
# dumps older than the retention. Credentials stay inside the postgres container.
#
#   backup-db.sh                                   # /var/backups/ops-pulse, keep 14 days
#   BACKUP_DIR=/srv/backups RETENTION_DAYS=30 backup-db.sh
#
# Schedule it (cron or a systemd timer) before the KPI job, e.g. daily at 05:30.
set -euo pipefail

# shellcheck source=deploy/scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

backup_dir="${BACKUP_DIR:-/var/backups/ops-pulse}"
retention_days="${RETENTION_DAYS:-14}"
[[ "$retention_days" =~ ^[0-9]+$ ]] || die "RETENTION_DAYS must be a whole number of days"

require_prerequisites
umask 077
mkdir -p "$backup_dir"

dump="$backup_dir/ops_pulse_$(date -u +%Y%m%dT%H%M%SZ).dump"
partial="$dump.partial"
trap 'rm -f "$partial"' EXIT

log "dumping database to $dump"
# The escaped variables expand inside the container, where the credentials live.
compose exec -T postgres sh -c "pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" --format=custom --no-owner" \
  >"$partial"

log "verifying the dump"
compose exec -T postgres pg_restore --list <"$partial" >/dev/null || die "the dump is not readable"
mv "$partial" "$dump"

log "deleting dumps older than $retention_days days"
find "$backup_dir" -maxdepth 1 -type f -name 'ops_pulse_*.dump' -mtime +"$retention_days" -print -delete

log "backup done: $dump ($(du -h "$dump" | cut -f1))"
