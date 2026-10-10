# Indexing in PostgreSQL

> Part of the [SQL & PostgreSQL reference library](README.md) · Last researched: 2026-10-05 · Targets PostgreSQL 14–18 (19 beta noted where relevant)

**What this covers.** How PostgreSQL indexes work, when the planner uses them, every built-in index type, and how to design, build, check and remove indexes safely on a live database. Full-text and vector indexes get one short subsection each; the details live in [full-text and vector search](12-full-text-and-vector-search.md). Reading plans and the `pg_stat_statements` workflow live in [query optimization](06-query-optimization-and-explain.md). Keyset pagination, upserts and query rewrites ("sargable" predicates) live in [query patterns](04-query-patterns-and-antipatterns.md).

## Key rules (TL;DR)

1. Design indexes from real, frequent queries (`pg_stat_statements` + `EXPLAIN (ANALYZE, BUFFERS)`), not from a list of columns.
2. Every index slows down every `INSERT`, most `UPDATE`s and every `VACUUM`; add one only when a frequent or critical query needs it.
3. Avoid indexing a column that changes on almost every update (`updated_at`, counters): it blocks HOT updates for the whole table.
4. Use B-tree by default; choose another type only for a specific operator (`@>`, `&&`, `<->`, `@@`) or data shape.
5. In a multicolumn B-tree, put equality columns first and the range or sort column last; "most selective column first" is a myth.
6. Keep the indexed column "naked" in `WHERE`: no function, cast or arithmetic on it, unless an expression index uses exactly the same expression.
7. For `WHERE a = $1 ORDER BY b LIMIT n`, create an index on `(a, b)`; an index on `b` alone can make the planner read most of the table (the LIMIT trap).
8. Use partial indexes for hot subsets (pending jobs, non-deleted rows) and partial unique indexes for rules like "one active row per user".
9. Write a partial-index condition as a literal in the query (`status = 'pending'`), never as a bind parameter.
10. Use `INCLUDE` (PG 11+) for index-only scans on frequent, narrow queries, and keep the table vacuumed so `Heap Fetches` stays near zero.
11. Index the referencing columns of a foreign key when you delete or update parent rows or join on them; PostgreSQL does not do it for you.
12. Use GIN for `jsonb` containment, arrays, full text and trigram search; use a B-tree expression index for equality on one `jsonb` key.
13. Use GiST for ranges, geometry, nearest-neighbor `ORDER BY ... <->` and exclusion constraints.
14. Use BRIN only on very large, append-only tables whose column follows the physical row order.
15. On a live table, always use `CREATE INDEX CONCURRENTLY` outside a transaction block; after a failure, drop the `INVALID` index and retry.
16. Rebuild bloated or corrupted indexes with `REINDEX INDEX CONCURRENTLY` (PG 12+); drop indexes with `DROP INDEX CONCURRENTLY`.
17. On partitioned tables, use `CREATE INDEX ... ON ONLY`, then `CREATE INDEX CONCURRENTLY` on each partition, then `ALTER INDEX ... ATTACH PARTITION`.
18. Before you drop an "unused" index, check `idx_scan` on the primary and on every replica, the last statistics reset, and whether the index backs a constraint.
19. Remove duplicate and left-prefix-redundant indexes; keep busy tables to about 15 indexes or fewer (GitLab's limit) to protect writes and lock performance.
20. Use `text_pattern_ops` (or `COLLATE "C"`) for `LIKE 'prefix%'`; use a `pg_trgm` GIN index for `LIKE '%infix%'` and `ILIKE`.
21. Mark a function `IMMUTABLE` only if it truly is; `timestamptz::date` depends on the session time zone and cannot be indexed.
22. PG 18 skip scan helps only when the skipped leading column has few distinct values; it is not a reason to drop an index you need.
23. Test a candidate index with HypoPG and plain `EXPLAIN` before you build it; confirm it afterwards with `EXPLAIN (ANALYZE, BUFFERS)` and `pg_stat_user_indexes`.

## Example schema used in this document

The examples use these tables (some sections add a small table of their own).

```sql
CREATE TABLE users (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   bigint      NOT NULL,
    email       text        NOT NULL,
    status      text        NOT NULL DEFAULT 'active',
    deleted_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      bigint      NOT NULL REFERENCES users (id),
    status       text        NOT NULL,
    total_cents  bigint      NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   bigint      NOT NULL,
    title       text        NOT NULL,
    tags        text[]      NOT NULL DEFAULT '{}',
    metadata    jsonb       NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chunks (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id  bigint NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    content      text   NOT NULL
);

CREATE TABLE jobs (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    queue    text        NOT NULL,
    status   text        NOT NULL DEFAULT 'pending',  -- pending, running, done, failed
    run_at   timestamptz NOT NULL DEFAULT now(),
    payload  jsonb       NOT NULL
);

CREATE TABLE events (            -- append-only log: rows are inserted, never updated
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at  timestamptz NOT NULL DEFAULT now(),
    request_id  uuid,
    kind        text        NOT NULL,
    payload     jsonb
);

CREATE TABLE pages (             -- crawled web pages with long URLs
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    url   text NOT NULL,
    body  text
);
```

**Terms used below.** *Selectivity*: the fraction of rows a condition keeps (high selectivity = few rows). *Cardinality*: the number of distinct values in a column. *Predicate*: a `WHERE` condition. *Operator class* (opclass): the rules an index uses for one data type. *Collation*: the rules for sorting and comparing text. *Planner*: the part of PostgreSQL that chooses how to run a query.

## 1. How indexes work

### 1.1 Heap, index and TID

- A PostgreSQL table is a **heap**: an unordered set of pages (8 kB each by default). A new row goes wherever there is free space. The primary key does not decide where rows are stored.
- Each row version has a **TID** (tuple identifier): the page number plus the position inside the page. You can see it as the hidden column `ctid`.
- An index is a separate file. Each index entry holds a key value and the TID of a heap row. So every PostgreSQL index is a "secondary" index: finding a row means "search the index, then fetch the heap page".
- Index entries do not store visibility information. Because of MVCC (several versions of the same row can exist, see [transactions and concurrency](08-transactions-concurrency-locking.md)), the executor must check the heap, or the visibility map, to know if a row version is visible to your transaction [8].

### 1.2 The B-tree structure

B-tree is the default index type. It is a **balanced** tree: the distance from the root to every leaf is the same [60].

- **Root and internal pages** (also called branch pages) guide the search.
- **Leaf pages** hold the sorted entries (key + TID). Leaf pages are linked to their neighbors, so a range scan walks sideways from leaf to leaf [60].
- Depth grows very slowly: "Real world indexes with millions of records have a tree depth of four or five" [60]. You can see the depth with `pgstatindex()` (column `tree_level`) [43].
- By default, entries are stored in ascending order with `NULL`s last, and equal keys are ordered by TID. A forward scan of an index on `x` therefore returns `ORDER BY x ASC NULLS LAST` [3]. B-tree indexes store `NULL` values and support `IS NULL` / `IS NOT NULL` [1].

### 1.3 The four ways to read a table

The planner chooses one of these access methods for each table in a query. It compares estimated costs; there is no fixed "use the index below X %" rule [65][72].

| Plan node | What it does | Usually chosen when |
|---|---|---|
| `Seq Scan` | Reads every page of the table in physical order. | Many rows match, the table is small, or no index fits the condition. |
| `Index Scan` | Walks the index, then fetches each matching row from the heap by TID (random reads). Returns rows in index order. | Few rows match, or the query needs the index order (`ORDER BY ... LIMIT`). |
| `Index Only Scan` | Answers from the index alone. Visits the heap only for pages that are not marked "all-visible". | All columns the query uses are in the index, and the table is well vacuumed. |
| `Bitmap Index Scan` + `Bitmap Heap Scan` | Collects matching TIDs from one or more indexes into an in-memory bitmap, then reads heap pages in physical order, each page once. | A medium number of rows, or several indexes combined with `BitmapAnd` / `BitmapOr`. |

What drives the choice:

- **Estimated row count**, from table statistics. Wrong estimates are the most common cause of a wrong choice; see [query optimization](06-query-optimization-and-explain.md).
- **Correlation** between index order and physical row order (`pg_stats.correlation`). Near +1 or -1, an index scan reads fewer pages and is estimated cheaper [30].
- **Cost settings**: `random_page_cost` (default 4.0) versus `seq_page_cost` (default 1.0), and `effective_cache_size` (default 4GB) [31]. Tuning them is covered in [operations](09-operations-and-server-tuning.md).

A bitmap scan loses the index order, so an `ORDER BY` needs an extra `Sort` step [4]. The plan shows `Recheck Cond`: rows are re-checked against the condition when the bitmap became "lossy" (it stores whole pages instead of single rows when it does not fit in `work_mem`) or when the index itself is lossy (BRIN, some GIN and GiST cases) [21][27].

### 1.4 The visibility map and index-only scans

PostgreSQL keeps one bit per heap page in the **visibility map**: "all rows on this page are visible to every transaction". `VACUUM` sets these bits. An index-only scan checks the bit for each row it finds: if the bit is set, it returns the row from the index; if not, it must visit the heap page [8]. The visibility map is "four orders of magnitude smaller than the heap", so checking it is cheap [8].

- `EXPLAIN ANALYZE` shows `Heap Fetches: N` on an `Index Only Scan`. A high number means many pages are not all-visible: vacuum the table more often [27].
- Since PG 13, inserts also trigger autovacuum (`autovacuum_vacuum_insert_threshold`, `autovacuum_vacuum_insert_scale_factor`). This sets visibility bits on append-only tables and helps index-only scans there [48].

### 1.5 Every index has a write cost

Indexes make reads faster and writes slower. This is called **write amplification**: one logical change causes several physical writes.

- **`INSERT`**: one new entry in every index of the table.
- **`UPDATE`** that is not HOT (see below): one new entry in *every* index, including indexes whose columns did not change. The B-tree documentation says: changing one column "always necessitates a new set of index tuples — one for each and every index on the table" [16].
- **`DELETE`**: nothing happens in the indexes at once, but `VACUUM` must later remove the dead entries from every index.
- Every index change is also written to the **WAL** (write-ahead log), so more indexes mean more WAL and more replication traffic. Indexes take disk space (often as much as the data) and make backups bigger [68], and they compete with table data for memory (cache).

A benchmark by Percona on PostgreSQL 17.4 (mixed `INSERT`/`UPDATE`/`SELECT` workload, 128-core server) measured about 1,400 transactions per second with 7 indexes and about 600 with 39 indexes; average latency went from 11 ms to 26 ms [75]. Your numbers will differ; the direction will not.

### 1.6 HOT updates: why indexing an updated column hurts

A **HOT update** (Heap-Only Tuple) writes the new row version on the same heap page and adds **no** index entries. Old versions on that page can later be pruned without `VACUUM` [26]. HOT is possible only when both conditions are true [26]:

1. The update changes **no column used by any index** (BRIN indexes are an exception since PG 16, because they only summarize page ranges [52][26]).
2. The page that holds the old row has **enough free space** for the new version.

```sql
-- Bad: every "touch" update sets updated_at, so no update of orders can be HOT anymore
CREATE INDEX orders_updated_at_idx ON orders (updated_at);

-- Good: keep update-heavy columns out of indexes unless a real query needs them,
-- and leave free space in each page for HOT updates on update-heavy tables
ALTER TABLE jobs SET (fillfactor = 80);
-- From now on, inserts fill pages only up to 80 %; rows already stored move only when the table is rewritten.
```

Check the HOT ratio per table. If `hot_pct` is low on an update-heavy table, look for indexes on frequently updated columns [66]:

```sql
SELECT relname,
       n_tup_upd,
       n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) AS hot_pct
FROM pg_stat_user_tables
WHERE n_tup_upd > 0
ORDER BY n_tup_upd DESC
LIMIT 20;
```

PG 16+ also has `n_tup_newpage_upd`: updates whose new version had to go to another page (often because the page was full) [52].

## 2. When an index is not used

Most "PostgreSQL ignores my index" reports have one of these causes. The query-side fixes are covered in detail in *Sargable predicates* (conditions written so that an index can be used) in [query patterns](04-query-patterns-and-antipatterns.md); statistics and generic plans in [query optimization](06-query-optimization-and-explain.md).

| Cause | Example | Fix |
|---|---|---|
| Low selectivity (the condition matches many rows) | `WHERE status = 'active'` when 95 % of rows are active | Nothing: a seq scan is faster. Index only the rare values with a partial index. |
| Small table | A table that fits in a few pages | Nothing: "no plan can beat sequentially fetching 1 disk page" [11]. |
| Function, cast or arithmetic on the column | `lower(email) = $1`, `created_at::date = $1`, `id::text = $1`, `total_cents / 100 > 50` | Rewrite as a condition on the raw column, or create an expression index with the same expression. |
| Type mismatch | `WHERE user_id = 42.5` on a `bigint` column: the column is cast to `numeric` | Compare with a value of the column's type [64]. |
| Leading wildcard | `email LIKE '%@gmail.com'` | `pg_trgm` GIN index [23], or an expression index on `reverse(email)`. |
| `LIKE 'abc%'` with a non-C collation | Default operator class, database collation `en_US.UTF-8` | `text_pattern_ops` index, or a column with `COLLATE "C"` [1][9]. |
| `OR` across different columns | `WHERE user_id = 1 OR email = 'a@b.c'` | An index on each column (the planner can use `BitmapOr`), or `UNION`. Same-column `OR`s become `= ANY (...)` automatically in PG 18 [54]. |
| Stale statistics | Right after a bulk load | `ANALYZE table_name;` |
| Generic plan of a prepared statement | Partial index `WHERE status = 'pending'`, query `WHERE status = $1` | Put the literal in the SQL text; see section 7.4 [7][34]. |
| Collation mismatch | `ORDER BY title COLLATE "C"`, index uses the default collation | One index per collation you query with [10]. |
| Wrong operator for the index type | `'pg' = ANY (tags)` with a GIN index on `tags` | `tags @> ARRAY['pg']` [20]. |
| `jsonb` operator mismatch | `metadata ->> 'source' = 'upload'` with a GIN index on `metadata` | `metadata @> '{"source": "upload"}'`, or a B-tree expression index [24]. |
| Negative condition | `status <> 'done'`, `NOT IN (...)` | Usually matches most rows; use a partial index on the rows you want. |
| Index is `INVALID` | A failed `CREATE INDEX CONCURRENTLY` | Drop it and build it again (section 13.2). |

Two examples:

```sql
-- Bad: the cast is applied to every row, so the index on created_at cannot be used
SELECT id FROM orders WHERE created_at::date = DATE '2026-10-01';

-- Good: a half-open range on the raw column uses an index on created_at
SELECT id FROM orders
WHERE created_at >= TIMESTAMPTZ '2026-10-01 00:00:00+00'
  AND created_at <  TIMESTAMPTZ '2026-10-02 00:00:00+00';
```

```sql
-- Bad: GIN on tags cannot serve "= ANY"
SELECT id FROM documents WHERE 'postgres' = ANY (tags);

-- Good: containment uses the GIN index
SELECT id FROM documents WHERE tags @> ARRAY['postgres'];
```

To check whether an index *could* be used, discourage the alternative in a test session and look at the plan. Do this only to investigate, never in application code [11][31]:

```sql
BEGIN;
SET LOCAL enable_seqscan = off;
EXPLAIN SELECT id FROM orders WHERE user_id = 42;
ROLLBACK;
```

If the plan still shows a `Seq Scan`, the index cannot serve this condition at all (wrong expression, operator, collation or type). If it now shows the index with a higher cost, the planner believed the seq scan was cheaper: check row estimates first.

## 3. Index types

### 3.1 Overview

An **operator class** (opclass) tells an index type how to handle one data type: which operators it can speed up and how to compare values. Each type has a default opclass; you name another one only when you need it (for example `jsonb_path_ops`).

| Type | Good for | Typical operators | Sorted output | Unique | Multicolumn | `INCLUDE` | Index-only scan |
|---|---|---|---|---|---|---|---|
| B-tree | Default: equality, ranges, sorting, prefix `LIKE` | `< <= = >= >`, `BETWEEN`, `IN`, `IS NULL` | Yes | Yes | Yes | Yes (PG 11+) | Yes |
| Hash | Equality on long values | `=` | No | No | No | No | No |
| GIN | `jsonb`, arrays, full text, trigrams | `@> <@ && ? ?\| ?& @@ @?` | No | No | Yes | No | No |
| GiST | Ranges, geometry, nearest neighbor, exclusion constraints | `&& @> <@ << >> <->` | Distance order only | No (use exclusion constraints) | Yes | Yes (PG 12+) | Some opclasses |
| SP-GiST | Points, ranges, `inet`, text prefixes | `<< >> <@ ^@ <->` | Distance order only | No | No | Yes (PG 14+) | Some opclasses |
| BRIN | Huge tables where values follow the physical order | `< <= = >= >` (minmax), `=` (bloom) | No | No | Yes | No | No |

Sources for the table: [1][2][5][8][12][46][47][49]. Only B-tree can return rows in sorted order for `ORDER BY column`; GiST and SP-GiST can return rows ordered by *distance* (`<->`) [1][3].

### 3.2 B-tree (the default)

**Use for:** equality, ranges (`<`, `>`, `BETWEEN`), `IN` lists, `IS NULL`, sorting, `min()`/`max()`, and prefix patterns (`LIKE 'abc%'`, `~ '^abc'`) when the pattern is a constant and the collation or opclass allows it [1]. Only B-tree indexes can be declared `UNIQUE` [5]. (A PG 18 `PRIMARY KEY` or `UNIQUE` constraint with `WITHOUT OVERLAPS` is enforced with a GiST index instead [37].)

```sql
CREATE INDEX orders_user_id_idx ON orders (user_id);                 -- equality and joins
CREATE INDEX orders_created_at_idx ON orders (created_at);           -- ranges and sorting
CREATE UNIQUE INDEX users_email_key ON users (email);                -- uniqueness
```

Built-in improvements you get for free:

- **Deduplication (PG 13+).** Equal keys are stored once, followed by a sorted list of TIDs (a "posting list"). This makes indexes on low-cardinality columns (few distinct values) much smaller [16][48]. It is on by default (`deduplicate_items = on`) [12]. It is never used for `numeric`, `jsonb`, `float4`/`float8`, text with a nondeterministic collation, arrays/ranges/composite types, or indexes with `INCLUDE` columns [16]. An index that was `pg_upgrade`d from PG 12 or older needs a `REINDEX` to use it [48].
- **Bottom-up index deletion (PG 14+).** When non-HOT updates fill a leaf page with obsolete versions, the B-tree deletes them before splitting the page. This reduces bloat on tables with frequently updated indexed columns [49][16].
- **Faster `IN` lists (PG 17+).** A B-tree finds a set of values, such as `id IN (1, 2, 3)`, more efficiently; values that sit on the same leaf page are read in one pass [53][27].

**Limit:** an index entry cannot exceed about one third of a page (after compression) [16], which is roughly 2.7 kB with 8 kB pages. Inserting a longer value into an indexed column fails. For long values that you only compare with `=` (URLs, tokens), use a hash index, or a B-tree on a hash of the value:

```sql
-- Equality on long URLs without hitting the B-tree size limit
CREATE INDEX pages_url_md5_idx ON pages (md5(url));
SELECT id FROM pages WHERE md5(url) = md5($1) AND url = $1;  -- re-check the real value
```

#### Skip scan (PG 18+)

Before PG 18, a multicolumn B-tree on `(a, b)` was efficient only when the query constrained the leading column `a`. PG 18 adds **skip scan**: the index can be used when the query has no condition (or only a range condition) on early columns, as long as it has a useful condition on a later column [54].

How it works: the B-tree internally generates an equality condition for every value of the skipped column and runs one small search per value [2]. With an index on `(x, y)` and `WHERE y = 7700`, it runs `x = N AND y = 7700` for each distinct `x`. The documentation adds: "This approach is generally only taken when there are so few distinct `x` values that the planner expects the scan to skip over most of the index. If there are many distinct `x` values, then the entire index will have to be scanned, so in most cases the planner will prefer a sequential table scan" [2].

When it applies:

- B-tree, multicolumn index.
- One or more columns before the last constrained column have no `=` condition: the condition is missing, or it is a range such as `BETWEEN 1 AND 3` [2][27].
- The skipped columns have **few distinct values**. Peter Geoghegan, the author of the feature, gives "hundreds of distinct [values] total, or perhaps thousands" as a rule-of-thumb upper limit [59].
- The planner's cost model prefers it; otherwise you get a seq scan or another index.

Example from the PostgreSQL documentation (`tenk1_four_unique1_idx` is an index on `(four, unique1)`; `four` has 4 distinct values) [27]:

```sql
EXPLAIN ANALYZE SELECT four, unique1 FROM tenk1 WHERE four BETWEEN 1 AND 3 AND unique1 = 42;
--  Index Only Scan using tenk1_four_unique1_idx on tenk1  (cost=0.29..6.90 rows=1 width=8) (actual time=0.006..0.007 rows=1.00 loops=1)
--    Index Cond: ((four >= 1) AND (four <= 3) AND (unique1 = 42))
--    Heap Fetches: 0
--    Index Searches: 3
--    Buffers: shared hit=7
```

`Index Searches: 3` (shown by `EXPLAIN ANALYZE` since PG 18 [54]) means three small searches: `four = 1`, `2` and `3`, each with `unique1 = 42`. A practical case in the example schema:

```sql
-- One index serves both query shapes when status has only a few values (PG 18+)
CREATE INDEX jobs_status_run_at_idx ON jobs (status, run_at);

SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now();       -- classic use
SELECT count(*) FROM jobs WHERE run_at >= now() - interval '5 minutes'; -- skip scan over status
```

What skip scan does **not** change: if the leading column has many distinct values (`user_id`, `tenant_id` with thousands of tenants), queries without it still need their own index. Note also that each index search increments `pg_stat_all_indexes.idx_scan`, so `idx_scan` can become much larger than the number of query executions with `IN` lists and skip scans [28].

### 3.3 Hash

**Use for:** `=` only, on long values (URLs, long tokens) where a B-tree would be large. A hash index stores only a 4-byte hash code per entry [17].

```sql
CREATE INDEX pages_url_hash_idx ON pages USING hash (url);
SELECT id FROM pages WHERE url = 'https://example.com/a/very/long/path';
```

- Limits: single column, no uniqueness, no ranges, no sorting, no index-only scans; all scans are lossy (the row is re-checked) [17][8].
- Hash indexes are crash-safe and replicated; the old advice "never use hash indexes" dates from before PostgreSQL 10 [17][78].
- They suit "unique, nearly unique data or data with a low number of rows per hash bucket"; with many duplicates they can be worse than a B-tree. They grow in the foreground during inserts and never shrink without `REINDEX` [17].
- Haki Benita measured, on PG 13 with a 1-million-row URL-shortener table, a hash index on the key column about half the size of the B-tree before reindexing (37 MB vs 73 MB), and slightly faster lookups [78]. Measure on your data before you choose it.

### 3.4 GIN (Generalized Inverted Index)

**Use for:** values that contain many parts: `jsonb` documents, arrays, `tsvector` (full text), and trigrams (`pg_trgm`). An inverted index stores one entry per component (array element, JSON key or value, word) with the list of rows that contain it [1][20]. GIN cannot return sorted output or do index-only scans [3][8]; the planner reads it with bitmap scans.

```sql
-- Arrays: overlap (&&), contains (@>), contained by (<@)
CREATE INDEX documents_tags_gin ON documents USING gin (tags);
SELECT id FROM documents WHERE tags && ARRAY['postgres', 'indexing'];

-- jsonb, default opclass jsonb_ops: supports ?, ?|, ?&, @>, @?, @@
CREATE INDEX documents_metadata_gin ON documents USING gin (metadata);
SELECT id FROM documents WHERE metadata ? 'archived_at';           -- key exists

-- jsonb_path_ops: only @>, @?, @@, but smaller and faster for them
CREATE INDEX documents_metadata_path_gin ON documents USING gin (metadata jsonb_path_ops);
SELECT id FROM documents WHERE metadata @> '{"source": "upload", "lang": "fr"}';
```

`jsonb_ops` vs `jsonb_path_ops` [24][20]:

| | `jsonb_ops` (default) | `jsonb_path_ops` |
|---|---|---|
| Operators | `?`, `?\|`, `?&`, `@>`, `@?`, `@@` | `@>`, `@?`, `@@` |
| Index items | One per key and one per value | One hash per value *with its path* |
| Size and speed | Bigger; slower for frequent keys | "Usually much smaller"; more specific searches |
| Weak spot | — | Finds no entries for empty structures such as `{"a": {}}`: such searches scan the full index |

For equality on **one known key**, a B-tree expression index is smaller and faster than a GIN index on the whole document (section 8). A GIN index on one sub-path is another option: `CREATE INDEX ... USING gin ((metadata -> 'labels'))` stores only that part [24].

**Write cost and the pending list.** One row can add many GIN entries, so GIN updates are slow. With `fastupdate = on` (the default), new entries first go to an unsorted **pending list**. It is moved into the main index by `VACUUM`, by autoanalyze, by `gin_clean_pending_list()`, or when it exceeds `gin_pending_list_limit` (default 4MB) [20][12][33]. Searches must also read the pending list, so a big pending list slows them down [20].

- Read latency matters more than insert speed? Set `fastupdate = off` on that index, or lower its `gin_pending_list_limit`.
- Big bulk load? The documentation advises dropping the GIN index and recreating it afterwards [20].
- GIN build time is "very sensitive to the `maintenance_work_mem` setting" [20]; GIN builds can run in parallel since PG 18 [54].

A multicolumn GIN index works equally well for any subset of its columns [2]. To mix a scalar column (such as `tenant_id`) into one GIN index, use the `btree_gin` extension.

### 3.5 GiST (Generalized Search Tree)

**Use for:** ranges and multiranges, geometric types and PostGIS geometries, `inet`, nearest-neighbor search, full text (lossy), trigram distance search, and **exclusion constraints** [18][25]. GiST is a framework: each data type defines what "overlaps" or "contains" means.

Range overlap and "no double booking" with an exclusion constraint (the constraint creates its own GiST index):

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- lets GiST handle "room_id WITH ="

CREATE TABLE room_bookings (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id  bigint    NOT NULL,
    during   tstzrange NOT NULL,
    EXCLUDE USING gist (room_id WITH =, during WITH &&)
);

-- The same GiST index serves overlap searches
SELECT id FROM room_bookings
WHERE room_id = 7
  AND during && tstzrange('2026-10-05 09:00+00', '2026-10-05 12:00+00');
```

PG 18+ offers the same rule as a temporal key: `PRIMARY KEY (room_id, during WITHOUT OVERLAPS)` or `UNIQUE (...)`. It is enforced with a GiST index, and `btree_gist` is the expected way to support the non-range columns [37][54].

Nearest neighbor: GiST can return rows ordered by distance, so `ORDER BY ... <-> ... LIMIT n` stops after the first `n` rows instead of computing and sorting every distance [1][18]:

```sql
CREATE TABLE places (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name      text  NOT NULL,
    location  point NOT NULL
);
CREATE INDEX places_location_gist ON places USING gist (location);

SELECT id, name
FROM places
ORDER BY location <-> point '(2.3522, 48.8566)'   -- distance from a point
LIMIT 10;
```

- GiST supports `INCLUDE` (PG 12+) [47] and index-only scans for some operator classes [8].
- In a multicolumn GiST index the first column matters most; GiST is "relatively ineffective if its first column has only a few distinct values" [2].
- For `inet`/`cidr`, name the opclass: "for historical reasons, the `inet_ops` operator class is not the default class", so write `USING gist (network inet_ops)` [18]. (PG 19, beta — may change: the core GiST opclass becomes the default, because the `btree_gist` `inet`/`cidr` opclasses "can exclude rows that should be returned"; `pg_upgrade` will refuse clusters that still have such indexes [55].)

### 3.6 SP-GiST (space-partitioned GiST)

**Use for:** data that splits naturally into non-overlapping regions: points (quad-trees, k-d trees), ranges, IP networks, and text prefixes (radix trees) [19]. Searches that match the partitioning are very fast [19].

```sql
CREATE TABLE ip_blocks (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    network  inet NOT NULL,
    country  text NOT NULL
);
CREATE INDEX ip_blocks_network_spgist ON ip_blocks USING spgist (network);

SELECT country FROM ip_blocks WHERE network >>= inet '192.168.10.25';  -- "contains or equals"
```

- Built-in opclasses: `quad_point_ops`, `kd_point_ops`, `range_ops`, `box_ops`, `poly_ops`, `inet_ops`, `text_ops` (with the starts-with operator `^@`) [19].
- Point, box and polygon opclasses support `<->` nearest-neighbor ordering [19]. `INCLUDE` is supported since PG 14 [49]. No multicolumn SP-GiST indexes [2].
- Choose SP-GiST over GiST only after measuring on your data; GiST is the more common choice.

### 3.7 BRIN (Block Range Index)

**Use for:** very large tables where a column follows the **physical order** of rows, such as `created_at` in an append-only log. BRIN stores one small summary (for example min and max) per range of pages; the default range is `pages_per_range = 128` [21][12].

- A BRIN index is tiny. Crunchy Data measured 32 kB for BRIN versus 214 MB for B-tree on 10 million rows (PostgreSQL 11.2) [80].
- It is **lossy**: it returns whole page ranges through a bitmap scan, and the executor re-checks each row [21]. It cannot enforce uniqueness, sort, or answer very selective lookups as fast as a B-tree.
- It works only if values are correlated with the physical order. Check `pg_stats.correlation` first: close to `1` or `-1` is good, close to `0` means BRIN will not help [30][21].
- Updates (new row versions land on other pages) and deletes (new rows later fill the freed space) reduce the correlation over time.

```sql
-- Check correlation (run ANALYZE first)
SELECT attname, correlation
FROM pg_stats
WHERE tablename = 'events' AND attname = 'created_at';

-- Default BRIN (minmax): 128 pages per summary
CREATE INDEX events_created_at_brin ON events USING brin (created_at);

-- Smaller ranges: more precise, slightly bigger index
CREATE INDEX events_created_at_brin32 ON events USING brin (created_at) WITH (pages_per_range = 32);

-- PG 14+: minmax-multi keeps several min/max intervals per range (handles outliers)
CREATE INDEX events_created_at_brin_mm ON events
    USING brin (created_at timestamptz_minmax_multi_ops(values_per_range = 16));

-- PG 14+: bloom answers "=" on values that are not physically clustered
CREATE INDEX events_request_id_brin_bloom ON events USING brin (request_id uuid_bloom_ops);
```

**Summarization.** Page ranges filled after the index was built are not summarized until `VACUUM` (or autovacuum) runs, `autosummarize` is on (off by default), or you call `brin_summarize_new_values()` [21][12]. Unsummarized ranges are always scanned.

```sql
ALTER INDEX events_created_at_brin SET (autosummarize = on);
SELECT brin_summarize_new_values('events_created_at_brin');
```

Other facts: minmax-multi `values_per_range` defaults to 32 (8–256); bloom has `n_distinct_per_range` (default -0.1) and `false_positive_rate` (default 0.01) [21]. BRIN builds can run in parallel since PG 17 [53]. BRIN is a "summarizing" index, so since PG 16 it does not block HOT updates [52][26]. For time-series data, also consider partitioning (see [schema design](07-schema-design-and-patterns.md)).

### 3.8 The bloom extension

`bloom` (a contrib extension, not BRIN bloom) builds one signature per row. One bloom index can serve `=` searches on **any combination** of many columns [22].

```sql
CREATE EXTENSION IF NOT EXISTS bloom;

CREATE TABLE product_filters (
    product_id  bigint PRIMARY KEY,
    color       text,
    size        text,
    brand       text,
    material    text
);

-- length = signature bits per row; colN = bits per column (defaults 80 and 2)
CREATE INDEX product_filters_bloom ON product_filters USING bloom (color, size, brand, material)
    WITH (length = 80, col1 = 2, col2 = 2, col3 = 4, col4 = 2);

SELECT product_id FROM product_filters WHERE brand = 'acme' AND material = 'wool';
```

- Only `=`; only `int4` and `text` opclasses ship with it; no uniqueness; no `NULL` searches; lossy [22].
- The documentation's own example (10 million rows, 6 columns) shows the bloom index (153 MB) much faster than a seq scan, but separate B-tree indexes (531 MB in total) combined by bitmaps were faster still [22]. Use bloom when space matters more than the last millisecond.

### 3.9 Full-text search indexes (short)

Store a `tsvector` in a `STORED` generated column and index it with GIN. Use the two-argument `to_tsvector('english', ...)`: the one-argument form depends on a setting and cannot be indexed.

```sql
ALTER TABLE documents
    ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('english', title)) STORED;
