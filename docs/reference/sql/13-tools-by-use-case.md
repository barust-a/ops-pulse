# Tools by Use Case

> Part of the [SQL & PostgreSQL reference library](README.md) · Last researched: 2026-10-05 · Targets PostgreSQL 14–18 (19 beta noted where relevant)

**What this covers.** A catalog of tools for working with PostgreSQL, grouped by job: clients, plan analysis, monitoring, index advice, maintenance, pooling, backups, high availability, migrations, linting, testing, data access libraries, extensions, local development, managed hosting, data movement, and AI/MCP servers. For each tool you get what it is best for, when to choose it, its license or cost, and its status as checked in October 2026. The last section is an opinionated default toolbox for a TypeScript + PostgreSQL project. This file tells you *which tool*; the sibling documents tell you *how to do the work*.

**How to read the status column.** "Active" means releases or commits in 2025–2026. "Slow" means maintained but with few releases. "Preview" means not GA. "Deprecated" or "Retired" means do not start new work with it. "Unverified" means I could not confirm the 2026 status; check before you depend on it. Prices change often: treat every price here as an example, not a quote.

## Key rules (TL;DR)

1. Use `psql` for scripts, CI and quick checks; pick one GUI (DBeaver, DataGrip, pgAdmin or the VS Code PostgreSQL extension) for browsing.
2. Enable `pg_stat_statements` on every database. It is the first tool for any "the database is slow" question.
3. Read plans with `EXPLAIN (ANALYZE, BUFFERS)` and paste them into explain.dalibo.com or explain.depesz.com; run PEV2 locally for private plans.
4. Test index ideas with HypoPG (hypothetical indexes) before you build real ones.
5. Remove table bloat online with pg_repack or pg_squeeze, not `VACUUM FULL` (PG 19 beta adds `REPACK (CONCURRENTLY)`).
6. Put a transaction-mode pooler (PgBouncer 1.21+ or your provider's pooler) in front of PostgreSQL when you have many short-lived clients or serverless functions.
7. Use a real backup tool with point-in-time recovery (pgBackRest, Barman, WAL-G, or your provider's PITR); `pg_dump` alone is not a backup strategy. Test restores.
8. Use Patroni for HA on virtual machines and CloudNativePG on Kubernetes.
9. Lint every migration in CI with Squawk (or the Postgres Language Server).
10. Test against real PostgreSQL (Testcontainers, or PGlite for fast unit tests). Do not trust pg-mem for anything beyond trivial SQL.
11. In TypeScript, use Prisma 7 for CRUD and migrations, and drop to node-postgres or typed raw SQL for complex queries.
12. Choose a managed host by extensions (pgvector), PITR, pooling, branching, region and price model — not by free-tier size.
13. Give AI agents a dedicated read-only role with `statement_timeout`; never connect an MCP server with write rights to production.
14. Do not use the archived `@modelcontextprotocol/server-postgres`; it has a known read-only bypass.
15. Check tool status at least once a year: in 2026 alone, pgBackRest was declared unmaintained and then rescued, and Azure Data Studio was retired.

## 1. SQL clients and IDEs

| Tool | Best for | Choose it when | License / cost | Status (Oct 2026) |
|---|---|---|---|---|
| `psql` | Scripts, CI, admin, `\` meta-commands | Always installed; you need exact PostgreSQL behavior | PostgreSQL License (free) | Active (ships with PostgreSQL) |
| pgcli | Interactive terminal work with autocompletion | You live in the terminal and want completion + syntax colors | BSD-3 (free) | Active (4.x) |
| DBeaver Community | Free cross-database GUI (ER diagrams, data editor) | You want a free, full GUI on any OS | Apache-2.0 (free); paid PRO editions | Active (frequent releases) |
| DataGrip (JetBrains) | Power users: refactoring, smart completion, many DBs | You already use JetBrains IDEs or want the best SQL editor | Paid for commercial use; free for non-commercial use since Oct 2025 [47] | Active |
| pgAdmin 4 | Official PostgreSQL admin GUI (desktop or web) | You need admin dialogs, server-side web access, or Docker deployment | PostgreSQL License (free) | Active (v9.18, Sept 2026) [1] |
| VS Code PostgreSQL extension (Microsoft) | Editing SQL next to your code; plan visualizer; Copilot/MCP | Your team works in VS Code or Cursor | Free (Microsoft extension) | Active (v1.31, Sept 2026) [3]; started as a public preview in 2025 — I could not confirm a formal GA announcement [2][3] |
| TablePlus | Fast native GUI (macOS, Windows, Linux) | You want a light, quick GUI and accept a paid license | Paid; free trial with tab/window limits | Active |
| Beekeeper Studio | Simple cross-platform GUI | You want an easy open-source GUI | Community edition GPLv3; paid Ultimate [48] | Active |
| Postico 2 | Mac-native PostgreSQL client | You are on macOS and only use PostgreSQL | Paid one-time license; free evaluation | Active |
| DbGate | Desktop or self-hosted web client, many DBs | You want a browser-based client on a server | GPL-3.0; Premium adds connectors [57] | Active |
| Harlequin | Terminal UI (TUI) SQL IDE | You want a full-screen terminal IDE (DuckDB-first, Postgres adapter) | MIT (free) | Active |
| Azure Data Studio | (was) cross-platform SQL GUI | Do not choose it | — | **Retired on 2026-02-28** [46] |

**Recommendation.** Learn `psql` first: it is everywhere, and its output is what other people (and AI agents) expect to see. Add one GUI. For a TypeScript developer in VS Code, Microsoft's PostgreSQL extension is now the natural choice: it has IntelliSense, a schema visualizer, a query-plan visualizer with tree and icicle views, a server dashboard, and it registers an MCP server for agents [2]. Microsoft points Azure Data Studio users to this extension [46]. Use DBeaver Community if you want a free stand-alone GUI, DataGrip if you want the strongest editor (free for learning and hobby work, but the free license requires telemetry you cannot turn off [47]), and pgAdmin for admin tasks.

A small `~/.psqlrc` makes `psql` safer and nicer (these are psql meta-commands, not SQL):

```text
-- ~/.psqlrc
\set ON_ERROR_STOP on
\timing on
\x auto
\pset null '(null)'
\set HISTCONTROL ignoredups
```

`ON_ERROR_STOP` stops a script at the first error, so a half-applied script does not keep going.

## 2. Query plan analysis

| Tool | Best for | Choose it when | License / cost | Status |
|---|---|---|---|---|
| explain.depesz.com | Text plans with color-coded slow nodes; plan history | You want a quick, proven text view; obfuscation is available before saving [7] | Free web service | Active |
| explain.dalibo.com (PEV2) | Graphical plan tree, easy sharing | You want a visual plan; plans are stored on the server and shareable [4] | Free; PEV2 is PostgreSQL License [6] | Active |
| PEV2 local (`pev2.html`) | Visualizing **private** plans offline | Plans contain sensitive table names or literals | PostgreSQL License, single HTML file [6] | Active |
| pgMustard | Plan advice: it explains *why* a node is slow and suggests fixes | You want guided tips, not only a picture | Paid (from €95/year), 5 free plans [5] | Active |
| pganalyze | Plans collected automatically (auto_explain) + insights | You run production and want history and alerts | Paid SaaS (from $149/month) [12] | Active |
| VS Code PostgreSQL extension | Plan view inside the editor, Copilot analysis | You already use the extension [2] | Free | Active |

**Recommendation.** Always capture `EXPLAIN (ANALYZE, BUFFERS)` (in PG 18+ `EXPLAIN ANALYZE` includes buffers automatically [79]). Paste it into explain.dalibo.com for a picture or explain.depesz.com for a dense text view. If the plan contains customer data in literals, use local PEV2 or depesz's obfuscation. Pay for pgMustard when you want an expert explanation of a single plan; pay for pganalyze when you want plans collected for you over time. How to read a plan is covered in [query optimization and EXPLAIN](06-query-optimization-and-explain.md).

```sql
-- Collect a plan you can paste into a visualizer (JSON for PEV2, TEXT for depesz)
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
SELECT o.id, o.total_cents
FROM orders AS o
WHERE o.customer_id = 42
ORDER BY o.created_at DESC
LIMIT 20;
```

Warning: `EXPLAIN ANALYZE` really runs the statement. Wrap a data-changing statement in `BEGIN; ... ROLLBACK;`.

## 3. Performance monitoring and observability

| Tool | Best for | Choose it when | License / cost | Status |
|---|---|---|---|---|
| `pg_stat_statements` (contrib) | Which queries use the most time, calls, I/O | Always; it is the base of almost every other tool | Ships with PostgreSQL | Active (core contrib) |
| `auto_explain` (contrib) | Logging plans of slow queries automatically | You need the plan of a slow query that you cannot reproduce | Ships with PostgreSQL | Active |
| pg_stat_monitor (Percona) | A richer `pg_stat_statements` (time buckets, histograms) | You want bucketed history without an external tool | Open source (Percona) | Active (2.3.x supports PG 13–18) |
| pgBadger | HTML reports from PostgreSQL log files | You want a one-off or daily report of slow queries, locks, errors | PostgreSQL License (free) | Active (13.2, Dec 2025) [9] |
| pganalyze | Managed Postgres monitoring + index/VACUUM advisors | You want expert dashboards without building them | Paid SaaS; Enterprise can be self-hosted [12] | Active |
| pgwatch (Cybertec) | Self-hosted metrics collector with Grafana dashboards | You want an open-source, SQL-defined metrics stack | BSD-3 (free) | Active (v6 in 2026, supports PG 19) [8][11] |
| postgres_exporter + Prometheus + Grafana | Metrics in an existing Prometheus stack | Your company already runs Prometheus | Apache-2.0 (free) | Active (CI-tested on PG 13–18) [10] |
| Datadog Database Monitoring | Postgres metrics, query samples and plans in Datadog | Your company already pays for Datadog | Paid per database host | Active |
| Percona PMM 3 | Self-hosted, open-source monitoring for several DBs | You want a free all-in-one server with query analytics | Open source (free); paid support | Active (3.x releases in 2026) |
| PoWA | Workload history + index suggestions (with pg_qualstats) | You want self-hosted query history and index advice | PostgreSQL License | Active (PoWA 5) |
| pg_activity | `top`-like live view of sessions and locks | You are on the server during an incident | PostgreSQL License | Active (3.6.x) |
| pgcenter | Terminal stats viewer (`pg_stat_*`, `pg_stat_io`) | You want quick stats screens from the terminal | BSD-3 | Active (v0.11) |

**Recommendation.** Turn on `pg_stat_statements` and `auto_explain` first; they are free and they feed every other tool. The step-by-step workflow (top queries by total time, reset, compare) lives in [query optimization](06-query-optimization-and-explain.md); server settings and logging are in [operations](09-operations-and-server-tuning.md). For a small team, add pgBadger on the logs and your cloud provider's "query insights" page. When the database matters to revenue, pay for pganalyze or use Datadog if you already have it. For fully self-hosted, pick pgwatch or Prometheus + postgres_exporter + Grafana.

```ini
# postgresql.conf (restart needed for shared_preload_libraries)
shared_preload_libraries = 'pg_stat_statements,auto_explain'
pg_stat_statements.track = top
auto_explain.log_min_duration = '500ms'   # log plans of statements slower than 500 ms
auto_explain.log_analyze = on
auto_explain.log_buffers = on
auto_explain.log_timing = off             # less overhead; row counts are still logged
auto_explain.sample_rate = 0.1            # instrument 10% of statements
```

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Top 10 statements by total execution time
SELECT queryid,
       calls,
       round(total_exec_time)        AS total_ms,
       round(mean_exec_time::numeric, 1) AS mean_ms,
       rows,
       left(query, 80)               AS query_start
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

## 4. Index advice

| Tool | Best for | Choose it when | License / cost | Status |
|---|---|---|---|---|
| HypoPG | Hypothetical ("what if") indexes and hiding real indexes | You want to know if the planner *would* use an index, at zero cost | PostgreSQL License | Active (1.4.x) [49] |
| Dexter (ankane) | Automatic index suggestions from `pg_stat_statements` or logs | You want a CLI that proposes and can create indexes | MIT; needs HypoPG [13] | Active |
| pganalyze Index Advisor | Workload-wide index advice | You already pay for pganalyze | Paid [12] | Active |
| Supabase `index_advisor` | Index advice for one query, as a SQL function | You want advice from SQL (also on Supabase) | PostgreSQL License; needs HypoPG [14] | Active |
| pg_qualstats (+ PoWA) | Statistics on `WHERE`/`JOIN` predicates, index advisor function | You want advice based on real predicates over time | Open source; needs `shared_preload_libraries` [50] | Active |
| Postgres MCP Pro | Index tuning and health checks for AI agents | You use an AI agent and want HypoPG-based suggestions [34] | MIT | Active (see section 17 for security) |

**Recommendation.** Use HypoPG by hand for one query, `index_advisor` when you want a direct answer from SQL, and Dexter or pganalyze for the whole workload. Every suggestion is a hypothesis: check write cost and duplicate indexes before you build it, and build it with `CREATE INDEX CONCURRENTLY` (see [indexing](05-indexing.md) and [safe migrations](10-safe-schema-migrations.md)).

```sql
CREATE EXTENSION IF NOT EXISTS hypopg;

-- 1. Create a hypothetical index (no disk, no lock, only in this session)
SELECT * FROM hypopg_create_index(
  'CREATE INDEX ON orders (customer_id, created_at DESC)'
);

-- 2. Plain EXPLAIN only: EXPLAIN ANALYZE ignores hypothetical indexes
EXPLAIN
SELECT id, total_cents
FROM orders
WHERE customer_id = 42
ORDER BY created_at DESC
LIMIT 20;

-- 3. Clean up
SELECT hypopg_reset();
```

HypoPG can also hide a real index from the planner with `hypopg_hide_index(oid)`, which lets you test "can I drop this index?" safely [49]. Supabase's function works per query and accepts `$1` parameters [14]:

```sql
CREATE EXTENSION IF NOT EXISTS index_advisor;  -- requires hypopg
SELECT * FROM index_advisor('SELECT id FROM orders WHERE customer_id = $1');
```

## 5. Maintenance

| Tool | Best for | Choose it when | License / cost | Status |
|---|---|---|---|---|
| pg_repack | Rebuilding a bloated table or index online | `VACUUM` cannot shrink a table and you cannot take a long lock | BSD-3; needs a PK or unique NOT NULL index [80] | Active (1.5.3, supports PG 18) |
| pg_squeeze (Cybertec) | Automatic, scheduled bloat removal via logical decoding | You want bloat removed on a schedule without triggers | Open source; needs `shared_preload_libraries` and (before PG 19) `wal_level = logical` [81] | Active (1.9 supports PG 18) |
| `REPACK` (core) | Built-in replacement for `VACUUM FULL` and `CLUSTER`; `CONCURRENTLY` option | Only on PG 19 | Core | **(PG 19, beta — may change)** [15] |
| `pgstattuple` (contrib) | Exact bloat measurement for a table or index | You need real numbers before you repack | Ships with PostgreSQL | Active |
| `amcheck` / `pg_amcheck` (contrib) | Detecting index and heap corruption | Before/after upgrades, after hardware problems, periodically | Ships with PostgreSQL | `pg_amcheck` CLI (PG 14+); `gin_index_check()` (PG 18+) [79] |
| pg_cron | Scheduling SQL jobs inside the database | You need cron-like jobs and your host supports it | PostgreSQL License [17] | Active |
| pg_partman | Creating and dropping time/ID partitions automatically | You use declarative partitioning with many partitions | PostgreSQL License | Active (5.x; 5.5 in 2026) [16] |
| `pg_prewarm` (contrib) | Loading a table into cache after a restart | Cold-cache latency after restarts hurts you | Ships with PostgreSQL | Active |
| `pg_buffercache` (contrib) | Seeing what is in shared buffers | You investigate cache usage | Ships with PostgreSQL | Eviction functions (PG 17+/18+) [79] |

**Recommendation.** First tune autovacuum (see [operations](09-operations-and-server-tuning.md)). When a table is already bloated, measure with `pgstattuple`, then run pg_repack during a quiet period. Choose pg_squeeze if you prefer a server-side, scheduled job. When you reach PG 19, plan to replace both with `REPACK (CONCURRENTLY)`; note the PG 19 docs say it is not MVCC-safe and cannot run inside a transaction block, on partitioned tables, or on unlogged tables [15][82]. Use pg_cron for small in-database jobs, but keep heavy business jobs in your application's job system.

```bash
# pg_repack: the extension must exist in the target database first (CREATE EXTENSION pg_repack;)
pg_repack --dbname=app --table=public.events --jobs=2
```

```sql
-- PG 19 beta only; syntax may change before GA
REPACK (CONCURRENTLY) events;

-- Check B-tree indexes of one table for corruption (amcheck)
CREATE EXTENSION IF NOT EXISTS amcheck;
SELECT bt_index_check(index => c.oid, heapallindexed => true)
FROM pg_index AS i
JOIN pg_class AS c ON c.oid = i.indexrelid
JOIN pg_am AS am ON am.oid = c.relam
WHERE i.indrelid = 'public.orders'::regclass
  AND am.amname = 'btree'
  AND i.indisvalid;

-- Schedule a nightly cleanup with pg_cron
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule(
  'purge-expired-sessions',
  '15 3 * * *',
  $$DELETE FROM sessions WHERE expires_at < now() - interval '7 days'$$
);
SELECT jobid, status, start_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5;
```

pg_cron runs in only one database per cluster (set by `cron.database_name`), but `cron.schedule_in_database()` can target others; it does not run jobs on a hot standby [17].

## 6. Connection pooling

| Tool | Best for | Choose it when | License / cost | Status |
|---|---|---|---|---|
| PgBouncer | The standard lightweight pooler | Default choice for self-hosted pooling | ISC (free) | Active (1.26.0, 2026-09-23) [18] |
| PgDog | Pooler + load balancer + sharding (Rust) | You need read/write splitting or sharding in the proxy | AGPL-3.0 or enterprise license | Active, funded (seed round) [20]; built by PgCat's original author |
| PgCat | Pooler with load balancing and sharding (Rust) | You already run it | MIT | Not archived [19], but new work moved to PgDog — prefer PgDog or PgBouncer |
| Supavisor | Supabase's cloud pooler (Elixir) | You use Supabase (port 6543 = transaction mode) [61] | Open source | Active |
| Odyssey (Yandex) | Multi-threaded pooler for very high connection counts | You hit PgBouncer's single-thread limit | BSD-3 | Active |
| Pgpool-II | Pooling + load balancing + failover in one daemon | You need its specific features and accept its complexity | BSD-style | Active (4.7.x) |
| Cloud proxies | RDS Proxy (AWS), built-in PgBouncer (Azure Flexible Server), Neon/Supabase/Prisma Postgres poolers | You are on that cloud | Included or per-hour | Active |

**Recommendation.** Use PgBouncer in **transaction mode** unless your host gives you a pooler. Since PgBouncer 1.21 it supports protocol-level prepared statements in transaction mode, and since 1.24 `max_prepared_statements` defaults to 200, so modern drivers work out of the box [18]. Transaction mode breaks features that depend on a session: `SET` without `LOCAL`, session advisory locks, `LISTEN`, temporary tables and session-level prepared statements on old poolers. Supabase's shared pooler in transaction mode (port 6543) does not support prepared statements, so turn them off in your driver there [61]. Choose PgDog only when you need routing or sharding, not just pooling. Keep the pooler patched like the database itself: the PgBouncer 1.26.0 release (September 2026) included security fixes [18][83]. Pool sizing and settings are in [operations](09-operations-and-server-tuning.md); Prisma and node-postgres pool settings are in [Postgres from TypeScript](15-postgres-from-typescript.md).

```ini
; pgbouncer.ini (minimal transaction-mode setup)
[databases]
app = host=127.0.0.1 port=5432 dbname=app

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 2000
default_pool_size = 20
max_prepared_statements = 200
```

## 7. Backup and recovery

| Tool | Best for | Choose it when | License / cost | Status |
|---|---|---|---|---|
| `pg_dump` / `pg_restore` | Logical copies: one database, migrations between versions, dev data | Small databases, upgrades by dump/restore, seed data | Core | Active; `--statistics` option (PG 18+) [79] |
| `pg_basebackup` + `pg_combinebackup` | Physical base backups; incremental backups | You want core tools only | Core | Incremental backup (PG 17+) |
| pgBackRest | Full/differential/incremental backups, parallel, S3/GCS/Azure, PITR | Self-hosted production; the most complete tool | MIT | Active: v2.59.3 (2026-10-04) [21]. Declared unmaintained on 2026-04-27, then funded by a sponsor coalition [21][22] |
| Barman (EDB) | Backup server for many PostgreSQL servers, PITR | You want a central backup server, or you use CloudNativePG's Barman Cloud plugin | GPL-3.0 | Active (3.x) |
| WAL-G | Cloud-native WAL archiving and backups (Go) | You want simple object-storage backups, also for other DBs | Apache-2.0 | Active (3.0.x) |
| Managed PITR | Provider-handled backups and restore to a time | You use a managed service | Included | Check the retention window |

**Recommendation.** On a managed service, use its PITR, check the retention window, and practice a restore. Self-hosted, use pgBackRest (now backed by several sponsors) or Barman, and also keep periodic `pg_dump` files for "oops, I dropped one table" restores. The 2026 pgBackRest scare shows why: a key tool depended on one maintainer and one sponsor [22]. Backup strategy, retention and restore drills are in [operations](09-operations-and-server-tuning.md).

```bash
# Logical backup of one database (custom format, compressed, restorable in parallel)
pg_dump --format=custom --no-owner --file=app.dump "$DATABASE_URL"
pg_restore --jobs=4 --no-owner --dbname=app_restore app.dump

# PG 17+: incremental physical backup (requires summarize_wal = on)
pg_basebackup -D /backups/full --checkpoint=fast
pg_basebackup -D /backups/incr1 --incremental=/backups/full/backup_manifest
pg_combinebackup -o /restore/data /backups/full /backups/incr1
```

## 8. High availability and Kubernetes

| Tool | Best for | Choose it when | License / cost | Status |
|---|---|---|---|---|
| Patroni | Automatic failover on VMs using etcd/Consul/ZooKeeper/Kubernetes | Self-hosted HA outside Kubernetes (or inside, via Spilo) | MIT | Active (4.1.x in 2026) |
| CloudNativePG | Kubernetes operator: HA, backups, PITR, declarative config | You run PostgreSQL on Kubernetes | Apache-2.0; CNCF Sandbox since 2025-01-21 [54] | Active (1.30.1, 2026-09-23) [23] |
| Crunchy PGO | Kubernetes operator using Patroni + pgBackRest | You already use Crunchy's stack | Apache-2.0 operator; Crunchy Data is owned by Snowflake since 2025 | Active [24] |
| Zalando postgres-operator | Operator based on Patroni + Spilo | You already run it | MIT | Slow; check PG 18 support before upgrading |
| StackGres (OnGres) | "Full stack" operator with many integrations and a web UI | You want a batteries-included platform | AGPL-3.0 | Active (1.18.x) |
| repmgr (EDB) | Replication setup and manual/automatic switchover | Legacy setups that already use it | GPL-3.0 | Slow; prefer Patroni for new setups |
| pg_auto_failover | Simple monitor-based failover | Small setups that already use it | PostgreSQL License | Unverified 2026 activity; prefer Patroni |

**Recommendation.** If a managed service is possible, use it: HA is hard to run well. On Kubernetes, CloudNativePG is the community default (EDB created it and donated it to the CNCF). On VMs, Patroni with etcd is the standard. Replication concepts are in [operations](09-operations-and-server-tuning.md).

## 9. Migrations and schema change

| Tool | Best for | Choose it when | License / cost | Status |
|---|---|---|---|---|
| Prisma Migrate | Migrations generated from `schema.prisma` | You use Prisma ORM (Prisma 7 config lives in `prisma.config.ts`) [26] | Apache-2.0 | Active |
| Drizzle Kit | Migrations generated from Drizzle TS schema | You use Drizzle ORM | Apache-2.0 | Active (Drizzle 1.0 in release-candidate phase in 2026) |
| node-pg-migrate | JS/TS/SQL migrations for node-postgres | You use node-postgres without an ORM | MIT | Active (v8 stable, v9 alpha) |
| graphile-migrate | SQL-first, roll-forward migrations with a watch mode | You write SQL by hand and like fast iteration | MIT | Slow (2.0 release candidates) |
| dbmate | Plain SQL up/down files, language-agnostic, single binary | You want the simplest SQL migration runner | MIT | Active (v2.36, Sept 2026) |
| golang-migrate | SQL migrations as CLI or Go library | Go projects, or a tiny CLI in CI | MIT | Active (v4) [38] |
| Flyway (Redgate) | Versioned SQL migrations, JVM ecosystem | Java/Spring teams; enterprise governance | Community free; Enterprise paid (Teams no longer sold to new customers) | Active |
| Liquibase | Changelogs in XML/YAML/SQL, rollbacks, many DBs | Enterprise Java teams | **FSL since 5.0** (converts to Apache-2.0 after two years) [51] | Active |
| Sqitch | Dependency-based (not numbered) SQL changes with deploy/revert/verify | You want explicit dependencies between changes | MIT | Active (mature) |
| Atlas (Ariga) | Declarative schema-as-code, migration linting (50+ analyzers), drift checks [52] | You want "desired state" diffs and CI linting | Apache-2.0 core; some features in paid plans | Active |
| pgroll (Xata) | Zero-downtime, reversible migrations (expand/contract with views) | You need old and new app versions to run at the same time | Apache-2.0 | Active |
| Bytebase | GUI workflow: review, approval, SQL review rules | Teams that need change approval and audit | Open core (free Community + paid) | Active |

Schema diff tools (compare two databases or a database and a file, then generate SQL):

| Tool | Notes | Status |
|---|---|---|
| migra | Classic Python schema diff | **Deprecated** (last release 2022); the author points to `results` [53] |
| pg-schema-diff (Stripe) | Go library/CLI; plans online-safe DDL (concurrent index builds) | Active |
| Atlas `schema diff` | Diff between URLs, HCL or SQL files | Active [52] |
| `prisma migrate diff` | Diff between schema files, migrations and a live DB | Active |

**Recommendation.** Use the migration tool that matches your ORM (Prisma Migrate here), but always read the generated SQL and hand-edit it for production safety (for example `CREATE INDEX CONCURRENTLY`, `NOT VALID` constraints). For hand-written SQL projects, dbmate or node-pg-migrate are simple and enough. Consider pgroll when you need true zero-downtime column changes. All the safe patterns are in [safe schema migrations](10-safe-schema-migrations.md).

## 10. Linting, formatting and static analysis

| Tool | Best for | Choose it when | License / cost | Status |
|---|---|---|---|---|
| Squawk | Linting migrations for dangerous locks and unsafe DDL | Every project with migrations; runs in CI, has a VS Code extension and a language server [66] | Open source (free) | Active |
| Postgres Language Server (Supabase community) | LSP: autocompletion, syntax diagnostics, type checking, formatting, migration and database linting, PL/pgSQL support | You want editor feedback on raw `.sql` files [67] | MIT | Active (0.x; still evolving) |
| SQLFluff | Style linting and auto-fix for many dialects, dbt support | You want consistent style rules in a team | MIT | Active (4.x in 2026, Rust parser) |
| sqruff | Fast Rust linter/formatter inspired by SQLFluff | SQLFluff is too slow for you | Open source (free) | Active |
| pgFormatter | PostgreSQL-aware formatter (CLI, web) | You want a formatter that knows PostgreSQL syntax | PostgreSQL License | Active (5.x) |
| sql-formatter (npm) | Formatter library for JS/TS tooling | You format SQL inside a Node.js toolchain | MIT | Active |
| plpgsql_check | Static analysis and profiler for PL/pgSQL functions | You write PL/pgSQL functions or triggers | Open source (free) | Active (2.8.x, PG 14–18) |
| libpg_query / pglast / pgsql-parser | The real PostgreSQL parser as a library | You build your own SQL tooling | libpg_query BSD-3; pglast GPLv3 | Active |

**Recommendation.** Run Squawk on every migration in CI; it catches the classic outage causes (non-concurrent index builds, `NOT NULL` additions that rewrite or scan, long locks). Add a formatter so diffs stay small. Use SQLFluff only if you want strict style rules; it can be noisy on PostgreSQL-specific syntax. If you write PL/pgSQL, `plpgsql_check` finds errors that `CREATE FUNCTION` does not.

```bash
# CI step: lint new migration files
npx squawk-cli prisma/migrations/*/migration.sql
```

## 11. Testing

| Tool | Best for | Choose it when | License / cost | Status |
|---|---|---|---|---|
| pgTAP + pg_prove | Unit tests written in SQL (schema, constraints, functions, RLS) | You test database logic inside the database | PostgreSQL License | Active (1.3.x) |
| Testcontainers (`@testcontainers/postgresql`) | Real PostgreSQL in Docker for integration tests | Default for app integration tests; supports snapshot/restore [65] | MIT | Active |
| PGlite (ElectricSQL) | PostgreSQL compiled to WASM, in-process, under 3 MB gzipped [29] | Very fast unit tests, browser demos; supports pgvector [29] | Apache-2.0 / PostgreSQL License | Active |
| pg-mem | In-memory **emulation** of PostgreSQL in JS | Only trivial queries; its parser is home-made and it lacks timezones, real numeric types, real indexes [30] | MIT | Experimental — avoid for real tests |
| pgbench | Simple load tests and custom TPC-B-like scripts | You want quick, scriptable benchmarks | Core | Active (`--continue-on-error` in PG 19 beta [15]) |
| HammerDB | Standard TPROC-C / TPROC-H benchmarks | You compare servers or cloud offers | GPL-3.0 (TPC Council) | Active |
| PostgreSQL Anonymizer (Dalibo) | Masking/faking personal data for dev and test copies | You copy production data to non-production | PostgreSQL License | Active (2.x, rewritten in Rust) |
| Database branching | Copy-on-write copies of a database for each PR or test | Neon, Supabase, Xata (and Prisma Postgres) offer it | Provider pricing | Active |

**Recommendation.** For a TypeScript app, run integration tests against real PostgreSQL with Testcontainers, apply migrations once, take a snapshot, and restore it between tests (do not use the `postgres` database name if you want snapshots [65]). Use PGlite when you want millisecond startup and can accept a single-connection, in-process database. Use pgTAP for constraints, triggers and row-level security policies. Never copy raw production data into dev; anonymize it first. Details in [Postgres from TypeScript](15-postgres-from-typescript.md).

```sql
-- pgTAP: a tiny test file (run with pg_prove)
BEGIN;
SELECT plan(3);
SELECT has_table('public', 'orders', 'orders table exists');
SELECT col_not_null('public', 'orders', 'customer_id', 'customer_id is NOT NULL');
SELECT results_eq(
  $$SELECT count(*)::int FROM orders WHERE status = 'paid' AND paid_at IS NULL$$,
  ARRAY[0],
  'paid orders always have paid_at'
);
SELECT * FROM finish();
ROLLBACK;
```

```ts
// Vitest/Jest global setup sketch (see 15-postgres-from-typescript.md for the full pattern)
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const container = await new PostgreSqlContainer("postgres:18")
  .withDatabase("app_test") // not "postgres": snapshots need another database
  .start();
process.env.DATABASE_URL = container.getConnectionUri();
// ...run migrations here, then:
await container.snapshot();
// before each test file:
await container.restoreSnapshot();
```

## 12. Data access by language

### TypeScript / Node.js

| Library | Kind | Best for | Choose it when | License | Status |
|---|---|---|---|---|---|
| node-postgres (`pg`) | Driver | Everything low-level: pools, COPY, LISTEN/NOTIFY | You want full control, or as the driver under Prisma's `@prisma/adapter-pg` | MIT | Active (8.x) |
| postgres.js (`postgres`) | Driver | Tagged-template SQL, fast, works on Node, Deno, Bun, Workers | You like tagged templates such as `` sql`SELECT 1` `` and want a modern driver | Unlicense | Active (3.4.x) |
| Prisma ORM 7 | ORM + migrations | Typed CRUD from a schema file; Rust-free TypeScript client; driver adapters [26] | You want the most productive typed CRUD and migrations | Apache-2.0 | Active (7.0 released 2025-11-19) [26] |
| Drizzle ORM | ORM / SQL-like builder | SQL-shaped TypeScript API, schema in TS | You want to stay close to SQL with types | Apache-2.0 | Active (1.0 RC in 2026) |
| Kysely | Query builder | Type-safe SQL builder, no ORM magic | You want SQL control with types; pair with Kanel or kysely-codegen | MIT | Active (0.28.x) |
| TypeORM | ORM (decorators) | Entity classes, Active Record or Data Mapper | Existing TypeORM code; renewed maintenance | MIT | Active (1.0 released 2026-05-19) [27] |
| MikroORM | ORM (Unit of Work) | Domain-driven design with identity map | You want a Hibernate-like ORM | MIT | Active (v7 in 2026) |
| Knex | Query builder + migrations | Older projects | Existing Knex code | MIT | Slow; not recommended for new TS projects |
| Sequelize | ORM | Older projects | Existing Sequelize code | MIT | Slow; v7 still alpha — avoid for new projects |
| Slonik | Driver wrapper | Strict SQL-first style with runtime result validation | You want SQL strings + schema validation | BSD-3 | Active |
| pgTyped | Codegen from SQL | Types generated from `.sql` files against a live DB | You write SQL files and want types | MIT | Active (APIs may change) [25] |
| Zapatos | Codegen + helpers | Types from the schema + SQL template helpers | Small projects that like its style | MIT | Slow (one maintainer) |
| Kanel | Codegen | TypeScript types (and Kysely types) from the schema | You use Kysely or plain `pg` | MIT | Active |
| sqlc (`sqlc-gen-typescript`) | Codegen from SQL | Typed functions from SQL queries | You want sqlc's model in TS | MIT | Preview — expect breaking changes |

**How to choose.** Start from how you want to write queries. If you want an object API and generated migrations, use **Prisma** (the default this library assumes); since Prisma 7 the client is pure TypeScript, needs a driver adapter (for PostgreSQL, `@prisma/adapter-pg` on top of node-postgres), and configuration moves to `prisma.config.ts` [26]. If you want SQL-shaped code with types, use **Drizzle** or **Kysely**. If you want raw SQL with types, use **pgTyped** or Prisma's typed raw SQL. Keep **node-postgres** in your toolbox for COPY, LISTEN/NOTIFY, bulk loads and anything an ORM hides. Avoid new projects on Sequelize or Knex. Whatever you choose, always pass values as parameters, never by string concatenation (see [security](11-security.md)).

### Other languages (compact)

| Language | Driver | Higher level | Notes |
|---|---|---|---|
| Python | psycopg 3 (sync + async; 3.3 adds Python 3.14 template-string queries) | SQLAlchemy 2.x (2.1 released Sept 2026) | asyncpg is a fast asyncio-only driver |
| Go | pgx v5 | sqlc (generates Go from SQL) | `database/sql` works through pgx's stdlib adapter |
| Java / Kotlin | pgJDBC | jOOQ (free Apache-2.0 edition for open-source DBs like PostgreSQL), Hibernate/JPA | Use HikariCP for pooling |
| Rust | tokio-postgres | sqlx (compile-time checked SQL), Diesel (ORM) | sqlx is async; Diesel is sync with diesel-async available |
| .NET | Npgsql | Entity Framework Core (Npgsql provider) | Npgsql also supports COPY and logical replication |

## 13. Extensions by use case

Extensions add data types, index types and functions. Check two things first: does your managed host allow it, and does it support your PostgreSQL major version?

| Use case | Extension | What it gives you | License | Status / notes |
|---|---|---|---|---|
| Vector search | pgvector | `vector` type, HNSW and IVFFlat indexes | PostgreSQL License | Active (0.8.7, 2026-10-01) [28] — the default everywhere |
| Vector search at scale | VectorChord | Faster, disk-friendly vector indexes; pgvector-compatible types [76] | AGPLv3 or ELv2 | Active (1.x); successor of the deprecated pgvecto.rs |
| Vector search at scale | pgvectorscale (Tiger Data) | StreamingDiskANN index for pgvector data | PostgreSQL License | Active |
| BM25 full-text ranking | pg_textsearch (Tiger Data) | BM25 ranked search with `<@>` operator [77] | PostgreSQL License | Active (1.x; PG 17–18) |
| BM25 full-text + analytics | pg_search (ParadeDB) | Tantivy-based BM25, facets, hybrid search [78] | AGPL-3.0 or commercial | Active |
| Fuzzy text | pg_trgm (contrib) | Trigram similarity, fast `LIKE '%x%'` | Core | Active |
| Time series | TimescaleDB | Hypertables, compression, continuous aggregates | Apache-2.0 core + Timescale License for some features [69] | Active (Tiger Data, formerly Timescale) [56] |
| Geospatial | PostGIS | Geometry/geography types, spatial indexes | GPL-2.0 | Active (3.x) |
| Scheduling | pg_cron | Cron jobs in SQL [17] | PostgreSQL License | Active |
| Partitioning | pg_partman | Automatic partition creation/retention [16] | PostgreSQL License | Active |
| Queues | pgmq | SQS-like queue with visibility timeout and archive [70] | PostgreSQL License | Active (PG 14–18), used by Supabase |
| Analytics in Postgres | pg_duckdb | DuckDB engine inside PostgreSQL; read Parquet/Iceberg [71] | MIT | Active (1.0 in 2025) |
| Analytics / columnar | pg_mooncake | Columnstore tables mirrored to Iceberg/Delta | MIT | **Unverified**: its company joined Databricks on 2025-10-01 [72]; check activity before adopting |
| Distributed | Citus | Sharding across nodes, distributed queries | AGPL-3.0 | Active (14.x supports PG 18) [74] |
| Auditing | pgAudit | Session and object audit logs [75] | PostgreSQL License | Active (v18.x for PG 18, v19.x for PG 19) |
| Privacy | PostgreSQL Anonymizer | Masking rules, anonymous dumps | PostgreSQL License | Active (2.x) |
| Foreign data | postgres_fdw, file_fdw (contrib) | Query other PostgreSQL servers or files as tables | Core | Active |
| Graph | Apache AGE | openCypher graph queries in PostgreSQL | Apache-2.0 | Active (builds per PG major, incl. PG 18) [73] |
| HTTP (async) | pg_net (Supabase) | Async HTTP GET/POST/DELETE from SQL [43] | Apache-2.0 | Active; requires PG 14+ |
| HTTP (sync) | pgsql-http | Synchronous HTTP calls; blocks until reply (5 s default timeout) [45] | MIT | Active — avoid inside hot transactions |
| GraphQL | pg_graphql (Supabase) | GraphQL API reflected from your schema [44] | Apache-2.0 | Active |
| JSON Schema | pg_jsonschema (Supabase) | Validate `json`/`jsonb` against JSON Schema in CHECK constraints [42] | Apache-2.0 | Active |
| Hypothetical indexes | HypoPG | See section 4 [49] | PostgreSQL License | Active |
| Plan hints | pg_hint_plan | Hints in SQL comments to force plans | BSD-3 | Active (1.8 for PG 18) |
| Plan control (core) | pg_plan_advice + pg_stash_advice | Stabilize and store planner decisions [15] | Core contrib | **(PG 19, beta — may change)** |
| Incremental materialized views | pg_ivm | Materialized views updated on each write | PostgreSQL License | Active (1.12 added PG 18) |

**Recommendation.** Start with contrib extensions (`pg_stat_statements`, `pg_trgm`, `pgcrypto`, `postgres_fdw`) and pgvector; they are available almost everywhere. Add PostGIS, TimescaleDB, pg_cron and pg_partman when the use case is clear. Check the license before you build a product on AGPL or source-available extensions (pg_search, VectorChord, Citus, StackGres). Use plan hints only as an emergency fix after you understand the cause (see [query optimization](06-query-optimization-and-explain.md)). Search and vector extensions are compared in depth in [full-text and vector search](12-full-text-and-vector-search.md); extension basics are in [PostgreSQL features](03-postgresql-features-and-types.md).

## 14. Local development

| Option | Best for | Choose it when | Notes |
|---|---|---|---|
| Official Docker image `postgres` | Same PostgreSQL as production, any OS | Default for teams and CI | Tags `18`, `17`, …, and `19beta4`; **PG 18+ mounts the volume at `/var/lib/postgresql`** (PGDATA moved to `/var/lib/postgresql/18/docker`) [35] |
| Postgres.app (macOS) | Native Mac app, several majors side by side | Solo work on a Mac | PostgreSQL License [37]; ships PG 14–18 with PostGIS; a v3 alpha adds 19beta4 [36] |
| Homebrew (`postgresql@18`) | CLI install on macOS/Linux | You want `psql` and a server from your package manager | Formula per major version |
| PGlite | In-process WASM PostgreSQL | Unit tests, demos, local-first apps [29][31] | Not a full server; check extension support |
| Supabase CLI (`supabase start`) | Full local Supabase stack in Docker | You deploy to Supabase | Includes Auth, Storage, Studio; uses Docker |
| Neon branches | Cloud copy of your database per branch | You deploy to Neon and want real data shapes in dev | Copy-on-write, fast to create |

**Recommendation.** Use the official Docker image with the same major version as production. Pin the major (`postgres:18`, not `latest`). Watch the PG 18 volume change: old compose files that mount `/var/lib/postgresql/data` do not match the new layout [35].

```yaml
# compose.yaml for local development (PostgreSQL 18)
services:
  db:
    image: postgres:18
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql   # PG 18+; use /var/lib/postgresql/data for PG 17 and older
    command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements"]
volumes:
  pgdata:
```

## 15. Managed hosting landscape

| Provider | Type | Branching | Pooling | Notes / ownership (Oct 2026) |
|---|---|---|---|---|
| AWS RDS for PostgreSQL | Classic managed instances | No (snapshots/clones) | RDS Proxy | Wide extension list; Multi-AZ HA |
| AWS Aurora PostgreSQL | Cloud-native storage, Serverless v2 option | Fast clones | RDS Proxy | Higher price, fast failover |
| AWS Aurora DSQL | Distributed, serverless, PostgreSQL-*compatible* | No | — | Not full PostgreSQL: no extensions, triggers or PL/pgSQL; check limits before use |
| Google Cloud SQL for PostgreSQL | Classic managed instances | No | Check current docs | Enterprise / Enterprise Plus editions |
| Google AlloyDB | PostgreSQL-compatible engine with columnar cache | No | Check current docs | Also AlloyDB Omni for self-hosting |
| Azure Database for PostgreSQL Flexible Server | Classic managed instances | No | Built-in PgBouncer | Elastic clusters (Citus) replace Cosmos DB for PostgreSQL, which is on a retirement path with new deployments blocked [68] |
| Azure HorizonDB | New cloud-native PostgreSQL service | — | — | Public preview (2026) |
| Neon | Serverless, scale to zero, storage/compute split | Yes (copy-on-write) | Built-in PgBouncer | Owned by Databricks (announced 2025-05-14) [55]; basis of Databricks Lakebase |
| Supabase | Postgres + Auth + Storage + APIs | Yes | Supavisor + dedicated PgBouncer [61] | Free projects pause after inactivity |
| Crunchy Bridge | Managed PostgreSQL on AWS/GCP/Azure | No | Built-in | Still sold [24]; Crunchy Data owned by Snowflake, which launched Snowflake Postgres (GA 2026-02-24) [58] |
| Tiger Cloud | PostgreSQL + TimescaleDB, tiered storage | Forks | Built-in | Tiger Data = Timescale renamed on 2025-06-17 [56] |
| Aiven for PostgreSQL | Managed PostgreSQL on many clouds | No | PgBouncer | Free tier available |
| PlanetScale Postgres | HA clusters (1 primary + 2 replicas across 3 zones), Metal (local NVMe) option [59] | No | Check current docs | From $5/month single node; Neki sharding [59] |
| Xata | PostgreSQL with copy-on-write branches and PII masking | Yes | — | Rebuilt platform, open-sourced (Apache-2.0) |
| Nile | PostgreSQL virtualized per tenant (B2B SaaS) | — | — | Operating in 2026 [32] |
| Prisma Postgres | Serverless PostgreSQL by Prisma; direct TCP connections since Oct 2025 | — | Built-in | Free tier; paid from $10/month, billed by operations and storage [60] |

**Selection criteria.**

1. **Extensions**: is pgvector there, which version, and are PostGIS, pg_cron, pg_partman, TimescaleDB (often not offered by others because of its license) available?
2. **Versions and upgrades**: are PG 17/18 available, and how are major upgrades done (in-place, blue/green, dump/restore)?
3. **Backups**: PITR window, cross-region copies, how fast a restore is.
4. **Pooling**: built-in pooler and its mode (transaction mode limits session features).
5. **Branching**: per-PR databases (Neon, Supabase, Xata) are a big help for preview environments and tests.
6. **Region and data residency**: EU regions if you need GDPR data residency.
7. **Price model**: fixed instance, serverless compute units, or operations-based (Prisma Postgres). Model your real load.
8. **Exit path**: can you get logical replication out, `pg_dump` access, and superuser-like rights you need?
9. **HA**: multi-zone standby and failover time.

**Recommendation.** For a new TypeScript app: Neon or Supabase if you value branching and a generous free tier; AWS RDS, Cloud SQL or Azure Flexible Server if your company already lives in that cloud; Crunchy Bridge or PlanetScale if you want a Postgres-focused team with plain instances. Prisma Postgres is convenient with Prisma, but check its operations-based pricing against your query volume [60]. Avoid "PostgreSQL-compatible" engines (Aurora DSQL, some distributed SQL products) unless you have verified every feature you use.

## 16. Data movement, BI and schema documentation

| Tool | Best for | Choose it when | License / cost | Status |
|---|---|---|---|---|
| Logical decoding (`pgoutput`) | Built-in change data capture (CDC) and logical replication | You stream changes to another PostgreSQL | Core | Active (PG 19 beta replicates sequences [15]) |
| Debezium | CDC from PostgreSQL to Kafka or other sinks | You need an event stream of row changes | Apache-2.0 | Active (3.x) |
| pgloader | One-command migration from MySQL, SQLite, MS SQL, CSV into PostgreSQL | You migrate another database to PostgreSQL | PostgreSQL License | Maintained (3.6.x stable; v4 rewrite pre-release) |
| Airbyte | ELT connectors with a UI | You need many SaaS sources | MIT + ELv2 (mixed) [39] | Active |
| dlt (dlthub) | ELT as Python code | Developers who prefer code over UI | Apache-2.0 | Active |
| Metabase | Self-serve dashboards for non-developers | You want simple BI quickly | AGPL (open source) or commercial [41] | Active |
| Apache Superset | Open-source BI at scale | You need a powerful free BI tool | Apache-2.0 | Active |
| Grafana | Time-series dashboards, also SQL panels | Ops dashboards and metrics | AGPL-3.0 | Active |
| SchemaSpy | HTML schema docs with ER diagrams, anomaly detection | You want generated documentation in CI | LGPL-3.0 / GPL-3.0 [40] | Active |
| tbls | CI-friendly schema docs in Markdown, diagrams, schema linting | You want docs in the repo | MIT | Active |
| dbdiagram.io | Draw ER diagrams from a small text DSL | Quick design sketches | Freemium SaaS | Active |
| DrawDB | Browser ER editor that generates SQL | Free visual design | AGPL-3.0 | Active |
| Azimutt | Exploring and documenting large existing schemas | Big legacy schemas | MIT | Active |

**Recommendation.** Use built-in logical replication for PostgreSQL-to-PostgreSQL moves and major-version upgrades; add Debezium only when you need an event stream. Use pgloader to import from MySQL or SQLite. For BI, give analysts Metabase on a **read replica** with a read-only role. Generate schema docs with tbls or SchemaSpy in CI so they never go stale.

## 17. AI assistants and MCP servers

MCP (Model Context Protocol) servers let an AI agent list tables, read schemas and run SQL. They are useful, and they are also a new way to leak or destroy data: an agent can be tricked by text stored in your own tables ("prompt injection") [62].

| Server | Best for | Notes | License | Status |
|---|---|---|---|---|
| VS Code PostgreSQL extension (Microsoft) | Agent mode and `@pgsql` chat inside VS Code/Cursor; registers an MCP server [2] | Uses your saved connections | Free | Active |
| Postgres MCP Pro (crystaldba) | Index tuning (HypoPG), EXPLAIN, health checks [34] | Has "unrestricted" and "restricted" modes; restricted mode parses SQL with pglast and rejects `COMMIT`/`ROLLBACK` [34]. Third-party reports in 2026 described a restricted-mode bypass (not verified here) — in any case, do not treat it as a security boundary | MIT | Active |
| Supabase MCP | Managing Supabase projects, running SQL | Use read-only mode, project scoping and manual approval of tool calls [62] | Open source | Active |
| Neon MCP | Managing Neon projects and branches; migrations tested on a temporary branch | "Intended for local development and IDE integrations only" [63] | Open source | Active (remote server at mcp.neon.tech) |
| Prisma MCP | Prisma CLI (local) and Prisma Postgres management (remote) | Local: `npx -y prisma mcp` | Apache-2.0 | Active |
| Google MCP Toolbox for Databases | Generic MCP server for PostgreSQL, AlloyDB, Cloud SQL and many others | Prebuilt tools via `--prebuilt=postgres` [64] | Apache-2.0 | Active (1.13.x) |
| AWS Labs Postgres MCP server | Aurora/RDS PostgreSQL via RDS Data API or direct connection | Read-only by default unless you allow writes | Apache-2.0 | Active |
| `@modelcontextprotocol/server-postgres` | — | **Archived 2025-05-29**; v0.6.2 on npm has a SQL-injection bypass of its read-only mode (`COMMIT; DROP ...`) [33] | MIT | **Do not use** |

**The rule: give AI agents a read-only role with `statement_timeout`.** The database must enforce safety, not the MCP server. Read-only transactions in a tool can be escaped (the archived reference server is the proof [33]); a role without write privileges cannot.

```sql
-- A dedicated, least-privilege role for AI agents and MCP servers
CREATE ROLE ai_reader LOGIN PASSWORD 'change-me' CONNECTION LIMIT 5;
GRANT CONNECT ON DATABASE app TO ai_reader;
GRANT USAGE ON SCHEMA public TO ai_reader;
GRANT SELECT ON orders, order_items, products TO ai_reader;   -- only what it needs; no PII tables

-- Safety settings applied at every login
ALTER ROLE ai_reader SET default_transaction_read_only = on;   -- extra guard, not a security boundary
ALTER ROLE ai_reader SET statement_timeout = '5s';
ALTER ROLE ai_reader SET lock_timeout = '1s';
ALTER ROLE ai_reader SET idle_in_transaction_session_timeout = '10s';
```

- The real protection is privileges: `ai_reader` has no `INSERT`, `UPDATE`, `DELETE`, DDL, or file-access roles (never grant `pg_read_server_files`, `pg_write_server_files` or `pg_execute_server_program`). A session can turn `default_transaction_read_only` off; it cannot give itself privileges.
- Point agents at a read replica or a branch, not the production primary.
- Do not grant access to tables with personal data; use views with only the needed columns, or row-level security (see [security](11-security.md)).
- Keep manual approval of tool calls on for interactive work [62].

## 18. Default toolbox for a TypeScript + PostgreSQL project (opinionated)

This is an opinion, not a standard. It fits a team building a TypeScript/Node.js app with Prisma 7 and node-postgres.

| Job | Default choice | Why |
|---|---|---|
| Local database | Docker `postgres:18` (same major as production), or Postgres.app on a Mac | Same behavior as production; easy reset |
| Client | `psql` + VS Code PostgreSQL extension (or DBeaver/DataGrip) | Scriptable + visual |
| Data access | Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg`) for CRUD; node-postgres for COPY, LISTEN/NOTIFY and complex SQL | Typed productivity, with an escape hatch to plain SQL |
| Migrations | Prisma Migrate, with generated SQL reviewed and hand-edited for locks | One source of truth, safe DDL |
| Migration linting | Squawk in CI | Catches locking DDL before production |
| Formatting | pgFormatter or sql-formatter for `.sql` files | Small, readable diffs |
| Tests | Vitest + Testcontainers (`postgres:18`) with snapshot/restore; pgTAP for constraints and RLS | Real PostgreSQL behavior |
| Seed data | SQL or Prisma seed script; anonymized data only | No PII in dev |
| Observability | `pg_stat_statements` + `auto_explain` (sampled) + provider insights; pgBadger on logs; pganalyze when budget allows | See slow queries early |
| Plan reading | explain.dalibo.com (or local PEV2 for sensitive plans) | Fast visual diagnosis |
| Index advice | HypoPG / `index_advisor`, then `CREATE INDEX CONCURRENTLY` | Test before you build |
| Pooling | Provider pooler or PgBouncer in transaction mode | Many short connections from serverless or many app instances |
| Backups | Provider PITR (or pgBackRest when self-hosted) + regular restore drills | A backup you never restored is a hope |
| Hosting | Neon or Supabase (branching), or RDS/Cloud SQL/Azure if your company is there | Match team and cloud |
| AI agents | `ai_reader` role with `statement_timeout`, on a replica or branch; Microsoft's VS Code extension or Postgres MCP Pro in restricted mode | Database-enforced safety |

Read next: [Postgres from TypeScript](15-postgres-from-typescript.md) for Prisma/node-postgres details, [safe schema migrations](10-safe-schema-migrations.md) before your first production migration, and [learning resources](14-learning-resources.md) to go deeper.

## Sources

1. [News Archive](https://www.pgadmin.org/news/) — pgadmin.org: pgAdmin 4 v9.18 released 2026-09-17; release cadence.
2. [PostgreSQL Extension for Visual Studio Code](https://learn.microsoft.com/en-us/azure/postgresql/extensions/vs-code-extension/overview) — Microsoft Learn: features (plan visualizer, schema visualizer, dashboard, Copilot agent mode, MCP server), Cursor support.
3. [PostgreSQL – Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql) — Microsoft: extension version and install count in 2026.
4. [explain.dalibo.com](https://explain.dalibo.com/) — Dalibo: plans stored server-side and shareable; standalone version for local use.
5. [pgMustard pricing](https://www.pgmustard.com/pricing) — pgMustard: plans from €95/year; 5 free plan reviews.
6. [PEV2](https://github.com/dalibo/pev2) — Dalibo (GitHub): PostgreSQL License; offline single-file `pev2.html`.
7. [explain.depesz.com](https://explain.depesz.com/) — depesz: obfuscation option and history page.
8. [pgwatch releases](https://github.com/cybertec-postgresql/pgwatch/releases) — Cybertec (GitHub): v5/v6 release line.
9. [pgBadger releases](https://github.com/darold/pgbadger/releases) — Gilles Darold (GitHub): 13.2 released Dec 2025.
10. [postgres_exporter](https://github.com/prometheus-community/postgres_exporter) — Prometheus community (GitHub): Apache-2.0, CI-tested on PG 13–18.
11. [pgwatch v6.0.0](https://github.com/cybertec-postgresql/pgwatch/releases/tag/v6.0.0) — Cybertec (GitHub): Prometheus sources, Grafana dashboards, PG 19 support.
12. [pganalyze pricing](https://pganalyze.com/pricing) — pganalyze: plans, Index/Query/VACUUM Advisors, self-hosted Enterprise.
13. [Dexter](https://github.com/ankane/dexter) — Andrew Kane (GitHub): automatic indexer; needs HypoPG; MIT.
14. [index_advisor](https://github.com/supabase/index_advisor) — Supabase (GitHub): per-query index advice; needs HypoPG.
15. [PostgreSQL 19 release notes (beta 4)](https://www.postgresql.org/docs/19/release-19.html) — postgresql.org: REPACK (CONCURRENTLY), pg_plan_advice, pgbench `--continue-on-error`, sequence replication.
16. [pg_partman releases](https://github.com/pgpartman/pg_partman/releases) — pg_partman (GitHub): 5.x release line incl. 5.5.0.
17. [pg_cron](https://github.com/citusdata/pg_cron) — Citus Data (GitHub): one database per cluster, `cron.schedule_in_database()`, no jobs on standbys.
18. [PgBouncer changelog](https://www.pgbouncer.org/changelog.html) — pgbouncer.org: 1.26.0 (2026-09-23); `max_prepared_statements` default 200 since 1.24.0.
19. [PgCat](https://github.com/postgresml/pgcat) — PostgresML (GitHub): repository not archived.
20. [PgDog](https://pgdog.dev/) — PgDog: pooler, load balancer and sharding; funding.
21. [pgBackRest](https://pgbackrest.org/) — pgbackrest.org: v2.59.3 (2026-10-04), sponsor list, MIT license.
22. [pgBackRest is archived, what now?](https://percona.community/blog/2026/04/28/pgbackrest-is-archived-what-now/) — Percona Community: 2026-04-27 unmaintained announcement and context.
23. [CloudNativePG releases](https://cloudnative-pg.io/releases/) — CloudNativePG: 1.30.1 released 2026-09-23.
24. [Crunchy Data](https://www.crunchydata.com/) — Crunchy Data: Crunchy Bridge and PGO still offered.
25. [pgTyped](https://github.com/adelsz/pgtyped) — adelsz (GitHub): active; APIs may change.
26. [Announcing Prisma ORM 7.0.0](https://www.prisma.io/blog/announcing-prisma-orm-7-0-0) — Prisma: release 2025-11-19, Rust-free client, `prisma.config.ts`, `prisma-client` generator.
27. [TypeORM 1.0 is here](https://typeorm.io/blog/typeorm-1-0/) — TypeORM: 1.0 released 2026-05-19, Node.js 20+.
28. [pgvector CHANGELOG](https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md) — pgvector (GitHub): 0.8.7 (2026-10-01).
29. [PGlite](https://pglite.dev/) — ElectricSQL: WASM Postgres under 3 MB gzipped, pgvector, dual license.
30. [pg-mem](https://github.com/oguimbal/pg-mem) — pg-mem (GitHub): experimental; known limitations.
31. [What is PGlite](https://pglite.dev/docs/about) — ElectricSQL: unit and CI testing use case.
32. [Nile](https://www.thenile.dev/) — Nile: service operating in 2026.
33. [MCP vulnerability case study: SQL injection in the Postgres MCP server](https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/) — Datadog Security Labs: read-only bypass, archival on 2025-05-29, mitigations.
34. [Postgres MCP Pro](https://github.com/crystaldba/postgres-mcp) — Crystal DBA (GitHub): tools, access modes, MIT.
35. [postgres – Docker Official Image](https://hub.docker.com/_/postgres) — Docker Hub: PG 18 PGDATA/volume change; tags incl. 19beta4.
36. [Postgres.app downloads](https://postgresapp.com/downloads.html) — Postgres.app: PG 14–18 bundles; v3 alpha with 19beta4.
37. [Postgres.app](https://postgresapp.com/) — Postgres.app: PostgreSQL License; PostGIS included.
38. [golang-migrate](https://github.com/golang-migrate/migrate) — golang-migrate (GitHub): v4 stable, active.
39. [Airbyte](https://github.com/airbytehq/airbyte) — Airbyte (GitHub): MIT and ELv2 licensing.
40. [SchemaSpy](https://github.com/schemaspy/schemaspy) — SchemaSpy (GitHub): HTML docs, ER diagrams, LGPL/GPL.
41. [Metabase](https://github.com/metabase/metabase) — Metabase (GitHub): AGPL open-source edition, commercial editions.
42. [pg_jsonschema](https://github.com/supabase/pg_jsonschema) — Supabase (GitHub): JSON Schema validation; Apache-2.0.
43. [pg_net](https://github.com/supabase/pg_net) — Supabase (GitHub): async HTTP; limits; PG 14+.
44. [pg_graphql](https://github.com/supabase/pg_graphql) — Supabase (GitHub): GraphQL from SQL schema; Apache-2.0.
45. [pgsql-http](https://github.com/pramsey/pgsql-http) — Paul Ramsey (GitHub): synchronous HTTP, 5 s default timeout, MIT.
46. [What's happening with Azure Data Studio](https://learn.microsoft.com/en-us/sql/tools/whats-happening-azure-data-studio) — Microsoft Learn: retired 2026-02-28; PostgreSQL users pointed to the VS Code extension.
47. [DataGrip is now free for non-commercial use](https://blog.jetbrains.com/datagrip/2025/10/01/datagrip-is-now-free-for-non-commercial-use/) — JetBrains: terms and mandatory telemetry.
48. [Open Source – Beekeeper Studio](https://docs.beekeeperstudio.io/support/open-source/) — Beekeeper Studio: Community Edition GPLv3.
49. [HypoPG](https://github.com/HypoPG/hypopg) — HypoPG (GitHub): EXPLAIN-only use; `hypopg_hide_index()`.
50. [pg_qualstats](https://github.com/powa-team/pg_qualstats) — PoWA team (GitHub): predicate statistics, index advisor, preload requirement.
51. [Strengthening Liquibase Community for the future](https://www.liquibase.com/blog/liquibase-community-for-the-future-fsl) — Liquibase: FSL from 5.0, Apache-2.0 after two years.
52. [Atlas](https://github.com/ariga/atlas) — Ariga (GitHub): declarative and versioned workflows, 50+ lint analyzers, Apache-2.0.
53. [migra](https://github.com/djrobstep/migra) — djrobstep (GitHub): official deprecation notice.
54. [CloudNativePG at CNCF](https://www.cncf.io/projects/cloudnativepg/) — CNCF: Sandbox since 2025-01-21.
55. [Databricks and Neon](https://www.databricks.com/blog/databricks-neon) — Databricks: acquisition announced 2025-05-14.
56. [Timescale becomes Tiger Data](https://www.tigerdata.com/newsroom/timescale-becomes-tiger-data-defining-a-new-standard-as-the-fastest-postgresql-platform-for-modern-applications) — Tiger Data: rename on 2025-06-17; Tiger Cloud; TimescaleDB.
57. [DbGate](https://github.com/dbgate/dbgate) — DbGate (GitHub): GPL-3.0, desktop and web, Premium connectors.
58. [Snowflake Postgres GA](https://docs.snowflake.com/en/release-notes/2026/other/2026-02-24-snowflake-postgres-ga) — Snowflake: GA on 2026-02-24.
59. [PlanetScale Postgres](https://planetscale.com/postgres) — PlanetScale: HA clusters, Metal, Neki, from $5/month.
60. [Prisma pricing](https://www.prisma.io/pricing) — Prisma: Prisma Postgres plans and operations-based billing.
61. [Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres) — Supabase: direct, session (5432) and transaction (6543) modes; no prepared statements in transaction mode.
62. [Supabase MCP server](https://supabase.com/docs/guides/ai-tools/mcp) — Supabase: read-only mode, project scoping, manual approval, prompt injection.
63. [Neon MCP server](https://github.com/neondatabase/mcp-server-neon) — Neon (GitHub): dev-only recommendation, read-only mode, migration branches.
64. [MCP Toolbox for Databases](https://github.com/googleapis/mcp-toolbox) — Google (GitHub): supported databases, prebuilt Postgres tools, Apache-2.0.
65. [Testcontainers PostgreSQL module](https://node.testcontainers.org/modules/postgresql/) — Testcontainers for Node.js: usage, snapshot/restore and its caveat.
66. [Squawk](https://squawkhq.com/) — Squawk: migration linter, rules, VS Code extension, language server.
67. [Postgres Language Server](https://github.com/supabase-community/postgres-language-server) — Supabase community (GitHub): features, editors, MIT.
68. [Migrate to Azure Database for PostgreSQL with Elastic Cluster](https://learn.microsoft.com/en-us/azure/cosmos-db/postgresql/concepts-benefits-database-postgresql) — Microsoft Learn: Cosmos DB for PostgreSQL retirement path.
69. [TimescaleDB](https://github.com/timescale/timescaledb) — Tiger Data (GitHub): Apache-2.0 + Timescale License.
70. [pgmq](https://github.com/pgmq/pgmq) — pgmq (GitHub): SQS-like queue, PG 14–18, users.
71. [Announcing pg_duckdb 1.0](https://motherduck.com/blog/pg-duckdb-release/) — MotherDuck: what pg_duckdb does and its limits.
72. [Mooncake Labs joins Databricks](https://www.databricks.com/blog/mooncake-labs-joins-databricks-accelerate-vision-lakebase) — Databricks: acquisition announced 2025-10-01.
73. [Apache AGE releases](https://github.com/apache/age/releases) — Apache AGE (GitHub): per-PG-major builds incl. PG 18.
74. [Distribute PostgreSQL 18 with Citus 14](https://www.citusdata.com/blog/2026/02/17/distribute-postgresql-18-with-citus-14/) — Citus Data: PG 18 support.
75. [pgAudit](https://github.com/pgaudit/pgaudit) — pgAudit (GitHub): version-to-PG mapping, `pgaudit.log` classes.
76. [VectorChord](https://github.com/tensorchord/VectorChord) — TensorChord (GitHub): AGPLv3/ELv2, pgvector-compatible, successor of pgvecto.rs.
77. [pg_textsearch](https://github.com/timescale/pg_textsearch) — Tiger Data (GitHub): BM25, PG 17–18, PostgreSQL License.
78. [ParadeDB](https://github.com/paradedb/paradedb) — ParadeDB (GitHub): pg_search, AGPL-3.0 + commercial.
79. [PostgreSQL 18 release notes](https://www.postgresql.org/docs/18/release-18.html) — postgresql.org: BUFFERS in EXPLAIN ANALYZE, `gin_index_check()`, pg_buffercache eviction, `pg_dump --statistics`.
80. [pg_repack documentation](https://reorg.github.io/pg_repack/) — pg_repack: requirements, locks, PG 9.5–18 support, 1.5.3.
81. [pg_squeeze](https://github.com/cybertec-postgresql/pg_squeeze) — Cybertec (GitHub): logical-decoding design, settings, PG < 19 needs `wal_level = logical`.
82. [REPACK (PostgreSQL 19 beta)](https://www.postgresql.org/docs/19/sql-repack.html) — postgresql.org: synopsis and CONCURRENTLY limitations.
83. [Planet PostgreSQL](https://planet.postgresql.org/) — PostgreSQL community aggregator: October 2026 post "Nobody Patches the Pooler" on the PgBouncer 1.26.0 security fixes.
