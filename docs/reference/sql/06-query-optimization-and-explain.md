# Query Optimization and EXPLAIN

> Part of the [SQL & PostgreSQL reference library](README.md) · Last researched: 2026-10-05 · Targets PostgreSQL 14–18 (19 beta noted where relevant)

**What this covers.** How PostgreSQL turns a query into a plan, how to read `EXPLAIN` output, why the planner picks bad plans (mostly wrong row estimates), and a repeatable workflow to find and fix slow queries: `pg_stat_statements`, `auto_explain`, `EXPLAIN (ANALYZE, BUFFERS)`, one change at a time, benchmark, monitor. Index design lives in [05-indexing.md](05-indexing.md), server-wide tuning in [09-operations-and-server-tuning.md](09-operations-and-server-tuning.md), query idioms in [04-query-patterns-and-antipatterns.md](04-query-patterns-and-antipatterns.md).

## Key rules (TL;DR)

1. Find slow queries with data (`pg_stat_statements`, logs), not by guessing. Sort by total time first.
2. Diagnose with `EXPLAIN (ANALYZE, BUFFERS)` on production-like data. Plain `EXPLAIN` shows only guesses.
3. `EXPLAIN ANALYZE` really runs the statement. Wrap `INSERT`/`UPDATE`/`DELETE`/`MERGE` in `BEGIN; … ROLLBACK;`.
4. Read a plan from the inside out. Multiply per-loop `actual time` and `rows` by `loops` to get totals.
5. Compare estimated `rows` with actual `rows` at every node. A gap of 10× or more is the usual root cause of a bad plan.
6. Fix estimates before you force a plan: `ANALYZE`, a higher statistics target, `CREATE STATISTICS` for correlated columns.
7. Run `ANALYZE` after bulk loads, and on partitioned parent tables (autovacuum never analyzes them).
8. Look at buffers (pages touched), not only time. Buffers are more stable between runs than milliseconds.
9. Keep predicates sargable: no function or cast on an indexed column. Make parameter types match column types.
10. Replace per-row SubPlans (correlated subqueries) with joins or `LATERAL`. Replace `NOT IN (subquery)` with `NOT EXISTS`.
11. Use keyset pagination, not a deep `OFFSET`.
12. Pass a list as one array parameter: `WHERE id = ANY($1::bigint[])`, not a growing `IN ($1, $2, …)`.
13. Treat "external merge Disk", hash "Batches" above 1, and "lossy" heap blocks as spills: raise `work_mem` for that query (`SET LOCAL`) or that role, not globally.
14. Remember that `work_mem` is per sort/hash node and per process. Real memory use can be many times its value.
15. Turn JIT off (or raise `jit_above_cost`) for OLTP workloads. PostgreSQL 19 (beta — may change) turns it off by default.
16. Use `enable_*` switches only to test a hypothesis in one session. Never set them in production.
17. For prepared statements, know if you get custom or generic plans. Use `plan_cache_mode` per role or transaction for value-sensitive queries.
18. Use `EXPLAIN (GENERIC_PLAN)` (PG 16+) to explain a `$1`-style query copied from `pg_stat_statements` or the logs.
19. Run `auto_explain` in production with a duration threshold, so you capture the real plan of slow queries.
20. Change one thing at a time. Compare plan, buffers, and `pg_stat_statements` numbers before and after.
21. Benchmark with `pgbench`, realistic volume and skew, several runs, and a known cache state (warm or cold).

---

## 1. How PostgreSQL runs a query

### 1.1 The four stages

Every statement goes through the same pipeline [33]:

| Stage | What it does |
|---|---|
| **Parser** | Checks the syntax and builds a *query tree*. |
| **Rewriter** | Applies rules, for example it expands views into their definition. |
| **Planner / optimizer** | Builds many possible *paths* (ways to get the rows), estimates the cost of each one, and keeps the cheapest. The result is a *plan tree*. |
| **Executor** | Walks the plan tree and produces the rows. |

`EXPLAIN` shows the output of the planner. `EXPLAIN ANALYZE` also runs the executor and shows what really happened.

### 1.2 Cost-based planning

The planner does not run the query to choose a plan. It *estimates*. For each table it always considers a sequential scan, plus index scans when an index matches a condition or the `ORDER BY` [34]. For joins it compares three strategies [34][54]:

| Join strategy | How it works | Good when | Weak when |
|---|---|---|---|
| **Nested Loop** | For each outer row, scan the inner side. | The outer side is small and the inner side has an index on the join key. Also the only option for non-`=` join conditions. | The outer side is large: the inner scan repeats many times. |
| **Hash Join** | Build a hash table from the inner side, then probe it with each outer row. | Medium or large inputs, the hash table fits in memory. Needs `=`. Indexes on the join key do not help. | The hash does not fit in `work_mem × hash_mem_multiplier` and spills to disk in batches. |
| **Merge Join** | Sort both sides on the join key, then walk them together. | Very large inputs, or inputs already sorted (by an index). Needs `=` and sortable types. | Both sides need an expensive sort. |

**Cost** is a number in arbitrary units. By convention, reading one page sequentially costs 1.0 [3][60]. The planner adds up page reads and CPU work using these *cost constants* [3]:

| Setting | Default | Meaning |
|---|---|---|
| `seq_page_cost` | 1.0 | Read one page as part of a sequential scan. |
| `random_page_cost` | 4.0 | Read one page in random order (index scans). |
| `cpu_tuple_cost` | 0.01 | Process one row. |
| `cpu_index_tuple_cost` | 0.005 | Process one index entry. |
| `cpu_operator_cost` | 0.0025 | Run one operator or function call. |
| `parallel_setup_cost` | 1000 | Start parallel workers. |
| `parallel_tuple_cost` | 0.1 | Pass one row from a worker to the leader. |
| `effective_cache_size` | 4GB | How much data the planner assumes is cached (OS + `shared_buffers`). Only used for estimates. |

Example from the docs [2]: a table with 345 pages and 10,000 rows. A full sequential scan costs `345 × 1.0 + 10000 × 0.01 = 445`. With a `WHERE` condition, each row also pays one `cpu_operator_cost`: `445 + 10000 × 0.0025 = 470`.

```text
EXPLAIN SELECT * FROM tenk1;
 Seq Scan on tenk1  (cost=0.00..445.00 rows=10000 width=244)
```

### 1.3 Row estimates come from statistics

The cost formula needs a row count for every step. The planner gets it from statistics [12]:

- `pg_class.reltuples` and `relpages`: rows and pages per table and index. They are updated by `VACUUM`, `ANALYZE`, and `CREATE INDEX`, and the planner scales them to the current physical size of the table [12].
- `pg_statistic` (readable through the `pg_stats` view): per-column null fraction, number of distinct values, most common values, histogram, and physical correlation [13].

From these numbers the planner computes the *selectivity* (fraction of rows that match) of each condition. By default it assumes conditions on different columns are **independent** and multiplies their selectivities [85]. That assumption is wrong when columns are correlated (city and zip code, `status` and `shipped_at`). Wrong row counts lead to wrong join strategies and wrong join orders. Section 5 shows how to fix them.

### 1.4 Join search: join order, collapse limits, GEQO

The number of possible join orders grows exponentially with the number of tables. The docs warn that above about ten tables an exhaustive search is no longer practical, and even six or seven tables can take noticeable planning time [31].

| Setting | Default | Effect |
|---|---|---|
| `from_collapse_limit` | 8 | The planner merges (flattens) subqueries into the parent `FROM` list only if the result has at most this many items. |
| `join_collapse_limit` | 8 | The planner reorders explicit `JOIN`s only up to this many items. With `1`, joins run in the order you wrote them. |
| `geqo_threshold` | 12 | With this many `FROM` items or more, the *genetic query optimizer* (GEQO) replaces the exhaustive search. |
| `geqo` | on | Enables GEQO. |

GEQO is a heuristic search. It plans faster but does not guarantee the best plan [32]. It is repeatable: with the same `geqo_seed`, settings and statistics, it produces the same plan [32]. In practice: if a query joins 10+ tables, check `Planning Time` and the join order. Section 7.18 shows the fixes.

---

## 2. EXPLAIN options

### 2.1 Option reference

| Option | Default | Min version | What it adds |
|---|---|---|---|
| `ANALYZE` | off | all | Runs the statement. Shows actual time, rows, loops per node, plus `Planning Time` and `Execution Time`. |
| `BUFFERS` | **on when `ANALYZE` is on (PG 18+)**; off before | all | Pages hit in cache, read, dirtied, written (shared, local, temp), and I/O time if `track_io_timing = on` [1]. |
| `VERBOSE` | off | all | Output columns of each node, schema-qualified names, query identifier. |
| `SETTINGS` | off | all supported | Planner-related settings that differ from the built-in defaults. |
| `WAL` | off | all supported | WAL records, full-page images, bytes, and (PG 18+) WAL buffers full. Needs `ANALYZE`. |
| `TIMING` | on with `ANALYZE` | all | Per-node timing. `TIMING OFF` keeps row counts but removes clock overhead. |
| `SUMMARY` | on with `ANALYZE` | all | Planning and execution totals. |
| `COSTS` | on | all | Estimated costs, rows, width. `COSTS OFF` is handy for comparing plan shapes in tests. |
| `FORMAT` | `TEXT` | all | `TEXT`, `JSON`, `XML`, `YAML`. Tools like pgMustard and PEV2 accept JSON. |
| `GENERIC_PLAN` | off | **PG 16+** | Plans a query that contains `$1`, `$2` placeholders, without values. Cannot be combined with `ANALYZE` [1][6]. |
| `SERIALIZE` | `NONE` | **PG 17+** | Measures the cost of converting the result to text or binary for the client (output functions, de-TOASTing of large values). Needs `ANALYZE` [1][5]. |
| `MEMORY` | off | **PG 17+** | Memory used by the planner [1][5]. |

Sources: [1][4][5][6]. In PostgreSQL 19 (beta — may change), `EXPLAIN ANALYZE` gets an `IO` option that reports asynchronous I/O activity [9].

### 2.2 The command to use by default

```sql
-- PG 18+: BUFFERS is already included by ANALYZE
EXPLAIN (ANALYZE, VERBOSE, SETTINGS)
SELECT ...;

-- PG 14–17: ask for BUFFERS explicitly
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)
SELECT ...;

-- For a visualizer (pgMustard, PEV2): JSON output
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON)
SELECT ...;
```

Turn on `track_io_timing` in your session if you are allowed to (it needs superuser or the right privilege), to see how much time went into reads. Measure its overhead first with `pg_test_timing` [44].

### 2.3 EXPLAIN ANALYZE executes the statement

The docs are explicit: with `ANALYZE` the statement is really executed; only the output rows are discarded [1]. For writes, use a transaction you roll back:

```sql
-- Good: measure a write without keeping its effects
BEGIN;
EXPLAIN (ANALYZE, BUFFERS)
UPDATE orders SET status = 'shipped' WHERE id = 1001;
ROLLBACK;
```

Rolling back does not undo everything: sequence values are consumed, and the rows you wrote leave dead tuples for `VACUUM`. Never run it on production for a heavy write without thinking about locks: the `UPDATE` holds its row locks until `ROLLBACK`.

### 2.4 Explaining a query with `$1` parameters

Queries from `pg_stat_statements` and from driver logs look like `WHERE user_id = $1`. Three options:

```sql
-- 1. PG 16+: generic plan, no values needed (no ANALYZE possible)
EXPLAIN (GENERIC_PLAN)
SELECT * FROM orders WHERE user_id = $1 AND created_at >= $2;

-- If the type of a parameter is ambiguous, add a cast [50]
EXPLAIN (GENERIC_PLAN)
SELECT * FROM generate_series($1::integer, $2, $3);

-- 2. Before PG 16: the PREPARE workaround [51]
PREPARE stmt(unknown, unknown) AS
  SELECT * FROM orders WHERE user_id = $1 AND created_at >= $2;
SET plan_cache_mode = force_generic_plan;
EXPLAIN EXECUTE stmt(NULL, NULL);
DEALLOCATE stmt;
RESET plan_cache_mode;

-- 3. Real numbers: substitute realistic values (from the logs) and run
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE user_id = 42 AND created_at >= '2026-09-01';
```

The generic plan is the plan a prepared statement may switch to after five executions (section 6). The plan with real values is the *custom* plan. Check both when a query is fast in `psql` but slow in the application.

---

## 3. Reading a plan

### 3.1 The tree, from the inside out

A plan is a tree. Each line starting with `->` is a node. A parent node pulls rows from its children, so the most indented nodes run first [60]. Read from the innermost node outward, and from the top child to the bottom child.

Each node shows two groups of numbers:

```text
Seq Scan on orders  (cost=0.00..20834.00 rows=101 width=24) (actual time=0.215..161.802 rows=97.00 loops=1)
                     └─ estimates (planner) ──────────────┘  └─ measurements (executor, with ANALYZE) ──────┘
```

