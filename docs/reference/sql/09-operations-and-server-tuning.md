# Operating and Tuning PostgreSQL

> Part of the [SQL & PostgreSQL reference library](README.md) · Last researched: 2026-10-05 · Targets PostgreSQL 14–18 (19 beta noted where relevant)

What this covers: how a PostgreSQL server works inside, how to set its main configuration parameters, what to log and monitor, how to keep VACUUM healthy and bloat low, how to pool connections, and how to back up, replicate, upgrade and scale a server. Query-level tuning and the `pg_stat_statements` workflow are in [06 — query optimization](06-query-optimization-and-explain.md). Security settings (`pg_hba.conf`, TLS, roles) are in [11 — security](11-security.md). Zero-downtime schema changes are in [10 — safe migrations](10-safe-schema-migrations.md).

## Key rules (TL;DR)

1. Put a connection pooler in front of PostgreSQL and keep the number of *active* connections close to a small multiple of the CPU core count.
2. Start with `shared_buffers` at about 25% of RAM and `effective_cache_size` at 50–75% of RAM; change other settings only with evidence.
3. Keep `work_mem` modest globally (it applies per sort or hash step, per process); raise it per role or with `SET LOCAL` for heavy queries.
4. Size `max_wal_size` so that most checkpoints are started by time (`checkpoint_timeout`), not by WAL volume.
5. On SSD or NVMe storage with a mostly cached working set, lower `random_page_cost` to about 1.1–2; test the change first, because sources disagree ([06 §8.2](06-query-optimization-and-explain.md#82-planner-cost-settings-effective_cache_size-and-random_page_cost)).
6. Set `statement_timeout` and `lock_timeout` per application role, not in `postgresql.conf`; add a server-wide `idle_in_transaction_session_timeout` as a safety net.
7. Never turn off `fsync` or `full_page_writes`; use `synchronous_commit = off` only per transaction, for data you can afford to lose.
8. Log slow statements, lock waits, temporary files, checkpoints and autovacuum runs; read the logs with pgBadger or a monitoring service.
9. Monitor connection states, long transactions, blocking, dead tuples, transaction ID age, replication lag and WAL kept by replication slots.
10. Never disable autovacuum; make it run earlier and faster on big, busy tables with per-table settings.
11. Do not leave transactions open: long or idle-in-transaction sessions stop VACUUM from cleaning every table in the database.
12. Watch transaction ID age and act long before PostgreSQL forces anti-wraparound vacuums or stops accepting writes.
13. Do not run `VACUUM FULL` on a live table; use pg_repack or pg_squeeze, or `REPACK (CONCURRENTLY)` (PG 19, beta — may change).
14. Prevent bloat: batch mass updates and deletes, keep updates HOT-friendly, and lower `fillfactor` on update-heavy tables.
15. In PgBouncer transaction mode, avoid session state: use `SET LOCAL` (not `SET`), transaction-level advisory locks, and a direct connection for `LISTEN`.
16. For production, use physical backups with WAL archiving (pgBackRest, Barman or WAL-G); `pg_dump` is a complement, not the main backup.
17. Test restores on a schedule and time them; an untested backup is not a backup.
18. Set `max_slot_wal_keep_size` and drop unused replication slots; a forgotten slot can fill the disk and block VACUUM.
19. Treat read replicas as slightly late: read your own writes from the primary, or check the replay position first.
20. Apply minor releases quickly; plan major upgrades before end of life (PostgreSQL 14 reaches end of life on 2026-11-12).
21. Before a major upgrade, run `pg_upgrade --check` and confirm that every extension exists for the new version.
22. Scale in this order: queries and indexes, configuration, bigger hardware, pooling, read replicas, partitioning, caching and archiving, then sharding.
23. In development, run the same PostgreSQL major version as production, in Docker, with a persistent volume.

## Architecture in brief

You do not need to know PostgreSQL internals to run it. But a few facts explain almost every tuning rule in this document. The best deep reference is the free book *PostgreSQL 14 Internals* by Egor Rogov and Liudmila Mantrova [47].

### Processes: one per connection

PostgreSQL uses one operating-system process per client connection. The main process (the *postmaster*) listens on the network port. For each new connection it starts a *backend* process. That backend runs the client's queries until the client disconnects. Background processes do the shared work:

| Process | What it does |
|---|---|
| checkpointer | At each checkpoint, writes all changed ("dirty") pages from memory to the data files |
| background writer | Writes some dirty pages early, so backends find free buffers without waiting |
| WAL writer | Flushes the write-ahead log (WAL) from memory to disk at short intervals |
| autovacuum launcher and workers | Run `VACUUM` and `ANALYZE` on tables that need it |
| WAL sender / WAL receiver | Stream WAL from a primary to its replicas |
| archiver | Copies finished WAL files to the backup archive, if archiving is on |
| I/O workers (PG 18+) | Perform asynchronous reads when `io_method = worker` [3] |

Since PG 15, statistics counters live in shared memory and there is no separate statistics collector process [28].

### Memory: three layers

- **`shared_buffers`**: a cache of 8 kB data pages, shared by all processes.
- **Operating-system page cache**: PostgreSQL reads and writes files through the kernel, so the kernel caches the same data again. This "double buffering" is why `shared_buffers` is usually about 25% of RAM and not 80% [3][37].
- **Private memory of each backend**: each sort or hash step of a query can use up to `work_mem` (hash steps up to `work_mem × hash_mem_multiplier`) [3]. One complex query can have several such steps, and parallel workers each have their own.

### WAL and checkpoints: how commits stay safe

- **WAL (write-ahead log)**: every change is first written to the WAL, a sequential log in the `pg_wal/` directory. At `COMMIT`, PostgreSQL forces the WAL to disk. The data files are updated later. After a crash, the server replays the WAL to repair the data files.
- **Checkpoint**: a moment when all dirty pages have been written to the data files. Older WAL is then no longer needed for crash recovery. A checkpoint starts every `checkpoint_timeout` or when the WAL grows past `max_wal_size` [4].
- **Full-page writes**: the first change to a page after a checkpoint copies the whole page into the WAL. So frequent checkpoints produce more WAL [43].
- The same WAL also feeds replicas and point-in-time recovery (see the backup and replication sections).

### MVCC and VACUUM in one paragraph

PostgreSQL uses MVCC (multi-version concurrency control): an `UPDATE` writes a new version of the row and keeps the old one, and a `DELETE` only marks the row as deleted. Readers never block writers. Old row versions that no running transaction can still see are called *dead tuples*. `VACUUM` removes them so the space can be reused [8]. Concurrency details are in [08 — transactions and locking](08-transactions-concurrency-locking.md); VACUUM operations are below.

### Why the connection count matters

- Each connection is a full process with private memory. Andres Freund measured an overhead below 2 MiB per idle connection when huge pages are used, but memory grows as soon as queries sort, hash or cache catalog data [38].
- Many connections slow down everybody. In his tests, 5,000 idle connections made a single active connection about two times slower; the main cost was building snapshots (`GetSnapshotData()`) [38]. PG 14 made this much cheaper [29].
- More active queries than CPU cores do not finish faster; they wait for CPU, I/O and locks. The fix is a pooler, not a higher `max_connections` (see [Connection management](#connection-management-and-pooling)).

## Configuration: how settings work

### Where settings live and how to change them

| Level | How | Scope |
|---|---|---|
| Server file | `postgresql.conf` (and files it includes) | Whole server |
| Server, from SQL | `ALTER SYSTEM SET ...` writes `postgresql.auto.conf`, which overrides `postgresql.conf` [13] | Whole server |
| Database | `ALTER DATABASE app SET ...` | New sessions in that database |
| Role | `ALTER ROLE app_user SET ...` (optionally `IN DATABASE app`) | New sessions of that role |
| Session / transaction | `SET ...` / `SET LOCAL ...` | Current session / current transaction |

Each parameter has a *context*. `postmaster` means a restart is needed. `sighup` means a reload is enough. `user` and `superuser` parameters can also be set per session or role.

```sql
-- Current value, unit, and what a change requires
SELECT name, setting, unit, context, source, pending_restart
FROM pg_settings
WHERE name IN ('shared_buffers', 'work_mem', 'max_connections', 'random_page_cost');

-- Change a setting server-wide and reload
ALTER SYSTEM SET work_mem = '32MB';
SELECT pg_reload_conf();

-- Find errors in the configuration files before you trust a reload
SELECT sourcefile, sourceline, name, setting, error
FROM pg_file_settings
WHERE error IS NOT NULL;
```

Since PG 17, `allow_alter_system = off` disables `ALTER SYSTEM`, for teams that manage the configuration with files only [13].

### Managed services and calculators

Managed services (Amazon RDS and Aurora, Google Cloud SQL, Azure, Supabase, Neon and others) compute many defaults from the instance size. You change them through the provider ("parameter groups" on RDS), and some parameters are *static* and need a reboot [79]. Example: RDS sets `max_wal_size` to 2 GB for PostgreSQL 15 and older, and to 2 GB or 6 GB depending on storage size for 16 and newer [79]. Check your provider's values before you copy any guide, including this one.

PGTune [76] and pgconfig.org [81] compute a configuration from your hardware and workload type; postgresqlco.nf [77] documents every parameter. Treat their output as a first draft: they do not know your queries.

## Configuration starting points

The values below assume a dedicated Linux database server with SSD or NVMe storage, an OLTP workload (many short transactions), and a connection pooler in front. Change one thing at a time and measure.

### Memory

**`shared_buffers`** (default 128 MB, restart). The documentation says: on a dedicated server with 1 GB of RAM or more, start at 25% of RAM; more than 40% is unlikely to work better [3]. A larger value usually needs a larger `max_wal_size` too [3].

**`huge_pages`** (default `try`, restart). Huge pages make page tables smaller and reduce CPU time spent on memory management [3]. On Linux you must reserve them yourself [14]:

```bash
# Server stopped. Asks PostgreSQL how many huge pages it needs (PG 15+)
postgres -D "$PGDATA" -C shared_memory_size_in_huge_pages
# Reserve them (persist the value in /etc/sysctl.conf)
sudo sysctl -w vm.nr_hugepages=<value printed above>
```

With `huge_pages = try`, the server silently falls back to normal pages if the reservation fails [3]; since PG 17, `SHOW huge_pages_status;` tells you which case you are in [26]. Use `on` if you prefer a failed start over a silent slowdown. The same documentation chapter also explains Linux memory overcommit (`vm.overcommit_memory = 2`) and how to protect the postmaster from the out-of-memory killer [14].

**`effective_cache_size`** (default 4 GB). This is only a hint for the planner; it allocates nothing [5]. A higher value makes index scans more likely. Use 50% of RAM (conservative) to 75% of RAM (common on a dedicated server) [37][42].

**`work_mem`** (default 4 MB). It is the memory limit for *each* sort or hash step, in *each* process, before data spills to temporary files on disk [3]. Hash steps may use `work_mem × hash_mem_multiplier`; the multiplier defaults to 2.0 since PG 15 and to 1.0 in PG 14 [3][31]. How to choose:

1. Budget = RAM − `shared_buffers` − memory for the OS and other programs.
2. Worst case ≈ active queries × memory-hungry steps per query × `work_mem` × (1 + parallel workers per query).
3. Start low (16–64 MB). Then look for temporary files (`log_temp_files`, `pg_stat_database.temp_bytes`). Raise `work_mem` only where queries spill.

```sql
-- Raise work_mem for one heavy report only
BEGIN;
SET LOCAL work_mem = '256MB';
SELECT user_id, sum(total_amount) AS revenue
FROM orders
GROUP BY user_id
ORDER BY revenue DESC
LIMIT 100;
COMMIT;

-- Or for a reporting role
ALTER ROLE reporting SET work_mem = '128MB';
```

**`maintenance_work_mem`** (default 64 MB) and **`autovacuum_work_mem`** (default -1 = use `maintenance_work_mem`). They limit memory for `VACUUM`, `CREATE INDEX` and `ALTER TABLE ... ADD FOREIGN KEY` [3]. Each autovacuum worker can use this amount, so the total is `autovacuum_max_workers × autovacuum_work_mem` [3]. Up to PG 16, VACUUM could use at most 1 GB to remember dead tuples [31]. PG 17 removed that limit and stores dead-tuple references much more compactly [26]. Starting point: `maintenance_work_mem` 512 MB–2 GB, `autovacuum_work_mem` 256 MB–1 GB.

### Connections

**`max_connections`** (default 100, restart). Every slot reserves shared memory, and a standby needs a value at least as high as its primary [12]. A higher limit does not create capacity: it only lets more queries compete for the same CPUs. Laurenz Albe (Cybertec) gives this upper bound for *active* connections [40]:

```text
active connections < min(num_cores, parallel_io_limit) / (session_busy_ratio × avg_parallelism)
```

A pooler raises `session_busy_ratio` (each server connection is busy more of the time), so fewer connections do the same work [40]. Keep `superuser_reserved_connections` (default 3) for emergencies. Since PG 16, `reserved_connections` keeps extra slots for roles granted `pg_use_reserved_connections`, for example your monitoring user [12][27].

### WAL and checkpoints

**`wal_buffers`** (default -1, restart). Automatic size: 1/32 of `shared_buffers`, at least 64 kB and at most one WAL segment (usually 16 MB) [4]. Keep the default.

**`checkpoint_timeout`** (default 5 min), **`max_wal_size`** (default 1 GB) and **`min_wal_size`** (default 80 MB) [4]. Checkpoints write a lot of data at once, and pages changed after a checkpoint cost a full-page image in the WAL. Tomas Vondra's rule: most checkpoints should be triggered by time, not by WAL volume; production systems often use 30–60 minutes [43]. The trade-off: a longer interval means a longer crash recovery [4]. `max_wal_size` is a soft limit; WAL can exceed it under heavy load, failing archiving, or a high `wal_keep_size` [4].

How to size `max_wal_size`: measure how much WAL you write per checkpoint interval, then leave room. Vondra's example: 1.8 GB per 5 minutes means about 11 GB per 30 minutes; he then doubles it to 22 GB [43].

```sql
-- Measure WAL volume: run once, wait (for example 15 minutes), run again
SELECT now(), pg_current_wal_lsn();
-- Then compute the difference between the two LSNs (log sequence numbers)
SELECT pg_size_pretty(pg_wal_lsn_diff('3/2A000000', '3/10000000')) AS wal_written;
```

If the log says "checkpoints are occurring too frequently" (`checkpoint_warning`, default 30 s), raise `max_wal_size` [4]. The monitoring section shows how to compare timed and requested checkpoints.

**`checkpoint_completion_target`** (default 0.9 since PG 14; it was 0.5 before) spreads checkpoint writes over 90% of the interval [4][29]. Keep it.

**`wal_compression`** (default `off`). It compresses full-page images in the WAL: less WAL and less replication traffic, for some CPU, without extra risk of corruption [4]. `lz4` and `zstd` are available since PG 15 if the server was built with them; `pglz` (or `on`) works everywhere [4][28].

**`synchronous_commit`** (default `on`). With `off`, `COMMIT` returns before the WAL reaches disk. A crash can lose the last few transactions (at most three times `wal_writer_delay`, which is 200 ms by default), but the database stays consistent, as if those transactions had been rolled back [4]. When synchronous replication is configured, the value also decides what the commit waits for on the standby [4]:

| Value | Durable on the primary | On the standby, survives a PostgreSQL crash | On the standby, survives an OS crash | Standby queries already see the commit |
|---|---|---|---|---|
| `remote_apply` | Yes | Yes | Yes | Yes |
| `on` (default) | Yes | Yes | Yes | No |
| `remote_write` | Yes | Yes | No | No |
| `local` | Yes | No | No | No |
| `off` | No (recent commits may be lost) | No | No | No |

```sql
-- Good: relax durability only for low-value data, only in this transaction
BEGIN;
SET LOCAL synchronous_commit = off;
INSERT INTO page_views (user_id, path, viewed_at) VALUES (42, '/pricing', now());
COMMIT;
```

```ini
# Bad: never do this on data you want to keep
fsync = off              # a power loss can corrupt the whole cluster [4]
full_page_writes = off   # same risk after a crash during a page write
```

### Planner and I/O

**`random_page_cost`** (default 4.0). The default assumes that most random reads are served from cache [5]. For SSDs, the long-standing community advice is a value close to 1 [41], and 1.1 is a common choice. This works well when most random reads are served from cache; if the whole database fits in RAM, setting it equal to `seq_page_cost` (1.0) also makes sense [5]. But 2025 measurements of *uncached* random reads on SSDs found them much slower than sequential reads, so do not lower it blindly when the data does not fit in memory: change it on a test system and compare before and after. Details and sources: [06 §8.2](06-query-optimization-and-explain.md#82-planner-cost-settings-effective_cache_size-and-random_page_cost).

**`effective_io_concurrency`** and **`maintenance_io_concurrency`**. Defaults are 16 and 16 in PG 18 [3][1], and 1 and 10 in PG 14–17 [30][31]. For SSDs, the PG 17 documentation says "the best value might be in the hundreds" [30]. In PG 18 this value also limits how far asynchronous I/O reads ahead (about `effective_io_concurrency × io_combine_limit`), so benchmark before raising it far [44].

**`io_method`** and **`io_workers`** (PG 18+). `io_method` chooses how asynchronous I/O is done: `worker` (default, background I/O worker processes), `io_uring` (Linux only, needs a build with `--with-liburing`), or `sync` (the old behavior) [3]. `io_workers` defaults to 3 [3]. In PG 18, asynchronous I/O covers sequential scans, bitmap heap scans and VACUUM; writes and index scans still use the old path [2][44]. In a pganalyze cold-cache test on AWS (3.5 GB table), a sequential scan took 15.8 s on PG 17, 10.1 s with `worker` and 5.7 s with `io_uring` [44]. PostgreSQL 19 adds automatic scaling of I/O workers (`io_min_workers`, `io_max_workers`) (PG 19, beta — may change) [34].

**`default_statistics_target`** (default 100) [5]. Keep the default and raise it per column when estimates are wrong, with `ALTER TABLE orders ALTER COLUMN status SET STATISTICS 1000;` followed by `ANALYZE orders;` (see [06](06-query-optimization-and-explain.md)).

**`jit`** (default `on` in PG 14–18; `jit_above_cost` 100000) [5]. Just-in-time compilation helps long analytic queries but adds planning time. For OLTP, compile time often costs more than it saves; check `EXPLAIN (ANALYZE)` output for a "JIT" section with large times, and consider `jit = off`. PostgreSQL 19 changes the default to `off` (PG 19, beta — may change) [34][36].

### Parallel query

Defaults: `max_worker_processes` 8 (restart), `max_parallel_workers` 8, `max_parallel_workers_per_gather` 2, `max_parallel_maintenance_workers` 2 [3]. Each parallel worker is a full process with the impact of an extra session, and each one can use `work_mem` [3]. For OLTP, keep 2 workers per gather. For reporting on many cores, try 4. Keep `max_worker_processes` at least as high as `max_parallel_workers` plus the background workers that extensions and logical replication need. Standbys need `max_worker_processes` at least as high as the primary [3].

### Timeouts as safety nets

Timeouts stop one bad query or one forgotten transaction from hurting everybody.

| Parameter | Default | Stops | Notes |
|---|---|---|---|
| `statement_timeout` | 0 (off) | A statement that runs too long | Do not set it in `postgresql.conf`: it affects all sessions, including maintenance [6] |
| `lock_timeout` | 0 | Waiting too long for a lock | Useful for migrations; see [10](10-safe-schema-migrations.md) [6] |
| `idle_in_transaction_session_timeout` | 0 | A session idle inside an open transaction | Such sessions hold locks and block VACUUM [6] |
| `transaction_timeout` (PG 17+) | 0 | A transaction that lasts too long | Not for prepared transactions [6][26] |
| `idle_session_timeout` (PG 14+) | 0 | A session idle outside a transaction | Poolers may not like their connections being closed; use only for interactive roles [6] |
| `client_connection_check_interval` (PG 14+) | 0 | A query whose client has disconnected | Checks the socket during long queries [12][29] |

```sql
-- Good: per-role limits for the application
ALTER ROLE app_user SET statement_timeout = '15s';
ALTER ROLE app_user SET lock_timeout = '3s';
ALTER ROLE app_user SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE app_user SET transaction_timeout = '2min';   -- PG 17+
ALTER ROLE reporting SET statement_timeout = '10min';

-- A server-wide safety net that is safe for every role
ALTER SYSTEM SET idle_in_transaction_session_timeout = '10min';
SELECT pg_reload_conf();
```

Role settings apply to new sessions. They also work behind PgBouncer, because PgBouncer keeps separate server connections per user and database pair [50].

### Sample `postgresql.conf` excerpt (starting point only)

```ini
# STARTING POINT ONLY — not a recommendation for your server.
# Assumes: PostgreSQL 18, Linux, dedicated VM with 8 vCPU / 32 GB RAM / NVMe SSD,
# OLTP workload, PgBouncer in front. Measure, then adjust one setting at a time.

# --- Connections ---
max_connections = 200                   # restart; the pooler keeps active ones low
reserved_connections = 5                # PG 16+; for roles granted pg_use_reserved_connections

# --- Memory ---
shared_buffers = 8GB                    # restart; ~25% of RAM
huge_pages = try                        # restart; reserve vm.nr_hugepages to really use them
effective_cache_size = 24GB             # planner hint only (~75% of RAM)
work_mem = 32MB                         # per sort/hash step per process; watch temp files
maintenance_work_mem = 1GB              # CREATE INDEX, manual VACUUM
autovacuum_work_mem = 512MB             # per autovacuum worker

# --- WAL and checkpoints ---
wal_compression = lz4                   # PG 15+ if built with lz4; otherwise pglz
checkpoint_timeout = 15min
max_wal_size = 16GB                     # size from measured WAL rate; soft limit
min_wal_size = 2GB
checkpoint_completion_target = 0.9      # default since PG 14

# --- Planner and I/O ---
random_page_cost = 1.1                  # SSD/NVMe, mostly cached data; test first (06 §8.2)
#effective_io_concurrency = 16          # PG 18 default; benchmark before raising
io_method = worker                      # PG 18+, restart; io_uring on Linux if available
io_workers = 3                          # PG 18+ default; raise if scans wait on I/O
jit = off                               # OLTP; default is on in PG 14-18

# --- Parallel query ---
max_worker_processes = 16               # restart; parallel workers + extension workers
max_parallel_workers = 8
max_parallel_workers_per_gather = 2
max_parallel_maintenance_workers = 4

# --- Autovacuum ---
autovacuum_max_workers = 5              # PG 18: reload is enough (up to autovacuum_worker_slots = 16)
autovacuum_vacuum_cost_limit = 1000     # default -1 means vacuum_cost_limit (200)

# --- Safety nets (statement_timeout and lock_timeout: per role, not here) ---
idle_in_transaction_session_timeout = 10min

# --- Logging (see the next section) ---
logging_collector = on                  # restart
log_line_prefix = '%m [%p] %q%u@%d app=%a client=%h '
log_min_duration_statement = 250ms
log_lock_waits = on
log_temp_files = 10MB
log_autovacuum_min_duration = 10s
log_checkpoints = on
track_io_timing = on                    # test overhead first with pg_test_timing

# --- Extensions (restart) ---
shared_preload_libraries = 'pg_stat_statements,auto_explain'
```

## Logging for observability

Logs answer "what happened at 03:12?" when no dashboard was open. Statistics views (next section) show totals; logs show individual events with their context.

### Recommended logging settings

| Parameter | Default | Suggested | Why |
|---|---|---|---|
| `logging_collector` | off | on (self-hosted) | Captures stderr into files; needed for `csvlog` and `jsonlog` [9] |
| `log_destination` | `stderr` | `stderr`, or `jsonlog` (PG 15+) for log pipelines | [9][28] |
| `log_line_prefix` | `'%m [%p] '` | `'%m [%p] %q%u@%d app=%a client=%h '` | Adds user, database, application and client to each line [9] |
| `log_min_duration_statement` | -1 (off) | 250 ms–1 s | Logs every statement slower than the threshold, with its duration [9] |
| `log_lock_waits` | off (on in PG 19, beta — may change) | on | Logs a wait longer than `deadlock_timeout` (default 1 s) [9][34] |
| `log_temp_files` | -1 (off) | 0, or 10 MB on busy servers | Finds queries that spill to disk (too little `work_mem` or a bad plan) [9] |
| `log_autovacuum_min_duration` | 10 min (PG 15+), -1 in PG 14 | 10 s–1 min (0 while investigating) | Shows what autovacuum does and how long it takes [9][28] |
| `log_checkpoints` | on (PG 15+), off in PG 14 | on | Checkpoint timing and cause [9][28] |
| `log_connections`, `log_disconnections` | off | on (if connection volume is moderate) | Connection storms, session length. PG 18 accepts a list such as `'receipt,authorization,setup_durations'` [9] |
| `log_statement` | `none` | `ddl` | Records every schema change [9] |
| `log_min_duration_sample`, `log_statement_sample_rate` | -1, 1.0 | e.g. 50 ms and 0.1 | Samples medium-fast statements on busy servers [9] |
| `lc_messages` | from initdb | `'C'` | English messages, which log analyzers expect [68] |

Two cautions. First, logged statements can contain personal data and even plain-text passwords; protect log files and see [11 — security](11-security.md) [9]. Second, `log_min_duration_statement = 0` logs everything and can overload a busy server; use sampling instead. `log_parameter_max_length` trims logged bind parameters [9].

### auto_explain: capture plans of slow queries automatically

`auto_explain` is a contrib module that writes the execution plan of slow statements to the log, so you see the plan that actually ran in production [11]. Load it with `session_preload_libraries` or `shared_preload_libraries` [11].

```ini
shared_preload_libraries = 'pg_stat_statements,auto_explain'   # restart
auto_explain.log_min_duration = '500ms'   # default -1 = off
auto_explain.log_analyze = on             # real row counts and times
auto_explain.log_buffers = on             # needs log_analyze
auto_explain.log_timing = off             # reduces the overhead of log_analyze
auto_explain.log_format = 'json'          # easier for tools
auto_explain.sample_rate = 0.25           # explain only a fraction of statements
```

Warning from the documentation: with `log_analyze` on, every statement is instrumented, whether or not it is slow enough to be logged. This "can have an extremely negative impact on performance". Turning off `log_timing` reduces the cost [11]. Test on a staging server first. How to read plans: [06](06-query-optimization-and-explain.md).

### pgBadger: turn logs into reports

pgBadger is a Perl log analyzer that builds HTML reports: slowest queries, most frequent queries, lock waits, temporary files, checkpoints, autovacuum, connections and errors [68]. It reads `stderr`, `csvlog`, `jsonlog` and `syslog` formats [68]. Its README suggests a prefix such as `'%t [%p]: user=%u,db=%d,app=%a,client=%h '` and `lc_messages = 'C'` [68]. Incremental mode (`-I`) builds daily and weekly reports from a cron job [68].

```bash
# Daily cron job: incremental reports into a web folder
pgbadger -I -O /var/www/pgbadger /var/log/postgresql/postgresql-*.log
```

Managed services expose logs through their consoles; pganalyze and similar services parse them for you (see the monitoring stacks below).

## Monitoring

### What to watch, and where

| Signal | View or source | Look for | Since |
|---|---|---|---|
| Sessions and waits | `pg_stat_activity` | Close to `max_connections`; many `idle in transaction`; transactions open for minutes; many sessions waiting on `Lock`, `LWLock` or `IO` | all |
| Blocking | `pg_blocking_pids()`, `pg_locks`, `log_lock_waits` | Any lock wait longer than a few seconds | all |
| Database health | `pg_stat_database` | Drop of the cache hit ratio; growth of temporary files, deadlocks, rollbacks, checksum failures | all; session columns PG 14 [29] |
| Table health | `pg_stat_user_tables` | Large `n_dead_tup`; big tables not vacuumed for days; many sequential scans on big tables | all; `last_seq_scan`, `last_idx_scan`, `n_tup_newpage_upd` PG 16 [27]; vacuum time totals PG 18 [1] |
| Index usage | `pg_stat_user_indexes` | Indexes never used ([05](05-indexing.md)) | all; `last_idx_scan` PG 16 [27] |
| Cache use per table | `pg_statio_user_tables`, `pg_statio_user_indexes` | Hot tables read mostly from outside `shared_buffers` | all |
| I/O by process type | `pg_stat_io` | Client backends that write or evict many buffers themselves | PG 16 [27]; byte columns and WAL rows PG 18 [1] |
| Checkpoints | `pg_stat_checkpointer` (`pg_stat_bgwriter` before PG 17) | Many requested (not timed) checkpoints | PG 17 [26] |
| WAL volume | `pg_stat_wal` | Sudden growth; many full-page images | PG 14 [29] |
| Wraparound | `pg_database`, `pg_class` | Transaction ID age far above `autovacuum_freeze_max_age` | all |
| Replication lag | `pg_stat_replication` | Lag in seconds or bytes that keeps growing | all |
| Replication slots | `pg_replication_slots` | Inactive slots; `wal_status` = `extended` or `unreserved`; growing retained WAL | `inactive_since`, `invalidation_reason` PG 17 [23][26] |
| WAL archiving | `pg_stat_archiver` | `failed_count` growing | all |
| Long operations | `pg_stat_progress_vacuum`, `_analyze`, `_create_index`, `_cluster`, `_basebackup`, `_copy` | Progress of VACUUM, index builds, base backups, `COPY` | `_copy` PG 14 [29] |
| Disk space | operating system | Data and `pg_wal` volumes; a full `pg_wal` volume stops the server [18] | — |
| Query performance | `pg_stat_statements` | See [06](06-query-optimization-and-explain.md) | — |

Statistics in these views are cumulative since the last reset (`stats_reset` column). They survive a clean restart but are reset after a crash or a restore from backup [10]. Compare two samples over time, or use a tool that does it for you. A monitoring user needs the built-in `pg_monitor` role, not superuser [71].

### Ready-to-use queries

All queries work on PG 14–18 unless marked. Run them as a user with the `pg_monitor` role.

**Sessions: states, oldest transactions, waits** (compare the connection total with `max_connections`):

```sql
-- Connections by state
SELECT state, count(*) AS connections
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY state
ORDER BY connections DESC;

-- Oldest open transactions and running queries
SELECT pid, usename, application_name, state,
       now() - xact_start  AS transaction_age,
       now() - query_start AS query_age,
       wait_event_type, wait_event,
       left(query, 120)    AS query
FROM pg_stat_activity
WHERE backend_type = 'client backend' AND state <> 'idle'
ORDER BY xact_start NULLS LAST
LIMIT 20;

-- What active sessions are waiting for (NULL = running on the CPU)
SELECT wait_event_type, wait_event, count(*) AS sessions
FROM pg_stat_activity
WHERE state = 'active' AND backend_type = 'client backend'
GROUP BY wait_event_type, wait_event
ORDER BY sessions DESC;
```

`Lock` means heavyweight locks on tables or rows; `LWLock` means internal shared-memory locks; `IO` means waiting for storage [10].

**Who blocks whom:**

```sql
SELECT blocked.pid                 AS blocked_pid,
       now() - blocked.query_start AS waiting_for,
       left(blocked.query, 80)     AS blocked_query,
       blocking.pid                AS blocking_pid,
       blocking.state              AS blocking_state,
       now() - blocking.xact_start AS blocking_transaction_age,
       left(blocking.query, 80)    AS blocking_query
FROM pg_stat_activity AS blocked
CROSS JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS b(pid)
JOIN pg_stat_activity AS blocking ON blocking.pid = b.pid
ORDER BY waiting_for DESC;
```

To stop a session, first try `SELECT pg_cancel_backend(pid);` (cancels the current query), then `SELECT pg_terminate_backend(pid);` (closes the connection and rolls back its transaction).

**Database health: cache hits, rollbacks, deadlocks, temporary files:**

```sql
SELECT datname,
       round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS cache_hit_pct,
       xact_commit, xact_rollback, deadlocks,
       temp_files, pg_size_pretty(temp_bytes) AS temp_written,
       stats_reset
FROM pg_stat_database
WHERE datname IS NOT NULL
ORDER BY blks_read DESC;
```

There is no universal target for the cache hit ratio. Busy OLTP databases usually have a high ratio, and a sudden drop matters more than the absolute number. `blks_read` counts reads from the operating system, and many of them come from the OS page cache, not from the disk.

**Tables: size, dead tuples and vacuum history:**

```sql
-- Largest tables, with their indexes and TOAST data
SELECT c.oid::regclass                               AS table_name,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       pg_size_pretty(pg_relation_size(c.oid))       AS table_size,
       pg_size_pretty(pg_indexes_size(c.oid))        AS indexes_size
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 20;

-- Dead tuples and the last autovacuum / autoanalyze
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       n_mod_since_analyze, n_ins_since_vacuum,
       last_autovacuum, last_autoanalyze, autovacuum_count
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 20;
```

Queries for unused indexes and sequential-scan counts are in [05 — indexing](05-indexing.md) and [06](06-query-optimization-and-explain.md).

**Transaction ID (XID) age per database and per table** (wraparound risk, explained in the VACUUM section; the table query comes from the documentation [8]):

```sql
SELECT datname,
       age(datfrozenxid)    AS xid_age,
       mxid_age(datminmxid) AS multixact_age,
       current_setting('autovacuum_freeze_max_age')::bigint AS freeze_max_age
FROM pg_database
ORDER BY xid_age DESC;

SELECT c.oid::regclass AS table_name,
       greatest(age(c.relfrozenxid), age(t.relfrozenxid)) AS xid_age
FROM pg_class AS c
LEFT JOIN pg_class AS t ON c.reltoastrelid = t.oid
WHERE c.relkind IN ('r', 'm')
ORDER BY xid_age DESC
LIMIT 20;
```

**Replication lag and replication slots (run on the primary):**

```sql
SELECT application_name, client_addr, state, sync_state,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS replay_lag_size,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;

SELECT slot_name, slot_type, active, wal_status, safe_wal_size,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal,
       age(xmin) AS xmin_age, age(catalog_xmin) AS catalog_xmin_age
       -- PG 17+: also inactive_since, invalidation_reason
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC NULLS LAST;
```

**Checkpoints, I/O, WAL archiving and VACUUM progress:**

```sql
-- Checkpoints, PG 17+ (num_done exists from PG 18)
SELECT num_timed, num_requested,
       round(100.0 * num_requested / nullif(num_timed + num_requested, 0), 1) AS requested_pct,
       write_time, sync_time, buffers_written, stats_reset
FROM pg_stat_checkpointer;

-- Checkpoints, PG 14-16
SELECT checkpoints_timed, checkpoints_req, checkpoint_write_time,
       checkpoint_sync_time, buffers_checkpoint, stats_reset
FROM pg_stat_bgwriter;

-- I/O by process type (PG 16+)
SELECT backend_type, object, context, reads, writes, extends, hits, evictions
FROM pg_stat_io
WHERE coalesce(reads, 0) + coalesce(writes, 0) > 0
ORDER BY coalesce(reads, 0) + coalesce(writes, 0) DESC;

-- WAL archiving health
SELECT archived_count, last_archived_time, failed_count, last_failed_wal, last_failed_time
FROM pg_stat_archiver;

-- Running VACUUMs
SELECT p.pid, p.relid::regclass AS table_name, p.phase,
       round(100.0 * p.heap_blks_scanned / nullif(p.heap_blks_total, 0), 1) AS scanned_pct,
       p.index_vacuum_count
FROM pg_stat_progress_vacuum AS p;
```

A high share of requested checkpoints means `max_wal_size` is too small for your write rate [43]. If `client backend` rows in `pg_stat_io` show many `writes` in the `normal` context, queries write dirty pages themselves: `shared_buffers` may be too small or the background writer too slow. PG 17 removed the old `buffers_backend` counter because `pg_stat_io` covers it [26].

### Monitoring stacks

| Tool | Type | Notes |
|---|---|---|
| pganalyze | Commercial SaaS (on-premise option) | Query statistics, plans via `auto_explain`, log insights, index and VACUUM advisors; RDS, Aurora, Cloud SQL, Azure and self-managed [69] |
| pgwatch | Open source (Cybertec, BSD-3) | Collector plus Grafana dashboards; stores metrics in PostgreSQL or exports to Prometheus [70] |
| postgres_exporter + Prometheus + Grafana | Open source | Standard Prometheus exporter; CI-tested on PostgreSQL 13–18; use a `pg_monitor` user [71] |
| Datadog Database Monitoring | Commercial SaaS | Query metrics, query samples, explain plans next to host metrics [72] |
| Percona Monitoring and Management (PMM) | Open source | PMM Server + Client, Query Analytics; MySQL, PostgreSQL, MongoDB; PMM 3 [73] |
| pg_activity | Open source CLI (Dalibo) | `top`-like view of running, waiting and blocking queries; can cancel or kill sessions [74] |
| pgcenter | Open source CLI | `top`-like statistics viewer that combines PostgreSQL and Linux metrics [75] |

Managed services also include basic dashboards, but you still need alerts on the signals in the table above.

## VACUUM and autovacuum

### Why VACUUM exists

The documentation lists four jobs [8]:

1. **Reuse space**: remove dead tuples left by `UPDATE` and `DELETE`, so new rows can use the space.
2. **Update planner statistics**: `ANALYZE` (often run together with VACUUM) samples the data for the planner.
3. **Update the visibility map**: a small bitmap per table that marks pages where every row is visible to everyone (*all-visible*) or already frozen (*all-frozen*). Index-only scans and later VACUUM runs skip such pages.
4. **Prevent transaction ID wraparound**: *freeze* old rows so that their 32-bit transaction IDs can be reused safely.

Autovacuum does all four automatically. Never turn it off: tables bloat, statistics go stale, and PostgreSQL still forces anti-wraparound vacuums anyway, at a worse moment [7]. The PostgreSQL wiki puts it simply: the answer to almost all vacuuming problems is to vacuum more often, not less [37]. (Temporary tables are the exception: autovacuum cannot see them, so analyze them yourself [8].)

### VACUUM, VACUUM FULL and REPACK

| Command | Lock | Space returned to the OS | When to use |
|---|---|---|---|
| `VACUUM` (and autovacuum) | Reads and writes continue; only schema changes wait | Only empty pages at the end of the table [8] | Routine; `VACUUM (ANALYZE, VERBOSE)` after a large data change |
| `VACUUM FULL t` | `ACCESS EXCLUSIVE`: blocks reads and writes for the whole run; needs free disk about the table size [8] | Yes | Maintenance window, small tables |
| pg_repack / pg_squeeze | Short exclusive locks only | Yes | Online rewrite of a bloated table (see [Bloat](#bloat)) |
| `REPACK` (PG 19, beta — may change) | `ACCESS EXCLUSIVE`; with `CONCURRENTLY`, only for the final file swap [35] | Yes | Replaces `VACUUM FULL` and `CLUSTER`; the old commands remain [34] |

The documentation is clear: "administrators should strive to use standard `VACUUM` and avoid `VACUUM FULL`" [8].

At the end of a run, VACUUM may shrink the file by cutting empty pages at its end; this needs a short `ACCESS EXCLUSIVE` lock [7]. If that lock causes trouble on a busy table, disable it per table with the storage parameter `vacuum_truncate = false` (since PG 12), or server-wide with the new `vacuum_truncate` setting (PG 18+) [1][7].

### How autovacuum decides to run

Autovacuum visits each database about once per `autovacuum_naptime` (default 1 min) and checks every table [7]. The formulas, as documented for PG 18 [8]:

```text
vacuum after   min(autovacuum_vacuum_max_threshold,                    -- PG 18+, default 100,000,000
                   autovacuum_vacuum_threshold                          -- default 50
                   + autovacuum_vacuum_scale_factor × reltuples)        -- default 0.2
               updated or deleted rows

vacuum after   autovacuum_vacuum_insert_threshold                       -- PG 13+, default 1,000
               + autovacuum_vacuum_insert_scale_factor × reltuples      -- default 0.2
                 (PG 18: × fraction of the table not yet frozen)
               inserted rows

analyze after  autovacuum_analyze_threshold                             -- default 50
               + autovacuum_analyze_scale_factor × reltuples            -- default 0.1
               inserted, updated or deleted rows
```

What the defaults mean in practice:

| Table size (rows) | Dead rows before autovacuum, PG 14–17 | Same, PG 18 |
|---|---|---|
| 10,000 | 2,050 | 2,050 |
| 10,000,000 | 2,000,050 | 2,000,050 |
| 1,000,000,000 | 200,000,050 | 100,000,000 (capped) |

A 20% scale factor is fine for small tables but far too late for big ones. In addition, any table whose oldest unfrozen transaction ID is older than `autovacuum_freeze_max_age` is always vacuumed [8].

Autovacuum does not analyze partitioned tables themselves (only their partitions). Run `ANALYZE` on the parent table after loading data or when the data distribution changes [8].

### Tuning autovacuum for big, busy tables

Change settings per table first, globally second. Storage parameters override the server settings for one table [46]:

```sql
-- Big, frequently updated table: vacuum after about 1% changes instead of 20%
ALTER TABLE orders SET (
  autovacuum_vacuum_scale_factor  = 0.01,
  autovacuum_vacuum_threshold     = 1000,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_limit    = 2000
);

-- Append-mostly table (PG 13+): vacuum regularly to update the visibility map and freeze rows
ALTER TABLE events SET (
  autovacuum_vacuum_insert_scale_factor = 0.01,
  autovacuum_vacuum_insert_threshold    = 10000
);

-- Very hot table (for example a queue): no throttling at all
ALTER TABLE job_queue SET (autovacuum_vacuum_cost_delay = 0);

-- List every per-table setting
SELECT relname, reloptions FROM pg_class WHERE reloptions IS NOT NULL;
```

Queue tables, sessions and counters change constantly and need special design; see [07 — schema design](07-schema-design-and-patterns.md).

### Autovacuum speed: cost limit, cost delay and workers

- Autovacuum throttles itself. It adds "cost" points for each page: 1 if found in `shared_buffers`, 2 if read from disk, 20 if it dirties the page. After `vacuum_cost_limit` points (default 200) it sleeps `autovacuum_vacuum_cost_delay` (default 2 ms) [7].
- Rough upper bound with the defaults: 200 points per 2 ms is 100,000 points per second. If every page is dirtied (20 points), that is about 5,000 pages, or about 40 MB, per second. On a multi-terabyte database this can be too slow.
- The cost limit is *shared*: "The value is distributed proportionally among the running autovacuum workers" [7]. More workers without a higher limit do not vacuum more in total; each worker just gets slower. More workers help when many tables or partitions need work at the same time [46].
- To make autovacuum faster, raise `autovacuum_vacuum_cost_limit` (for example 1000–2000) or lower `autovacuum_vacuum_cost_delay` [46]. Watch disk I/O while you do it.
- `autovacuum_max_workers` defaults to 3 [7]. Up to PG 17 a change needs a restart. In PG 18, `autovacuum_worker_slots` (default 16) reserves slots at start, and `autovacuum_max_workers` can then change with a reload [1][7].
- A manual `VACUUM` is not throttled by default (`vacuum_cost_delay = 0`) [7].

### Freezing and transaction ID wraparound

Transaction IDs (XIDs) are 32-bit numbers, compared in a circle: for every XID, about two billion are "older" and two billion are "newer" [8]. If a row's XID became more than about two billion transactions old, the row would suddenly look like it came from the future and become invisible. To prevent this, VACUUM *freezes* old rows: it marks them as visible to everyone, so their XID no longer matters [8]. Every table must be vacuumed at least once every two billion transactions [8].

Defaults and what happens at each age [7][8]:

| Age of the oldest unfrozen XID | What happens |
|---|---|
| 50 million (`vacuum_freeze_min_age`) | Normal VACUUM freezes rows older than this on the pages it visits |
| 150 million (`vacuum_freeze_table_age`) | VACUUM becomes *aggressive*: it visits every page that is not all-frozen |
| 200 million (`autovacuum_freeze_max_age`) | Autovacuum forces an anti-wraparound vacuum on the table, even if autovacuum is disabled |
| 1.6 billion (`vacuum_failsafe_age`, PG 14+) | Failsafe: VACUUM stops throttling and skips index cleanup to finish quickly [7][29] |
| About 40 million XIDs before the limit | `WARNING: database "app" must be vacuumed within ... transactions` |
| About 3 million XIDs before the limit | `ERROR: database is not accepting commands that assign new transaction IDs ...`; only read-only transactions work |

*Multixacts* (IDs used when several transactions lock the same row) follow the same logic, with `autovacuum_multixact_freeze_max_age` = 400 million [7][8].

A normal autovacuum cancels itself when another session needs a conflicting lock. An anti-wraparound autovacuum (its query in `pg_stat_activity` ends with "(to prevent wraparound)") is not interrupted, so an `ALTER TABLE` on that table will wait behind it [8]. Plan schema changes on huge tables with this in mind, and set `lock_timeout` in migrations ([10](10-safe-schema-migrations.md)).

**If you get the warning or the error**, follow the documented steps [8]:

1. Commit or roll back old prepared transactions (`pg_prepared_xacts`).
2. End long-running sessions (large `age(backend_xid)` or `age(backend_xmin)` in `pg_stat_activity`).
3. Drop stale replication slots (large `age(xmin)` or `age(catalog_xmin)`).
4. Run a plain `VACUUM` in the affected database. Do not use `VACUUM FULL` or `VACUUM FREEZE`, and do not stop the server or use single-user mode: the documentation says this is "not necessary or desirable" [8].

**Alerting**: the per-database query in the monitoring section shows `xid_age`. Alert when it stays far above `autovacuum_freeze_max_age` (for example above 500 million with the default 200 million): it means anti-wraparound vacuums do not finish.

### Recent VACUUM improvements by version

| Version | Change |
|---|---|
| PG 13 | Autovacuum also triggers on inserts (`autovacuum_vacuum_insert_*`), so append-only tables get frozen and their visibility map updated [46][7] |
| PG 14 | Failsafe mode near wraparound (`vacuum_failsafe_age`) [29] |
| PG 15 | Slow autovacuum runs are logged by default (`log_autovacuum_min_duration = 10min`) [28] |
| PG 16 | `vacuum_buffer_usage_limit` and `VACUUM (BUFFER_USAGE_LIMIT ...)` control how much of `shared_buffers` VACUUM uses; faster freezing [27] |
| PG 17 | New dead-tuple storage: much less memory, and no more 1 GB limit [26] |
| PG 18 | *Eager freezing*: normal vacuums also freeze some all-visible pages, which makes later aggressive vacuums cheaper (`vacuum_max_eager_freeze_failure_rate`, default 0.03) [1][7][8]; `autovacuum_vacuum_max_threshold`; `autovacuum_worker_slots`; time totals per table (`total_vacuum_time`, `total_autovacuum_time`, ...) [1]; `track_cost_delay_timing` shows time spent sleeping [1]; `VACUUM` and `ANALYZE` of a partitioned table now include its partitions (use `ONLY` for the old behavior) [1] |
| PG 19 (beta — may change) | A scoring system chooses which tables autovacuum processes first (view `pg_stat_autovacuum_scores`); parallel autovacuum workers; `REPACK` [34] |

### What blocks VACUUM: the xmin horizon

VACUUM can remove a dead tuple only when no transaction can still need it. The oldest transaction that might still need old rows defines the *xmin horizon* for the whole database (for some causes, the whole server). Laurenz Albe lists four usual culprits [45]:

1. **Long-running transactions**, including sessions *idle in transaction* and long `pg_dump` runs.
2. **Abandoned replication slots** (their `xmin` or `catalog_xmin`).
3. **Orphaned prepared transactions** (two-phase commit).
4. **Standbys with `hot_standby_feedback = on`** that run long queries.

```sql
-- 1. Sessions holding back the horizon
SELECT pid, usename, application_name, state,
       now() - xact_start AS transaction_age,
       age(backend_xmin)  AS xmin_age
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY age(backend_xmin) DESC
LIMIT 5;

-- 2. Replication slots
SELECT slot_name, slot_type, active,
       age(xmin) AS xmin_age, age(catalog_xmin) AS catalog_xmin_age
FROM pg_replication_slots
ORDER BY greatest(age(xmin), age(catalog_xmin)) DESC NULLS LAST;

-- 3. Prepared transactions
SELECT gid, prepared, owner, database, age(transaction) AS xid_age
FROM pg_prepared_xacts
ORDER BY age(transaction) DESC;

-- 4. Standbys sending feedback
SELECT application_name, client_addr, age(backend_xmin) AS xmin_age
FROM pg_stat_replication
ORDER BY age(backend_xmin) DESC NULLS LAST;
```

`VACUUM (VERBOSE) orders;` also prints how many dead rows are "not yet removable" and how old the removal cutoff is. Prevent the problem with `idle_in_transaction_session_timeout`, `transaction_timeout` (PG 17+), `max_slot_wal_keep_size` and `idle_replication_slot_timeout` (PG 18+) [6][20].

## Bloat

### What bloat is and where it comes from

*Bloat* is space inside table or index files that holds no live data. Some free space is normal and gets reused. It becomes a problem when it grows and stays:

- VACUUM is too slow or blocked (previous section), so dead tuples pile up.
- A mass `DELETE` or `UPDATE` frees space that new rows will not need for a long time; plain VACUUM gives back only empty pages at the end of the file [8].
- Every non-HOT update adds a new entry to *every* index of the table; index pages split and stay half empty.
- High-churn tables (queues, sessions, counters) rewrite the same rows all day.

Bloat makes scans read more pages, makes the cache less effective, and makes backups and replicas bigger.

### Measuring bloat

1. **Quick look**: `n_dead_tup` and `dead_pct` from `pg_stat_user_tables` (monitoring section). These are estimates.
2. **Estimation queries**: the widely used queries by ioguix estimate table and B-tree bloat from planner statistics, without reading the table. They need fresh `ANALYZE` data and can be wrong for TOAST-heavy tables [48].
3. **Exact numbers**: the `pgstattuple` extension [24]. Callers need the `pg_stat_scan_tables` role or superuser [24].

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;

-- Fast: skips all-visible pages using the visibility map
SELECT * FROM pgstattuple_approx('orders'::regclass);

-- Exact: reads the whole table (run off-peak on big tables)
SELECT table_len, dead_tuple_percent, free_percent FROM pgstattuple('orders');

-- B-tree index: a low avg_leaf_density means a bloated index
SELECT avg_leaf_density, leaf_fragmentation FROM pgstatindex('orders_pkey');
```

A large table whose `free_percent` plus `dead_tuple_percent` stays high (say, above 30–50%) after autovacuum has run is a candidate for a rewrite.

### Fixing bloat

| Method | Locking | Requirements | Use when |
|---|---|---|---|
| Tune autovacuum and wait | None | — | Moderate bloat; new rows will reuse the space |
| `REINDEX INDEX CONCURRENTLY` (PG 12+) | Short locks | Disk for the new index | A bloated index |
| pg_repack | Short `ACCESS EXCLUSIVE` at start and end; reads and writes continue in between [58] | Primary key or unique index on NOT NULL columns; free disk about twice the table plus indexes; PG 9.5–18 [58] | Online rewrite of a table |
| pg_squeeze | Short exclusive lock at the end, limited by `squeeze.max_xlock_time` [59] | `shared_preload_libraries`, a replication slot, `wal_level = logical` (on PG 14–18), primary key or replica identity [59] | Online rewrite, scheduled inside the server |
| `VACUUM FULL` / `CLUSTER` | `ACCESS EXCLUSIVE` for the whole run [8] | Free disk about the table size [8] | Small tables, maintenance window |
| `REPACK (CONCURRENTLY)` (PG 19, beta — may change) | Exclusive lock only to swap files [35] | Primary key or replica identity index; not for partitioned or unlogged tables; not MVCC-safe (old snapshots may see wrong data); disk for a full copy [35] | Future built-in online rewrite |

```bash
# Rewrite one table online, without reordering rows (run from a client; the
# pg_repack extension must be installed in the database first)
pg_repack --host=db1 --dbname=app --table=public.orders --no-order --jobs=2
```

For a single bloated index, `REINDEX INDEX CONCURRENTLY orders_created_at_idx;` rebuilds it without blocking writes.

### Preventing bloat

1. **Keep autovacuum ahead** (previous section) and keep transactions short.
2. **Keep updates HOT**. A *HOT* (heap-only tuple) update happens when no indexed column changes and the page has free space. It creates no new index entries, and old versions can be cleaned during normal page access, without VACUUM [25]. Do not index a column that changes all the time (like `last_seen_at`) unless queries really need it.
3. **Lower `fillfactor`** on update-heavy tables to leave free space on each page for HOT updates [25]. It applies to new pages; rewrite the table (pg_repack) to apply it everywhere.
4. **Batch mass changes**: delete or update in batches of a few thousand rows, each in its own transaction, so autovacuum can work in between and locks stay short. Patterns are in [04 — query patterns](04-query-patterns-and-antipatterns.md).
5. **Drop partitions instead of deleting rows** for time-based data: dropping or detaching a partition creates no dead tuples ([07 — schema design](07-schema-design-and-patterns.md)).

```sql
-- Leave 20% free space per page for HOT updates
ALTER TABLE user_sessions SET (fillfactor = 80);

-- How many updates are HOT?
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) AS hot_pct,
       n_tup_newpage_upd          -- PG 16+: remove this column on PG 14-15
FROM pg_stat_user_tables
WHERE n_tup_upd > 0
ORDER BY n_tup_upd DESC
LIMIT 20;

-- Delete old rows in batches; repeat until it deletes 0 rows
WITH batch AS (
  SELECT id
  FROM events
  WHERE created_at < now() - interval '90 days'
  ORDER BY id
  LIMIT 5000
)
DELETE FROM events AS e
USING batch
WHERE e.id = batch.id;
```

## Connection management and pooling

### Why many connections hurt

Each connection is a process (see [Architecture](#architecture-in-brief)). Too many of them cost memory, CPU time for snapshots and scheduling, and lock contention [38]. When all slots are used, new clients get `FATAL: sorry, too many clients already`. Raising `max_connections` only moves the problem; a pooler solves it [40].

### How big should a pool be?

- The HikariCP guide gives a starting formula: `connections = (core_count × 2) + effective_spindle_count`, where the spindle count is 0 when the active data is fully cached [39]. Its main idea: "You want a small pool, saturated with threads waiting for connections." [39]
- It cites an Oracle demonstration where shrinking a pool from 2,048 to about 96 connections cut response times from about 100 ms to about 2 ms [39].
- One request should hold at most one connection at a time. If a request needs several at once, the pool must hold at least `threads × (connections per thread − 1) + 1` to avoid a pool deadlock [39].
- Add up every client: (app instances × pool size) + background workers + migration jobs + admin and monitoring. Without a server-side pooler, this sum must stay below `max_connections` minus the reserved slots. Example: 20 app containers × 10 connections = 200 connections, already twice the default limit.
- With PgBouncer, the app pools connect to PgBouncer (client connections are cheap), and PgBouncer opens at most `default_pool_size` server connections (default 20) per user and database pair [50]. On an 8-core database server, 16–20 busy server connections is a reasonable first value; then measure waiting time and CPU.

Client-side pool settings for Prisma and node-postgres are in [15 — PostgreSQL from TypeScript](15-postgres-from-typescript.md).

### PgBouncer pool modes

| Mode | Server connection goes back to the pool | Session features | Typical use |
|---|---|---|---|
| `session` (default [50]) | When the client disconnects | All work | Apps that need session state; limits only the connection count |
| `transaction` | At the end of each transaction | Session state is not kept (next table) | Most web and API backends |
| `statement` | After each statement; multi-statement transactions are refused | Very limited | Rare |

(Descriptions from the PgBouncer documentation [49][50].)

In transaction mode, the next transaction of a client can run on a different server connection. Anything that lives in the *session* therefore breaks [49]:

| Feature | Transaction mode | Use instead |
|---|---|---|
| `SET` / `RESET` (session level) | Never | `SET LOCAL` inside the transaction; `ALTER ROLE ... SET`; startup parameters that PgBouncer tracks (such as `application_name`, `TimeZone`, `DateStyle`; `search_path` since 1.26) [50][51] |
| `LISTEN` | Never (`NOTIFY` works) | A separate direct connection for listeners |
| `WITH HOLD` cursors | Never | Keyset pagination ([04](04-query-patterns-and-antipatterns.md)) |
| SQL `PREPARE` / `DEALLOCATE` | Never | Protocol-level prepared statements (next row) |
| Protocol-level prepared statements | Yes, if `max_prepared_statements` > 0: available since 1.21, on by default (200) since 1.24 [49][51] | — |
| Temporary tables with `ON COMMIT PRESERVE/DELETE ROWS` | Never (`ON COMMIT DROP` works) | Regular tables, or temp tables inside one transaction |
| `LOAD` | Never | `shared_preload_libraries` / `session_preload_libraries` |
| Session-level advisory locks | Never | `pg_advisory_xact_lock()` |

```sql
-- Bad with transaction pooling: session state leaks to other clients or is lost
SET statement_timeout = '5s';
SELECT pg_advisory_lock(42);

-- Good: transaction-scoped versions
BEGIN;
SET LOCAL statement_timeout = '5s';
SELECT pg_advisory_xact_lock(42);   -- released automatically at COMMIT or ROLLBACK
UPDATE orders SET status = 'shipped' WHERE id = 1001;
COMMIT;
```

```ini
; pgbouncer.ini — starting point, transaction pooling
[databases]
app = host=10.0.0.5 port=5432 dbname=app

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 2000          ; client connections are cheap (default 100)
default_pool_size = 20          ; server connections per user+database (default 20)
reserve_pool_size = 5           ; extra connections for bursts (default 0)
max_prepared_statements = 200   ; 1.21+; default 200 since 1.24
query_wait_timeout = 120        ; seconds a query may wait for a server connection
server_idle_timeout = 600
```

Run migrations, `pg_dump` and other session-heavy tools on a direct connection, not through a transaction pooler [57].

### Pooler options

| Pooler | Notes (October 2026) |
|---|---|
| PgBouncer | The reference pooler. 1.26.0 released 2026-09-23. Prepared statements in transaction mode since 1.21; LDAP authentication, direct TLS and `transaction_timeout` in 1.25 [51]. Single-threaded: one process uses one CPU core |
| Odyssey | Multi-threaded pooler from Yandex; version 1.4 released 2025-07-16 [55] |
| PgCat | Rust pooler from PostgresML with load balancing, failover and sharding; its README says it is used in production [52]. Release activity has slowed; check it before adopting |
| PgDog | Rust pooler, load balancer and sharding proxy from PgCat's original author; parses `SET` so session settings work in transaction mode; AGPL-3.0 [53] |
| Supavisor | Supabase's cloud-native, multi-tenant pooler written in Elixir [54] |
| pgpool-II | Older middleware with pooling, load balancing and failover features; more complex to operate |
| Amazon RDS Proxy | Managed by AWS. Reuses server connections per transaction, but *pins* a client to one server connection after `SET`, `PREPARE`/`EXECUTE`/`DEALLOCATE`, `DISCARD`, temporary tables, cursors, `LISTEN`, `nextval`/`setval`, or session advisory locks [56] |
| Provider poolers | Supabase (Supavisor), Neon (PgBouncer in transaction mode, up to 10,000 client connections) [57] |

### Serverless and edge runtimes

In serverless platforms, every function instance creates its own pool, and instances scale out without limit. A few hundred instances with a pool of 10 each will exhaust any server. So:

- Connect through the provider's pooled endpoint, in transaction mode [57].
- Keep each instance's pool very small (often 1 connection) and close idle connections quickly.
- Use a direct (unpooled) connection for migrations, `pg_dump`/`pg_restore`, logical replication and long analytic sessions [57].

## Backups and recovery

### Decide RPO and RTO first

- **RPO** (recovery point objective): how much data you accept to lose. A nightly dump means up to 24 hours. WAL archiving means seconds to a minute. A synchronous replica means zero for the loss of one server.
- **RTO** (recovery time objective): how long you accept to be down while restoring. Restoring a large `pg_dump` can take hours, because every index is rebuilt.

Write both numbers down. They decide the tools below.

### Logical vs physical backups

| | Logical (`pg_dump`) | Physical (base backup + WAL archive) |
|---|---|---|
| Contains | SQL definitions and data of one database | Files of the whole cluster, plus WAL |
| Point-in-time recovery | No | Yes |
| Restore speed for big databases | Slow (rebuilds indexes) | Fast (copy files, replay WAL) |
| Across major versions | Yes (also an upgrade method) | No (same major version only) |
| Granularity | Database, schema or table | Whole cluster |
| Best for | Small databases, copies, migrations, extra safety | Production disaster recovery |

### Logical backups with pg_dump

- `pg_dump` takes a consistent snapshot and does not block readers or writers [17]. But it holds `ACCESS SHARE` locks on the tables it dumps, so `ALTER TABLE` and `DROP` wait [17]. A long dump is also a long transaction that holds back VACUUM [45].
- Formats: plain SQL (`-Fp`), custom (`-Fc`), directory (`-Fd`) and tar (`-Ft`). Only the directory format can dump in parallel (`-j`); custom and directory formats can restore in parallel [17]. `lz4` and `zstd` compression need `pg_dump` 16+ [27].
- `pg_dump` does not include roles or tablespaces; dump them with `pg_dumpall --globals-only` [17].
- In PG 18, optimizer statistics are not dumped by default (`--statistics` adds them); run `ANALYZE` after a restore [17].
- Use the newest `pg_dump` version, especially when upgrading [16].
- A restore runs code chosen by the superusers of the source database; only restore dumps you trust [17].

```bash
# One database, custom format (compressed by default)
pg_dump -h db1 -U backup -d app -Fc -f app_2026-10-05.dump

# Parallel dump (directory format only), zstd compression (pg_dump 16+)
pg_dump -h db1 -U backup -d app -Fd -j 4 -Z zstd -f app_2026-10-05.dir

# Roles and tablespaces are not in pg_dump
pg_dumpall -h db1 -U postgres --globals-only -f globals_2026-10-05.sql

# Restore in parallel into a new database, then refresh statistics
createdb -h db2 -U postgres app_restore
pg_restore -h db2 -U postgres -d app_restore -j 4 --no-owner app_2026-10-05.dump
vacuumdb -h db2 -U postgres -d app_restore --analyze-only
```

### Physical backups, WAL archiving and point-in-time recovery

Point-in-time recovery (PITR) combines a *base backup* (a copy of the data directory) with the *archive* of every WAL file written since. To restore, you copy the base backup and replay WAL up to the moment you choose, for example just before an accidental `DELETE` [18].

Rules from the documentation [18]:

- Set up and test WAL archiving *before* the first base backup: you need an unbroken chain of WAL files.
- The archive command must return 0 only on success, and must refuse to overwrite an existing file with different content.
- If archiving fails, WAL files pile up in `pg_wal/`. If that disk fills, the server stops with a PANIC (no committed data is lost, but you are down).
- Take a new base backup after creating or dropping tablespaces.

```ini
# postgresql.conf on the primary (example with pgBackRest)
wal_level = replica              # default; 'minimal' cannot be archived
archive_mode = on                # restart
archive_command = 'pgbackrest --stanza=main archive-push %p'
archive_timeout = 60s            # switch WAL files at least every minute on quiet servers
```

```bash
# pgBackRest: weekly full, daily differential, restore to a point in time
pgbackrest --stanza=main --type=full backup
pgbackrest --stanza=main --type=diff backup
pgbackrest --stanza=main --delta --type=time \
  --target="2026-10-05 09:30:00+00" --target-action=promote restore
```

With core tools only, the restore steps are: copy the base backup into an empty data directory; set `restore_command` and `recovery_target_time` in `postgresql.conf`; create an empty `recovery.signal` file; start the server [18][4]. The target time must be after the end of the base backup [18].

### Incremental backups in core (PG 17+)

PG 17 added incremental base backups [26]. With `summarize_wal = on`, the server records which blocks changed; `pg_basebackup --incremental` then copies only those blocks [18].

```bash
# postgresql.conf: summarize_wal = on   (PG 17+; wal_level must not be minimal)
pg_basebackup -h db1 -U replicator -D /backups/full_2026-10-05 -c fast -P
pg_basebackup -h db1 -U replicator -D /backups/incr_2026-10-06 \
  --incremental=/backups/full_2026-10-05/backup_manifest -c fast -P

# Restore: rebuild a full data directory, oldest backup first
pg_combinebackup /backups/full_2026-10-05 /backups/incr_2026-10-06 -o /restore/pgdata
```

Limits [18][19]: you must keep track of which backups each incremental depends on (losing one breaks the chain); `pg_combinebackup` checks only that the backups belong together, so check each backup with `pg_verifybackup`; incremental backups mostly pay off for large databases where much of the data rarely changes.

### Backup tools

| Tool | Status (October 2026) | Highlights |
|---|---|---|
| pgBackRest | Its maintainer announced the end of maintenance on 2026-04-27 after the sponsor (Crunchy Data, bought by Snowflake) stopped funding it; a sponsor group restarted the project in May 2026 [61]. Version 2.59.3 released 2026-10-04 [60] | Parallel backup and restore; full, differential and incremental (also block-level); S3, Azure and GCS; encryption; asynchronous archiving; backup verification [60]. If you use repository encryption, read the October 2026 security notice on its home page [60] |
| Barman | Maintained by EDB; 3.20.1 released 2026-09-29 [62] | Manages backups of many servers from one place; catalog of backups; PITR [62] |
| WAL-G | Active open-source project; v3.0.9 released 2026-08-20 [63] | Cloud object storage, compression; also supports other databases (MySQL, MongoDB, Redis) [63] |
| Managed services | Provider | Automatic snapshots plus a PITR window; you still need to test restores |

### Test your restores

- Restore the latest backup to a separate server on a schedule (at least monthly; weekly if automated). Run checks: row counts of key tables, the latest `created_at` values, a few application queries.
- Practice a point-in-time restore to a chosen timestamp.
- Measure the restore time and compare it with your RTO.
- Alert on archiving failures (`pg_stat_archiver.failed_count`) and on failed backup jobs.

## Replication and high availability

### Streaming replication

A *standby* receives the WAL of the primary and replays it, so it is a byte-for-byte copy of the whole cluster, on the same major version. With `hot_standby = on` (the default) it also answers read-only queries [20]. Streaming replication is asynchronous by default: if the primary crashes, the last committed transactions may be missing on the standby; the delay is "typically under one second" [21].

```sql
-- On the primary: a role for replication (also add a pg_hba.conf entry; see 11-security)
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'change-me';
```

```bash
# On the new standby, with an empty data directory:
# copy the primary, create replication slot "standby1", write standby.signal and primary_conninfo
pg_basebackup -h primary.internal -U replicator -D "$PGDATA" -X stream -C -S standby1 -R -P
```

**Synchronous replication** makes `COMMIT` wait for one or more standbys. Name more candidate standbys than you need: if the required standbys are down, commits wait, and "may never be completed" [21].

```ini
# Wait for any 1 of 2 standbys (quorum); FIRST 1 (...) would use priority order
synchronous_standby_names = 'ANY 1 (standby1, standby2)'
```

### Replication slots and WAL retention

A replication slot makes the primary keep WAL (and, with feedback, old row versions) until its consumer has received it. This prevents a standby from falling too far behind, but an abandoned slot keeps WAL forever and can fill the `pg_wal` volume [21]. Protect the server:

- `max_slot_wal_keep_size` (PG 13+, default -1 = unlimited): above this size the slot is invalidated and its standby must be rebuilt. That is better than a full disk [20][23].
- `idle_replication_slot_timeout` (PG 18+, default 0 = off): invalidates slots that stayed inactive longer than the timeout [20].
- Monitor `wal_status` (`reserved`, `extended`, `unreserved`, `lost`) and `safe_wal_size` in `pg_replication_slots` [23].
- Drop slots that nobody uses anymore: `SELECT pg_drop_replication_slot('old_reporting_slot');`.

### Logical replication

Logical replication sends row changes of selected tables through *publications* and *subscriptions*. It works between different major versions, which makes it useful for upgrades, change data capture (CDC) and partial copies. The publisher needs `wal_level = logical` (restart). Restrictions [22]:

- Schema changes (DDL) are not replicated; apply them on both sides.
- Sequence values are not replicated; set them before a switchover. PostgreSQL 19 adds sequence synchronization (PG 19, beta — may change) [34].
- Large objects are not replicated; only tables can be published (not views or materialized views).
- `UPDATE` and `DELETE` need a replica identity, normally the primary key.

```sql
-- On the publisher
CREATE PUBLICATION app_pub FOR TABLE users, orders;

-- On the subscriber, after creating the schema (pg_dump --schema-only)
CREATE SUBSCRIPTION app_sub
  CONNECTION 'host=old-primary.internal dbname=app user=replicator'
  PUBLICATION app_pub;
```

PG 17 added failover slots (`sync_replication_slots`), so logical subscribers can continue after a primary failover, and `pg_createsubscriber`, which turns a physical standby into a logical replica [26].

### Read replicas and lag

- Replicas are always a little behind. Monitor lag in bytes and seconds (monitoring queries above).
- A long query on a replica can conflict with WAL replay and be cancelled ("conflict with recovery"). `max_standby_streaming_delay` (default 30 s) lets replay wait that long first. `hot_standby_feedback = on` avoids most cancellations but can cause bloat on the primary [20].
- **Read your own writes**: after a user changes data, read that user's data from the primary for a short time, or compare WAL positions:

```sql
-- On the primary, right after the write (same connection)
SELECT pg_current_wal_lsn();        -- for example '3/5A0012F8'

-- On the replica, before reading
SELECT pg_last_wal_replay_lsn() >= '3/5A0012F8'::pg_lsn AS caught_up;
```

PostgreSQL 19 adds a `WAIT FOR` command so a standby session can wait until a given LSN is replayed (PG 19, beta — may change) [34].

### Failover managers

Do not script your own failover: split brain (two primaries accepting writes) is the classic disaster. Use a proven tool and test it.

| Tool | How it works | Status (October 2026) |
|---|---|---|
| Patroni | Agent on each node; leader election through a distributed store (etcd, Consul, ZooKeeper or Kubernetes) | Active; 4.1.5 released 2026-08-12, adds compatibility with the latest 14–18 minor releases [64] |
| CloudNativePG | Kubernetes operator: failover, backups to object storage, PgBouncer poolers, rolling updates, declarative configuration; Apache 2.0, originally created by EDB [82] | Active; 1.30.1 released 2026-09-23 [65] |
| repmgr | Replication setup plus a failover daemon; maintained by EDB | 5.5.x supports PostgreSQL 13–18 [66] |
| pg_auto_failover | Monitor node plus keeper agents; maintained by Microsoft | Supports PostgreSQL 13–18 [67] |
| Managed HA | The provider's standby and automatic failover | — |

High availability is not a backup: replication copies a `DROP TABLE` to every standby within a second. Keep PITR backups too. Test that the application reconnects and retries after a failover.

## Upgrades

### Minor releases: apply them

Minor releases (for example 18.5 → 18.6) contain only bug and security fixes and never change the storage format; you replace the binaries and restart [16][32]. They come out at least every three months, and the project recommends always running the current minor release [32]. Read the release notes anyway: some fixes require an extra step, such as rebuilding certain indexes. With standbys, update the standbys first; a newer minor release is more likely to read WAL from an older one than the reverse [21].

### Major upgrades: choose a method

| Method | Downtime | Notes |
|---|---|---|
| `pg_dump` + `pg_restore` | Long for big databases | Simplest; also cleans bloat; use the new version's tools [16] |
| `pg_upgrade --copy` (default) | Proportional to data size | Old cluster stays usable [15] |
| `pg_upgrade --link` | Minutes | Hard links; same file system; old cluster unusable once the new one starts [15] |
| `pg_upgrade --clone` | Minutes | Reflinks (Linux Btrfs/XFS, macOS APFS); old cluster stays usable [15] |
| `pg_upgrade --copy-file-range` (PG 17+) | Short to medium | Uses `copy_file_range()` on Linux and FreeBSD [15][26] |
| `pg_upgrade --swap` (PG 18+) | Fastest with many relations | Moves files; the old cluster is destroyed once the transfer starts; use `--sync-method=fsync` [15] |
| Logical replication | Seconds | New cluster subscribes to the old one, then you switch; DDL frozen meanwhile; sequences and large objects need manual steps [16][22] |

### pg_upgrade step by step

```bash
# 1. Install the new binaries and the new builds of every extension.
#    PG 18 initdb enables data checksums by default; pg_upgrade needs matching settings,
#    so add --no-data-checksums if the old cluster has none.
/usr/lib/postgresql/18/bin/initdb -D /var/lib/postgresql/18/main --no-data-checksums

# 2. Check only, while the old server still runs
/usr/lib/postgresql/18/bin/pg_upgrade \
  --old-bindir=/usr/lib/postgresql/16/bin --new-bindir=/usr/lib/postgresql/18/bin \
  --old-datadir=/var/lib/postgresql/16/main --new-datadir=/var/lib/postgresql/18/main \
  --link --jobs=8 --check

# 3. Stop the old server, take a backup, run the same command without --check
# 4. Start the new server and refresh statistics
vacuumdb --all --analyze-in-stages --missing-stats-only   # PG 18+: most statistics were kept
vacuumdb --all --analyze-only
# Upgrading to PG 14-17: statistics are not kept; run vacuumdb --all --analyze-in-stages
```

Checklist [15][16][1]:

- Read the "Migration" section of the release notes of every major version you skip.
- Extensions: install the new shared libraries but do not run `CREATE EXTENSION`; pg_upgrade reports extensions that can be updated and writes a script for them. On managed services, check that every extension and version you use is offered on the new major version.
- Statistics: PG 18 keeps most planner statistics, but not extended statistics (`CREATE STATISTICS`); run `ANALYZE` for those.
- Standbys: after `--link`, update them with the documented `rsync` procedure, or rebuild them.
- Logical replication slots are carried over only when the old cluster is PG 17 or newer.
- Test the application on the new version first (staging restore + test suite).

### Support policy

Each major version gets fixes for five years [32]:

| Major | First release | Final release (end of life) |
|---|---|---|
| 18 | 2025-09-25 | 2030-11-14 |
| 17 | 2024-09-26 | 2029-11-08 |
| 16 | 2023-09-14 | 2028-11-09 |
| 15 | 2022-10-13 | 2027-11-11 |
| 14 | 2021-09-30 | 2026-11-12 |
| 13 | 2020-09-24 | 2025-11-13 (already unsupported) |

PostgreSQL 19 is expected in October 2026 [33]. Start new projects on the newest stable major version.

## Scaling path

Most "the database is slow" incidents come from a few queries, not from a lack of hardware. Go down this list in order and stop when the problem is solved:

1. **Fix queries and indexes**: find them with `pg_stat_statements` and `EXPLAIN` ([06](06-query-optimization-and-explain.md), [05](05-indexing.md)).
2. **Fix configuration and maintenance**: memory settings, checkpoints, autovacuum (this document).
3. **Scale up**: more RAM so the working set fits in memory, faster NVMe, more cores. One big server is simpler than any distributed system.
4. **Pool connections** (above).
5. **Add read replicas** for read-heavy traffic, and design for lag.
6. **Partition very large tables**, mainly to make maintenance cheap (VACUUM per partition, dropping old data); it does not make every query faster ([07](07-schema-design-and-patterns.md)).
7. **Cache** expensive results: application cache, or materialized views for heavy aggregates.
8. **Archive cold data**: move old rows to cheaper storage or another database, or drop old partitions.
9. **Shard**: Citus (an extension for distributed tables and schema-based sharding, AGPL-3.0, PG 18 compatible, also managed on Azure) [80], or a sharding proxy such as PgDog [53].
10. **Use another engine when the workload is different**: large analytical scans fit columnar engines better ([02 — dialects and analytical engines](02-sql-dialects-compared.md)); search workloads are in [12](12-full-text-and-vector-search.md).

## PostgreSQL in Docker for development

Run the same major version as production. Use a named volume so data survives container restarts. The official image documentation adds these points [78]:

- **Data path changed in the PG 18 images**: `PGDATA` is now `/var/lib/postgresql/18/docker` and the volume is `/var/lib/postgresql` (this makes `pg_upgrade --link` possible). Mount the volume at `/var/lib/postgresql` for 18+, and at `/var/lib/postgresql/data` for 17 and older.
- **Shared memory**: Docker gives `/dev/shm` only 64 MB, which parallel queries can exhaust ("could not resize shared memory segment"). Use `--shm-size=256mb` or `shm_size` in Compose.
- **Init scripts** in `/docker-entrypoint-initdb.d` run only when the data directory is empty. Remove the volume to re-run them.
- `POSTGRES_PASSWORD` is required. Do not use `POSTGRES_HOST_AUTH_METHOD=trust` outside a throwaway local container.
- Pass settings with `-c name=value` or mount your own `postgresql.conf`.

```yaml
# compose.yaml — local development database
services:
  db:
    image: postgres:18                  # same major version as production
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app_dev_password
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    shm_size: 256mb
    volumes:
      - pgdata:/var/lib/postgresql      # 18+ images; /var/lib/postgresql/data for <= 17
      - ./db/init:/docker-entrypoint-initdb.d:ro
    command: >
      postgres
      -c shared_preload_libraries=pg_stat_statements
      -c log_min_duration_statement=200ms
      -c log_lock_waits=on
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 3s
      retries: 10
volumes:
  pgdata:
```

Logging slow statements and loading `pg_stat_statements` in development catches slow queries before production does. Test databases and containers for automated tests are covered in [15](15-postgres-from-typescript.md).

## Managed vs self-hosted

| Aspect | Managed service | Self-hosted (VM, bare metal, Kubernetes) |
|---|---|---|
| Backups and PITR | Built in; you choose the retention | You build and monitor them (pgBackRest, Barman, WAL-G) |
| High availability | An option to enable | Patroni or CloudNativePG; you test failover yourself |
| Minor upgrades | Automatic or in a maintenance window | You apply them |
| Major upgrades | Provider tools | pg_upgrade or logical replication |
| Configuration | Parameter groups; some settings locked [79] | Full control |
| Extensions | Only the provider's list | Anything you can build and trust |
| Superuser access | Not available | Yes |
| Cost | Higher per CPU and GB; less staff time | Lower per CPU and GB; needs operations skills |
| Portability | Some provider-specific features | Portable |

For a small team, a managed service is usually the safer default: backups, failover and minor updates are the parts that hurt most when done wrong. Self-hosting pays off with special needs (extensions, cost at scale, data location) and someone who owns operations.

## Operations checklist

### Daily (automated alerts)

- [ ] Backups finished; WAL archiving shows no failures (`pg_stat_archiver`).
- [ ] Free disk space on the data and `pg_wal` volumes.
- [ ] Replication lag; no inactive replication slots; slot WAL retention stable.
- [ ] No long transactions or `idle in transaction` sessions; no long lock waits.
- [ ] Error log: `FATAL`, `PANIC`, deadlocks, checksum failures (`pg_stat_database.checksum_failures`).
- [ ] Connection count compared with pool sizes and `max_connections`.

### Weekly

- [ ] Top queries by total time in `pg_stat_statements` ([06](06-query-optimization-and-explain.md)); pgBadger report.
- [ ] Dead tuples and last autovacuum on the largest tables.
- [ ] Trend of transaction ID age (`age(datfrozenxid)`).
- [ ] Temporary file volume and requested-vs-timed checkpoints.

### Monthly

- [ ] Restore test (full and point-in-time), timed against the RTO.
- [ ] Unused and duplicate indexes, checked on the primary and on every replica ([05](05-indexing.md)).
- [ ] Bloat check on the largest tables and indexes.
- [ ] Apply the latest minor release; update PgBouncer, backup tools and extensions.
- [ ] Capacity: growth of data, WAL volume and connections.

### Before go-live

- [ ] Backups and WAL archiving configured, and one restore tested.
- [ ] Monitoring and alerts for every signal in the [Monitoring](#monitoring) table.
- [ ] Pooler in front; pool sizes add up below `max_connections`.
- [ ] Per-role timeouts; server-wide `idle_in_transaction_session_timeout`.
- [ ] Logging settings applied; `pg_stat_statements` and `auto_explain` loaded.
- [ ] Per-table autovacuum settings for big or hot tables.
- [ ] Data checksums on (default for new PG 18 clusters [1]).
- [ ] `max_slot_wal_keep_size` set if you use replication slots.
- [ ] Failover tested if you need high availability; the application reconnects and retries.
- [ ] Security review done ([11](11-security.md)): TLS, `pg_hba.conf`, least-privilege roles.
- [ ] Major version with at least two years of support left, and the same version in development and CI.
- [ ] Load test with a production-like data volume.

## Sources

1. [PostgreSQL 18 Release Notes](https://www.postgresql.org/docs/18/release-18.html) — postgresql.org: PG 18 parameters, changed defaults, AIO, vacuum, pg_upgrade, monitoring changes
2. [PostgreSQL 18 Released!](https://www.postgresql.org/about/news/postgresql-18-released-3142/) — postgresql.org: AIO scope (sequential scans, bitmap heap scans, vacuum), statistics kept by pg_upgrade, checksums default
3. [Resource Consumption (PG 18)](https://www.postgresql.org/docs/18/runtime-config-resource.html) — postgresql.org: memory, I/O, io_method, io_workers, parallel worker defaults and guidance
4. [Write Ahead Log (PG 18)](https://www.postgresql.org/docs/18/runtime-config-wal.html) — postgresql.org: fsync, synchronous_commit, wal_compression, wal_buffers, checkpoint settings, archiving, recovery settings
5. [Query Planning (PG 18)](https://www.postgresql.org/docs/18/runtime-config-query.html) — postgresql.org: random_page_cost, effective_cache_size, default_statistics_target, jit defaults
6. [Client Connection Defaults (PG 18)](https://www.postgresql.org/docs/18/runtime-config-client.html) — postgresql.org: statement, lock, idle and transaction timeouts and their warnings
7. [Vacuuming (PG 18)](https://www.postgresql.org/docs/18/runtime-config-vacuum.html) — postgresql.org: autovacuum thresholds, cost settings, freezing ages, eager freezing, vacuum_truncate
8. [Routine Vacuuming (PG 18)](https://www.postgresql.org/docs/18/routine-vacuuming.html) — postgresql.org: reasons for VACUUM, VACUUM FULL, trigger formulas, wraparound limits and recovery steps
9. [Error Reporting and Logging (PG 18)](https://www.postgresql.org/docs/18/runtime-config-logging.html) — postgresql.org: logging parameters, defaults, log_line_prefix escapes
10. [The Cumulative Statistics System (PG 18)](https://www.postgresql.org/docs/18/monitoring-stats.html) — postgresql.org: statistics views, states, wait events, reset behavior
11. [auto_explain (PG 18)](https://www.postgresql.org/docs/18/auto-explain.html) — postgresql.org: loading, parameters, overhead warning
12. [Connections and Authentication (PG 18)](https://www.postgresql.org/docs/18/runtime-config-connection.html) — postgresql.org: max_connections, reserved connections, client_connection_check_interval
13. [Setting Parameters (PG 18)](https://www.postgresql.org/docs/18/config-setting.html) — postgresql.org: postgresql.auto.conf, reload, per-role and per-database settings, allow_alter_system
14. [Managing Kernel Resources (PG 18)](https://www.postgresql.org/docs/18/kernel-resources.html) — postgresql.org: Linux huge pages, memory overcommit, OOM killer
15. [pg_upgrade (PG 18)](https://www.postgresql.org/docs/18/pgupgrade.html) — postgresql.org: transfer modes, --swap, --check, statistics, extensions, standby upgrades
16. [Upgrading a PostgreSQL Cluster (PG 18)](https://www.postgresql.org/docs/18/upgrading.html) — postgresql.org: minor vs major upgrades, three upgrade methods
17. [pg_dump (PG 18)](https://www.postgresql.org/docs/18/app-pgdump.html) — postgresql.org: formats, parallelism, locks, statistics options, restore warning
18. [Continuous Archiving and Point-in-Time Recovery (PG 18)](https://www.postgresql.org/docs/18/continuous-archiving.html) — postgresql.org: archive command rules, PITR steps, incremental backups, caveats
19. [pg_combinebackup (PG 18)](https://www.postgresql.org/docs/18/app-pgcombinebackup.html) — postgresql.org: combining incremental backups, limits, pg_verifybackup
20. [Replication (PG 18)](https://www.postgresql.org/docs/18/runtime-config-replication.html) — postgresql.org: slots, max_slot_wal_keep_size, idle_replication_slot_timeout, synchronous_standby_names, hot standby settings
21. [Log-Shipping Standby Servers (PG 18)](https://www.postgresql.org/docs/18/warm-standby.html) — postgresql.org: slot risks, synchronous commit behavior, asynchronous data-loss window, lag monitoring
22. [Logical Replication Restrictions (PG 18)](https://www.postgresql.org/docs/18/logical-replication-restrictions.html) — postgresql.org: DDL, sequences, large objects, replica identity
23. [pg_replication_slots (PG 18)](https://www.postgresql.org/docs/18/view-pg-replication-slots.html) — postgresql.org: wal_status values, safe_wal_size, inactive_since, invalidation reasons
24. [pgstattuple (PG 18)](https://www.postgresql.org/docs/18/pgstattuple.html) — postgresql.org: exact and approximate bloat functions, privileges
25. [Heap-Only Tuples (HOT) (PG 18)](https://www.postgresql.org/docs/18/storage-hot.html) — postgresql.org: HOT conditions, fillfactor, monitoring
26. [PostgreSQL 17 Release Notes](https://www.postgresql.org/docs/17/release-17.html) — postgresql.org: vacuum memory, incremental backup, pg_stat_checkpointer, transaction_timeout, failover slots, pg_createsubscriber
27. [PostgreSQL 16 Release Notes](https://www.postgresql.org/docs/16/release-16.html) — postgresql.org: pg_stat_io, last scan columns, reserved_connections, vacuum_buffer_usage_limit
28. [PostgreSQL 15 Release Notes](https://www.postgresql.org/docs/15/release-15.html) — postgresql.org: log_checkpoints and autovacuum logging defaults, jsonlog, wal_compression lz4/zstd, shared-memory statistics
29. [PostgreSQL 14 Release Notes](https://www.postgresql.org/docs/14/release-14.html) — postgresql.org: checkpoint_completion_target 0.9, idle_session_timeout, failsafe, pg_stat_wal, snapshot scalability
30. [Resource Consumption (PG 17)](https://www.postgresql.org/docs/17/runtime-config-resource.html) — postgresql.org: effective_io_concurrency default and "in the hundreds" for SSDs
31. [Resource Consumption (PG 14)](https://www.postgresql.org/docs/14/runtime-config-resource.html) — postgresql.org: hash_mem_multiplier 1.0, 1 GB vacuum memory limit, I/O concurrency defaults
32. [Versioning Policy](https://www.postgresql.org/support/versioning/) — postgresql.org: five-year support, minor release cadence, current minors, end-of-life dates
33. [PostgreSQL 19 Beta 4 Released!](https://www.postgresql.org/about/news/postgresql-19-beta-4-released-3386/) — postgresql.org: reverted features, REPACK and autovacuum fixes, expected GA October 2026
34. [PostgreSQL 19 Release Notes (beta)](https://www.postgresql.org/docs/19/release-19.html) — postgresql.org: REPACK, autovacuum scoring, jit off, log_lock_waits on, I/O worker scaling, WAIT FOR
35. [REPACK (PG 19 beta)](https://www.postgresql.org/docs/19/sql-repack.html) — postgresql.org: syntax, CONCURRENTLY locking and restrictions
36. [Query Planning (PG 19 beta)](https://www.postgresql.org/docs/19/runtime-config-query.html) — postgresql.org: jit default off in 19
37. [Tuning Your PostgreSQL Server](https://wiki.postgresql.org/wiki/Tuning_Your_PostgreSQL_Server) — PostgreSQL wiki: shared_buffers and effective_cache_size ratios, vacuum advice
38. [Analyzing the Limits of Connection Scalability in Postgres](https://www.citusdata.com/blog/2020/10/08/analyzing-connection-scalability/) — Andres Freund (Citus/Microsoft): per-connection memory, idle-connection cost, snapshot bottleneck
39. [About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing) — HikariCP wiki: pool size formula, small-pool principle, pool-locking formula
40. [Tuning max_connections in PostgreSQL](https://www.cybertec-postgresql.com/en/tuning-max_connections-in-postgresql/) — Laurenz Albe (Cybertec): upper bound for active connections, role of poolers
41. [Better PostgreSQL performance on SSDs](https://www.cybertec-postgresql.com/en/better-postgresql-performance-on-ssds/) — Hans-Jürgen Schönig (Cybertec): random_page_cost close to 1 on SSD
42. [Optimize PostgreSQL Server Performance Through Configuration](https://www.crunchydata.com/blog/optimize-postgresql-server-performance) — Crunchy Data: shared_buffers, effective_cache_size, work_mem, maintenance_work_mem
43. [Basics of Tuning Checkpoints](https://www.enterprisedb.com/blog/basics-tuning-checkpoints) — Tomas Vondra (EDB): time-based checkpoints, max_wal_size sizing, full-page-write effect
44. [Waiting for Postgres 18: Accelerating Disk Reads with Asynchronous I/O](https://pganalyze.com/blog/postgres-18-async-io) — pganalyze: io_method comparison, benchmark, read-ahead formula
45. [Four reasons why VACUUM won't remove dead rows](https://www.cybertec-postgresql.com/en/reasons-why-vacuum-wont-remove-dead-rows/) — Laurenz Albe (Cybertec): xmin horizon causes and queries
46. [Tuning autovacuum for PostgreSQL](https://www.cybertec-postgresql.com/en/tuning-autovacuum-postgresql/) — Laurenz Albe (Cybertec): cost limit and delay, per-table settings, insert-triggered vacuum
47. [PostgreSQL 14 Internals](https://postgrespro.com/community/books/internals) — Egor Rogov and Liudmila Mantrova (Postgres Professional), free book: MVCC, buffer cache, WAL, locks
48. [pgsql-bloat-estimation](https://github.com/ioguix/pgsql-bloat-estimation) — ioguix (GitHub): statistics-based table and B-tree bloat estimates, caveats
49. [PgBouncer Features](https://www.pgbouncer.org/features.html) — pgbouncer.org: pool modes and SQL feature compatibility table
50. [PgBouncer Configuration](https://www.pgbouncer.org/config.html) — pgbouncer.org: pool settings and defaults, tracked parameters
51. [PgBouncer Changelog](https://www.pgbouncer.org/changelog.html) — pgbouncer.org: 1.21 prepared statements, 1.24 default 200, 1.25 and 1.26 features
52. [PgCat](https://github.com/postgresml/pgcat) — PostgresML (GitHub): features and production-use statement
53. [PgDog](https://github.com/pgdogdev/pgdog) — PgDog (GitHub): pooling, load balancing, sharding, SET handling, license
54. [Supavisor](https://github.com/supabase/supavisor) — Supabase (GitHub): cloud-native multi-tenant pooler
55. [Odyssey 1.4 released](https://www.postgresql.org/about/news/odyssey-14-released-3101/) — postgresql.org news: Odyssey release date and features
56. [Avoiding pinning an RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html) — AWS: PostgreSQL operations that pin sessions
57. [Connection pooling](https://neon.com/docs/connect/connection-pooling) — Neon docs: PgBouncer transaction mode, limits, when to use direct connections
58. [pg_repack](https://reorg.github.io/pg_repack/) — pg_repack docs: supported versions, requirements, locking, disk space
59. [pg_squeeze](https://github.com/cybertec-postgresql/pg_squeeze) — Cybertec (GitHub): logical-decoding-based rewrite, requirements, locking
60. [pgBackRest](https://pgbackrest.org/) — pgbackrest.org: features, sponsors, latest release, security notice
61. [The pgBackRest Rescue and Open Source's Forced Price Discovery](https://blog.vonng.com/en/pg/pgbackrest-resume/) — Vonng: 2026 maintenance stop and restart timeline
62. [Barman](https://pgbarman.org/) — pgbarman.org: latest release, maintainer, features
63. [WAL-G releases](https://github.com/wal-g/wal-g/releases) — WAL-G (GitHub): release dates and activity
64. [Patroni release notes](https://patroni.readthedocs.io/en/latest/releases.html) — Patroni docs: 4.1.5 release, PostgreSQL 18 support
65. [CloudNativePG releases](https://cloudnative-pg.io/releases/) — cloudnative-pg.io: release history up to 1.30.1
66. [repmgr](https://github.com/EnterpriseDB/repmgr) — EDB (GitHub): supported versions, maintenance
67. [pg_auto_failover](https://github.com/hapostgres/pg_auto_failover) — Microsoft (GitHub): supported versions
68. [pgBadger](https://github.com/darold/pgbadger) — Gilles Darold (GitHub): recommended log settings, formats, incremental mode
69. [pganalyze](https://pganalyze.com/) — pganalyze: product features and platforms
70. [pgwatch](https://github.com/cybertec-postgresql/pgwatch) — Cybertec (GitHub): monitoring solution with Grafana dashboards
71. [postgres_exporter](https://github.com/prometheus-community/postgres_exporter) — Prometheus community (GitHub): collectors, supported versions, pg_monitor user
72. [Database Monitoring](https://docs.datadoghq.com/database_monitoring/) — Datadog docs: query metrics, samples, explain plans
73. [Percona Monitoring and Management 3](https://docs.percona.com/percona-monitoring-and-management/3/index.html) — Percona docs: open-source PMM, Query Analytics
74. [pg_activity](https://github.com/dalibo/pg_activity) — Dalibo (GitHub): top-like activity monitor
75. [pgcenter](https://github.com/lesovsky/pgcenter) — pgcenter (GitHub): top-like statistics viewer with OS metrics
76. [PGTune](https://pgtune.leopard.in.ua/) — PGTune: configuration calculator by hardware
77. [postgresqlco.nf](https://postgresqlco.nf/) — postgresqlco.nf: parameter documentation site
78. [postgres Docker Official Image docs](https://github.com/docker-library/docs/blob/master/postgres/README.md) — Docker library: PG 18 data path, shared memory, init scripts, environment variables
79. [Working with parameters on your RDS for PostgreSQL DB instance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Parameters.html) — AWS: parameter groups, static vs dynamic parameters, max_wal_size presets
80. [Citus](https://github.com/citusdata/citus) — Citus Data / Microsoft (GitHub): distributed PostgreSQL, PG 18 support, license, managed option
81. [PGConfig](https://www.pgconfig.org/) — pgconfig.org: configuration calculator
82. [CloudNativePG](https://cloudnative-pg.io/) — cloudnative-pg.io: operator features, Apache 2.0 license, origin