CREATE INDEX documents_search_gin ON documents USING gin (search);

SELECT id FROM documents WHERE search @@ websearch_to_tsquery('english', 'vacuum tuning');
```

Configurations, ranking, BM25 extensions and trigram search are in [full-text and vector search](12-full-text-and-vector-search.md).

### 3.10 Vector indexes with pgvector (short)

pgvector adds approximate nearest-neighbor indexes [87]:

- **HNSW**: better speed/recall trade-off, slower build, more memory; can be created on an empty table.
- **IVFFlat**: faster build, less memory, lower speed/recall; needs data first (it trains clusters).
- The opclass must match the distance operator: `vector_cosine_ops` with `<=>`, `vector_l2_ops` with `<->`, `vector_ip_ops` with `<#>` [87].
- Indexable dimensions: up to 2,000 for `vector`, 4,000 for `halfvec` [87].

```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE chunks ADD COLUMN embedding vector(1024);
CREATE INDEX CONCURRENTLY chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);

-- $1 is the query embedding sent as a bind parameter
SELECT id FROM chunks ORDER BY embedding <=> $1 LIMIT 10;
```

Filtering, iterative scans, quantization and RAG schemas are in [full-text and vector search](12-full-text-and-vector-search.md).

## 4. Multicolumn indexes