| Field | Meaning |
|---|---|
| `cost=A..B` | `A` = startup cost (work before the first row, for example a sort). `B` = total cost if the node runs to completion. Parent costs include child costs [2]. |
| `rows` (estimate) | Rows the planner expects this node to return. |
| `width` | Average row size in bytes. |
| `actual time=A..B` | Milliseconds to the first row and to the last row, **per loop**. |
| `rows` (actual) | Rows returned, **average per loop**. Since PG 18 it is shown with two decimals (`rows=10.24`), so averages below 1 no longer show as `0` [2][4]. |
| `loops` | How many times the node ran. |

**Multiply by `loops`.** The docs say: actual time and rows are averages per execution; multiply by `loops` to get the total time spent in the node [2]. An inner index scan with `actual time=0.008..0.070 loops=50000` costs about 3.5 seconds in total, not 0.07 ms.

**Exclusive time.** A node's time includes its children. To find where time is spent, subtract the children's totals from the parent's total. Tools such as explain.depesz.com do this for you ("exclusive" column) [62].

**Parallel nodes.** Under a `Gather`, `loops` counts processes (workers plus the leader), and `rows` is an average per process [62].

### 3.2 Filters and removed rows

| Line | Meaning | Signal |
|---|---|---|
| `Index Cond:` | Condition used to search the index. | Good: only matching entries are read. |
| `Filter:` | Condition checked on each row after it was read. | Fine if few rows are removed. |
| `Rows Removed by Filter: N` | Rows read and then thrown away (average per loop). | Large `N` compared with output rows = wasted work, often a missing or wrong index [2][69]. |
| `Rows Removed by Index Recheck: N` | Rows returned by a lossy index or a lossy bitmap that failed the exact check [2]. | Large `N` on a bitmap scan = bitmap too big for `work_mem` (section 4.1). |
| `Recheck Cond:` | Always printed on a Bitmap Heap Scan; applied only to lossy pages or when the index itself is inexact (GIN, GiST). | Look at `Heap Blocks: lossy=` instead. |
| `Index Searches: N` (PG 18+) | Total number of index descents across all loops: normally one per loop, more with `IN` lists (one per value) and skip scans [2][4]. | Far more searches than you expect: check the index column order (see [05](05-indexing.md)). |

### 3.3 Buffers

With `BUFFERS` (default with `ANALYZE` since PG 18 [2][4]), each node shows pages touched by the node **and its children**, as totals over all loops [2]:

```text
Buffers: shared hit=1024 read=7310 dirtied=3 written=0, temp read=0 written=0
```

| Counter | Meaning |
|---|---|
| `shared hit` | 8 kB pages found in PostgreSQL's cache (`shared_buffers`). |
| `shared read` | Pages read from the OS (OS cache or disk). Slow if they come from disk. |
| `shared dirtied` | Pages this query modified (writes, or setting hint bits on recently changed rows). |
| `shared written` | Pages this query had to write out itself to free cache space. Repeated high values can hint that the cache or the background writer is undersized. |
| `local …` | Pages of temporary tables. |
| `temp read/written` | Pages of temporary files: sorts, hashes, or materializations that spilled to disk. |

Why buffers matter: time changes with cache state, CPU load, and the machine. The *total* number of pages touched (`hit + read`) stays about the same between runs. If a fix reduces buffers 100×, it is a real fix even if your laptop timing is noisy. One page is 8 kB, so `read=7310` is about 57 MB.

`Planning:` also has a `Buffers:` line (pages read from the catalogs). With `MEMORY` (PG 17+) it also shows planner memory [72]:

```text
Planning:
  Buffers: shared hit=17 read=6
  Memory: used=6kB  allocated=8kB
```

### 3.4 Planning time, execution time, triggers, JIT, serialization

```text
Planning Time: 0.233 ms
Execution Time: 161.951 ms
```

- **Planning Time** = time to build the plan. It excludes parsing and rewriting [2]. High values come from many joins, many partitions, or huge `IN` lists.
- **Execution Time** = executor start-up, run, and shut-down, including triggers [2]. `BEFORE` trigger time is inside the modify node; `AFTER` trigger time is shown separately per trigger. Deferred constraint triggers fire at commit and are not counted [2].
- **Not included:** sending rows to the client over the network, and (unless you add `SERIALIZE`, PG 17+) converting rows to text [2]. A query that returns 50 MB of JSON can be fast in `EXPLAIN ANALYZE` and slow in the application.

```text
Serialization: time=23.446 ms  output=3346kB  format=text      -- EXPLAIN (ANALYZE, SERIALIZE), PG 17+ [71]
```

- **JIT** (just-in-time compilation of expressions) shows its own block. If `Timing: … Total` is a large part of `Execution Time` on a short query, JIT is hurting (section 7.15) [38]:

```text
JIT:
  Functions: 3
  Options: Inlining false, Optimization false, Expressions true, Deforming true
  Timing: Generation 1.259 ms (Deform 0.000 ms), Inlining 0.000 ms, Optimization 0.797 ms, Emission 5.048 ms, Total 7.104 ms
```

- **`(never executed)`**: the node was planned but never ran. Common with run-time partition pruning and with the inner side of a join whose outer side returned no rows [41].
- **`Disabled: true`** (PG 18+): the node was chosen even though an `enable_*` setting disabled it [2]. Before PG 18 a disabled node showed a huge cost such as `cost=10000000000.00..`.

### 3.5 Worked example 1 — a missing index

Illustrative output from PG 18 (numbers made consistent, parallel query disabled to keep it short). The `orders` table has 1,000,000 rows in 8,334 pages.

```sql
EXPLAIN (ANALYZE)
SELECT id, total_cents, created_at
FROM orders
WHERE user_id = 42
ORDER BY created_at DESC
LIMIT 20;
```

```text
Limit  (cost=20836.43..20836.48 rows=20 width=24) (actual time=161.912..161.917 rows=20.00 loops=1)
  Buffers: shared hit=1024 read=7310                                   -- (4) whole table read: 8,334 pages ≈ 65 MB
  ->  Sort  (cost=20836.43..20836.68 rows=101 width=24) (actual time=161.910..161.913 rows=20.00 loops=1)
        Sort Key: created_at DESC
        Sort Method: top-N heapsort  Memory: 27kB                      -- (3) fine: only the top 20 kept in memory
        Buffers: shared hit=1024 read=7310
        ->  Seq Scan on orders  (cost=0.00..20834.00 rows=101 width=24) (actual time=0.215..161.802 rows=97.00 loops=1)
              Filter: (user_id = 42)                                   -- (1) condition applied row by row
              Rows Removed by Filter: 999903                           -- (2) 1,000,000 rows read to keep 97
              Buffers: shared hit=1024 read=7310
Planning Time: 0.112 ms
Execution Time: 161.951 ms
```

Reading it: (1) the scan has a `Filter`, not an `Index Cond`; (2) it reads one million rows to keep 97; (3) the sort itself is cheap; (4) the buffers confirm the whole table was read. The estimate (101 rows) is good, so statistics are fine; the plan is bad because no index matches.

Fix: an index whose column order matches "equality first, then sort" (see [05-indexing.md](05-indexing.md)):

```sql
CREATE INDEX CONCURRENTLY orders_user_created_idx
  ON orders (user_id, created_at DESC);
```

```text
Limit  (cost=0.42..21.37 rows=20 width=24) (actual time=0.031..0.064 rows=20.00 loops=1)
  Buffers: shared hit=23
  ->  Index Scan using orders_user_created_idx on orders  (cost=0.42..106.24 rows=101 width=24) (actual time=0.030..0.060 rows=20.00 loops=1)
        Index Cond: (user_id = 42)
        Index Searches: 1
        Buffers: shared hit=23
Planning Time: 0.140 ms
Execution Time: 0.081 ms
```

No sort node: the index returns rows already in `created_at DESC` order, and `Limit` stops after 20 rows. Buffers drop from 8,334 to 23. Note how `Limit` costs only a fraction of the index scan's total cost: the planner knows it will stop early.

### 3.6 Worked example 2 — loops in a nested loop

```sql
EXPLAIN (ANALYZE)
SELECT u.email, o.id, o.total_cents
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE u.created_at >= now() - interval '1 day';
```

```text
Nested Loop  (cost=0.85..1754.20 rows=480 width=40) (actual time=0.041..3.902 rows=512.00 loops=1)
  Buffers: shared hit=1690
  ->  Index Scan using users_created_at_idx on users u  (cost=0.42..12.65 rows=48 width=36) (actual time=0.020..0.110 rows=50.00 loops=1)
        Index Cond: (created_at >= (now() - '1 day'::interval))
        Index Searches: 1
        Buffers: shared hit=52
  ->  Index Scan using orders_user_id_idx on orders o  (cost=0.43..36.18 rows=10 width=20) (actual time=0.008..0.070 rows=10.24 loops=50)
        Index Cond: (user_id = u.id)
        Index Searches: 50
        Buffers: shared hit=1638
Planning Time: 0.301 ms
Execution Time: 3.958 ms
```

- The outer side (users) returns 50 rows, so the inner index scan runs 50 times (`loops=50`).
- Inner total: `0.070 ms × 50 ≈ 3.5 ms`, and `10.24 rows × 50 = 512` rows.
- `Index Searches: 50` and `Buffers` are totals over all loops, not per loop.
- Estimates (48 users, 480 rows) are close to reality (50, 512). This is a healthy nested loop. It becomes a problem when the planner expects 48 outer rows and gets 500,000 (section 7.6).

### 3.7 Worked example 3 — a misestimate from correlated columns

```sql
EXPLAIN (ANALYZE)
SELECT * FROM addresses WHERE city = 'Paris' AND country = 'FR';
```

```text
Bitmap Heap Scan on addresses  (cost=380.12..23912.40 rows=2012 width=64) (actual time=4.201..38.950 rows=20113.00 loops=1)
  Recheck Cond: (city = 'Paris'::text)
  Filter: (country = 'FR'::text)
  Heap Blocks: exact=9120
  ->  Bitmap Index Scan on addresses_city_idx  (cost=0.00..379.62 rows=20120 width=0) (actual time=2.871..2.871 rows=20113.00 loops=1)
        Index Cond: (city = 'Paris'::text)
        Index Searches: 1
```

The index scan estimate for `city = 'Paris'` is right (20,120 vs 20,113). The heap scan estimate is 10× too low (2,012 vs 20,113): the planner multiplied the selectivity of `city = 'Paris'` by the selectivity of `country = 'FR'` (about 10%), as if the columns were independent. Alone this costs nothing, but if this node feeds a join, the planner may pick a nested loop sized for 2,000 rows. Fix it with extended statistics (section 5.5):

```sql
CREATE STATISTICS addresses_city_country (dependencies, mcv) ON city, country FROM addresses;
ANALYZE addresses;
-- the estimate now becomes about 20,000 rows
```

---

## 4. Plan node reference

Each table lists what the node does and the signals that point to a problem. The pgMustard glossary has one page per node type [66]; depesz's series explains the classic ones [60][61].

### 4.1 Scan nodes

| Node | What it does | Problem signals |
|---|---|---|
| **Seq Scan** | Reads every page of the table in physical order. | Normal for small tables or when you need most rows. Problem: `Rows Removed by Filter` much larger than the output rows. |
| **Index Scan** | Walks the index, then fetches each matching row from the table (the *heap*). Can return rows in index order (no sort needed). | `Filter:` under it = part of the condition is not in the index. Many rows fetched in random order can be slower than a Seq Scan. |
| **Index Only Scan** | Answers from the index alone, when the visibility map says the page is all-visible. | `Heap Fetches: N` close to the row count = the table changed since the last `VACUUM`, so most rows were checked in the heap anyway [69]. Vacuum more often (see [09](09-operations-and-server-tuning.md)). |
| **Bitmap Index Scan** + **Bitmap Heap Scan** | The index part builds a bitmap of matching pages (several indexes can be combined with `BitmapAnd` / `BitmapOr`). The heap part reads those pages in physical order [68]. | `Heap Blocks: exact=… lossy=…`: lossy pages appear when the bitmap does not fit in `work_mem`; every row on a lossy page is rechecked (`Rows Removed by Index Recheck`) [68]. |
| **Function Scan** | Rows from a set-returning function (`unnest`, `generate_series`, `jsonb_to_recordset`). | The row estimate is often a fixed guess (see 5.7). |
| **Subquery Scan** | Wraps a subquery that could not be merged into the parent. | Conditions from outside may not reach the subquery. |
| **Others** | `Values Scan` (a `VALUES` list), `CTE Scan` (see 4.6), `TID Scan` / `TID Range Scan` (rows by physical address `ctid`; range scans are PG 14+ [8]). | — |

