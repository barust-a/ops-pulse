# Maintenance guide

Recurring tasks to keep Ops Pulse secure, fast and recoverable. `opc` is the Compose alias from
the [operations runbook](operations.md).

| Task                              | Frequency            | Owner          |
| --------------------------------- | -------------------- | -------------- |
| Check backups ran and restore test | daily / quarterly   | run team       |
| Dependency and base-image updates | monthly (critical CVE: within 72 h) | dev team |
| PostgreSQL health (bloat, vacuum, indexes) | monthly     | dev + DBA      |
| Retention purge                   | monthly              | dev team (manual in v0.1) |
| `JWT_SECRET` and DB password rotation | yearly, or on suspicion | run + dev |
| Certificate renewal (TLS)         | before expiry        | run team       |

## Releases and rollback

```sh
sudo /opt/ops-pulse/deploy/scripts/deploy.sh --tag v0.2.0     # or the GitLab "deploy_production" job
sudo /opt/ops-pulse/deploy/scripts/rollback.sh                 # back to the previous recorded tag
sudo /opt/ops-pulse/deploy/scripts/rollback.sh 3f9c2ab1        # or to an explicit tag
```

Rollback re-deploys the previous images **without** reverting the schema: migrations follow
expand → migrate → contract, so release N−1 runs on release N's schema
([migration rules](../migration/migration-plan.md#4-schema-migration-rules)). If data must be
restored, use [Restore](#restore) deliberately.

## Dependency updates

1. Branch `chore/deps-YYYY-MM`.
2. Node apps: `npm outdated`, then `npm update` (minor/patch) and one major at a time with its
   migration guide; `npm audit --omit=dev`.
3. Dataiku: bump pins in `dataiku/pyproject.toml`, `uv lock`, regenerate `requirements.txt`
   with `uv export --no-dev --no-hashes`; keep the DSS code environment in sync.
4. Base images: the `:1` UBI tags move with Red Hat errata; the pipeline rebuilds on every merge
   to `main` — trigger it monthly even without code changes. Production may pin digests
   (`image@sha256:…`) for strict reproducibility.
5. All gates green, staging deploy, then a normal release.

## Backups

- `ops-pulse-backup.timer` runs `deploy/scripts/backup-db.sh` daily at 05:30: `pg_dump` in custom
  format to `/var/backups/ops-pulse/ops_pulse_<UTC timestamp>.dump`, verified with
  `pg_restore --list`, dumps older than 14 days deleted.
- Copy the backup directory off-host (NFS, object storage) with the site's backup tool.
- Check: `journalctl -u ops-pulse-backup.service -n 20` and `ls -lh /var/backups/ops-pulse`.

## Restore

Rehearse quarterly on staging. On production, this is a **normal change** (data rollback).

```sh
sudo systemctl stop ops-pulse-kpi.timer
opc stop api web
opc exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --if-exists ops_pulse_restore && createdb -U "$POSTGRES_USER" ops_pulse_restore'
opc exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d ops_pulse_restore --no-owner' \
  < /var/backups/ops-pulse/ops_pulse_20261010T053000Z.dump
# Verify counts in ops_pulse_restore, then swap the databases:
opc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "ALTER DATABASE ops_pulse RENAME TO ops_pulse_old" -c "ALTER DATABASE ops_pulse_restore RENAME TO ops_pulse"'
opc up -d api web && sudo systemctl start ops-pulse-kpi.timer
```

Keep `ops_pulse_old` until the restore is confirmed, then drop it (with approval).

## PostgreSQL maintenance

Autovacuum is on by default and sufficient for this workload (append-mostly incidents, daily
upsert of the KPI table). Monthly checks:

```sql
-- Tables with many dead tuples (autovacuum lagging)
select relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
from pg_stat_user_tables where schemaname = 'ops' order by n_dead_tup desc;

-- Unused indexes (candidates for removal after a full business cycle)
select indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
from pg_stat_user_indexes where schemaname = 'ops' order by idx_scan asc;

-- Slowest statements (enable pg_stat_statements in postgresql.conf first)
select calls, round(mean_exec_time::numeric, 1) as mean_ms, query
from pg_stat_statements order by mean_exec_time desc limit 10;
```

- After a bulk load (history import, purge): `VACUUM (ANALYZE) ops.incidents;`.
- Bloated index: `REINDEX INDEX CONCURRENTLY ops.<index>;` (no write lock).
- KPI table upserts rewrite rows daily; if `n_dead_tup` stays high, lower
  `autovacuum_vacuum_scale_factor` for that table (`ALTER TABLE … SET (…)` in a migration).
- PostgreSQL minor upgrades: pull the new `postgres:16` image, `opc up -d postgres` (same data
  directory). Major upgrades (16 → 17): dump/restore or `pg_upgrade`, planned as a normal change.

## Rotating the JWT secret

Effect: every session ends (users sign in again). Plan it outside peak hours.

1. Generate: `openssl rand -base64 48`.
2. Edit `JWT_SECRET` in `/opt/ops-pulse/deploy/compose/.env` (`sudoedit`).
3. `opc up -d --no-deps --force-recreate api` and check `/api/v1/health`.
4. Log the rotation in the change record (never the value).

Database password: `ALTER ROLE ops_pulse PASSWORD '…'` through `psql` inside the container, update
`POSTGRES_PASSWORD` in `.env`, recreate `api` (and the DSS connection if DSS writes the KPIs).

## Retention purge

Records older than the retention period ([security §5](security.md#5-data-protection-gdpr--rgpd))
are to be deleted monthly in batches, followed by `VACUUM (ANALYZE)`; KPI aggregates are kept.
**Not automated in v0.1** (the demo data covers a few months): the purge job is in the backlog
for v0.2; until then it is a manual, approved operation.