### 4.1 Column order: equality first, then one range or sort column

The documentation gives the exact rule for B-tree: "equality constraints on leading columns, plus any inequality constraints on the first column that does not have an equality constraint, will always be used to limit the portion of the index that is scanned" [2]. Conditions on columns further right are checked inside the index (this saves heap visits) but they do not shrink the part of the index that is read [2]. Markus Winand summarizes it as "index for equality first—then for ranges" [61].

```sql
-- Query: one user's orders of the last 30 days, newest first
SELECT id, total_cents, created_at
FROM orders
WHERE user_id = $1
  AND created_at >= now() - interval '30 days'
ORDER BY created_at DESC
LIMIT 20;

-- Good: equality column first, then the range/sort column
CREATE INDEX orders_user_id_created_at_idx ON orders (user_id, created_at);

-- Bad for this query: the range column comes first, so user_id only filters
-- entries inside a 30-day slice that contains every user's orders
CREATE INDEX orders_created_at_user_id_idx ON orders (created_at, user_id);
```

- In `EXPLAIN`, PostgreSQL shows both kinds of conditions under `Index Cond`. A range on an early column followed by an equality on a later column means the later column only *filters* the scanned range [61]. Compare `Buffers` (and, in PG 18+, `Index Searches`) between candidate indexes.
- Among several equality columns, put first the column that most queries filter on, for example `tenant_id` in a multi-tenant application. The goal is that one index serves as many queries as possible [62].
- Limits: at most 32 columns including `INCLUDE` columns; only B-tree, GiST, GIN and BRIN support several key columns [2]. The documentation warns that "indexes with more than three columns are unlikely to be helpful unless the usage of the table is extremely stylized" [2].

### 4.2 The leftmost-prefix rule, and how PG 18 skip scan changes it

A B-tree on `(tenant_id, status, created_at)` is sorted by `tenant_id` first. A query that does not constrain `tenant_id` cannot jump to the right place in the index; before PG 18 it had to read the whole index (so the planner usually chose another plan). PG 18 skip scan (section 3.2) removes this limit **only** when the skipped columns have few distinct values.

| Condition in the query | PG 14–17 | PG 18+ |
|---|---|---|
| `tenant_id = ?` | Efficient | Efficient |
| `tenant_id = ? AND status = ? AND created_at > ?` | Efficient | Efficient |
| `tenant_id = ? AND created_at > ?` | Reads all of the tenant's entries; `created_at` only filters | Can skip from one `status` value to the next (few statuses) |
| `status = ?` or `created_at > ?` only | Index useless in practice | Skip scan over the missing leading columns: useful only if they have few distinct values (few tenants) |

If a query shape without the leading column is frequent and the leading column has many values, it still needs its own index, for example `(created_at)`.

### 4.3 The "most selective column first" myth

A common rule says "put the most selective column first". It is wrong as a general rule [62]. What matters is which columns are constrained with `=` and how many queries can use the index: "It's useless to have the most selective column of the index on the left if very few queries filter on it" [62].

Selectivity matters in one case: when two columns both have **range** conditions. Only the first range limits the scan [2], so put the more selective range column first [62]. With skip scan (PG 18+), a low-cardinality leading column such as `status` no longer blocks queries that omit it [2][59].

### 4.4 One multicolumn index or several single-column indexes?

PostgreSQL can combine single-column indexes: it builds one bitmap per index and joins them with `BitmapAnd` or `BitmapOr` [4]. This is flexible, but each index is scanned separately and the result loses the index order.

| Workload | Choose |
|---|---|
| Queries always filter on `a` and `b` together | One index on `(a, b)`: usually faster than combining two indexes [4][69] |
| Some queries filter on `a`, some on `b`, some on both | `(a, b)` plus `(b)`; or `(a)` plus `(b)` and let bitmaps combine them [4] |
| Ad-hoc filters on many columns (search screens) | Single-column indexes on the most used columns, or `bloom` for equality-only filters |
| `a` = equality and `ORDER BY b LIMIT n` | `(a, b)`: bitmaps cannot return rows in order |

The documentation's advice: create all three indexes `(a, b)`, `(a)` and `(b)` only if the table is "searched much more often than it is updated and all three types of query are common" [4].

## 5. Indexes for `ORDER BY` and `LIMIT`

### 5.1 Matching the sort order

Only B-tree indexes return rows in sorted order. If an index matches the `ORDER BY`, "the first n rows can be retrieved directly, without scanning the remainder at all" [3]. Use the Index, Luke calls this a "pipelined order by": the plan has no `Sort` node [63].

- A B-tree can be read forward or backward. By default it stores `ASC NULLS LAST`; read backward it gives `DESC NULLS FIRST` [3].
- `ORDER BY x DESC NULLS LAST` needs an index declared `(x DESC NULLS LAST)` (or `(x NULLS FIRST)`, read backward).
- Mixed directions need a matching index: `ORDER BY a ASC, b DESC` needs `(a ASC, b DESC)` or `(a DESC, b ASC)` [3].
- An equality prefix keeps the order: `(user_id, created_at)` serves `WHERE user_id = $1 ORDER BY created_at DESC` by reading backward.

```sql
-- Same direction for all keys: a plain index works (read backward)
CREATE INDEX documents_tenant_created_id_idx ON documents (tenant_id, created_at, id);

SELECT id, title, created_at
FROM documents
WHERE tenant_id = $1
ORDER BY created_at DESC, id DESC
LIMIT 50;

-- Mixed directions: the index must have the same mix
CREATE INDEX documents_tenant_created_desc_id_idx ON documents (tenant_id, created_at DESC, id ASC);

SELECT id, title, created_at
FROM documents
WHERE tenant_id = $1
ORDER BY created_at DESC, id ASC
LIMIT 50;
```

Paging through such results with "seek" conditions (keyset pagination) is covered in [query patterns](04-query-patterns-and-antipatterns.md).

### 5.2 Incremental sort (PG 13+)

If the index provides only the first sort key, PostgreSQL can sort the rest in small groups instead of sorting everything. This is **incremental sort** [48]. It is very effective with `LIMIT`, because only the first groups need sorting.

```sql
-- Only an index on (user_id) exists
EXPLAIN SELECT id FROM orders ORDER BY user_id, created_at LIMIT 10;
-- Typical plan shape:
-- Limit
--   ->  Incremental Sort
--         Sort Key: user_id, created_at
--         Presorted Key: user_id
--         ->  Index Scan using orders_user_id_idx on orders
```

`Presorted Key` shows the part that comes from the index. Since PG 16 incremental sort is used in more cases, including `DISTINCT` [52]; it is controlled by `enable_incremental_sort` (default `on`) [31].

### 5.3 The LIMIT trap

The planner assumes that matching rows are spread evenly over the table. With `ORDER BY ... LIMIT`, it may walk the index of the `ORDER BY` column and filter each row, expecting to find enough matches quickly [73][27]. If the matching rows are rare or all at the "far end" of the index, it reads a large part of the table.

```sql
-- Only single-column indexes exist: orders_user_id_idx and orders_created_at_idx
SELECT id, total_cents
FROM orders
WHERE user_id = 42
ORDER BY created_at DESC
LIMIT 10;

-- Typical bad plan shape:
-- Limit
--   ->  Index Scan Backward using orders_created_at_idx on orders
--         Filter: (user_id = 42)
--         Rows Removed by Filter: 4210335
```