### 4.2 Join nodes

| Node | Lines to read | Problem signals |
|---|---|---|
| **Nested Loop** | `loops` on the inner child; `Join Filter` and `Rows Removed by Join Filter`. | Outer side much larger than estimated (inner side runs thousands of times). A `Join Filter` that removes most pairs = the join condition cannot use an index. |
| **Hash Join** + **Hash** | On the Hash node: `Buckets: … Batches: … Memory Usage: …` [2]. | `Batches` above 1 = the hash table spilled to temporary files. `Batches: 16 (originally 1)` = the inner side was much bigger than estimated. |
| **Merge Join** | Usually has `Sort` or ordered index scans as children. | Expensive sorts below it; `Materialize` on the inner side to rescan duplicates. |
| **Memoize** (PG 14+) | Sits between a Nested Loop and its inner side and caches results per key [8][67]: `Cache Key`, `Hits`, `Misses`, `Evictions`, `Overflows`, `Memory Usage`. | Few hits and many evictions = the planner over-estimated how often keys repeat; the cache only adds overhead [67]. PG 19 (beta — may change) also prints the planner's cache estimates [9]. |
| **Semi / Anti joins** | `Hash Semi Join`, `Nested Loop Anti Join`, etc. They come from `EXISTS`, `IN`, `NOT EXISTS`. PG 18 adds `Right Semi Join` [4]. | Good sign: the subquery was turned into a join [53]. |

### 4.3 Sorting, grouping, windows

| Node | Lines to read | Problem signals |
|---|---|---|
| **Sort** | `Sort Key`, `Sort Method`: `quicksort Memory: …` (in memory), `top-N heapsort Memory: …` (with `LIMIT`, keeps only N rows), `external merge Disk: …` (spilled) [2]. | `external merge` = sort did not fit in `work_mem`. A big sort under a `Limit` = an index could give the order instead. |
| **Incremental Sort** (PG 13+) | `Presorted Key`: input is already sorted on a prefix; sorts small groups. | Usually good. |
| **HashAggregate** | `Group Key`; since PG 13 it can spill: `Batches`, `Memory Usage`, `Disk Usage` [70]. | `Disk Usage` or `Batches` above 1 = spill; or far more groups than estimated (check `n_distinct`). |
| **GroupAggregate** | Needs input sorted by the group key; uses little memory [70]. | A large `Sort` below it. |
| **Aggregate** | Plain aggregate, one output row (`count(*)` without `GROUP BY`). | Large scan below it: see 7.11 for `count(*)`. |
| **Unique**, **SetOp**, **HashSetOp** | `DISTINCT`, `INTERSECT`, `EXCEPT`. | Same as sorts and hashes. |
| **WindowAgg** | Window functions; usually a `Sort` below it. PG 15+ shows a `Run Condition` when a filter such as `row_number() <= 10` lets it stop early [7]. PG 18 shows the memory or disk it used [4]. | A big sort below it; disk storage. |

### 4.4 Parallel nodes

| Node | Lines to read | Problem signals |
|---|---|---|
| **Gather** | `Workers Planned: N`, `Workers Launched: M`. Collects rows from workers in any order [40]. | `Launched` lower than `Planned` (or 0): no free workers (`max_parallel_workers`, `max_worker_processes`) [39][40]. |
| **Gather Merge** | Each worker returns sorted rows; the leader merges them [40]. | Same as Gather. |
| **Parallel Seq Scan / Index Scan / Bitmap Heap Scan / Hash / Append** | The work is split between processes. Row counts are per process. | Per-worker sort or hash lines (`Worker 0: Sort Method …`) show spills in workers. |
| **Partial / Finalize Aggregate** | Each worker aggregates its part, the leader combines them. | — |

### 4.5 Partitions and UNION

| Node | Lines to read | Problem signals |
|---|---|---|
| **Append** | One child per partition (or per `UNION ALL` branch). | All partitions listed = no pruning. `Subplans Removed: N` = partitions pruned when the executor started (for example with `$1` or `now()`) [2][41]. Children shown as `(never executed)` = pruned during execution [41]. |
| **Merge Append** | Merges children that are each sorted (ordered scan of partitions, sorted `UNION`). | — |

Partitions pruned at planning time do not appear in the plan at all [41]. Partition design is covered in [07-schema-design-and-patterns.md](07-schema-design-and-patterns.md).

### 4.6 Subqueries, CTEs, materialization

| Node | Meaning | Problem signals |
|---|---|---|
| **InitPlan** | A subquery that does not depend on the outer row. It runs **once**; the result is reused [61]. PG 17+ shows references as `(InitPlan 1).col1`; older versions show `$0` [57]. | Rarely a problem. |
| **SubPlan** | A *correlated* subquery: it depends on the current outer row and runs **once per outer row** (`loops` = outer rows) [61]. | Many loops × cost per loop. Rewrite as a join (section 7.7). |
| **hashed SubPlan** | The subquery result is loaded once into a hash table (typical for `NOT IN (SELECT …)`). PG 17+ shows `ANY (x = (hashed SubPlan 1).col1)` [57]. | Large subquery results use a lot of memory; `NOT IN` has surprising `NULL` semantics [53]. |
| **CTE Scan** | Reads a CTE that was materialized: `WITH … AS MATERIALIZED`, a CTE referenced twice or more, a recursive CTE, or a data-modifying CTE [35]. | Outer `WHERE` conditions cannot reach inside it (section 7.8). |
| **Materialize** | Stores the child's rows so they can be read again cheaply (inner side of a nested loop or merge join). PG 18 shows the memory or disk it used [4]. | Large disk storage. |
| **Result** | Computes values without a table, or applies a `One-Time Filter` (for example a condition that is always false). | — |

### 4.7 Top-of-plan nodes

| Node | Meaning | Problem signals |
|---|---|---|
| **Limit** | Stops asking for rows after N. The planner chooses "fast-start" plans under a Limit. | The `ORDER BY … LIMIT` trap (section 7.12). |
| **LockRows** | Locks each returned row for `SELECT … FOR UPDATE / FOR SHARE` (also with `SKIP LOCKED`, see [08](08-transactions-concurrency-locking.md)). | Long waits are lock waits, not plan problems. |
| **ModifyTable** (`Insert on …`, `Update on …`, `Delete on …`, `Merge on …`) | Writes rows; shows triggers and, for upserts, conflict handling. | Time in triggers and foreign-key checks (shown per trigger). |
| **ProjectSet** | A set-returning function in the `SELECT` list. | — |

---

## 5. Row misestimates: the main cause of bad plans

The planner chooses join order, join strategy, and scan type from row counts. When a row count is wrong by 10×, 100×, or more, the "cheapest" plan is cheap only on paper. Fix the estimate and the planner usually fixes the plan.

### 5.1 How to spot a misestimate

1. In `EXPLAIN ANALYZE`, compare the estimated `rows=` with the actual `rows=` **on the same node**. Both are per loop, so compare them directly.
2. Start from the **lowest** node with a big gap. Errors grow as they move up the tree through joins.
3. A gap below 10× rarely matters. explain.depesz.com colors the "rows x" factor yellow above 10, brown above 100, red above 1000 [62]; pganalyze and pgMustard flag them too [58][65].

Typical consequences:

| Estimate vs actual | Typical bad choice |
|---|---|
| Too low on an outer side | Nested Loop that runs the inner side thousands of times. |
| Too low on a hash's inner side | Hash table too small, many batches, spill to disk. |
| Too high | Seq Scan or Hash Join where an index lookup would win; parallel plan for a tiny result. |
| Too high on number of groups | HashAggregate memory planned for millions of groups, or the opposite: a GroupAggregate with a huge sort. |

### 5.2 Stale statistics

Statistics are refreshed by `ANALYZE`, run by autovacuum when the rows changed since the last analyze exceed `autovacuum_analyze_threshold` (default 50) + `autovacuum_analyze_scale_factor` (default 0.1) × table rows [17][18]. On a 100-million-row table that is 10 million changes. Check freshness:

```sql
SELECT relname,
       n_live_tup,
       n_mod_since_analyze,
       last_analyze,
       last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_mod_since_analyze DESC
LIMIT 20;
```

Fixes:

```sql
-- Refresh now
ANALYZE orders;

-- Analyze a hot table more often (per-table setting; see 09 for autovacuum tuning)
ALTER TABLE orders SET (autovacuum_analyze_scale_factor = 0.02);
```

Cases where autovacuum will not help you:

- **Right after a bulk load** (`COPY`, big `INSERT … SELECT`, a migration backfill): run `ANALYZE` yourself before the first real query.
- **Temporary tables**: autovacuum cannot see them; run `ANALYZE` in the session after filling them [17].
- **Partitioned tables**: autovacuum analyzes the partitions, never the partitioned parent. Run `ANALYZE` on the parent from time to time [15][17]. PG 18 adds `ANALYZE ONLY parent` to refresh only the parent-level statistics without re-analyzing every partition [4].
- **After a major upgrade**: before PG 18, `pg_upgrade` drops planner statistics, so run `vacuumdb --all --analyze-in-stages` right after. PG 18 keeps column statistics but not extended statistics; `vacuumdb --analyze-only --missing-stats-only` (PG 18+) computes only what is missing [4]. Details in [09](09-operations-and-server-tuning.md).

### 5.3 The statistics target

`default_statistics_target` (default 100, maximum 10000) sets how many most-common values and histogram buckets `ANALYZE` keeps per column [3][12]. `ANALYZE` samples `300 × target` rows, so 30,000 rows by default [16]. For a skewed column used in `WHERE` or `JOIN` conditions, raise the target for that column only:

```sql
ALTER TABLE orders ALTER COLUMN status SET STATISTICS 1000;
ANALYZE orders;
```

The price is a larger `pg_statistic`, slower `ANALYZE`, and slightly slower planning [12]. Raise it per column, not globally.

If the number of distinct values is badly wrong (common on huge tables, because it is guessed from a sample), override it [15]:

```sql
-- negative = fraction of rows: here 5% of rows are distinct values
ALTER TABLE events ALTER COLUMN session_id SET (n_distinct = -0.05);
ANALYZE events;
```

### 5.4 Skewed data and the most-common-values list

For each column, `ANALYZE` stores the most common values (MCVs) with their frequency, and a histogram of the other values [13]. A value in the MCV list gets an accurate estimate. For a value not in the list, the planner assumes the rows that are not MCVs are evenly distributed among the other distinct values: `(1 − sum of MCV frequencies) / (n_distinct − number of MCVs)` [85]. Range conditions use the histogram, with linear interpolation inside a bucket [85]. Both can be far off for skewed data.

```sql
SELECT attname, null_frac, n_distinct,
       most_common_vals, most_common_freqs,
       histogram_bounds, correlation
FROM pg_stats
WHERE schemaname = 'public'
  AND tablename  = 'orders'
  AND attname IN ('status', 'user_id', 'created_at');
```

How to read `pg_stats` [13]:

| Column | Meaning |
|---|---|
| `null_frac` | Fraction of rows where the column is `NULL`. |
| `n_distinct` | Above 0: estimated number of distinct values. Below 0: minus the fraction of distinct values per row (`-1` = unique column). |
| `most_common_vals` / `most_common_freqs` | The MCV list and the fraction of rows for each value. |
| `histogram_bounds` | Bounds of buckets with about the same number of rows, **excluding** the MCVs. |
| `correlation` | -1 to +1: how well the physical row order follows the column order. Near ±1, index range scans read few pages; near 0, they jump around the table. |
| `inherited` | `true` for a row that includes child tables (partitions, inheritance). |

`pg_stats` shows only columns you are allowed to read [13].

### 5.5 Correlated columns: CREATE STATISTICS

By default the planner multiplies selectivities of conditions on different columns, as if they were independent [12][14]. *Extended statistics* fix this for chosen column groups. They are not built automatically: you create the object, then `ANALYZE` collects the data [12].

| Kind | Fixes | Notes |
|---|---|---|
| `dependencies` | `WHERE a = … AND b = …` when `a` determines `b` (zip → city). | Used only for equality and `IN` with constants; not for ranges or `LIKE` [12]. |
| `ndistinct` | Group-count estimates for `GROUP BY a, b` [12]. | Create only for column sets you actually group by [12]. |
| `mcv` | Combinations of values that are much more (or less) common than the product of single-column frequencies [12]. | Create only for columns used together in conditions [12]. |

If you omit the kind list, all kinds are built [14].

```sql
-- Orders: carrier depends on country, both used together in filters and GROUP BY
CREATE STATISTICS orders_country_carrier (dependencies, ndistinct, mcv)
  ON country, carrier FROM orders;
ANALYZE orders;

-- Inspect
SELECT statistics_name, attnames, dependencies, n_distinct
FROM pg_stats_ext
WHERE tablename = 'orders';
```