A large `Rows Removed by Filter` is the signature. pganalyze shows real cases where a query is fast without `ORDER BY` and orders of magnitude slower with it, because the planner walked the wrong index [73].

Fixes, best first:

1. **A composite index that covers both the filter and the order**: `(user_id, created_at)`. The scan reads about 10 entries and stops.
2. **Better statistics** for the filter column (`ALTER TABLE ... ALTER COLUMN ... SET STATISTICS`, extended statistics), so the planner sees that the value is rare [73]. See [query optimization](06-query-optimization-and-explain.md).
3. **Last resort**: make the `ORDER BY` an expression the index cannot provide, for example `ORDER BY created_at + interval '0 seconds' DESC`. The planner then filters with the `user_id` index and sorts the few rows [73]. Comment this hack in the code.

## 6. Covering indexes (`INCLUDE`) and index-only scans

An **index-only scan** answers a query from the index alone. It needs two things [8]:

1. An index type that supports it: B-tree always; GiST and SP-GiST for some operator classes; GIN, BRIN and hash never.
2. Every column the query uses (in `SELECT`, `WHERE`, `ORDER BY`...) is stored in the index.

It also depends on the visibility map (section 1.4): pages that are not all-visible still cost a heap visit (`Heap Fetches`).

`INCLUDE` (PG 11+ for B-tree [46], PG 12+ for GiST [47], PG 14+ for SP-GiST [49]) adds "payload" columns to the leaf entries. They are returned by index-only scans, but are not part of the search key [8][12].

```sql
-- Frequent query: the latest orders of a user, with status and amount
SELECT created_at, status, total_cents
FROM orders
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT 50;

CREATE INDEX orders_user_id_created_at_covering_idx
    ON orders (user_id, created_at) INCLUDE (status, total_cents);

-- Typical plan shape after VACUUM:
-- Limit
--   ->  Index Only Scan Backward using orders_user_id_created_at_covering_idx on orders
--         Index Cond: (user_id = 42)
--         Heap Fetches: 0
```

| | Key column | `INCLUDE` column |
|---|---|---|
| Used to search or sort | Yes | No [12] |
| Part of a unique rule | Yes | No: `UNIQUE (x) INCLUDE (y)` is unique on `x` only [8] |
| Needs a B-tree operator class | Yes | No: any type can be included [12][46] |
| Allows B-tree deduplication | Yes | Never, if the index has any `INCLUDE` column [12][16] |
| Can be an expression | Yes | No [12] |

Cautions:

- Be conservative with wide payload columns: they duplicate table data, make the index bigger, and an entry above the size limit makes the insert fail [8].
- Index-only scans need a well-vacuumed table. On busy tables, tune autovacuum (see [operations](09-operations-and-server-tuning.md)) and watch `Heap Fetches`.
- The planner considers an index-only scan only if all needed *columns* are in the index. An index on `f(x)` does not let it return `f(x)` without `x`; the workaround is `CREATE INDEX ... ON tab (f(x)) INCLUDE (x)` [8].
- A partial index's condition columns do not need to be in the index: for `... WHERE success`, a query with `AND success` can still be index-only [8].

## 7. Partial indexes

A **partial index** indexes only the rows that match a `WHERE` condition (the *predicate*). It is smaller, faster to search, and rows outside the predicate add no index entries on insert [7]. Columns used in the predicate count as indexed columns for HOT updates (section 1.6) [26].

### 7.1 Index only the rows you query

```sql
-- Soft delete: queries read live rows only
CREATE INDEX users_tenant_id_live_idx ON users (tenant_id) WHERE deleted_at IS NULL;

SELECT id, email FROM users WHERE tenant_id = $1 AND deleted_at IS NULL;  -- can use it

-- Queue: only pending jobs are searched; done jobs pile up but stay out of the index
CREATE INDEX jobs_pending_run_at_idx ON jobs (run_at) WHERE status = 'pending';

SELECT id
FROM jobs
WHERE status = 'pending' AND run_at <= now()
ORDER BY run_at
LIMIT 10
FOR UPDATE SKIP LOCKED;
```

- B-tree indexes store `NULL` values. If most rows have `NULL` in an indexed column and you never search for `NULL`, add `WHERE col IS NOT NULL`. Haki Benita shrank one such index from 769 MB to less than 5 MB this way [79][1].
- Low-cardinality flags (boolean, status): index the rare value with a partial index instead of indexing the flag itself.
- Queue tables, soft delete and status machines are designed in [schema design](07-schema-design-and-patterns.md); `SKIP LOCKED` is explained in [transactions and concurrency](08-transactions-concurrency-locking.md).

### 7.2 Partial unique indexes

A partial unique index enforces uniqueness only among the rows that match its predicate [7].

```sql
CREATE TABLE subscriptions (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id  bigint NOT NULL REFERENCES users (id),
    status   text   NOT NULL,          -- active, cancelled
    plan     text   NOT NULL
);

-- At most one active subscription per user; any number of cancelled ones
CREATE UNIQUE INDEX subscriptions_one_active_per_user
    ON subscriptions (user_id) WHERE status = 'active';

-- Email unique among live users only, case-insensitive
CREATE UNIQUE INDEX users_email_live_key
    ON users (lower(email)) WHERE deleted_at IS NULL;
```

- A foreign key cannot reference a partial unique index; it needs a primary key, a unique constraint or a non-partial unique index [36].
- `INSERT ... ON CONFLICT` must repeat the predicate to use a partial unique index (section 9.3) [35].

### 7.3 How the planner matches the predicate

The planner uses a partial index only if it can prove that the query's `WHERE` clause implies the index predicate. It "can recognize simple inequality implications, for example `x < 1` implies `x < 2`; otherwise the predicate condition must exactly match part of the query's `WHERE` condition". It has no "sophisticated theorem prover" [7].

```sql
CREATE INDEX orders_big_created_at_idx ON orders (created_at) WHERE total_cents >= 100000;

-- Used: total_cents >= 500000 implies total_cents >= 100000
SELECT id FROM orders
WHERE total_cents >= 500000 AND created_at > now() - interval '1 day';

-- Not used: for integers this is equivalent, but the planner cannot prove it
SELECT id FROM orders
WHERE total_cents > 99999 AND created_at > now() - interval '1 day';
```

Do not create many non-overlapping partial indexes (one per customer, one per month) as a replacement for partitioning: the planner tests each one, and that planning work costs more than one bigger index [7].

### 7.4 Partial indexes and prepared statements

Predicate matching happens at **planning** time. "Parameterized query clauses do not work with a partial index": `x < $1` can never imply `x < 2` for all values of `$1` [7].

With prepared statements, the first five executions use *custom plans* (built with the real values), then PostgreSQL may switch to a *generic plan* that ignores the values [34]. A generic plan cannot use a partial index whose predicate depends on a parameter. The same applies to prefix `LIKE $1` (the pattern must be a constant to use a B-tree [1]) and to strongly skewed values.

```sql
-- Bad: in a generic plan, the partial index jobs_pending_run_at_idx cannot be used
SELECT id FROM jobs WHERE status = $1 AND run_at <= now() ORDER BY run_at LIMIT 10;

-- Good: the predicate is literal SQL text; other values stay parameters
SELECT id FROM jobs WHERE status = 'pending' AND run_at <= $1 ORDER BY run_at LIMIT 10;
```

If one statement needs value-specific plans, `plan_cache_mode = force_custom_plan` (per session or role) forces re-planning on each execution, at the cost of planning time [34][31]. Drivers and ORMs differ in when they use named prepared statements; see [query optimization](06-query-optimization-and-explain.md) and [PostgreSQL from TypeScript](15-postgres-from-typescript.md).

## 8. Expression indexes

### 8.1 Index the expression you query

An index can store the result of an expression. The query must use the **same expression** for the planner to match it; the search is then as fast as on a plain column, because the expression is not recomputed during the search [6].

```sql
-- Case-insensitive lookup
CREATE INDEX users_email_lower_idx ON users (lower(email));
SELECT id FROM users WHERE lower(email) = lower($1);

-- Equality on one jsonb key: a small B-tree instead of a GIN on the whole document
CREATE INDEX documents_source_idx ON documents ((metadata ->> 'source'));
SELECT id FROM documents WHERE metadata ->> 'source' = 'upload';

-- Range on a jsonb number: the cast must be inside the index too
CREATE INDEX documents_page_count_idx ON documents (((metadata ->> 'page_count')::int));
SELECT id FROM documents WHERE (metadata ->> 'page_count')::int > 100;
```

- Syntax: a single function call needs no extra parentheses; any other expression needs its own parentheses, hence `((metadata ->> 'source'))` [6].
- "Same expression" is strict: `metadata -> 'source'` (returns `jsonb`) is not `metadata ->> 'source'` (returns `text`), and `upper(email)` is not `lower(email)`.
- A cast in the index can fail on bad data: if one document has `"page_count": "n/a"`, the insert (or the index build) fails. Validate the data first, or use a `CHECK` constraint.
- Cost: "index expressions are relatively expensive to maintain, because the derived expression(s) must be computed for each row insertion and non-HOT update" [6].

### 8.2 The `IMMUTABLE` rule and the time-zone trap

"All functions and operators used in an index definition must be 'immutable'": their result must depend only on their arguments, never on settings, other tables or the current time [12]. Functions whose result depends on `TimeZone` must be `STABLE`, not `IMMUTABLE` [41].

```sql
-- Bad: fails, because converting timestamptz to date depends on the TimeZone setting
CREATE INDEX orders_created_day_idx ON orders ((created_at::date));
-- ERROR:  functions in index expression must be marked IMMUTABLE

-- Good: fix the time zone inside the expression
CREATE INDEX orders_created_day_utc_idx ON orders (((created_at AT TIME ZONE 'UTC')::date));
SELECT count(*) FROM orders WHERE (created_at AT TIME ZONE 'UTC')::date = DATE '2026-10-01';

-- Often simpler: no expression index at all, query a half-open range on created_at (section 2)
```

Do not "fix" the error by wrapping a `STABLE` function in your own function declared `IMMUTABLE`. If the result can change (time zone, locale, data in another table), the index keeps the old results and queries silently return wrong rows [41][12].

### 8.3 Statistics on expressions

Without statistics, the planner guesses the selectivity of `lower(email) = ...` with a default. An expression index fixes that: `ANALYZE` also collects statistics for index expression columns, and you can raise their target with `ALTER INDEX ... ALTER COLUMN n SET STATISTICS` [15]. Since PG 14, `CREATE STATISTICS` on an expression gives the same estimates "without the overhead of index maintenance" [42][49].

```sql
ALTER INDEX documents_page_count_idx ALTER COLUMN 1 SET STATISTICS 1000;

-- PG 14+: statistics on an expression, no index
CREATE STATISTICS orders_created_day_utc_stats ON ((created_at AT TIME ZONE 'UTC')::date) FROM orders;
ANALYZE orders;
```

For this reason, an expression index with `idx_scan = 0` may still be useful (its statistics) [68]. More in [query optimization](06-query-optimization-and-explain.md).

### 8.4 Generated columns instead of expression indexes

A `STORED` generated column plus a plain index gives the same speed and makes the expression visible in the schema (and to ORMs).

```sql
ALTER TABLE users ADD COLUMN email_lower text GENERATED ALWAYS AS (lower(email)) STORED;
CREATE INDEX users_email_lower_col_idx ON users (email_lower);
```

- In PG 18, generated columns are `VIRTUAL` by default [45], and "indexes on virtual generated columns are not supported" [56]. Write `STORED` explicitly if you want to index the column.
- Adding a `STORED` generated column computes it for every existing row, which rewrites the table; plan it like any heavy migration ([safe migrations](10-safe-schema-migrations.md)).

## 9. Unique indexes, unique constraints and `ON CONFLICT`

### 9.1 Constraint or index?

- A `PRIMARY KEY` or `UNIQUE` constraint automatically creates a unique B-tree index (a GiST index with `WITHOUT OVERLAPS`, PG 18+) [36][37]. Do not create a second index on the same columns: it would only duplicate the first one [5].
- Prefer a **constraint** for plain column uniqueness: it is part of the schema metadata, tools and ORMs understand it, and it can be `DEFERRABLE`.
- Use a unique **index** when the rule needs an expression (`lower(email)`) or a predicate (partial uniqueness): constraints cannot express these.
- On a big live table, build the index first and then turn it into a constraint, so writes are not blocked for the whole build (details in [safe migrations](10-safe-schema-migrations.md)):

```sql
CREATE UNIQUE INDEX CONCURRENTLY users_tenant_email_key_idx ON users (tenant_id, email);
ALTER TABLE users ADD CONSTRAINT users_tenant_email_key UNIQUE USING INDEX users_tenant_email_key_idx;
```

### 9.2 `NULL` in unique indexes and `NULLS NOT DISTINCT` (PG 15+)

By default two `NULL` values are not equal, so a unique index accepts many rows that differ only by having `NULL` in a key column [36]. PG 15 added `NULLS NOT DISTINCT`, which treats `NULL`s as equal [51][36].

```sql
CREATE TABLE user_settings (
    user_id  bigint NOT NULL REFERENCES users (id),
    key      text   NOT NULL,
    scope    text,                  -- NULL means "global"
    value    jsonb  NOT NULL
);

-- PG 15+: only one global setting per (user_id, key)
CREATE UNIQUE INDEX user_settings_user_key_scope_key
    ON user_settings (user_id, key, scope) NULLS NOT DISTINCT;

-- PG 14 alternative: two partial unique indexes
-- CREATE UNIQUE INDEX user_settings_scoped_key ON user_settings (user_id, key, scope) WHERE scope IS NOT NULL;
-- CREATE UNIQUE INDEX user_settings_global_key ON user_settings (user_id, key) WHERE scope IS NULL;
```

### 9.3 The index that `ON CONFLICT` needs

`INSERT ... ON CONFLICT (columns)` does not search for duplicates by itself. It needs a unique index or constraint (an *arbiter*) that it can infer from the conflict target [35]:

- It picks unique indexes "that, without regard to order, contain exactly the conflict_target-specified columns/expressions" [35].
- For an expression index, repeat the expression; for a partial unique index, repeat the predicate in `WHERE` [35].
- `ON CONFLICT DO UPDATE` must name a conflict target; exclusion constraints cannot be arbiters for `DO UPDATE` [35].
- If nothing matches, the statement fails with `there is no unique or exclusion constraint matching the ON CONFLICT specification`.

```sql
-- Needs a unique index or constraint on exactly (tenant_id, email)
INSERT INTO users (tenant_id, email) VALUES ($1, $2)
ON CONFLICT (tenant_id, email) DO NOTHING;

-- Expression + partial unique index users_email_live_key (section 7.2)
INSERT INTO users (tenant_id, email) VALUES ($1, $2)
ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO NOTHING;

-- Partial unique index subscriptions_one_active_per_user (section 7.2)
INSERT INTO subscriptions (user_id, status, plan) VALUES ($1, 'active', $2)
ON CONFLICT (user_id) WHERE status = 'active'
DO UPDATE SET plan = EXCLUDED.plan;
```

Upsert patterns and their pitfalls are covered in [query patterns](04-query-patterns-and-antipatterns.md).

## 10. Operator classes and collations

A **collation** defines how text is sorted and compared (for example `en_US.UTF-8`, an ICU locale, or `"C"` = plain byte order). An index column uses one operator class and one collation, and a query can use the index only if it compares the same way.

### 10.1 `LIKE 'prefix%'` needs `text_pattern_ops` or the `C` collation

A B-tree can serve a prefix pattern only if comparisons follow byte order. With a non-C database collation, you need the `text_pattern_ops` (or `varchar_pattern_ops`, `bpchar_pattern_ops`) operator class, which compares "strictly character by character" [9][1].

```sql
-- Database collation is en_US.UTF-8 (or another non-C collation)
CREATE INDEX users_email_pattern_idx ON users (email text_pattern_ops);

SELECT id FROM users WHERE email LIKE 'alex%';       -- can use the index
SELECT id FROM users WHERE email = 'alex@example.com'; -- can use it too
SELECT id FROM users ORDER BY email LIMIT 10;        -- cannot: needs a default-opclass index

-- Case-insensitive prefix search: combine an expression and the opclass
CREATE INDEX users_email_lower_pattern_idx ON users (lower(email) text_pattern_ops);
SELECT id FROM users WHERE lower(email) LIKE 'alex%';
```

- `*_pattern_ops` indexes support `LIKE`, regular-expression prefixes and `=`, but not `<`, `<=`, `>`, `>=` or ordinary sorting; create a second, default index if you also need those [9].
- With the `C` collation you do not need pattern opclasses: the default index already supports prefix patterns [9]. Since PG 15, the starts-with operator `^@` can also use a B-tree with the `C` collation [51].
- For identifiers that are never sorted for humans (emails, codes, hashes, slugs), a column declared `COLLATE "C"` is simple: byte-order comparisons are efficient and "stable across all versions" [39].
- `ILIKE` can use a B-tree only when the pattern starts with non-alphabetic characters [1]; otherwise use `pg_trgm` (next section).

```sql
CREATE TABLE api_keys (
    id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    prefix  text COLLATE "C" NOT NULL,
    hash    text COLLATE "C" NOT NULL
);
CREATE INDEX api_keys_prefix_idx ON api_keys (prefix);
SELECT id FROM api_keys WHERE prefix LIKE 'live-%';   -- default opclass is enough
```

### 10.2 Infix and fuzzy search: `pg_trgm`

`pg_trgm` splits text into trigrams (groups of three characters). Its GIN and GiST opclasses support `LIKE`, `ILIKE`, `~` and `~*` (the pattern does not need to be anchored at the start), `=`, and similarity search [23].

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX documents_title_trgm_gin ON documents USING gin (title gin_trgm_ops);

SELECT id FROM documents WHERE title ILIKE '%invoice%';
```

- "The more trigrams in the search string, the more effective the index search is"; a pattern with no extractable trigrams "will degenerate to a full-index scan" [23]. Very short search strings are therefore slow.
- GiST (`gist_trgm_ops`) also supports `ORDER BY title <-> 'word' LIMIT n` (nearest by similarity); GIN does not [23]. More in [full-text and vector search](12-full-text-and-vector-search.md).

### 10.3 One collation per index column

"An index can support only one collation per index column" [10]. A query that compares or sorts with another collation cannot use it.

```sql
-- The index uses the column's default collation, the query asks for "C"
SELECT id FROM documents ORDER BY title COLLATE "C" LIMIT 20;          -- cannot use a default index on title
CREATE INDEX documents_title_c_idx ON documents (title COLLATE "C");    -- this one can
```

### 10.4 ICU and nondeterministic collations

A **nondeterministic** collation can treat different strings as equal, for example case-insensitive or accent-insensitive ICU collations [39].

```sql
CREATE COLLATION case_insensitive (provider = icu, locale = 'und-u-ks-level2', deterministic = false);

CREATE TABLE labels (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name  text COLLATE case_insensitive NOT NULL UNIQUE   -- 'Postgres' and 'postgres' collide
);
SELECT id FROM labels WHERE name = 'POSTGRES';             -- case-insensitive equality via the unique index
```

- Costs: a performance penalty, and B-tree deduplication is disabled for such indexes [39][16].
- `LIKE` works with nondeterministic collations only since PG 18 [54][40], and "there is no index support to make queries fast" for it [70].
- For case-insensitive search, the common alternatives are a `lower()` expression index, the `citext` type, or `ILIKE` with a trigram index [70].

### 10.5 Collation changes can corrupt indexes

Text indexes are sorted with the collation rules of the C library or ICU. If those rules change (for example a glibc upgrade in the operating system), "a query could fail to find data that is actually there, and an update could insert duplicate data that should be disallowed" [58]. After such an upgrade, reindex the affected `text`, `varchar`, `char` and `citext` indexes [58]. The `C` collation does not have this risk [39].

Two related notes: PG 18 asks you to reindex full-text and `pg_trgm` indexes after upgrading a cluster whose default collation provider is ICU or builtin [54]; and the `amcheck` extension can verify B-tree indexes (and GIN indexes with `gin_index_check()` since PG 18) [54].

## 11. Foreign keys need an index on the referencing side

The **referenced** columns of a foreign key always have an index (a primary key or unique constraint). The **referencing** columns do not: "the declaration of a foreign key constraint does not automatically create an index on the referencing columns" [36].

You usually need that index because [36][67]:

1. **Deleting or updating a parent row** makes PostgreSQL look for child rows. Without an index, it scans the whole child table, once per parent row. `ON DELETE CASCADE` makes this visible: deleting 1,000 documents can mean 1,000 scans of `chunks`.
2. **Joins** from parent to children can use a fast nested-loop join with the index.

```sql
-- RAG schema: deleting a document must find its chunks quickly
CREATE INDEX CONCURRENTLY chunks_document_id_idx ON chunks (document_id);
CREATE INDEX CONCURRENTLY orders_user_id_idx ON orders (user_id);
```

You can skip it when the child table is small, or when parent rows are never deleted, their key never changes, and nobody joins on that column [67]. A composite index whose *leading* columns are the foreign-key columns also serves (for example `(user_id, created_at)` covers `user_id`).

Find foreign keys without a matching index (query by Laurenz Albe, CYBERTEC) [67]:

```sql
-- Lists foreign keys whose columns are not the leading columns of a non-partial index
SELECT c.conrelid::regclass AS "table",
       string_agg(a.attname, ',' ORDER BY x.n) AS columns,
       pg_catalog.pg_size_pretty(pg_catalog.pg_relation_size(c.conrelid)) AS size,
       c.conname AS constraint,
       c.confrelid::regclass AS referenced_table
FROM pg_catalog.pg_constraint c
CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS x(attnum, n)
JOIN pg_catalog.pg_attribute a ON a.attnum = x.attnum AND a.attrelid = c.conrelid
WHERE NOT EXISTS
    (SELECT 1 FROM pg_catalog.pg_index i
     WHERE i.indrelid = c.conrelid
       AND i.indpred IS NULL
       AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] OPERATOR(pg_catalog.@>) c.conkey)
  AND c.contype = 'f'
GROUP BY c.conrelid, c.conname, c.confrelid
ORDER BY pg_catalog.pg_relation_size(c.conrelid) DESC;
```

## 12. Indexes on partitioned tables

An index created on a partitioned table is "virtual", like the partitioned table itself: the real data lives in one index per partition [38].

- `CREATE INDEX` on the parent recurses: it attaches an existing equivalent index on each partition, or creates one. Partitions created or attached later get a matching index automatically [12][38].
- `CREATE INDEX CONCURRENTLY` is **not supported** on the partitioned parent [12], and `DROP INDEX CONCURRENTLY` cannot drop a partitioned index [14].
- A unique index or primary key on a partitioned table must include all partition key columns, and the partition key cannot contain expressions; each partition can only check uniqueness inside itself [38].
- `REINDEX` can process all partitions of a partitioned table or index since PG 14, each partition in its own transaction [49][13].

To add an index to a big, live partitioned table without blocking writes, use the three-step method from the documentation [38][12]:

```sql
CREATE TABLE page_views (
    viewed_at  timestamptz NOT NULL,
    user_id    bigint      NOT NULL,
    path       text        NOT NULL
) PARTITION BY RANGE (viewed_at);

CREATE TABLE page_views_2026_09 PARTITION OF page_views
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE page_views_2026_10 PARTITION OF page_views
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

-- 1. Parent index only: reads no data and is created INVALID
CREATE INDEX page_views_user_id_viewed_at_idx ON ONLY page_views (user_id, viewed_at);

-- 2. Build each partition's index without blocking writes (one statement at a time, no transaction)
CREATE INDEX CONCURRENTLY page_views_2026_09_user_id_viewed_at_idx
    ON page_views_2026_09 (user_id, viewed_at);
CREATE INDEX CONCURRENTLY page_views_2026_10_user_id_viewed_at_idx
    ON page_views_2026_10 (user_id, viewed_at);

-- 3. Attach them; the parent becomes VALID once every partition has an attached index
ALTER INDEX page_views_user_id_viewed_at_idx
    ATTACH PARTITION page_views_2026_09_user_id_viewed_at_idx;
ALTER INDEX page_views_user_id_viewed_at_idx
    ATTACH PARTITION page_views_2026_10_user_id_viewed_at_idx;
```

Many partitions times many indexes also means many locks at planning time (section 15). Partitioning design is covered in [schema design](07-schema-design-and-patterns.md).

## 13. Creating and maintaining indexes safely

### 13.1 `CREATE INDEX` versus `CREATE INDEX CONCURRENTLY`

A plain `CREATE INDEX` "locks out writes (but not reads) on the table until it's done" [12]. On a big table that can mean minutes of blocked writes. `CONCURRENTLY` avoids this at the price of more work and some rules:

| | `CREATE INDEX` | `CREATE INDEX CONCURRENTLY` |
|---|---|---|
| Blocks `INSERT`/`UPDATE`/`DELETE` | Yes, for the whole build | No |
| Blocks reads | No | No |
| Work | One table scan | Two table scans, plus waits for older transactions |
| Inside a transaction block | Allowed | Not allowed |
| Several builds on one table at once | Allowed | One concurrent build per table at a time |
| If it fails | Rolled back | Leaves an `INVALID` index behind |
| On a partitioned parent | Allowed | Not supported (see section 12) |

All facts in this table come from the `CREATE INDEX` documentation [12].

How it works: the index is first registered as invalid; then two table scans run in separate transactions. Before each scan, the command waits for existing transactions that have modified the table; after the second scan, it waits for every transaction whose snapshot is older than that scan [12]. A **long-running transaction** or an **idle-in-transaction** session therefore makes `CREATE INDEX CONCURRENTLY` wait. The progress view (section 13.5) shows phases such as `waiting for writers before build` and the `current_locker_pid` it waits for [29].

Migration tools often wrap a migration in a transaction, or send several statements in one batch (which also runs as one transaction). `CREATE INDEX CONCURRENTLY` then fails. Run it as a separate, non-transactional migration step; see [safe migrations](10-safe-schema-migrations.md).

### 13.2 Recovering from a failed concurrent build

A deadlock, a uniqueness violation (for a unique index), a cancel or a timeout leaves an **invalid** index [12]. It "will be ignored for querying purposes because it might be incomplete; however it will still consume update overhead" [12]. `psql`'s `\d table_name` marks it `INVALID`. "The recommended recovery method in such cases is to drop the index and try again"; `REINDEX INDEX CONCURRENTLY` is another option [12]. For a unique index, note that uniqueness is already enforced against other transactions once the second table scan begins [12].

```sql
-- 1. Find invalid indexes (a parent index created with ON ONLY is also invalid until all partitions are attached)
SELECT n.nspname AS schema_name, c.relname AS index_name, t.relname AS table_name
FROM pg_index i
JOIN pg_class c     ON c.oid = i.indexrelid
JOIN pg_class t     ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT i.indisvalid;