### 5.6 Statistics on expressions (PG 14+)

When a condition uses an expression, the planner has no statistics for it and falls back to a default guess (0.5% for equality) [14]. Two ways to give it real statistics:

```sql
-- Option 1: an expression index (also collects statistics on the expression when analyzed)
CREATE INDEX users_lower_email_idx ON users (lower(email));

-- Option 2 (PG 14+): statistics only, when you do not need the index
CREATE STATISTICS users_lower_email ON (lower(email)) FROM users;
ANALYZE users;
```

Expressions can also be combined with columns or other expressions in one multivariate statistics object, for example `ON date_trunc('month', a), date_trunc('day', a)` on a `timestamp` column, which fixes both filter and `GROUP BY` estimates [14]. The docs recommend statistics objects or expression indexes for frequently used functions [17].

### 5.7 Other sources of bad estimates

- **Set-returning functions:** the planner uses the function's `ROWS` setting (1000 by default) unless the function has a planner support function [84]. Declare a realistic value: `CREATE FUNCTION … RETURNS SETOF … ROWS 20`.
- **Generic plans:** a prepared statement's generic plan uses average selectivity, not the selectivity of the actual value (section 6).
- **Complex expressions on columns:** `WHERE (data->>'kind') = 'invoice'` or `WHERE amount * 1.2 > 100` get default selectivities. Use expression statistics or an expression index, or rewrite the condition on the raw column.
- **Correlated filters inside joins:** extended statistics work on one table only. Cross-table correlation (for example `orders.country` vs `users.country`) cannot be described to the planner; consider denormalizing the filter column or splitting the query.
- **Statistics import is not data import:** PG 18 can copy statistics with `pg_dump --statistics-only` and `pg_restore_relation_stats()` [4], but the planner scales row counts to the current physical size of the table [12]. A test database with tiny tables still gets tiny estimates.

---

## 6. Prepared statements and plan caching

### 6.1 Custom plans and generic plans

A *prepared statement* is parsed once and executed many times with different parameter values. PostgreSQL can execute it with two kinds of plans [19]:

- **Custom plan:** planned again for each execution, using the actual values. Accurate, but costs planning time every time.
- **Generic plan:** planned once with placeholders (`$1`), reused for every value. No planning cost, but it uses average selectivity.

With the default `plan_cache_mode = auto`, the first five executions use custom plans. Then PostgreSQL builds a generic plan and compares its estimated cost with the average custom plan cost. If the generic plan is not much more expensive, it is used from then on [19]. The plan is also rebuilt when a table used by the statement changes (DDL), when its statistics are updated, or when `search_path` changes [19].

This is risky when the best plan depends on the value. Example: `status = 'pending'` matches 0.1% of orders (index scan is best), `status = 'delivered'` matches 90% (seq scan is best). A generic plan picks one strategy for all values:

```sql
PREPARE orders_by_status(text) AS
  SELECT * FROM orders WHERE status = $1 ORDER BY created_at DESC LIMIT 50;

EXECUTE orders_by_status('pending');   -- executions 1–5: custom plans
-- … from execution 6 a generic plan may be used for every value

EXPLAIN EXECUTE orders_by_status('delivered');
-- a generic plan shows "$1" in its conditions; a custom plan shows 'delivered'
```

How to see what happens:

```sql
-- PG 14+: how often each prepared statement in this session used each plan type
SELECT name, generic_plans, custom_plans
FROM pg_prepared_statements;
```

`pg_prepared_statements` has `generic_plans` and `custom_plans` since PG 14 [21][82]. PostgreSQL 19 (beta — may change) also adds generic and custom plan counts to `pg_stat_statements` [9].

### 6.2 plan_cache_mode

| Value | Effect | Use when |
|---|---|---|
| `auto` (default) | The 5-execution heuristic above. | Most queries. |
| `force_custom_plan` | Always plan with the actual values. | Results depend strongly on values (skewed columns, ranges of very different width, partitions chosen by value). |
| `force_generic_plan` | Always reuse the generic plan. | Planning time dominates (complex joins, many partitions) and data is uniform. |

The setting is read when the cached plan is executed, not when it is prepared [3]. Scope it narrowly:

```sql
-- For one transaction
BEGIN;
SET LOCAL plan_cache_mode = force_custom_plan;
-- … queries …
COMMIT;

-- For every session of one role
ALTER ROLE reporting SET plan_cache_mode = force_custom_plan;
```

JIT decisions are also made at plan time. With a generic plan, the JIT settings in effect when the plan was made apply, not the current ones [38].

### 6.3 Drivers, ORMs and poolers

- **node-postgres** sends parameterized queries with the extended protocol. Without a `name`, it uses the *unnamed* statement, which lives only until the next statement is parsed [20][76]. Each execution is parsed and planned again, so in practice you always get custom plans. With a `name` in the query config, node-postgres creates a named prepared statement once per connection, and the generic-plan switch above applies [76].
- **ORMs** (Prisma and others) may use named or unnamed statements depending on version and driver adapter. Check with `pg_prepared_statements` from the same connection, or with `log_min_duration_statement = 0` on a test server. Details in [15-postgres-from-typescript.md](15-postgres-from-typescript.md).
- **PgBouncer** in transaction mode supports protocol-level named prepared statements since 1.21.0 (2023-10-16), when `max_prepared_statements` is above 0 [75]. Since 1.24.0 (2025-01-10) the default is 200, so it is on by default [75]. SQL-level `PREPARE` / `EXECUTE` are not tracked and are sent straight to the server [74].
- **Server-side settings through a pooler:** in transaction pooling, a session-level `SET` stays on the server connection and can affect the next client. Use `SET LOCAL` inside a transaction instead.

---

## 7. Catalog of slow-query patterns

Each entry: what you see in the plan, then the fix. Query idioms in general are in [04-query-patterns-and-antipatterns.md](04-query-patterns-and-antipatterns.md).

### 7.1 Missing or wrong index

**In the plan:** `Seq Scan` with `Rows Removed by Filter` far larger than the output; or an `Index Scan` followed by a `Filter` that removes most rows (the index covers only part of the condition, or its columns are in the wrong order).

**Fix:** an index that matches the query: equality columns first, then the range or sort column; a partial index for a hot subset; `INCLUDE` columns for an index-only scan. Design rules are in [05-indexing.md](05-indexing.md). Re-run `EXPLAIN (ANALYZE, BUFFERS)` and check that buffers dropped.

### 7.2 Non-sargable predicates

A predicate is *sargable* ("search-argument-able") when the database can use it as an index search key. A function, a cast, or arithmetic on the column hides the column from a plain index [78].

```sql
-- Bad: the column is wrapped, so an index on created_at cannot be searched
SELECT * FROM orders WHERE date(created_at) = '2026-10-01';
SELECT * FROM orders WHERE extract(year FROM created_at) = 2026;
SELECT * FROM orders WHERE created_at + interval '30 days' > now();

-- Good: compare the raw column with a range
SELECT * FROM orders WHERE created_at >= '2026-10-01' AND created_at < '2026-10-02';
SELECT * FROM orders WHERE created_at >= '2026-01-01' AND created_at < '2027-01-01';
SELECT * FROM orders WHERE created_at > now() - interval '30 days';
```

If you really need the expression (for example `lower(email)`), index the expression instead: `CREATE INDEX … ON users (lower(email))`. A leading wildcard (`LIKE '%term'`) needs a trigram index, see [12-full-text-and-vector-search.md](12-full-text-and-vector-search.md).

### 7.3 Deep OFFSET

**In the plan:** a `Limit` whose child returns `OFFSET + LIMIT` rows. Page 5,000 reads 100,000 rows to show 20. The work grows with the page number, and rows inserted between requests shift the pages [80].

```sql
-- Bad: reads and throws away 100,000 rows
SELECT id, created_at FROM orders
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 100000;

-- Good: keyset ("seek") pagination; pass the last (created_at, id) of the previous page
SELECT id, created_at FROM orders
WHERE (created_at, id) < ($1, $2)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

Needs an index on `(created_at, id)`. Full pattern in [04](04-query-patterns-and-antipatterns.md).

### 7.4 Sort or hash spilling to disk

**In the plan:** `Sort Method: external merge  Disk: …`; Hash `Batches:` above 1; HashAggregate `Disk Usage`; `temp written=` in `Buffers`. **Outside the plan:** `temp_blks_written` in `pg_stat_statements` [22], `log_temp_files` messages [43].

**Fix, in this order:**

1. Avoid the work: an index that delivers rows already sorted; filter and aggregate earlier; select fewer and narrower columns (the sort or hash holds whole rows, so `width` matters).
2. Give that query more memory, not the whole server: `SET LOCAL work_mem = '256MB'` in its transaction (section 8.7).
3. For hash joins and hash aggregates, raise `hash_mem_multiplier`. The default is 2.0 since PG 15 and 1.0 in PG 13–14 [7][24][25]. (A pgMustard post says 2.0 for PG 14; the PG 14 docs say 1.0 [73][25].) The docs suggest 2.0–8.0 or more when `work_mem` is already 40MB or more and spills are frequent [24].

### 7.5 Lossy bitmap heap scan

**In the plan:**

```text
Bitmap Heap Scan on events  (…) (actual time=… rows=812345.00 loops=1)
  Recheck Cond: (created_at >= '2026-09-01 00:00:00+00'::timestamp with time zone)
  Rows Removed by Index Recheck: 2210533
  Heap Blocks: exact=1200 lossy=48000
```

The bitmap did not fit in `work_mem`, so PostgreSQL kept only page numbers for most pages and had to recheck every row on them [68]. **Fix:** more `work_mem` for this query, or a more selective condition or index so the bitmap is smaller.

### 7.6 Nested loop over a misestimated outer side

**In the plan:**

```text
Nested Loop  (cost=1.13..250.40 rows=12 width=48) (actual time=0.051..9874.210 rows=482113.00 loops=1)
  ->  Index Scan using orders_status_idx on orders o  (cost=0.56..60.10 rows=12 width=40) (actual time=0.030..410.552 rows=482113.00 loops=1)
        Index Cond: (status = 'pending'::text)
        Filter: (carrier = 'ups'::text)
  ->  Index Scan using users_pkey on users u  (cost=0.57..8.59 rows=1 width=16) (actual time=0.018..0.018 rows=1.00 loops=482113)
        Index Cond: (id = o.user_id)
```

The planner expected 12 orders, got 482,113, and ran the inner index scan 482,113 times. A hash join would have been far cheaper. The root cause is the estimate, not the join method: stale statistics, skew, or correlated columns (`status` and `carrier`).

**Fix:** sections 5.2–5.6 (`ANALYZE`, statistics target, `CREATE STATISTICS`). To *confirm* the diagnosis in a test session only:

```sql
BEGIN;
SET LOCAL enable_nestloop = off;   -- diagnosis only, never in production
EXPLAIN (ANALYZE, BUFFERS) SELECT …;
ROLLBACK;
```

If the forced plan is much faster, the estimate is the problem. Fix the estimate, then check that the normal plan changes.

### 7.7 Correlated subquery run once per row (SubPlan)

**In the plan:** `SubPlan 1` with `loops` equal to the number of outer rows [61][53].

```sql
-- Bad: one subquery execution per user (SubPlan, loops = number of users)
SELECT u.id, u.email,
       (SELECT max(o.created_at) FROM orders o WHERE o.user_id = u.id) AS last_order_at
FROM users u
WHERE u.created_at >= '2026-01-01';

-- Good: aggregate once, then join (hash or merge join possible)
SELECT u.id, u.email, o.last_order_at
FROM users u
LEFT JOIN (
  SELECT user_id, max(created_at) AS last_order_at
  FROM orders
  GROUP BY user_id
) o ON o.user_id = u.id
WHERE u.created_at >= '2026-01-01';
```

Nuance: for a few outer rows with an index on `orders (user_id, created_at)`, the per-row version is fine (a few index lookups). The join version wins when there are many outer rows. When you really want "for each row, the top N related rows", write it explicitly with `LEFT JOIN LATERAL (… ORDER BY … LIMIT N) ON true`.

`NOT IN (subquery)` is a special trap: PostgreSQL cannot turn it into an anti-join because of `NULL` semantics, and if the subquery returns a single `NULL`, the result is empty [53].

```sql
-- Bad: hashed SubPlan, and wrong results if orders.user_id contains NULL
SELECT * FROM users WHERE id NOT IN (SELECT user_id FROM orders);