-- 2. Drop the leftover and build again (fix duplicate data first if a unique build failed)
DROP INDEX CONCURRENTLY IF EXISTS orders_user_id_created_at_idx;
CREATE INDEX CONCURRENTLY orders_user_id_created_at_idx ON orders (user_id, created_at);
```

### 13.3 Rebuilding with `REINDEX CONCURRENTLY` (PG 12+)

Rebuild an index when it is bloated, corrupted, after a storage parameter change such as `fillfactor`, or after a failed concurrent build [13]. A plain `REINDEX` blocks writes to the table and blocks every query that wants to use that index [13]. `REINDEX ... CONCURRENTLY` (PG 12+ [47]) builds a new copy next to the old one and swaps them [13].

```sql
REINDEX INDEX CONCURRENTLY orders_user_id_created_at_idx;
REINDEX TABLE CONCURRENTLY orders;    -- every index of the table, one after the other
```

- It cannot run in a transaction block, needs disk space for the second copy, and does not process exclusion-constraint indexes [13].
- If it fails, it can leave invalid indexes with the suffix `_ccnew` (drop it and retry) or `_ccold` (the old index; safe to drop, the rebuild succeeded) [13].

### 13.4 Faster builds: memory and parallel workers

- `maintenance_work_mem` (default 64MB) is the memory for one `CREATE INDEX`; GIN builds are especially sensitive to it [32][20]. Raise it in the session that builds the index, not globally.
- Parallel builds: B-tree (PG 11+) [46], BRIN (PG 17+) [53], GIN (PG 18+) [54]. `max_parallel_maintenance_workers` defaults to 2 [32]. Each worker needs at least a 32MB share of `maintenance_work_mem`, plus 32MB for the leader [12].
- With `CONCURRENTLY`, only the first table scan runs in parallel [12].

```sql
-- In the session that builds the index
SET maintenance_work_mem = '2GB';
SET max_parallel_maintenance_workers = 4;
CREATE INDEX CONCURRENTLY documents_tenant_created_id_idx ON documents (tenant_id, created_at, id);
```

### 13.5 Watching progress

`pg_stat_progress_create_index` (PG 12+ [47]) shows every running `CREATE INDEX` and `REINDEX` [29]:

```sql
SELECT p.pid,
       p.relid::regclass       AS table_name,
       p.index_relid::regclass AS index_name,
       p.command,
       p.phase,
       p.current_locker_pid,
       p.lockers_done || '/' || p.lockers_total AS lockers,
       round(100.0 * p.blocks_done / nullif(p.blocks_total, 0), 1) AS blocks_pct,
       round(100.0 * p.tuples_done / nullif(p.tuples_total, 0), 1) AS tuples_pct
FROM pg_stat_progress_create_index p;
```

If the phase is a `waiting for ...` phase, look up `current_locker_pid` in `pg_stat_activity`: it is usually an old open transaction.

### 13.6 Bloat, fillfactor and when to rebuild

**Bloat** is space inside the index that holds no useful entries. `VACUUM` removes dead entries and empty pages can be reused, but the index file does not shrink. Mass deletes, many non-HOT updates, and long transactions (which delay cleanup) leave indexes larger and slower than needed.

- Measure exactly with `pgstatindex()` from the `pgstattuple` extension. It reads every page, so run it off-peak on big indexes [43]. A freshly built B-tree with the default `fillfactor` of 90 has leaf pages about 90 % full [12]; a much lower `avg_leaf_density` means bloat.
- Estimate cheaply with statistics-based queries such as ioguix's `pgsql-bloat-estimation`; the results are approximations [88].
- Fix with `REINDEX INDEX CONCURRENTLY`. Prevent with HOT-friendly indexing, a well-tuned autovacuum, short transactions, deduplication (PG 13+) and bottom-up deletion (PG 14+) [48][49].
- B-tree `fillfactor` defaults to 90 (allowed 10–100) [12]; a change takes full effect only after `REINDEX` [15]. Leave it at the default unless you measured a problem; the **table** `fillfactor` (default 100) matters more, because it controls room for HOT updates [66].

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;
SELECT tree_level, leaf_pages, avg_leaf_density, leaf_fragmentation
FROM pgstatindex('orders_user_id_created_at_idx');
```

### 13.7 Dropping indexes safely

A plain `DROP INDEX` takes an `ACCESS EXCLUSIVE` lock on the **table** [14]. It must wait for running queries, and new queries queue behind it (see the lock queue in [transactions and concurrency](08-transactions-concurrency-locking.md)). Use `DROP INDEX CONCURRENTLY`: one index per statement, no `CASCADE` (so it cannot drop an index that backs a `UNIQUE` or `PRIMARY KEY` constraint), not in a transaction block, and not for partitioned indexes [14].

Before dropping, you can test the effect with HypoPG's `hypopg_hide_index()`, which hides a real index from the planner in your session only [81].

### 13.8 Upgrade notes that affect indexes

- After `pg_upgrade` from PG 12 or older, `REINDEX` B-tree indexes to get deduplication [48].
- PG 14.0 to 14.3 could build incomplete indexes with `CONCURRENTLY`; 14.4 fixed it and recommended rebuilding indexes made with `CONCURRENTLY` on those versions [50].
- After an operating-system upgrade that changes the C library, reindex text indexes (section 10.5) [58].
- PG 18: reindex full-text and `pg_trgm` indexes if the cluster's default collation provider is ICU or builtin [54].

## 14. Finding bad indexes

Index usage counters live in `pg_stat_user_indexes`: `idx_scan` (number of index scans), `last_idx_scan` (PG 16+ [52]), `idx_tup_read` and `idx_tup_fetch` [28]. Read them with care:

- **Counters are per server.** A replica keeps its own statistics [28]. An index with `idx_scan = 0` on the primary may serve all read traffic on a replica. Check every server; pganalyze made its advisor "cluster-aware" for exactly this reason [74].
- **Counters get reset**: by `pg_stat_reset()`, and also after a crash, an immediate shutdown, a start from a base backup, or point-in-time recovery [28]. Check how old they are. (PG 19, beta — may change: `pg_stat_all_indexes` gets its own `stats_reset` column [55].)
- **Wait for a full business cycle**: a monthly report or a yearly batch may need an index that looks unused today.

### 14.1 Unused indexes

Based on Laurenz Albe's query [68]. It skips indexes that enforce constraints, expression indexes (they provide statistics, section 8.3) and partitions of partitioned indexes.

```sql
-- PG 16+; on PG 14–15 remove the last_idx_scan column
SELECT s.schemaname,
       s.relname       AS table_name,
       s.indexrelname  AS index_name,
       s.idx_scan,
       s.last_idx_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size
FROM pg_catalog.pg_stat_user_indexes s
JOIN pg_catalog.pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND 0 <> ALL (i.indkey)                       -- not an expression index
  AND NOT i.indisunique                         -- not a unique index
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                  WHERE c.conindid = s.indexrelid)   -- not backing a constraint
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits inh
                  WHERE inh.inhrelid = s.indexrelid) -- not a partition of a partitioned index
ORDER BY pg_relation_size(s.indexrelid) DESC;

-- How old are the counters?
SELECT stats_reset FROM pg_stat_database WHERE datname = current_database();
```

Before you drop a candidate:

1. Run the query on every replica too [28][74].
2. Check the counter age and the business cycle (above).
3. Think about foreign keys: an index on a referencing column can show 0 scans simply because no parent row was deleted recently. Dropping it makes the next big delete very slow (section 11).
4. Hide it first with `hypopg_hide_index()` and check the important plans [81]; keep its `CREATE INDEX` statement (`SELECT pg_get_indexdef('index_name'::regclass);`) so you can rebuild it.
5. Drop it with `DROP INDEX CONCURRENTLY` (section 13.7).

### 14.2 Duplicate and overlapping indexes

Exact duplicates (same table, columns, operator classes, expressions and predicate), from the PostgreSQL wiki. "Usually it's safe to drop one of them, but I give no guarantees" [57]:

```sql
SELECT pg_size_pretty(sum(pg_relation_size(idx))::bigint) AS size,
       (array_agg(idx))[1] AS idx1, (array_agg(idx))[2] AS idx2,
       (array_agg(idx))[3] AS idx3, (array_agg(idx))[4] AS idx4
FROM (
    SELECT indexrelid::regclass AS idx,
           (indrelid::text ||E'\n'|| indclass::text ||E'\n'|| indkey::text ||E'\n'||
            coalesce(indexprs::text,'')||E'\n' || coalesce(indpred::text,'')) AS key
    FROM pg_index) sub
GROUP BY key HAVING count(*) > 1
ORDER BY sum(pg_relation_size(idx)) DESC;
```

Left-prefix overlap: a non-unique index on `(a)` is usually redundant when an index on `(a, b)` exists, because `(a, b)` serves `WHERE a = ?` too. The smaller index is a bit faster, so drop it only if the write and memory savings matter more. This query lists such pairs for plain B-tree-like cases; review each result by hand (it ignores sort direction options):

```sql
SELECT a.indrelid::regclass   AS table_name,
       a.indexrelid::regclass AS redundant_index,
       b.indexrelid::regclass AS covered_by,
       pg_size_pretty(pg_relation_size(a.indexrelid)) AS redundant_size
FROM pg_index a
JOIN pg_index b
  ON  b.indrelid = a.indrelid
  AND b.indexrelid <> a.indexrelid
  AND b.indnkeyatts >= a.indnkeyatts
  AND (b.indkey::int2[])[0:a.indnkeyatts - 1]      = (a.indkey::int2[])[0:a.indnkeyatts - 1]
  AND (b.indclass::oid[])[0:a.indnkeyatts - 1]     = (a.indclass::oid[])[0:a.indnkeyatts - 1]
  AND (b.indcollation::oid[])[0:a.indnkeyatts - 1] = (a.indcollation::oid[])[0:a.indnkeyatts - 1]
JOIN pg_class ca ON ca.oid = a.indexrelid
JOIN pg_class cb ON cb.oid = b.indexrelid
WHERE ca.relam = cb.relam                          -- same index type
  AND NOT a.indisunique                            -- unique indexes enforce rules: keep them
  AND a.indnatts = a.indnkeyatts                   -- a has no INCLUDE columns
  AND a.indpred IS NULL AND b.indpred IS NULL      -- no partial indexes
  AND a.indexprs IS NULL AND b.indexprs IS NULL    -- no expression indexes
  AND b.indisvalid
  AND (b.indnkeyatts > a.indnkeyatts OR b.indisunique OR b.indexrelid < a.indexrelid)
ORDER BY pg_relation_size(a.indexrelid) DESC;
```

### 14.3 Invalid indexes

Use the query in section 13.2. An invalid index costs writes and serves no reads [12]: drop it or rebuild it.

### 14.4 Oversized indexes and mostly-`NULL` columns

```sql
-- Tables whose indexes take the most space
SELECT t.relname AS table_name,
       pg_size_pretty(pg_table_size(t.oid))   AS table_size,
       pg_size_pretty(pg_indexes_size(t.oid)) AS indexes_size,
       (SELECT count(*) FROM pg_index i WHERE i.indrelid = t.oid) AS index_count
FROM pg_class t
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE t.relkind = 'r'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_indexes_size(t.oid) DESC
LIMIT 20;

-- Single-column, non-partial indexes on columns that are mostly NULL (candidates for WHERE col IS NOT NULL)
SELECT s.schemaname, s.tablename, s.attname, s.null_frac,
       c.relname AS index_name,
       pg_size_pretty(pg_relation_size(c.oid)) AS index_size
FROM pg_stats s
JOIN pg_namespace n ON n.nspname = s.schemaname
JOIN pg_class t     ON t.relname = s.tablename AND t.relnamespace = n.oid
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = s.attname
JOIN pg_index i     ON i.indrelid = t.oid
JOIN pg_class c     ON c.oid = i.indexrelid
WHERE i.indnkeyatts = 1
  AND i.indkey[0] = a.attnum
  AND i.indpred IS NULL
  AND s.null_frac > 0.5
ORDER BY pg_relation_size(c.oid) DESC;
```

The second query follows the method of Haki Benita's article (find indexed columns with a high `null_frac`) [79][30].

### 14.5 Signs of missing indexes

```sql
-- Tables read mostly by sequential scans, with many rows read per scan
SELECT relname,
       seq_scan,
       seq_tup_read,
       idx_scan,
       seq_tup_read / nullif(seq_scan, 0) AS avg_rows_per_seq_scan,
       pg_size_pretty(pg_relation_size(relid)) AS table_size
FROM pg_stat_user_tables
WHERE seq_scan > 0
ORDER BY seq_tup_read DESC
LIMIT 20;
```

A big table with a high `avg_rows_per_seq_scan` is worth a look, but the real answer comes from the queries themselves: use `pg_stat_statements` and `EXPLAIN` ([query optimization](06-query-optimization-and-explain.md)), and the foreign-key query in section 11.

## 15. The cost of over-indexing

"Index shotgun" means creating an index on every column "just in case". Each extra index costs:

- **Slower writes.** Every insert and every non-HOT update writes to every index (section 1.5). Percona's PG 17.4 test: about 1,400 TPS with 7 indexes, about 600 TPS with 39 [75].
- **More WAL, replication traffic, disk space and backup size**: indexes often take as much space as the data itself [68].
- **Less cache** for the data that matters: indexes compete for `shared_buffers` and the OS page cache.
- **Fewer HOT updates**: each indexed column is one more column whose change blocks HOT [26][66].
- **Longer `VACUUM`**: vacuum must clean every index (since PG 14 it may skip index vacuuming when very few entries are dead [49]).
- **Longer planning and lock pressure.** During planning, a query takes a lock on the table and on all its indexes [76]. Up to PG 17 each backend has only 16 "fast-path" lock slots; beyond that, locks go to the shared lock table, and under load this shows up as `LWLock:LockManager` waits [76]. PG 18 scales the fast-path slots with `max_locks_per_transaction` (default 64) [76][54]. GitLab's database guidelines set a limit of 15 indexes per table, and block new indexes on some busy tables because of `LockManager` contention [77].

Each index must pay for itself. Name the queries it serves. Before adding a new index, check whether an existing one can be extended: replacing `(user_id)` with `(user_id, created_at)` serves both query shapes with one index.

## 16. Index design workflow

### 16.1 Steps

1. **Find the queries that matter**: top queries by total time in `pg_stat_statements`, the slow-query log, and the tables from section 14.5. See [query optimization](06-query-optimization-and-explain.md).
2. **Get the real plan**: `EXPLAIN (ANALYZE, BUFFERS)` with realistic parameter values on production-like data (PG 18 adds `BUFFERS` to `EXPLAIN ANALYZE` by default [54]). Small or invented test data gives misleading plans [11].
3. **Design** with the rules of this document and the decision table (section 17): equality → range → sort; partial for hot subsets; `INCLUDE` for index-only scans; the right type and opclass.
4. **Reuse first**: can an existing index be extended or replaced?
5. **Try it for free** with a hypothetical index (16.2).
6. **Build it safely** with `CREATE INDEX CONCURRENTLY` in its own migration step ([safe migrations](10-safe-schema-migrations.md)); check for an `INVALID` result.
7. **Verify**: the plan uses the index and reads fewer buffers; `idx_scan` grows; query time in `pg_stat_statements` drops.
8. **Check the write side**: HOT ratio (section 1.6), WAL volume, insert latency. Drop the indexes the new one made redundant.

### 16.2 Hypothetical indexes with HypoPG

HypoPG creates "hypothetical" indexes that exist only for the planner in your session: no disk, no lock, no build time [81]. Use plain `EXPLAIN`; `EXPLAIN ANALYZE` executes the query and cannot use an index that does not exist.

```sql
CREATE EXTENSION IF NOT EXISTS hypopg;

SELECT * FROM hypopg_create_index('CREATE INDEX ON orders (user_id, created_at)');

EXPLAIN
SELECT id, total_cents
FROM orders
WHERE user_id = 42
ORDER BY created_at DESC
LIMIT 10;                       -- the plan should name the hypothetical index

SELECT hypopg_reset();          -- remove all hypothetical indexes
```

### 16.3 Index advisors

| Tool | What it does | Status (checked 2026-10-05) |
|---|---|---|
| HypoPG | Hypothetical indexes; `hypopg_hide_index()` hides real ones [81] | Maintained: 1.4.2 (2025-06-29) fixed PG 18 compatibility; 1.4.3 (2026-06-20) PG 19 [82] |
| Dexter | CLI: reads queries from `pg_stat_statements`, logs or live activity, tests candidate indexes with HypoPG, dry run unless `--create` [83] | Active: 0.6.3 released 2025-10-15 [84] |
| Supabase `index_advisor` | SQL function `index_advisor(query)`; needs HypoPG; accepts `$1` parameters [85] | "will only recommend single column, B-tree indexes" [86] |
| pganalyze Index Advisor | Workload-wide advice; a constraint-programming model looks for the smallest set of indexes with the lowest write overhead; cluster-aware since February 2026 [74] | Commercial service [74] |

Treat every suggestion as a hypothesis: check write cost, duplicates and the queries it serves. A wider comparison of tools is in [tools by use case](13-tools-by-use-case.md).

### 16.4 Review checklist for a new index

- [ ] It serves named, frequent or critical queries (link the `pg_stat_statements` entry or the code path).
- [ ] Column order: equality columns, then the range or sort column; sort directions and `NULLS` match the `ORDER BY`.
- [ ] No existing index could be extended instead; no duplicate or left-prefix overlap is created.
- [ ] Partial predicate considered (soft delete, status, `IS NOT NULL`); the predicate appears literally in the queries.
- [ ] `INCLUDE` columns only when an index-only scan is the goal, and they are narrow.
- [ ] Expressions match the queries exactly and use only immutable functions.
- [ ] Right type and opclass: `text_pattern_ops`, `jsonb_path_ops`, `gin_trgm_ops`, collation.
- [ ] It does not index a column that changes on most updates (HOT).
- [ ] Built with `CREATE INDEX CONCURRENTLY` outside a transaction, checked for `INVALID`.
- [ ] Verified after the build with `EXPLAIN (ANALYZE, BUFFERS)` and `pg_stat_user_indexes`.

## 17. Decision table: query shape → index

| Query shape | Example | Recommended index |
|---|---|---|
| Equality on one column | `WHERE email = $1` | B-tree `(email)`; `UNIQUE` if it is a business rule |
| Range | `WHERE created_at >= $1` | B-tree `(created_at)` |
| Equality + range | `WHERE user_id = $1 AND created_at >= $2` | B-tree `(user_id, created_at)` |
| Equality + sort + `LIMIT` | `WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20` | B-tree `(user_id, created_at)`; add `INCLUDE (...)` for index-only scans |
| Mixed sort directions | `ORDER BY created_at DESC, id ASC` | B-tree `(created_at DESC, id ASC)` |
| `IN` list | `WHERE status IN ('a', 'b')` | B-tree `(status)`, or a partial index if the values are rare |
| Case-insensitive equality | `WHERE lower(email) = lower($1)` | B-tree `(lower(email))`, or `citext` / nondeterministic collation |
| Prefix `LIKE` | `WHERE email LIKE 'alex%'` | B-tree `(email text_pattern_ops)`, or a `COLLATE "C"` column |
| Infix `LIKE` / `ILIKE` | `WHERE title ILIKE '%invoice%'` | GIN `(title gin_trgm_ops)` |
| `jsonb` containment | `WHERE metadata @> '{"source": "upload"}'` | GIN `(metadata jsonb_path_ops)` |
| `jsonb` key exists | `WHERE metadata ? 'archived_at'` | GIN `(metadata)` (default `jsonb_ops`) |
| `jsonb` single key equality or range | `WHERE metadata ->> 'source' = 'upload'` | B-tree expression `((metadata ->> 'source'))` |
| Array contains / overlaps | `WHERE tags @> ARRAY['pg']`, `tags && $1` | GIN `(tags)` |
| Full-text search | `WHERE search @@ websearch_to_tsquery(...)` | GIN on a `tsvector` column ([12](12-full-text-and-vector-search.md)) |
| Range overlap | `WHERE during && tstzrange(...)` | GiST `(during)` |
| "No overlap" rule | No double booking per room | `EXCLUDE USING gist` + `btree_gist`, or `WITHOUT OVERLAPS` (PG 18+) |
| Nearest neighbor (geometry) | `ORDER BY location <-> point '(x,y)' LIMIT 10` | GiST `(location)` |
| IP network containment | `WHERE network >>= $1::inet` | SP-GiST `(network)`, or GiST `(network inet_ops)` |
| Huge append-only time series | `WHERE created_at BETWEEN $1 AND $2` on billions of rows | BRIN `(created_at)` if correlation is near 1; else B-tree, and consider partitioning |
| Low-cardinality flag, rare value | `WHERE status = 'pending'` (1 % of rows) | Partial B-tree `(...) WHERE status = 'pending'` |
| Soft delete | `WHERE tenant_id = $1 AND deleted_at IS NULL` | Partial B-tree `(tenant_id) WHERE deleted_at IS NULL` |
| One active row per key | One active subscription per user | Partial unique index `(user_id) WHERE status = 'active'` |
| Mostly-`NULL` column | `WHERE cancelled_by IS NOT NULL AND ...` | Partial index `WHERE cancelled_by IS NOT NULL` |
| Equality on long values | `WHERE url = $1` | Hash `(url)`, or B-tree on `md5(url)` |
| Equality on any combination of many columns | Search screens with many optional filters | Separate B-trees combined by bitmaps, or `bloom` |
| Foreign key | `DELETE FROM documents ...` cascading to `chunks` | B-tree on `chunks (document_id)` |
| Vector similarity | `ORDER BY embedding <=> $1 LIMIT 10` | HNSW `(embedding vector_cosine_ops)` ([12](12-full-text-and-vector-search.md)) |

## 18. How other engines differ

| Engine | How the table is stored | What a secondary index points to |
|---|---|---|
| PostgreSQL | Heap: unordered pages | The row's physical location (TID) |
| MySQL / MariaDB (InnoDB) | Inside the primary-key B-tree (the "clustered index") [89] | The primary-key value; the row is then found through the clustered index [89] |
| SQL Server | A clustered index (at most one, rows stored in key order) or a heap [90] | The clustered key, or a row pointer for a heap [90] |

What this means in PostgreSQL:

- The primary key does not decide the physical order, and there is no clustered index. `CLUSTER` reorders a table once by an index; "when the table is subsequently updated, the changes are not clustered", and it holds an `ACCESS EXCLUSIVE` lock while it runs [44]. (PG 19, beta — may change: a new `REPACK` command replaces `VACUUM FULL` and `CLUSTER`, with a `CONCURRENTLY` option [55].)
- In InnoDB a long primary key makes every secondary index bigger [89]; in PostgreSQL every index stores a fixed-size TID instead.
- Insert order still matters for B-tree locality. Random UUIDv4 keys spread inserts over the whole index: "a random UUID-based index will need to keep essentially the whole index in cache, whereas a sequential id index can make do with only a few recent pages" [71]. In Ants Aasma's test on 10 million rows, the same scan read 27,332 buffers with sequential ids, 39,126 with UUIDv7 and 8,562,960 with UUIDv4 (526 ms, 541 ms and 1,213 ms) [71]. Prefer `bigint` identity keys or time-ordered UUIDv7 (`uuidv7()` is built in since PG 18 [54]); key design is in [schema design](07-schema-design-and-patterns.md).
- PostgreSQL's `INCLUDE` plays the role of SQL Server's included columns [90]. Dialect differences in general are in [SQL dialects compared](02-sql-dialects-compared.md).

## Sources