-- Good: becomes an anti-join; correct with NULLs
SELECT * FROM users u
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id);
```

PostgreSQL 17 can turn correlated `IN` subqueries into joins [5]. PostgreSQL 19 (beta — may change) converts `NOT IN` to an anti-join when it can prove there are no `NULL`s [9]. Still write `NOT EXISTS`.

### 7.8 CTE materialization fence

Since PG 12, a non-recursive CTE without side effects that is referenced **once** is inlined into the main query [35]. It is materialized (computed fully, stored, then scanned) when it is marked `MATERIALIZED`, referenced two or more times, recursive, data-modifying, or contains volatile functions [35]. A materialized CTE is a *fence*: outer conditions are applied after it is fully computed.

**In the plan:** `CTE Scan on recent` with a `Filter` and many removed rows; the CTE itself scans a large range.

```sql
-- Bad: referenced twice → materialized; user_id filters are applied after
-- 30 days of orders were copied into the CTE
WITH recent AS (
  SELECT * FROM orders WHERE created_at >= now() - interval '30 days'
)
SELECT * FROM recent WHERE user_id = 42
UNION ALL
SELECT * FROM recent WHERE user_id = 43;

-- Good: inline it, so each branch can use an index on (user_id, created_at)
WITH recent AS NOT MATERIALIZED (
  SELECT * FROM orders WHERE created_at >= now() - interval '30 days'
)
SELECT * FROM recent WHERE user_id = 42
UNION ALL
SELECT * FROM recent WHERE user_id = 43;
```

The reverse is a valid tool: `AS MATERIALIZED` deliberately stops the planner from merging a subquery, which can protect a fragile plan, or avoid running an expensive expression twice [35].

### 7.9 OR conditions

**In the plan:** a `Seq Scan` or a big join with `Filter: ((a = …) OR (b = …))`.

| Case | Rewrite |
|---|---|
| Same column: `id = 1 OR id = 2` | `id = ANY ('{1,2}')` or `IN (…)`. PG 18 can do this conversion itself in some cases [4][52]. |
| Different columns of one table | One index per column lets the planner combine them with `BitmapOr`. |
| Columns of different joined tables | Split into a `UNION` of two queries, each with its own index [52]. |

```sql
-- Bad: OR across two tables: the planner must build the join, then filter it
SELECT o.*
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.reference = $1 OR u.email = $2;

-- Good: each branch uses its own index; UNION removes rows found by both branches
SELECT o.* FROM orders o WHERE o.reference = $1
UNION
SELECT o.* FROM orders o JOIN users u ON u.id = o.user_id WHERE u.email = $2;
```

Use `UNION ALL` (no duplicate removal, cheaper) only when the branches cannot return the same row [52].

### 7.10 Huge IN lists

Problems with `IN ($1, $2, …, $5000)`: long parse and plan time, a different statement text for each list length (one entry per length in `pg_stat_statements` before PG 18 [4][22]), and the wire protocol stores the parameter count in a 16-bit field, so very long lists hit a hard limit [47].

```sql
-- Bad: one parameter per value, statement text changes with the list length
SELECT * FROM users WHERE id IN ($1, $2, $3 /* … */);

-- Good: one array parameter, one statement text (node-postgres sends a JS array as an array)
SELECT * FROM users WHERE id = ANY($1::bigint[]);

-- Very large sets: join with the unnested array, or load a temp table and ANALYZE it
SELECT u.*
FROM unnest($1::bigint[]) AS ids(id)
JOIN users u ON u.id = ids.id;
```

Related improvements: PG 14 uses a hash lookup for long `IN` lists checked as a filter [8]; PG 17 makes B-tree index scans with `IN`/`= ANY` lists more efficient [5]; PG 18 turns some `IN (VALUES …)` into `= ANY (…)` [4]. Using `= ANY($1)` also groups all list sizes under one `pg_stat_statements` entry [81].

### 7.11 Slow count(*)

PostgreSQL stores no exact row count: because of MVCC (each transaction may see a different set of rows), `count(*)` must check which rows are visible [48][49]. `count(*)` is not slower than `count(1)`; `count(1)` and `count(col)` are slightly slower because they test the argument for `NULL` [49].

```sql
-- Fast estimate for a whole table (updated by VACUUM / ANALYZE)
SELECT reltuples::bigint AS estimated_rows
FROM pg_class
WHERE oid = 'public.orders'::regclass;   -- -1 means "never vacuumed or analyzed" [46]

-- Bad: counts everything to answer a yes/no question
SELECT count(*) > 0 FROM orders WHERE user_id = $1;

-- Good: stops at the first match
SELECT EXISTS (SELECT 1 FROM orders WHERE user_id = $1);

-- Good: capped count for a UI that shows "1000+"
SELECT count(*) FROM (SELECT 1 FROM orders WHERE status = 'pending' LIMIT 1001) AS t;
```

Other options: the planner's estimate for a filtered query (parse `EXPLAIN (FORMAT JSON)`, never with unsanitized input) [48]; an index-only scan on a well-vacuumed table [49]; a counter table maintained by triggers, which serializes concurrent writers on the counter row [49].

### 7.12 The ORDER BY … LIMIT index trap

**In the plan:**

```text
Limit  (cost=0.43..393.21 rows=20 width=64) (actual time=8231.402..8231.950 rows=20.00 loops=1)
  ->  Index Scan Backward using orders_created_at_idx on orders  (cost=0.43..982113.05 rows=50012 width=64) (actual time=8231.400..8231.940 rows=20.00 loops=1)
        Filter: (carrier = 'dhl'::text)
        Rows Removed by Filter: 4812733
```

The planner walks the index that matches `ORDER BY created_at DESC` and expects to find 20 matching rows quickly, assuming matches are spread evenly. If the matching rows are rare or all old, it scans most of the index [56].

**Fix:**

1. Best: an index for "filter, then sort": `CREATE INDEX … ON orders (carrier, created_at DESC)` [56].
2. Better statistics for the filter column (higher statistics target) can change the estimate [56].
3. Last resort: make the sort expression not match the index, for example `ORDER BY id + 0` for an integer key, so the planner stops choosing the "walk the sort index" plan [56]. Leave a comment in the code if you do this.

### 7.13 Partition pruning not happening

**In the plan:** the `Append` lists every partition, with no `Subplans Removed` line.

| Cause | Fix |
|---|---|
| The condition is not on the partition key, or wraps it: `WHERE date(created_at) = …` | Compare the raw key with a range: `created_at >= … AND created_at < …` [41]. |
| The value comes from a non-immutable expression (`now()`, `$1` in a generic plan) | Not a bug: pruning happens when the executor starts and shows as `Subplans Removed: N` [2][41]. |
| The value comes from a join (nested loop) | Pruning happens during execution; pruned children show `(never executed)` [41]. |
| `enable_partition_pruning = off` | Turn it back on (default on) [41]. |
| Thousands of partitions remain after pruning | Planning time and memory grow; design for fewer partitions per query [41]. See [07](07-schema-design-and-patterns.md). |

### 7.14 Parallel query surprises

- **No parallel plan** when the query writes or locks rows (`FOR UPDATE`), when it runs as a cursor or in a PL/pgSQL `FOR … IN query` loop, or when it calls a `PARALLEL UNSAFE` function [39]. User-defined functions are `PARALLEL UNSAFE` by default [84].
- **No workers at run time:** `Workers Launched: 0` when the worker pool (`max_parallel_workers`, `max_worker_processes`) is busy, or when the client fetches with a row limit (Execute with a non-zero fetch count, as streaming cursors do) [39].
- **Parallel plans in OLTP:** starting workers costs time and every worker can use its own `work_mem`. If short queries get parallel plans, set `max_parallel_workers_per_gather = 0` for the OLTP role, or raise `parallel_setup_cost` (section 8.5).

### 7.15 JIT overhead on short queries

**In the plan:** a `JIT:` block whose `Timing: … Total` is a large part of `Execution Time` (section 3.4).

JIT compiles expressions to machine code when the plan's estimated cost is above `jit_above_cost` (100000 by default) [3][38]. For short queries the compile time is often larger than the time it saves [38]. Big cost estimates come from large tables or from overestimates, so OLTP queries can cross the threshold. PostgreSQL 19 (beta — may change) disables JIT by default because "this costing has been determined to be unreliable" [9].

```sql
-- OLTP database: turn JIT off (new sessions)
ALTER DATABASE app SET jit = off;

-- Or keep it for a reporting role only
ALTER ROLE reporting SET jit = on;

-- Find statements that pay for JIT (pg_stat_statements, PG 15+)
SELECT left(query, 80) AS query, calls,
       round(mean_exec_time::numeric, 1) AS mean_ms,
       round(((jit_generation_time + jit_inlining_time
             + jit_optimization_time + jit_emission_time) / calls)::numeric, 1) AS jit_ms_per_call
FROM pg_stat_statements
WHERE jit_functions > 0
ORDER BY jit_generation_time + jit_inlining_time + jit_optimization_time + jit_emission_time DESC
LIMIT 10;
```

### 7.16 Functions with the wrong volatility

A new function is `VOLATILE` and `PARALLEL UNSAFE` unless you say otherwise [84]. A `VOLATILE` function is called again for every row, cannot be used in an index scan condition [36], prevents a CTE from being inlined [35], and prevents inlining of SQL set-returning functions (those must be `STABLE` or `IMMUTABLE`) [37]. `PARALLEL UNSAFE` forces a serial plan [84].

```sql
-- Bad: default VOLATILE → evaluated per row, used only as a Filter (Seq Scan)
CREATE FUNCTION current_tenant_id() RETURNS bigint
LANGUAGE plpgsql AS $$
BEGIN
  RETURN current_setting('app.tenant_id')::bigint;
END $$;

SELECT * FROM documents WHERE tenant_id = current_tenant_id();

-- Good: same result for the whole statement → STABLE, so it can feed an Index Cond
ALTER FUNCTION current_tenant_id() STABLE;
```

Use the strictest category that is **true** [36]: `IMMUTABLE` (same result forever for the same input), `STABLE` (same result within one statement, like `now()`), `VOLATILE` (anything else, including `random()`). A wrong `IMMUTABLE` label gives wrong results, for example in an expression index.

### 7.17 Implicit casts and type mismatches

PostgreSQL refuses many mixed-type comparisons outright (`text = integer` is an error) [79]. But some implicit casts exist, and they put the cast on the **column** side, which disables a plain index on that column.

```sql
-- Bad: users.id is bigint; 42.0 is numeric, so the column is cast:
--      Filter: ((id)::numeric = 42.0)  → no index
SELECT * FROM users WHERE id = 42.0;

-- Bad: cast on the column for convenience (documents.id is uuid)
SELECT * FROM documents WHERE id::text = $1;

-- Good: cast the value, never the column
SELECT * FROM users WHERE id = 42;
SELECT * FROM documents WHERE id = $1::uuid;
```

Look for `::` applied to the column inside `Filter:` or `Index Cond:` lines. In application code, pass parameters with the column's type (or no type, and let PostgreSQL infer it from the column).

### 7.18 Too many joins

**Symptoms:** a high `Planning Time`, a join order that follows the order you wrote, plans that change after small edits. Above `join_collapse_limit` / `from_collapse_limit` (8) the planner stops reordering; from `geqo_threshold` (12) `FROM` items it switches to the genetic search [3][31][32].

**Fix:**

- Join less: fetch in two simpler queries, pre-aggregate in a subquery, or drop joins that only exist for one rarely used column. ORM-generated SQL is a common source; log it and read it.
- If the query must stay big: raise `join_collapse_limit` and `from_collapse_limit` for that transaction only (more planning time, better plan), or write the joins in a good order and pin it with `SET LOCAL join_collapse_limit = 1` [31].

---

## 8. Query-level settings

Server-wide sizing (memory, I/O, connections) is in [09-operations-and-server-tuning.md](09-operations-and-server-tuning.md). This section covers the settings that change plans and that you may set for one query, role, or database.

### 8.1 work_mem and hash_mem_multiplier

- `work_mem` (default 4MB) is the memory **one** sort or hash operation may use before it writes temporary files. Sorts serve `ORDER BY`, `DISTINCT`, and merge joins; hash tables serve hash joins, hash aggregation, Memoize, and hashed `IN` subqueries [24].
- One query can run several such operations at once, every parallel worker has its own, and many sessions run at the same time. Total use "could be many times the value of `work_mem`" [24]. Simple arithmetic: 200 connections × 3 sort/hash nodes × 64MB = 37.5GB in the worst case.
- Hash operations may use `work_mem × hash_mem_multiplier` (default 2.0 since PG 15) [7][24].

Practical rule: keep the global value modest, and raise it for the queries or roles that spill (section 8.7).

### 8.2 Planner cost settings: effective_cache_size and random_page_cost

| Setting | Default | Guidance |
|---|---|---|
| `effective_cache_size` | 4GB | Estimate of the cache available to one query: `shared_buffers` plus the part of the OS page cache PostgreSQL will use. Allocates nothing. Higher values make index scans look cheaper [26]. |
| `random_page_cost` | 4.0 | Cost of a random page read relative to a sequential one (1.0). Can be set per tablespace [26]. |
| `seq_page_cost` | 1.0 | Usually left alone. |

**random_page_cost on SSDs — sources disagree.** From 2020 the docs suggested about 1.1 for SSDs [27], and community advice has long been "close to 1 on SSDs" [30]. The current docs no longer give a number: they explain that the default 4.0 assumes most random reads are cached, suggest a lower value when the data is likely fully cached, and a higher one for slow random storage [3][26]. In 2025 Tomas Vondra measured the uncached random-read cost on several SSD setups at about 20–50× a sequential read and argued the default is too *low*, not too high [28][29]. Practical position: if your working set fits in RAM (high cache hit ratio), values around 1.1–2 usually work well; otherwise test. Change it on a test system first, and compare `pg_stat_statements` before and after [29].

### 8.3 I/O concurrency

`effective_io_concurrency` sets how many I/O requests a session may have in flight, used for prefetching (bitmap heap scans). The default is 16 since PG 18; it was 1 in older versions [4][24][25]. PG 18 also adds asynchronous I/O (`io_method`, default `worker`) for sequential scans, bitmap heap scans, and vacuum [4][24]. Server-level I/O tuning: [09](09-operations-and-server-tuning.md).

### 8.4 JIT

| Setting | Default | Meaning |
|---|---|---|
| `jit` | on (PG 14–18); off in PG 19 (beta — may change) [3][9] | Allow JIT compilation. |
| `jit_above_cost` | 100000 | Plan cost above which JIT is used. |
| `jit_inline_above_cost` | 500000 | Cost above which functions are inlined (more compile time). |
| `jit_optimize_above_cost` | 500000 | Cost above which expensive optimizations run. |

Values from [3]. For OLTP, `jit = off` per database or role is a common and safe choice (section 7.15). Keep JIT for long analytical queries that are CPU-bound [38].

### 8.5 Parallel query

| Setting | Default | Meaning |
|---|---|---|
| `max_parallel_workers_per_gather` | 2 | Workers per `Gather` node. `0` disables parallel query for the scope where it is set. |
| `max_parallel_workers` | 8 | Workers for parallel query, server-wide. |
| `max_worker_processes` | 8 | All background workers (restart needed). |
| `parallel_setup_cost` | 1000 | Planner cost of starting workers. |
| `parallel_tuple_cost` | 0.1 | Planner cost per row sent from a worker. |
| `min_parallel_table_scan_size` | 8MB | Tables smaller than this are not scanned in parallel. |
| `min_parallel_index_scan_size` | 512kB | Same for indexes. |

Values from [3][24]. If you raise `max_parallel_workers_per_gather`, raise `max_parallel_workers` and `max_worker_processes` too, or plans will say `Workers Launched: 0` [40].

### 8.6 enable_* switches: for diagnosis only

`enable_seqscan`, `enable_indexscan`, `enable_bitmapscan`, `enable_nestloop`, `enable_hashjoin`, `enable_mergejoin`, `enable_memoize` (PG 14+), `enable_incremental_sort`, `enable_hashagg`, `enable_partition_pruning`, and others (all `on` by default; `enable_partitionwise_join` and `enable_partitionwise_aggregate` are `off`) [3]. Newer ones: `enable_presorted_aggregate` (PG 16+) [6], `enable_group_by_reordering` (PG 17+) [5], `enable_self_join_elimination` and `enable_distinct_reordering` (PG 18+) [4].

Use them to answer one question: "would the plan I expect really be faster?"

```sql
BEGIN;
SET LOCAL enable_seqscan = off;     -- discourage, not forbid: PG 18 marks such nodes "Disabled: true"
EXPLAIN (ANALYZE, BUFFERS) SELECT …;
ROLLBACK;
```

Never set them in `postgresql.conf`, on a role, or in application code. They act on every query in scope, they hide the real cause (usually an estimate or a cost constant), and they stop the planner from adapting when data changes.

### 8.7 Scoping a setting

| Scope | How | Notes |
|---|---|---|
| One transaction | `SET LOCAL work_mem = '256MB';` inside `BEGIN … COMMIT` | Reverts at commit or rollback. Outside a transaction it only emits a warning [45]. Safe with transaction-mode poolers. |
| One transaction, from code | `SELECT set_config('work_mem', '256MB', true);` | `true` = local to the transaction [45]. Works as a parameterized query. |
| One session | `SET work_mem = '256MB';` | Lasts until the session ends (rolled back if its transaction aborts) [45]. Avoid with transaction-mode poolers. |
| One role | `ALTER ROLE reporting SET work_mem = '256MB';` | Applies to new sessions of that role. |
| One database | `ALTER DATABASE app SET jit = off;` | Applies to new sessions. |
| One function | `CREATE FUNCTION … SET work_mem = '256MB' AS …` | Applies while the function runs. |

```sql
-- A heavy report in one transaction: more memory, no JIT, custom plans
BEGIN;
SET LOCAL work_mem = '256MB';
SET LOCAL jit = off;
SET LOCAL plan_cache_mode = force_custom_plan;
SELECT … ;   -- the report query
COMMIT;
```

From TypeScript, run these statements on the same client inside one transaction (node-postgres `client.query('BEGIN')` …, or an interactive Prisma transaction); see [15](15-postgres-from-typescript.md).

### 8.8 Hints: last resort

PostgreSQL has no built-in optimizer hints in versions 14–18. When statistics and rewrites cannot fix a plan:

- **pg_hint_plan** (extension from the ossc-db project): hints in a leading comment, for example `/*+ IndexScan(o orders_user_created_idx) */ SELECT … FROM orders o …` [83]. It has releases for PG 13–18 (1.8.0 for PG 18, August 2025) [77]. Availability on managed services varies.
- **pg_plan_advice** (PG 19, beta — may change): a contrib module that ships with PostgreSQL 19 [9][11] and is still present in beta 4 [10]. `EXPLAIN (PLAN_ADVICE)` prints the advice for the current plan (for example `JOIN_ORDER(f d) HASH_JOIN(d) SEQ_SCAN(f d)`), and `SET pg_plan_advice.advice = '…'` applies advice; `EXPLAIN` then reports each piece as `matched`, `not matched`, `failed`, and so on [11]. It constrains the planner instead of replacing it, cannot control aggregation or set operations, and the docs warn that overriding the planner "can easily backfire" when data changes [11]. A companion extension, `pg_stash_advice`, stores advice per query id [9].

Every hint freezes a decision that was right for yesterday's data. Write down why it exists and re-check it after data growth or upgrades.

---

## 9. The diagnosis workflow

1. **Find** the queries that matter with `pg_stat_statements` (9.1–9.3).
2. **Capture** their real plans from production with `auto_explain` and slow-query logs (9.4–9.5).
3. **Reproduce** on production-like data (9.6).
4. **Explain** with `EXPLAIN (ANALYZE, BUFFERS)`; locate the expensive node and the first big misestimate (sections 3–5).
5. **Change one thing**: statistics, an index, a rewrite, or a scoped setting (sections 5, 7, 8).
6. **Compare** plan shape, buffers, and time before and after; benchmark if the query is hot (section 11).
7. **Monitor** after release: the query's `mean_exec_time` and `calls` in `pg_stat_statements`, and new entries in the slow log.

### 9.1 Set up pg_stat_statements

```ini
# postgresql.conf (shared_preload_libraries needs a restart)
shared_preload_libraries = 'pg_stat_statements'
compute_query_id = auto                  # default; the extension turns it on (PG 14+)
pg_stat_statements.max = 10000           # default 5000 distinct statements
pg_stat_statements.track = top           # default; 'all' also tracks statements inside functions
pg_stat_statements.track_planning = off  # default; 'on' fills plans/*_plan_time at some overhead
track_io_timing = on                     # I/O time columns; check overhead with pg_test_timing
```

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

Setup and defaults from [22][44]. Query texts are normalized: constants become `$1`, `$2` [22]. Since PG 18, lists of constants such as `IN (1, 2, 3)` are squashed so all list lengths share one entry [4][22]. Seeing other users' query texts needs superuser or `pg_read_all_stats` [22].

### 9.2 Ready-to-use queries

These use only columns present in PG 14–18. Add `AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())` to the `WHERE` clause to limit them to the current database.

```sql
-- 1. Where does the time go? (start here: optimize the top of this list first)
SELECT queryid,
       left(regexp_replace(query, '\s+', ' ', 'g'), 100) AS query,
       calls,
       round(total_exec_time::numeric)                AS total_ms,
       round(mean_exec_time::numeric, 2)              AS mean_ms,
       round((100 * total_exec_time
              / sum(total_exec_time) OVER ())::numeric, 1) AS pct_total,
       round(rows::numeric / calls, 1)                AS rows_per_call
FROM pg_stat_statements
WHERE calls > 0
ORDER BY total_exec_time DESC
LIMIT 20;

-- 2. Slowest per call (ignore rare statements)
SELECT queryid, left(query, 100) AS query, calls,
       round(mean_exec_time::numeric, 2)   AS mean_ms,
       round(max_exec_time::numeric, 2)    AS max_ms,
       round(stddev_exec_time::numeric, 2) AS stddev_ms
FROM pg_stat_statements
WHERE calls >= 20
ORDER BY mean_exec_time DESC
LIMIT 20;

-- 3. Most data read from outside shared_buffers (I/O heavy)
SELECT queryid, left(query, 100) AS query, calls,
       shared_blks_read, shared_blks_hit,
       round(100.0 * shared_blks_hit
             / nullif(shared_blks_hit + shared_blks_read, 0), 1) AS hit_pct,
       pg_size_pretty(shared_blks_read * current_setting('block_size')::bigint) AS read_total
FROM pg_stat_statements
ORDER BY shared_blks_read DESC
LIMIT 20;

-- 4. Spills to temporary files (work_mem candidates)
SELECT queryid, left(query, 100) AS query, calls,
       pg_size_pretty(temp_blks_written * current_setting('block_size')::bigint) AS temp_written,
       round(mean_exec_time::numeric, 2) AS mean_ms
FROM pg_stat_statements
WHERE temp_blks_written > 0
ORDER BY temp_blks_written DESC
LIMIT 20;

-- 5. Most frequent (chatty code, N+1 loops, missing caching)
SELECT queryid, left(query, 100) AS query, calls,
       round(mean_exec_time::numeric, 3) AS mean_ms,
       round(rows::numeric / calls, 1)   AS rows_per_call
FROM pg_stat_statements
WHERE calls > 0
ORDER BY calls DESC
LIMIT 20;

-- 6. Planning time (only if pg_stat_statements.track_planning = on)
SELECT queryid, left(query, 100) AS query, plans, calls,
       round(mean_plan_time::numeric, 2) AS mean_plan_ms,
       round(mean_exec_time::numeric, 2) AS mean_exec_ms
FROM pg_stat_statements
WHERE plans > 0
ORDER BY total_plan_time DESC
LIMIT 20;

-- 7. Is the data trustworthy? (PG 14+)
SELECT dealloc, stats_reset FROM pg_stat_statements_info;
```

How to read them:

- **Total time** (query 1) is the best first sort: a 2 ms query called 5 million times can matter more than a 30-second report [55]. The `pct_total` column tells you how much you can gain at most.
- **Rows per call** in the thousands for an OLTP query often means a missing `LIMIT` or filtering in the application.
- **Max far above mean** (query 2) means value-sensitive plans, lock waits, or cold cache. Check plans with real values and `log_lock_waits`.
- I/O time columns need `track_io_timing`. They are named `blk_read_time` / `blk_write_time` in PG 14–16 and `shared_blk_read_time` / `shared_blk_write_time` since PG 17 [5]. `temp_blk_read_time` / `temp_blk_write_time` exist since PG 15 [7].
- `dealloc` growing means entries are being evicted: raise `pg_stat_statements.max` [22].

### 9.3 Reset and snapshot strategy

Counters accumulate from the last reset. Two ways to look at a time window:

- **Reset** after a deploy or a fix: `SELECT pg_stat_statements_reset();` (superuser by default; can be granted) [22]. One statement: `pg_stat_statements_reset(0, 0, <queryid>)`. Only min/max values (PG 17+): `pg_stat_statements_reset(0, 0, 0, true)` [5][22].
- **Snapshots** (better: keeps history and does not disturb other users of the view):

```sql
CREATE TABLE IF NOT EXISTS pgss_snapshot AS
SELECT now() AS taken_at, userid, dbid, toplevel, queryid,
       calls, total_exec_time, rows, shared_blks_read, temp_blks_written
FROM pg_stat_statements
WITH NO DATA;

-- run periodically (cron, pg_cron, or your job runner)
INSERT INTO pgss_snapshot
SELECT now(), userid, dbid, toplevel, queryid,
       calls, total_exec_time, rows, shared_blks_read, temp_blks_written
FROM pg_stat_statements;