1. [11.2. Index Types](https://www.postgresql.org/docs/18/indexes-types.html) — PostgreSQL 18 docs: operators per index type, prefix `LIKE` with C locale, `ILIKE` limits, `IS NULL`, sorted output.
2. [11.3. Multicolumn Indexes](https://www.postgresql.org/docs/18/indexes-multicolumn.html) — PostgreSQL 18 docs: leftmost-column rule, skip scan behavior, 32-column limit, GiST/GIN/BRIN multicolumn notes.
3. [11.4. Indexes and ORDER BY](https://www.postgresql.org/docs/18/indexes-ordering.html) — PostgreSQL 18 docs: only B-tree sorts, `ORDER BY ... LIMIT`, `ASC`/`DESC`/`NULLS` options, TID tie-breaker.
4. [11.5. Combining Multiple Indexes](https://www.postgresql.org/docs/18/indexes-bitmap-scans.html) — PostgreSQL 18 docs: bitmap AND/OR, lost ordering, single vs multicolumn trade-offs.
5. [11.6. Unique Indexes](https://www.postgresql.org/docs/18/indexes-unique.html) — PostgreSQL 18 docs: only B-tree can be unique, automatic indexes for constraints, `NULLS NOT DISTINCT`.
6. [11.7. Indexes on Expressions](https://www.postgresql.org/docs/18/indexes-expressional.html) — PostgreSQL 18 docs: `lower()` example, parentheses rule, maintenance cost.
7. [11.8. Partial Indexes](https://www.postgresql.org/docs/18/indexes-partial.html) — PostgreSQL 18 docs: predicate implication, parameterized queries, partial unique indexes, not a partitioning substitute.
8. [11.9. Index-Only Scans and Covering Indexes](https://www.postgresql.org/docs/18/indexes-index-only-scans.html) — PostgreSQL 18 docs: index-only scan rules, visibility map, `INCLUDE`, expression-index limitation.
9. [11.10. Operator Classes and Operator Families](https://www.postgresql.org/docs/18/indexes-opclass.html) — PostgreSQL 18 docs: `text_pattern_ops` and related opclasses, C locale.
10. [11.11. Indexes and Collations](https://www.postgresql.org/docs/18/indexes-collations.html) — PostgreSQL 18 docs: one collation per index column.
11. [11.12. Examining Index Usage](https://www.postgresql.org/docs/18/indexes-examine.html) — PostgreSQL 18 docs: `ANALYZE`, real data, small-table caveat, `enable_*` testing.
12. [CREATE INDEX](https://www.postgresql.org/docs/18/sql-createindex.html) — PostgreSQL 18 docs: `CONCURRENTLY` rules and failure mode, `ONLY`, `NULLS NOT DISTINCT`, immutability, storage parameters and defaults, parallel builds, `INCLUDE` rules.
13. [REINDEX](https://www.postgresql.org/docs/18/sql-reindex.html) — PostgreSQL 18 docs: when to reindex, `CONCURRENTLY` steps, `_ccnew`/`_ccold`, locking, partitioned tables.
14. [DROP INDEX](https://www.postgresql.org/docs/18/sql-dropindex.html) — PostgreSQL 18 docs: `ACCESS EXCLUSIVE` lock, `CONCURRENTLY` restrictions.
15. [ALTER INDEX](https://www.postgresql.org/docs/18/sql-alterindex.html) — PostgreSQL 18 docs: `ATTACH PARTITION`, statistics target on expression columns, storage parameters need `REINDEX`.
16. [B-Tree Indexes](https://www.postgresql.org/docs/18/btree.html) — PostgreSQL 18 docs: deduplication and its exceptions, bottom-up deletion, entry size limit, skip support.
17. [Hash Indexes](https://www.postgresql.org/docs/18/hash-index.html) — PostgreSQL 18 docs: 4-byte hash codes, equality only, crash safety, best use cases, growth.
18. [GiST Indexes](https://www.postgresql.org/docs/18/gist.html) — PostgreSQL 18 docs: built-in opclasses and ordering operators, `inet_ops` not the default, build methods, contrib opclasses.
19. [SP-GiST Indexes](https://www.postgresql.org/docs/18/spgist.html) — PostgreSQL 18 docs: space-partitioned structures, built-in opclasses, k-NN support.
20. [GIN Indexes](https://www.postgresql.org/docs/18/gin.html) — PostgreSQL 18 docs: fast update and pending list, build memory, bulk-load advice, built-in opclasses.
21. [BRIN Indexes](https://www.postgresql.org/docs/18/brin.html) — PostgreSQL 18 docs: block ranges, lossy bitmap scans, summarization, minmax-multi and bloom opclasses and parameters.
22. [bloom](https://www.postgresql.org/docs/18/bloom.html) — PostgreSQL 18 docs: bloom index purpose, parameters, example timings, limitations.
23. [pg_trgm](https://www.postgresql.org/docs/18/pgtrgm.html) — PostgreSQL 18 docs: trigram GIN/GiST opclasses, `LIKE`/`ILIKE`/regex support, full-index-scan caveat.
24. [JSON Types](https://www.postgresql.org/docs/18/datatype-json.html) — PostgreSQL 18 docs: `jsonb` indexing, `jsonb_ops` vs `jsonb_path_ops`, expression GIN index.
25. [Range Types](https://www.postgresql.org/docs/18/rangetypes.html) — PostgreSQL 18 docs: GiST/SP-GiST range indexing, exclusion constraints with `btree_gist`.
26. [Heap-Only Tuples (HOT)](https://www.postgresql.org/docs/18/storage-hot.html) — PostgreSQL 18 docs: HOT conditions, summarizing indexes, fillfactor.
27. [Using EXPLAIN](https://www.postgresql.org/docs/18/using-explain.html) — PostgreSQL 18 docs: `Index Searches`, skip scan example, bitmap scans, `LIMIT` plan changes.
28. [The Cumulative Statistics System](https://www.postgresql.org/docs/18/monitoring-stats.html) — PostgreSQL 18 docs: `pg_stat_all_indexes` columns, index search counting, per-server statistics and resets.
29. [Progress Reporting](https://www.postgresql.org/docs/18/progress-reporting.html) — PostgreSQL 18 docs: `pg_stat_progress_create_index` columns and phases.
30. [pg_stats](https://www.postgresql.org/docs/18/view-pg-stats.html) — PostgreSQL 18 docs: `null_frac`, `n_distinct`, `correlation`.
31. [Query Planning configuration](https://www.postgresql.org/docs/18/runtime-config-query.html) — PostgreSQL 18 docs: `enable_*` settings, cost constants and defaults, `plan_cache_mode`.
32. [Resource Consumption configuration](https://www.postgresql.org/docs/18/runtime-config-resource.html) — PostgreSQL 18 docs: `maintenance_work_mem`, `max_parallel_maintenance_workers`, `work_mem` defaults.
33. [Client Connection Defaults](https://www.postgresql.org/docs/18/runtime-config-client.html) — PostgreSQL 18 docs: `gin_pending_list_limit` default.
34. [PREPARE](https://www.postgresql.org/docs/18/sql-prepare.html) — PostgreSQL 18 docs: custom vs generic plans, five-execution rule, `plan_cache_mode`.
35. [INSERT](https://www.postgresql.org/docs/18/sql-insert.html) — PostgreSQL 18 docs: `ON CONFLICT` arbiter index inference rules.
36. [Constraints](https://www.postgresql.org/docs/18/ddl-constraints.html) — PostgreSQL 18 docs: foreign keys are not indexed automatically, unique constraints and `NULLS NOT DISTINCT`.
37. [CREATE TABLE](https://www.postgresql.org/docs/18/sql-createtable.html) — PostgreSQL 18 docs: indexes behind `PRIMARY KEY`/`UNIQUE`, `WITHOUT OVERLAPS`, generated columns.
38. [Table Partitioning](https://www.postgresql.org/docs/18/ddl-partitioning.html) — PostgreSQL 18 docs: indexes on partitioned tables, `ON ONLY` + `ATTACH PARTITION` method, unique-key limitation.
39. [Collation Support](https://www.postgresql.org/docs/18/collation.html) — PostgreSQL 18 docs: nondeterministic collations and their costs, `C` and builtin collations.
40. [Pattern Matching](https://www.postgresql.org/docs/18/functions-matching.html) — PostgreSQL 18 docs: `LIKE` with nondeterministic collations.
41. [Function Volatility Categories](https://www.postgresql.org/docs/18/xfunc-volatility.html) — PostgreSQL 18 docs: `IMMUTABLE` vs `STABLE`, `TimeZone`-dependent functions.
42. [CREATE STATISTICS](https://www.postgresql.org/docs/18/sql-createstatistics.html) — PostgreSQL 18 docs: statistics on a single expression without index maintenance.
43. [pgstattuple](https://www.postgresql.org/docs/18/pgstattuple.html) — PostgreSQL 18 docs: `pgstatindex`, `pgstatginindex`, privileges.
44. [CLUSTER](https://www.postgresql.org/docs/18/sql-cluster.html) — PostgreSQL 18 docs: one-time reorder, `ACCESS EXCLUSIVE` lock, fillfactor advice.
45. [Generated Columns](https://www.postgresql.org/docs/18/ddl-generated-columns.html) — PostgreSQL 18 docs: generated columns are virtual by default.
46. [PostgreSQL 11 release notes](https://www.postgresql.org/docs/11/release-11.html) — postgresql.org: `INCLUDE` covering indexes, parallel B-tree builds.
47. [PostgreSQL 12 release notes](https://www.postgresql.org/docs/12/release-12.html) — postgresql.org: `REINDEX CONCURRENTLY`, `pg_stat_progress_create_index`, GiST `INCLUDE`, B-tree duplicate handling.
48. [PostgreSQL 13 release notes](https://www.postgresql.org/docs/13/release-13.html) — postgresql.org: B-tree deduplication, incremental sort, insert-triggered autovacuum.
49. [PostgreSQL 14 release notes](https://www.postgresql.org/docs/14/release-14.html) — postgresql.org: bottom-up deletion, BRIN minmax-multi and bloom, SP-GiST `INCLUDE`, expression statistics, partitioned `REINDEX`.
50. [PostgreSQL 14.4 release notes](https://www.postgresql.org/docs/release/14.4/) — postgresql.org: `CONCURRENTLY` index corruption fix and rebuild advice.
51. [PostgreSQL 15 release notes](https://www.postgresql.org/docs/15/release-15.html) — postgresql.org: `NULLS NOT DISTINCT`, `^@` with B-tree in C collation.
52. [PostgreSQL 16 release notes](https://www.postgresql.org/docs/16/release-16.html) — postgresql.org: HOT with BRIN, `last_idx_scan`, `n_tup_newpage_upd`, more incremental sorts.
53. [PostgreSQL 17 release notes](https://www.postgresql.org/docs/17/release-17.html) — postgresql.org: faster B-tree `IN` lists, parallel BRIN builds.
54. [PostgreSQL 18 release notes](https://www.postgresql.org/docs/18/release-18.html) — postgresql.org: skip scan, parallel GIN builds, OR-to-array, `Index Searches`, `BUFFERS` by default, `uuidv7()`, `WITHOUT OVERLAPS`, `LIKE` with nondeterministic collations, `gin_index_check()`, reindex advice for FTS/`pg_trgm`.
55. [PostgreSQL 19 release notes (beta 4, as of 2026-09-14)](https://www.postgresql.org/docs/19/release-19.html) — postgresql.org: `REPACK`, per-index `stats_reset`, `inet`/`cidr` GiST opclass change.
56. [indexcmds.c (REL_18_STABLE)](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/commands/indexcmds.c) — PostgreSQL source: "indexes on virtual generated columns are not supported".
57. [Index Maintenance](https://wiki.postgresql.org/wiki/Index_Maintenance) — PostgreSQL wiki: index summary, usage and duplicate-index queries.
58. [Locale data changes](https://wiki.postgresql.org/wiki/Locale_data_changes) — PostgreSQL wiki: collation changes corrupt indexes, reindex advice.
59. [Skip scan (transcript)](https://postgres.fm/episodes/skip-scan/transcript) — Postgres FM with Peter Geoghegan: when skip scan helps, cardinality rule of thumb.
60. [The Search Tree (B-Tree)](https://use-the-index-luke.com/sql/anatomy/the-tree) — Use The Index, Luke (Markus Winand): balanced tree, leaf chain, typical depth.
61. [Greater, Less and BETWEEN](https://use-the-index-luke.com/sql/where-clause/searching-for-ranges/greater-less-between-tuning-sql-access-filter-predicates) — Use The Index, Luke: equality first then ranges, access vs filter predicates.
62. [Myth: most selective column first](https://use-the-index-luke.com/sql/myth-directory/most-selective-first) — Use The Index, Luke: column order is about reuse, not selectivity.
63. [Indexed ORDER BY](https://use-the-index-luke.com/sql/sorting-grouping/indexed-order-by) — Use The Index, Luke: pipelined `ORDER BY`.
64. [Numeric strings](https://use-the-index-luke.com/sql/where-clause/obfuscation/numeric-strings) — Use The Index, Luke: convert the search term, not the column.
65. [Index scan vs. bitmap scan vs. sequential scan (basics)](https://www.cybertec-postgresql.com/en/postgresql-indexing-index-scan-vs-bitmap-scan-vs-sequential-scan-basics/) — CYBERTEC (Hans-Jürgen Schönig): when each scan type is chosen.
66. [HOT updates in PostgreSQL for better performance](https://www.cybertec-postgresql.com/en/hot-updates-in-postgresql-for-better-performance/) — CYBERTEC (Laurenz Albe): HOT conditions, fillfactor, monitoring.
67. [Index your foreign key](https://www.cybertec-postgresql.com/en/index-your-foreign-key/) — CYBERTEC (Laurenz Albe): why FK indexes matter, query for missing ones.
68. [Get rid of your unused indexes!](https://www.cybertec-postgresql.com/en/get-rid-of-your-unused-indexes/) — CYBERTEC (Laurenz Albe): costs of indexes, unused-index query.
69. [Combined indexes vs. separate indexes](https://www.cybertec-postgresql.com/en/combined-indexes-vs-separate-indexes-in-postgresql/) — CYBERTEC (Hans-Jürgen Schönig): composite index vs `BitmapAnd`.
70. [Case-insensitive pattern matching in PostgreSQL](https://www.cybertec-postgresql.com/en/case-insensitive-pattern-matching-in-postgresql/) — CYBERTEC (Laurenz Albe): `lower()`, `citext`, ICU collations, trigram; no index support for `LIKE` with nondeterministic collations.
71. [Unexpected downsides of UUID keys in PostgreSQL](https://www.cybertec-postgresql.com/en/unexpected-downsides-of-uuid-keys-in-postgresql/) — CYBERTEC (Ants Aasma): UUIDv4 vs sequential vs UUIDv7 measurements.
72. [How Postgres chooses which index to use for a query](https://pganalyze.com/blog/how-postgres-chooses-index) — pganalyze (Lukas Fittl): candidate indexes, cost estimation.
73. [Postgres planner quirks: the impact of ORDER BY + LIMIT on index usage](https://pganalyze.com/blog/5mins-postgres-planner-order-by-limit) — pganalyze (Lukas Fittl): the LIMIT trap and workarounds.
74. [pganalyze Index Advisor is now cluster-aware](https://pganalyze.com/blog/cluster-aware-index-advisor) — pganalyze: replica-aware index advice, constraint-programming model, commercial status.
75. [Benchmarking PostgreSQL: The Hidden Cost of Over-Indexing](https://www.percona.com/blog/benchmarking-postgresql-the-hidden-cost-of-over-indexing/) — Percona (Pablo Svampa): TPS and latency with 7 to 39 indexes on PG 17.4.
76. [#PostgresMarathon 2-004: Fast-path locking explained](https://postgres.ai/blog/20251008-postgres-marathon-2-004) — postgres.ai (Nikolay Samokhvalov): 16 fast-path slots up to PG 17, PG 18 change, locks on all indexes at planning.
77. [Adding database indexes](https://docs.gitlab.com/development/database/adding_database_indexes/) — GitLab development docs: questions before adding an index, 15-index limit, partitioned-table helpers.
78. [Re-Introducing Hash Indexes in PostgreSQL](https://hakibenita.com/postgresql-hash-index) — Haki Benita: hash vs B-tree size and speed on PG 13.
79. [The Unexpected Find That Freed 20GB of Unused Index Space](https://hakibenita.com/postgresql-unused-index-size) — Haki Benita: `NULL`s in B-tree indexes, partial index savings.
80. [PostgreSQL BRIN Indexes: Big Data Performance With Minimal Storage](https://www.crunchydata.com/blog/postgresql-brin-indexes-big-data-performance-with-minimal-storage) — Crunchy Data (Jonathan S. Katz): BRIN vs B-tree size and speed on PG 11.2.
81. [HypoPG](https://github.com/HypoPG/hypopg) — GitHub: hypothetical indexes, hide/unhide functions.
82. [HypoPG CHANGELOG](https://raw.githubusercontent.com/HypoPG/hypopg/REL1_STABLE/CHANGELOG.md) — GitHub: release dates and PG 17/18/19 compatibility.
83. [Dexter](https://github.com/ankane/dexter) — GitHub (Andrew Kane): automatic index suggestions with HypoPG.
84. [Dexter CHANGELOG](https://raw.githubusercontent.com/ankane/dexter/master/CHANGELOG.md) — GitHub: release 0.6.3 (2025-10-15).
85. [index_advisor](https://github.com/supabase/index_advisor) — GitHub (Supabase): function signature, HypoPG requirement.
86. [index_advisor: query optimization](https://supabase.com/docs/guides/database/extensions/index_advisor) — Supabase docs: single-column B-tree limitation.
87. [pgvector](https://github.com/pgvector/pgvector) — GitHub: HNSW vs IVFFlat, opclasses, dimension limits, filtering.
88. [pgsql-bloat-estimation](https://github.com/ioguix/pgsql-bloat-estimation) — GitHub (ioguix): statistics-based B-tree and table bloat estimates and their caveats.
89. [Clustered and Secondary Indexes](https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html) — MySQL 8.4 manual: InnoDB clustered index, secondary indexes store the primary key.
90. [Clustered and nonclustered indexes](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/clustered-and-nonclustered-indexes-described) — Microsoft Learn: clustered index, heap, row locators, included columns.