-- what happened since the last snapshot
SELECT s.queryid,
       left(s.query, 80)                                          AS query,
       s.calls - p.calls                                          AS calls,
       round((s.total_exec_time - p.total_exec_time)::numeric)    AS exec_ms,
       round(((s.total_exec_time - p.total_exec_time)
              / nullif(s.calls - p.calls, 0))::numeric, 2)        AS mean_ms
FROM pg_stat_statements s
JOIN pgss_snapshot p USING (userid, dbid, toplevel, queryid)
WHERE p.taken_at = (SELECT max(taken_at) FROM pgss_snapshot)
ORDER BY exec_ms DESC
LIMIT 20;
```

If an entry was evicted and re-created between snapshots, the delta is wrong; since PG 17 the `stats_since` column shows when an entry started [5][22]. `queryid` is stable across minor versions on the same platform, but not across major versions [22].

### 9.4 Slow-query logging

```ini
log_min_duration_statement = '250ms'  # default -1 (off); logs statement text and duration
log_temp_files = '10MB'               # default -1 (off); logs temp files above this size
log_lock_waits = on                   # default off; logs waits longer than deadlock_timeout
```

Defaults from [43]. For busy servers, `log_min_duration_sample` with `log_statement_sample_rate` logs only a fraction of statements above a lower threshold [43]. With the extended protocol, Parse, Bind, and Execute durations are logged separately [43].

### 9.5 auto_explain: real plans from production

`auto_explain` logs the plan of every statement slower than a threshold. It does nothing until `auto_explain.log_min_duration` is set (default `-1`) [23].

```ini
# postgresql.conf
shared_preload_libraries = 'pg_stat_statements,auto_explain'
auto_explain.log_min_duration = '1s'      # start high, lower it later
auto_explain.log_analyze = on             # actual rows and loops in the logged plan
auto_explain.log_buffers = on             # default off, also in PG 18
auto_explain.log_timing = off             # per-node timing is the costly part
auto_explain.log_triggers = on
auto_explain.log_verbose = on
auto_explain.log_nested_statements = on   # statements inside functions
auto_explain.log_format = 'json'          # for tools; 'text' is easier to read by eye
auto_explain.sample_rate = 1              # lower it (0.1) on very busy servers
```

This matches pganalyze's recommended starting point [59]. The docs warn that with `log_analyze` on, per-node instrumentation runs for **all** statements, not only the logged ones, which can hurt performance; `log_timing = off` removes most of the clock overhead and keeps row counts [23]. To try it in one session: `LOAD 'auto_explain'; SET auto_explain.log_min_duration = 0;` (superuser) [23].

Privacy: since PG 16, auto_explain can log parameter values (`auto_explain.log_parameter_max_length`, default `-1` = full values) [6][23]. Set it to `0` if parameters contain personal data.

### 9.6 Reproduce before you fix

- **Volume and skew matter.** Plans on toy tables do not predict plans on large ones; on a one-page table you almost always get a sequential scan [2]. Use a recent, anonymized copy of production, or generate data with realistic size and skew (section 11.1).
- **Same version and settings.** Compare `EXPLAIN (SETTINGS)` output on both systems; differences in `work_mem`, `random_page_cost`, or `jit` change plans.
- **Same statistics.** Run `ANALYZE` on the copy; compare `pg_stats` for the columns in the query.
- **Same parameters and plan type.** Use the values from the slow log. If the application uses prepared statements, check both the custom plan and the generic plan (`EXPLAIN (GENERIC_PLAN)`, PG 16+).
- **Know the cache state.** Run twice and say which run you report (section 11.2).

---

## 10. Plan visualization and analysis tools

| Tool | What it does | Cost | Use it when |
|---|---|---|---|
| **explain.depesz.com** | Paste a text plan. Shows exclusive and inclusive time per node, the "rows x" misestimate factor with an arrow (↓ underestimate, ↑ overestimate), and colors the worst nodes [62]. Plans can be kept off the public history, and an obfuscation option anonymizes names before saving [63]. | Free | Quick triage of a text plan; sharing a link in a code review. |
| **explain.dalibo.com (PEV2)** | Graphical tree of a text or JSON plan. PEV2 is open source (PostgreSQL license); you can download a single `pev2.html` file and use it offline, or embed the Vue component [64]. | Free | Visual reading of big plans; sensitive plans (offline file). |
| **pgMustard** | Upload a text or JSON plan (PG 9.6–18); gets tips scored by estimated time saving: bad estimates, index problems, heap fetches, JIT, spills [65]. | Paid, with a free trial [65] | You know the slow query and want concrete advice on what to change. |
| **pganalyze** | Hosted monitoring: query statistics history from `pg_stat_statements`, plans collected from `auto_explain` logs, plan comparison, and automatic insights (disk sorts, hash batches, lossy bitmaps, large offsets, misestimates, stale statistics) [58][59]. | Paid | Continuous production monitoring and regression tracking. |

Plans contain table names, column names, and literal values. Before you paste a plan on a public site, remove sensitive values or use an offline tool.

---

## 11. Benchmarking

### 11.1 Realistic data with generate_series

Real data is skewed: a few customers have most orders, most rows are recent, some statuses are rare. Uniform test data hides the plans that hurt in production.

```sql
-- Assumes users(id bigint PRIMARY KEY, email text, created_at timestamptz)
-- and orders(id bigint GENERATED BY DEFAULT AS IDENTITY, user_id, status, carrier, total_cents, created_at).
-- 1 million users, 10 million orders, skewed: a few users own many orders
INSERT INTO users (id, email, created_at)
SELECT g, 'user' || g || '@example.com', now() - random() * interval '3 years'
FROM generate_series(1, 1000000) AS g;

INSERT INTO orders (user_id, status, carrier, total_cents, created_at)
SELECT 1 + floor(1000000 * random() ^ 3)::bigint,        -- power-law: low ids get many orders
       (ARRAY['paid','paid','paid','shipped','refunded'])[1 + floor(random() * 5)::int],
       (ARRAY['ups','ups','fedex','dhl'])[1 + floor(random() * 4)::int],
       (random() * 50000)::int,
       now() - random() * interval '3 years'
FROM generate_series(1, 10000000);

ANALYZE users, orders;   -- always, after a bulk load
```

Then check that the distribution looks like production (`pg_stats.most_common_freqs`, a few `GROUP BY` counts).

### 11.2 Cache state: warm or cold

- The first run of a query reads pages from disk (`shared read`); the next runs find them in cache (`shared hit`). Report which one you measure.
- For "typical production" numbers, warm the cache (run 2–3 times, then measure). For worst-case numbers, measure a cold cache, but cold means both PostgreSQL's cache and the OS page cache are empty, which needs a restart plus an OS cache drop.
- Compare **buffers** first: `hit + read` is the work done and changes little between runs; time changes with cache state, CPU load, and the machine.
- Use `EXPLAIN (ANALYZE, TIMING OFF)` when you repeat a measurement many times: you keep exact row counts without the per-node clock overhead [1][2].

### 11.3 pgbench with a custom script

`pgbench` runs SQL scripts from many concurrent clients and reports throughput and latency [42].

```text
-- bench_orders.sql
\set user_id random_zipfian(1, 1000000, 1.1)
SELECT id, total_cents, created_at
FROM orders
WHERE user_id = :user_id
ORDER BY created_at DESC
LIMIT 20;
```

```bash
# -n: no vacuum of pgbench's own tables   -f: custom script   -c/-j: clients/threads
# -T: seconds   -P: progress every N seconds   -r: per-statement latencies
pgbench -n -f bench_orders.sql -M extended -c 16 -j 4 -T 300 -P 10 -r appdb
```

- `-M extended` uses the unnamed statement on each call (like node-postgres without `name`); `-M prepared` uses named prepared statements, so the generic-plan switch after five executions applies (section 6) [42]. Benchmark the mode your application uses.
- `random_zipfian`, `random_exponential`, and `random_gaussian` give skewed parameter values; `random` is uniform [42].
- The docs' good practices: run for minutes, not seconds; repeat runs and check they agree; watch for autovacuum and dead rows changing results over time; run pgbench on a different machine than the server if the client becomes the bottleneck [42].

### 11.4 Compare fairly

- Change one thing between runs (one index, one setting, one rewrite).
- Run each variant several times; report the median and a high percentile, not the best run.
- Record the plan, buffers, settings, and PostgreSQL version with each result.
- After deploying, confirm in `pg_stat_statements` that `mean_exec_time` and `shared_blks_read` per call went down in production (section 9.3).

---

## 12. Optimization checklist

**Find**
- [ ] `pg_stat_statements` is installed; you sorted by total time, mean time, reads, and temp usage (9.2).
- [ ] `auto_explain` or the slow log gave you the real plan and the real parameter values (9.4–9.5).

**Explain**
- [ ] You ran `EXPLAIN (ANALYZE, BUFFERS)` (PG 18: `BUFFERS` is implicit) on production-like data, inside `BEGIN … ROLLBACK` for writes (2.3, 9.6).
- [ ] You found the node with the most exclusive time, multiplying per-loop values by `loops` (3.1).
- [ ] You compared estimated and actual rows at every node and found the lowest big misestimate (5.1).
- [ ] You checked `Rows Removed by Filter`, `Heap Fetches`, `lossy` blocks, sort/hash spills, `Workers Launched`, and the JIT block (3–4, 7).
- [ ] For prepared statements, you checked both the custom and the generic plan (2.4, 6).

**Fix**
- [ ] Statistics first: `ANALYZE`, per-column statistics target, `CREATE STATISTICS`, `n_distinct` override (5).
- [ ] Predicates are sargable and types match: no function or cast on indexed columns (7.2, 7.17).
- [ ] The right index exists for "equality columns, then range or sort column" ([05](05-indexing.md)).
- [ ] No per-row SubPlan, no `NOT IN (subquery)`, no unwanted CTE fence, no cross-table `OR` (7.7–7.9).
- [ ] Keyset pagination instead of deep `OFFSET`; `= ANY($1)` instead of huge `IN` lists; `EXISTS` instead of `count(*) > 0` (7.3, 7.10, 7.11).
- [ ] Settings changed only in a narrow scope (`SET LOCAL`, role, database), never `enable_*` in production (8.6, 8.7).
- [ ] JIT is off for OLTP or its cost threshold is raised (7.15).

**Verify**
- [ ] One change at a time; plan, buffers, and time compared before and after (11.4).
- [ ] Load-tested with `pgbench` if the query is hot, using the application's protocol mode (11.3).
- [ ] After release, `pg_stat_statements` shows the improvement and no new regression (9.3).

**Further reading:** the book *PostgreSQL Query Optimization* by Henrietta Dombrovskaya, Boris Novikov and Anna Bailliekova (Apress) covers the planner and query rewriting in depth; more books and courses in [14-learning-resources.md](14-learning-resources.md).

---

## Sources

1. [EXPLAIN](https://www.postgresql.org/docs/current/sql-explain.html) — PostgreSQL 18 docs: options, defaults, BUFFERS implied by ANALYZE, ANALYZE executes the statement.
2. [Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) — PostgreSQL 18 docs: cost math, per-loop values, buffers, Index Searches, Disabled nodes, caveats, Subplans Removed.
3. [Query Planning](https://www.postgresql.org/docs/current/runtime-config-query.html) — PostgreSQL 18 docs: cost constants, enable_* list, collapse limits, GEQO threshold, plan_cache_mode, JIT thresholds.
4. [PostgreSQL 18 release notes](https://www.postgresql.org/docs/18/release-18.html) — EXPLAIN changes, OR-to-array, IN (VALUES) conversion, skip scan, pg_stat_statements changes, AIO, io concurrency defaults, statistics in pg_upgrade.
5. [PostgreSQL 17 release notes](https://www.postgresql.org/docs/17/release-17.html) — SERIALIZE, MEMORY, IN-list B-tree improvement, correlated IN to join, pg_stat_statements column renames and minmax reset.
6. [PostgreSQL 16 release notes](https://www.postgresql.org/docs/16/release-16.html) — GENERIC_PLAN, enable_presorted_aggregate, auto_explain parameter logging.
7. [PostgreSQL 15 release notes](https://www.postgresql.org/docs/15/release-15.html) — hash_mem_multiplier default 2.0, window function run condition, temp I/O and JIT counters.
8. [PostgreSQL 14 release notes](https://www.postgresql.org/docs/14/release-14.html) — Memoize, expression statistics, compute_query_id, hashed IN lists, TID range scans.
9. [PostgreSQL 19 release notes (beta)](https://www.postgresql.org/docs/19/release-19.html) — pg_plan_advice, pg_stash_advice, EXPLAIN IO, Memoize estimates, JIT off by default, NOT IN anti-join, plan counts in pg_stat_statements.
10. [PostgreSQL 19 Beta 4 Released](https://www.postgresql.org/about/news/postgresql-19-beta-4-released-3386/) — postgresql.org: reverted features list; pg_plan_advice still present (fixed) in beta 4.
11. [pg_plan_advice](https://www.postgresql.org/docs/19/pgplanadvice.html) — PostgreSQL 19 beta docs: advice syntax, EXPLAIN (PLAN_ADVICE), feedback, limitations.
12. [Statistics Used by the Planner](https://www.postgresql.org/docs/current/planner-stats.html) — PostgreSQL docs: reltuples scaling, statistics target, extended statistics kinds and limits.
13. [pg_stats](https://www.postgresql.org/docs/current/view-pg-stats.html) — PostgreSQL docs: meaning of n_distinct, MCVs, histogram, correlation.
14. [CREATE STATISTICS](https://www.postgresql.org/docs/current/sql-createstatistics.html) — PostgreSQL docs: syntax, kinds, expression statistics, misestimate examples.
15. [ANALYZE](https://www.postgresql.org/docs/current/sql-analyze.html) — PostgreSQL docs: sampling, partitioned tables, n_distinct override.
16. [analyze.c](https://raw.githubusercontent.com/postgres/postgres/master/src/backend/commands/analyze.c) — PostgreSQL source: sample size of 300 × statistics target.
17. [Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html) — PostgreSQL docs: auto-analyze threshold formula, partitioned and temporary tables, expression statistics advice.
18. [Vacuuming settings](https://www.postgresql.org/docs/current/runtime-config-vacuum.html) — PostgreSQL 18 docs: autovacuum_analyze_threshold 50, scale factor 0.1.
19. [PREPARE](https://www.postgresql.org/docs/current/sql-prepare.html) — PostgreSQL docs: five custom plans heuristic, generic plans, re-planning triggers.
20. [Message Flow](https://www.postgresql.org/docs/current/protocol-flow.html) — PostgreSQL docs: unnamed statement lifetime, planning at Bind, plan reuse.
21. [pg_prepared_statements](https://www.postgresql.org/docs/current/view-pg-prepared-statements.html) — PostgreSQL docs: generic_plans and custom_plans columns.
22. [pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html) — PostgreSQL 18 docs: setup, columns, settings, reset, normalization, list squashing, queryid stability.
23. [auto_explain](https://www.postgresql.org/docs/current/auto-explain.html) — PostgreSQL docs: parameters, defaults, overhead warnings.
24. [Resource Consumption](https://www.postgresql.org/docs/current/runtime-config-resource.html) — PostgreSQL 18 docs: work_mem, hash_mem_multiplier, effective_io_concurrency, io_method, worker limits.
25. [Resource Consumption (PG 14)](https://www.postgresql.org/docs/14/runtime-config-resource.html) — PostgreSQL 14 docs: hash_mem_multiplier 1.0, effective_io_concurrency 1.
26. [Query Planning (PG 17)](https://www.postgresql.org/docs/17/runtime-config-query.html) — PostgreSQL 17 docs: current random_page_cost and effective_cache_size text.
27. [doc: suggest 1.1 as a random_page_cost value for SSDs](https://www.postgresql.org/message-id/E1jbvYS-0005lZ-Vd%40gemulon.postgresql.org) — pgsql-committers, Bruce Momjian, 2020: the former SSD suggestion.
28. [Should we update the random_page_cost default value?](https://www.postgresql.org/message-id/80d8b470-50fe-40df-b692-3292dd015595%40vondra.me) — pgsql-hackers, Tomas Vondra, 2025-10-06: SSD measurements of 20–50.
29. [The real cost of random I/O](https://vondra.me/posts/the-real-cost-of-random-io/) — Tomas Vondra: measured random_page_cost, advice to monitor before tuning.
30. [Better PostgreSQL performance on SSDs](https://www.cybertec-postgresql.com/en/better-postgresql-performance-on-ssds/) — Cybertec, Hans-Jürgen Schönig, 2013: random_page_cost close to 1 on SSDs.
31. [Controlling the Planner with Explicit JOIN Clauses](https://www.postgresql.org/docs/current/explicit-joins.html) — PostgreSQL docs: join order growth, collapse limits.
32. [Genetic Query Optimization](https://www.postgresql.org/docs/current/geqo-pg-intro.html) — PostgreSQL docs: GEQO method, determinism with geqo_seed.
33. [The Path of a Query](https://www.postgresql.org/docs/current/query-path.html) — PostgreSQL docs: parser, rewriter, planner, executor.
34. [Planner/Optimizer](https://www.postgresql.org/docs/current/planner-optimizer.html) — PostgreSQL docs: paths, join strategies.
35. [WITH Queries](https://www.postgresql.org/docs/current/queries-with.html) — PostgreSQL docs: CTE inlining rules, MATERIALIZED / NOT MATERIALIZED.
36. [Function Volatility Categories](https://www.postgresql.org/docs/current/xfunc-volatility.html) — PostgreSQL docs: VOLATILE / STABLE / IMMUTABLE effects.
37. [Inlining of SQL functions](https://wiki.postgresql.org/wiki/Inlining_of_SQL_functions) — PostgreSQL wiki: inlining conditions.
38. [When to JIT?](https://www.postgresql.org/docs/current/jit-decision.html) — PostgreSQL docs: JIT thresholds, overhead on short queries, decision at plan time.
39. [When Can Parallel Query Be Used?](https://www.postgresql.org/docs/current/when-can-parallel-query-be-used.html) — PostgreSQL docs: conditions that prevent parallel plans or workers.
40. [How Parallel Query Works](https://www.postgresql.org/docs/current/how-parallel-query-works.html) — PostgreSQL docs: Gather, Gather Merge, worker limits.
41. [Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) — PostgreSQL docs: partition pruning at plan and run time, partition count advice.
42. [pgbench](https://www.postgresql.org/docs/current/pgbench.html) — PostgreSQL docs: options, custom scripts, random functions, good practices.
43. [Error Reporting and Logging](https://www.postgresql.org/docs/current/runtime-config-logging.html) — PostgreSQL docs: log_min_duration_statement, sampling, log_temp_files, log_lock_waits.
44. [Run-time Statistics](https://www.postgresql.org/docs/current/runtime-config-statistics.html) — PostgreSQL docs: track_io_timing, compute_query_id.
45. [SET](https://www.postgresql.org/docs/current/sql-set.html) — PostgreSQL docs: SET LOCAL, set_config.
46. [pg_class](https://www.postgresql.org/docs/current/catalog-pg-class.html) — PostgreSQL docs: reltuples, -1 for never analyzed.
47. [Message Formats](https://www.postgresql.org/docs/current/protocol-message-formats.html) — PostgreSQL docs: 16-bit parameter count in Parse and Bind.
48. [Count estimate](https://wiki.postgresql.org/wiki/Count_estimate) — PostgreSQL wiki: why count(*) is slow, estimate queries.
49. [PostgreSQL count(*) made fast](https://www.cybertec-postgresql.com/en/postgresql-count-made-fast/) — Cybertec, Laurenz Albe: count(*) vs count(1), estimates, counter tables.
50. [EXPLAIN (GENERIC_PLAN) in PostgreSQL 16](https://www.cybertec-postgresql.com/en/explain-generic-plan-postgresql-16/) — Cybertec, Laurenz Albe: usage and type casts.
51. [EXPLAIN that parameterized statement](https://www.cybertec-postgresql.com/en/explain-that-parameterized-statement/) — Cybertec, Laurenz Albe: pre-PG 16 workaround.
52. [Avoiding "OR" for better query performance](https://www.cybertec-postgresql.com/en/avoid-or-for-better-performance/) — Cybertec, Laurenz Albe: OR rewrites, UNION.
53. [Subqueries and performance in PostgreSQL](https://www.cybertec-postgresql.com/en/subqueries-and-performance-in-postgresql/) — Cybertec, Laurenz Albe: SubPlans, NOT IN vs NOT EXISTS.
54. [Join strategies and performance in PostgreSQL](https://www.cybertec-postgresql.com/en/join-strategies-and-performance-in-postgresql/) — Cybertec, Laurenz Albe: nested loop, hash, merge joins.
55. [pg_stat_statements: the way I like it](https://www.cybertec-postgresql.com/en/pg_stat_statements-the-way-i-like-it/) — Cybertec, Hans-Jürgen Schönig: top-down analysis by total time.
56. [Postgres Planner Quirks: ORDER BY + LIMIT](https://pganalyze.com/blog/5mins-postgres-planner-order-by-limit) — pganalyze: the LIMIT index trap and fixes.
57. [Improved EXPLAIN for SubPlan nodes](https://pganalyze.com/blog/5mins-postgres-17-explain-subplan) — pganalyze: PG 17 InitPlan/SubPlan display.
58. [EXPLAIN plans](https://pganalyze.com/docs/explain) — pganalyze docs: plan collection and insight categories.
59. [Review auto_explain settings](https://pganalyze.com/docs/explain/setup/self_managed/03_review_settings) — pganalyze docs: recommended auto_explain configuration.
60. [Explaining the unexplainable](https://www.depesz.com/2013/04/16/explaining-the-unexplainable/) — depesz: reading plan trees, cost units, loops.
61. [Explaining the unexplainable, part 4](https://www.depesz.com/2013/05/19/explaining-the-unexplainable-part-4/) — depesz: InitPlan vs SubPlan and other nodes.
62. [explain.depesz.com help](https://explain.depesz.com/help) — depesz: exclusive/inclusive time, rows x, color thresholds.
63. [explain.depesz.com](https://explain.depesz.com/) — depesz: plan upload, privacy and obfuscation options.
64. [PEV2](https://github.com/dalibo/pev2) — Dalibo: open-source plan visualizer, offline single file.
65. [pgMustard](https://www.pgmustard.com/) — pgMustard: features, supported versions, pricing model.
66. [EXPLAIN glossary](https://www.pgmustard.com/docs/explain) — pgMustard: node and field reference.
67. [Memoize](https://www.pgmustard.com/docs/explain/memoize) — pgMustard: Memoize fields and when it backfires.
68. [Bitmap Heap Scan](https://www.pgmustard.com/docs/explain/bitmap-heap-scan) — pgMustard: exact vs lossy blocks, recheck.
69. [Index Only Scan](https://www.pgmustard.com/docs/explain/index-only-scan) — pgMustard: heap fetches and the visibility map.
70. [HashAggregate](https://www.pgmustard.com/docs/explain/hash-aggregate) — pgMustard: spill fields, HashAggregate vs GroupAggregate.
71. [SERIALIZE](https://www.pgmustard.com/docs/explain/serialize) — pgMustard: SERIALIZE output format (PG 17+).
72. [MEMORY](https://www.pgmustard.com/docs/explain/memory-parameter) — pgMustard: MEMORY output format (PG 17+).
73. [Configuring work_mem](https://www.pgmustard.com/blog/work-mem) — pgMustard: work_mem per session/server, hash_mem_multiplier.
74. [PgBouncer configuration](https://www.pgbouncer.org/config.html) — PgBouncer docs: max_prepared_statements, SQL-level PREPARE not tracked.
75. [PgBouncer changelog](https://www.pgbouncer.org/changelog.html) — PgBouncer: prepared statements in 1.21.0, default 200 in 1.24.0.
76. [node-postgres: Queries](https://node-postgres.com/features/queries) — node-postgres docs: parameterized queries, named prepared statements per connection.
77. [pg_hint_plan releases](https://github.com/ossc-db/pg_hint_plan/releases) — ossc-db: releases for PG 13–18.
78. [Obfuscated conditions: dates](https://use-the-index-luke.com/sql/where-clause/obfuscation/dates) — Use The Index, Luke (Markus Winand): functions on columns, range rewrites.
79. [Obfuscated conditions: numeric strings](https://use-the-index-luke.com/sql/where-clause/obfuscation/numeric-strings) — Use The Index, Luke: implicit conversion; PostgreSQL rejects text = number.
80. [No offset](https://use-the-index-luke.com/no-offset) — Use The Index, Luke: why OFFSET is slow, keyset pagination.
81. [Postgres Query Boost: Using ANY Instead of IN](https://www.crunchydata.com/blog/postgres-query-boost-using-any-instead-of-in) — Crunchy Data: = ANY($1) with one array parameter.
82. [pg_prepared_statements (PG 14)](https://www.postgresql.org/docs/14/view-pg-prepared-statements.html) — PostgreSQL 14 docs: generic_plans/custom_plans already present.
83. [pg_hint_plan](https://github.com/ossc-db/pg_hint_plan) — ossc-db: hint comment syntax.
84. [CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html) — PostgreSQL docs: default VOLATILE and PARALLEL UNSAFE, COST and ROWS defaults.
85. [Row Estimation Examples](https://www.postgresql.org/docs/current/row-estimation-examples.html) — PostgreSQL docs: MCV and histogram selectivity formulas, independence assumption.
