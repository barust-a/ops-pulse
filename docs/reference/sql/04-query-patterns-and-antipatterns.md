# Writing Good SQL: Patterns, Recipes and Anti-Patterns

> Part of the [SQL & PostgreSQL reference library](README.md) · Last researched: 2026-10-05 · Targets PostgreSQL 14–18 (19 beta noted where relevant)

**What this covers.** How to write SQL that is correct, readable and fast in PostgreSQL: style, sargable filters, joins, pagination, counting, top-N per group, a cookbook of recipes, write patterns (bulk insert, upsert, batches), CTE/view/function trade-offs, application patterns (N+1, batching), safe dynamic SQL, an anti-pattern catalog and a review checklist. This document **owns keyset pagination and upsert patterns**. Syntax basics: [01](01-sql-fundamentals.md), [03](03-postgresql-features-and-types.md). Index internals: [05](05-indexing.md). Reading plans: [06](06-query-optimization-and-explain.md). Features marked "(PG 19, beta — may change)" are in the PostgreSQL 19 beta 4 documentation and were not among the features reverted in that beta [32].

## Key rules (TL;DR)

1. Think in sets: one statement that filters, joins and aggregates beats a loop of small queries.
2. Make the query correct first, then measure with `EXPLAIN (ANALYZE, BUFFERS)` before you optimize ([06](06-query-optimization-and-explain.md)).
3. Never wrap an indexed column in a function, cast or arithmetic in `WHERE`; compare the raw column to a computed value, or add an expression index.
4. Filter time with half-open ranges: `created_at >= $1 AND created_at < $2`. Never `BETWEEN`, never `date(created_at) = $1`.
5. Use `NOT EXISTS` to find rows without a match. Never use `NOT IN (subquery)`: one `NULL` makes it return nothing.
6. Use `EXISTS` to test for related rows, not `count(*) > 0` and not `JOIN` + `DISTINCT`.
7. Aggregate child tables before you join them, so one-to-many joins do not multiply rows and inflate sums.
8. Treat `DISTINCT` as a smell: find the join that creates duplicates. Use `UNION ALL` unless you need de-duplication.
9. Paginate with keyset (seek) pagination: `WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT n`, with an index on the same columns.
10. Add a unique tie-breaker (usually the primary key) to every `ORDER BY` used with `LIMIT` or pagination.
11. Do not show exact total counts on big tables; show an estimate or a capped count ("1,000+").
12. Choose top-N per group by data shape: `DISTINCT ON` (one row, simple), `row_number()` (N rows, portable), `LATERAL … LIMIT` (few groups, good index).
13. Write explicit column lists: no `SELECT *` in application code; always name the columns of an `INSERT`.
14. Write explicit `INNER JOIN` / `LEFT JOIN … ON` with qualified column names. Never use comma joins.
15. Bulk-write with multi-row `VALUES`, `INSERT … SELECT FROM unnest($1::type[], …)` or `COPY`, never one `INSERT` per row in a loop.
16. Upsert with `INSERT … ON CONFLICT … DO UPDATE … WHERE (…) IS DISTINCT FROM (…)`; remember that `RETURNING` returns nothing for skipped and `DO NOTHING` rows.
17. Update and delete large sets in batches of a few thousand rows, one short transaction per batch.
18. Do not rewrite rows that would not change: add `WHERE col IS DISTINCT FROM new_value`.
19. Use `RETURNING` to get generated ids and changed values in the same round trip.
20. Pass a list as one array parameter (`= ANY($1::bigint[])`), not as a generated `IN ($1, $2, …)` list.
21. Remove N+1 queries: load related rows for the whole page in one query.
22. Never concatenate user input into SQL: values go in parameters, identifiers come from a whitelist or `format('%I')` / `escapeIdentifier` ([11](11-security.md)).
23. Use CTEs for readability; add `MATERIALIZED` only when you want an optimization fence, and comment why.
24. Bound every query: `LIMIT` for lists, batches for jobs, a cursor or `COPY` for exports.
25. Use `FILTER` for conditional aggregates and window functions for running totals, rankings, gaps and islands.

**Example tables** used below (design rules in [07](07-schema-design-and-patterns.md)):

```sql
-- users       (id bigint PK, email text, phone text, created_at timestamptz)
-- orders      (id bigint PK, user_id bigint FK -> users, status text, total_cents bigint,
--              paid_at timestamptz NULL, created_at timestamptz)
-- order_items (order_id bigint FK -> orders, product_id bigint, quantity integer,
--              unit_price_cents bigint, PRIMARY KEY (order_id, product_id))
-- documents   (id bigint PK, tenant_id bigint, title text, body text /* large */,
--              version integer, created_at timestamptz)
-- payments, products, events, tags, categories: columns shown where used.
```

## 1. Mindset

### 1.1 Think in sets, not in loops

Every statement has a fixed cost: a network round trip, parsing, planning and a transaction. When you send one statement for a whole set, the planner can pick hash or merge joins, use indexes and process millions of rows in one pass. When you loop in the application (or in a PL/pgSQL `FOR` loop), you pay the fixed cost once per row, and the planner only sees tiny queries. GitLab: moving query logic out of PostgreSQL into application code "is detrimental because PostgreSQL has a query optimizer" [8]. jOOQ: "let the database do the processing and fetch only the results" [45].

```sql
-- Bad: the application loads 10,000 pending orders and runs this once per order.
UPDATE orders SET status = 'expired' WHERE id = $1;

-- Good: one set-based statement (batch it if the set is huge, see 9.8).
UPDATE orders
SET status = 'expired'
WHERE status = 'pending' AND created_at < now() - INTERVAL '7 days';
```

### 1.2 Let the database filter, join, aggregate, sort and paginate

Put filters in `WHERE`, not in application code after a full fetch. Join in SQL, not "fetch list A, fetch list B, match in memory" [45]. Aggregate in SQL (`GROUP BY`, `FILTER`, window functions). Sort and paginate in SQL: "Let the database handle the pagination, filtering, and data retrieval" [49].

### 1.3 Correct first, then measure, then optimize

1. Write the simplest **correct** query. Test `NULL`s, duplicates, empty inputs and time zones.
2. Test it on a realistic data volume: a query that is fast on 1,000 rows can be slow on 10 million.
3. Run `EXPLAIN (ANALYZE, BUFFERS)` and find the expensive node ([06](06-query-optimization-and-explain.md)).
4. Change one thing (rewrite, index, statistics), then measure again.

Do not add indexes "just in case": that is Karwin's *Index Shotgun* anti-pattern [88] ([05](05-indexing.md)).

## 2. Style guide

Readable SQL is easier to review, and reviewers catch more bugs in it.

### 2.1 What the reference guides say

| Topic | sqlstyle.guide [6] | GitLab Data team [7] | dbt Labs [14] | SQLFluff defaults [9] |
|---|---|---|---|---|
| Keyword case | UPPERCASE | UPPERCASE (keywords, types, functions) | lowercase | "consistent": any case, but one |
| Commas | trailing | trailing | trailing | trailing (LT04) [11] |
| Indentation | right-aligned keyword "river" | 2 spaces (config) | 4 spaces | 4 spaces |
| Aliases | always `AS`; short (`staff AS s`) | `AS`; full names or 4+ characters | `as`; no initialisms | `AS` required |
| Join type | `JOIN` / `INNER JOIN` | explicit joins, no `USING` | `inner join`, no `right join` | bare `JOIN` flagged (AM05) [10] |
| Qualified columns | — | always when joining | always when joining | when 2+ tables (RF02) [13] |
| `SELECT *` | — | — | only `select * from final` | flagged (AM04) [10] |
| Line length | — | 80–100 | 80 | 80 |

**Where they disagree:** keyword case (UPPERCASE vs lowercase), alias length (short correlation names vs full names) and layout (the "river" vs plain indentation). On commas they agree: all default to **trailing** commas. Leading commas are a minority style; SQLFluff can enforce them if a team chooses so [11].

### 2.2 Recommended house style

- **Case**: keywords UPPERCASE (`SELECT`, `LEFT JOIN`); identifiers, functions and types lowercase (`orders`, `count(*)`, `timestamptz`), as in the PostgreSQL docs.
- **Names**: lowercase `snake_case`, never quoted. PostgreSQL folds unquoted names to lower case, so `"UserId"` must be quoted forever [1]. Naming rules: [07](07-schema-design-and-patterns.md).
- **Layout**: one clause per line (`SELECT`, `FROM`, each `JOIN`, `WHERE`, `GROUP BY`, `ORDER BY`, `LIMIT`); a short select list may stay on one line, a long one gets one column per line; 4-space indent; trailing commas; lines under ~100 characters.
- **Aliases**: always `AS`; the table name or a meaningful abbreviation (`orders AS o`, `order_items AS oi`), never `a`, `b`, `t1`.
- **Joins**: always the join type (`INNER JOIN`, `LEFT JOIN`) with `ON`; never comma joins; never `RIGHT JOIN` (swap the tables and use `LEFT JOIN`).
- **Columns**: qualify every column (`o.status`) as soon as there are two tables; no `SELECT *` in application code; every `INSERT` names its columns.
- **CTEs** for multi-step logic, named after their content (`paid_orders`, `order_totals`).
- **Not equal**: `<>` (standard; PostgreSQL also accepts `!=`). **Comments**: `--` or `/* */`, explaining *why*, not *what*.

### 2.3 Example

```sql
-- Bad: comma join, SELECT *, unqualified column, one long line, no tie-breaker.
select * from users u, orders o where u.id = o.user_id and status = 'paid' order by o.created_at desc limit 20;

-- Good
SELECT u.id AS user_id, u.email, o.id AS order_id, o.total_cents, o.created_at
FROM orders AS o
INNER JOIN users AS u ON o.user_id = u.id
WHERE o.status = 'paid' AND o.created_at >= $1
ORDER BY o.created_at DESC, o.id DESC
LIMIT 20;
```

### 2.4 Explicit `JOIN … ON`, never comma joins

With comma joins the join conditions hide among the filters in `WHERE`; forget one and you get a silent Cartesian product (every row times every row). With `JOIN … ON`, a missing condition is a syntax error. Mixing both styles also breaks scoping: in `FROM a, b JOIN c ON c.x = a.x`, `a` is not visible inside the `ON` clause, and PostgreSQL raises an error. Write `CROSS JOIN` when you really want a Cartesian product.

### 2.5 Explicit column lists

`SELECT *` is Karwin's *Implicit Columns* anti-pattern [88] (SQLFluff AM04 [10]):

- Results change when someone adds, removes or reorders a column; positional code and `UNION` inputs break.
- You transfer unused data. Large values (`documents.body`, embeddings, big `jsonb`) are stored out of line (TOAST) and cost extra reads and decompression [62].
- It prevents index-only scans and hides which columns the code depends on.

`SELECT *` is fine inside `EXISTS (…)`, in `count(*)` and in ad-hoc psql sessions.

```sql
INSERT INTO tags VALUES (DEFAULT, 'postgres');   -- Bad: breaks when a column is added
INSERT INTO tags (name) VALUES ('postgres');     -- Good
```

### 2.6 Lint it

SQLFluff (4.x in 2026) enables all its rules by default (`rules = all`) [9]. A starting `.sqlfluff` for this style:

```ini
[sqlfluff]
dialect = postgres
max_line_length = 100
# LT09 forces one select target per line; we allow short lists on one line.
exclude_rules = layout.select_targets

[sqlfluff:rules:capitalisation.keywords]
capitalisation_policy = upper

[sqlfluff:rules:capitalisation.functions]
extended_capitalisation_policy = lower

[sqlfluff:rules:capitalisation.types]
extended_capitalisation_policy = lower
```

SQL inside TypeScript template strings is not linted automatically: keep long queries in `.sql` files, or review them against [section 14](#14-query-review-checklist).

## 3. Sargable predicates: let the index do the work

A predicate (a condition in `WHERE` or `ON`) is **sargable** ("Search ARGument ABLE") when the database can answer it with an index lookup or range scan. Rule: **leave the indexed column alone on one side of the operator; put all computation on the other side** [16]. Index design: [05](05-indexing.md).

### 3.1 No functions or casts on the indexed column

An index on `created_at` stores `created_at`, not `date(created_at)`. For the planner, a function is a black box [15].

```sql
-- Bad: the function runs on every row; a plain index on created_at is useless.
SELECT id FROM orders WHERE date(created_at) = '2026-10-01';
SELECT id FROM orders WHERE extract(year FROM created_at) = 2026;

-- Good: half-open range on the raw column (midnight UTC).
SELECT id FROM orders
WHERE created_at >= TIMESTAMPTZ '2026-10-01 00:00:00+00'
  AND created_at < TIMESTAMPTZ '2026-10-02 00:00:00+00';

-- Good: "that day in Paris", computed on the constant side.
SELECT id FROM orders
WHERE created_at >= (TIMESTAMP '2026-10-01' AT TIME ZONE 'Europe/Paris')
  AND created_at < (TIMESTAMP '2026-10-02' AT TIME ZONE 'Europe/Paris');
```

- Use `>= start AND < end`. `BETWEEN` includes both ends, so a row at exactly midnight belongs to two days [1].
- With `timestamptz`, "a day" depends on a time zone: choose one and compute the bounds (in SQL as above, or in the application).
- An expression index cannot rescue `created_at::date` on a `timestamptz` column: the cast depends on the session `TimeZone`, so it is not immutable.
- When you must filter on an expression (such as `lower(email)`), create an **expression index** on exactly that expression; it adds work to every insert and non-HOT update [22].

### 3.2 No arithmetic on the indexed column

The planner does not solve equations [16]. Move constants to the other side.

```sql
SELECT id FROM orders WHERE total_cents + 500 > 10000;            -- Bad
SELECT id FROM orders WHERE total_cents > 10000 - 500;            -- Good
SELECT id FROM orders WHERE created_at + INTERVAL '30 days' < now();   -- Bad
SELECT id FROM orders WHERE created_at < now() - INTERVAL '30 days';   -- Good
```

### 3.3 `LIKE`: prefix patterns versus leading wildcards

| Pattern | B-tree index? | Use |
|---|---|---|
| `email LIKE 'alice%'` | Yes with the `C` collation or a `text_pattern_ops` index [20] | B-tree `text_pattern_ops` |
| `title LIKE '%invoice%'`, `ILIKE` | No [18] | `pg_trgm` GIN index [19] |
| Words in documents | No | Full-text search ([12](12-full-text-and-vector-search.md)) |

```sql
CREATE INDEX users_email_pattern_idx ON users (email text_pattern_ops);   -- prefix LIKE
CREATE EXTENSION IF NOT EXISTS pg_trgm;                                   -- trusted extension [19]
CREATE INDEX documents_title_trgm_idx ON documents USING gin (title gin_trgm_ops);
SELECT id, title FROM documents WHERE title ILIKE '%invoice%';
```

- A `text_pattern_ops` index does not serve `<`, `>` or `ORDER BY` in your collation; keep a normal index too if you need them [20].
- Trigram search needs at least one 3-character trigram: "a pattern with no extractable trigrams will degenerate to a full-index scan" [19].
- `LIKE '%word%'` as a search engine is Karwin's *Poor Man's Search Engine* [88].

### 3.4 Case-insensitive matching

| Option | Notes |
|---|---|
| Normalize on write (store lowercase) | Simplest; a plain index works |
| Expression index on `lower(email)`, query `lower(email) = lower($1)` | The query must repeat the exact expression [22] |
| `citext` type | Trusted, but slower than `text`; the docs now suggest nondeterministic collations instead [21] |
| Nondeterministic ICU collation | Handles more Unicode cases [21]; `LIKE` on them needs PG 18+ [25] |
| `casefold()` (PG 18+) | More correct Unicode case folding than `lower()` [25] |

```sql
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
SELECT id FROM users WHERE lower(email) = lower($1);
```

### 3.5 Implicit casts and parameter type mismatches

When the two sides have different types, PostgreSQL casts one of them. If it casts the **column**, the column's index is not used.

- `bigint` column versus a `numeric` value: PostgreSQL casts the column to `numeric`. pganalyze shows an indexed id lookup turning into a sequential scan, about 1000x slower, when a number too large for `bigint` arrived [23]. Fix: cast the parameter (`$1::bigint`) and validate input [23].
- `char(n)` compared with `text` "may break index usage" [1]: use `text`.
- Join columns must have the same type on both sides (`orders.user_id` and `users.id` both `bigint`); fix mismatches in the schema.
- node-postgres sends values as text without declaring parameter types [85][94], so the server infers types from the query. Trouble comes from casts on the wrong side:

```sql
SELECT id FROM users WHERE id::text = $1;      -- Bad: the column is cast, index ignored
SELECT id FROM users WHERE id = $1::bigint;    -- Good: the parameter is cast
```

### 3.6 `OR` across different columns

A single index scan combines conditions with `AND` only. For `a = 5 OR b = 6`, PostgreSQL needs one index per column and merges them with a **BitmapOr** [24]. When the `OR` spans joined tables or must feed `ORDER BY … LIMIT`, rewrite it as a `UNION`:

```sql
SELECT id FROM users WHERE email = $1 OR phone = $2;    -- fine with one index per column

SELECT u.id FROM users AS u WHERE u.email = $1
UNION                                                   -- not UNION ALL: a user can match both
SELECT u.id FROM users AS u WHERE u.phone = $2;
```

GitLab measured an OR-across-joins query at about 800 ms and its `UNION` rewrite at about 15 ms [8]. An `OR` on the **same** column is fine: write `status IN ('a', 'b')` or `status = ANY($1)`; PG 18 also turns such `OR` lists into arrays automatically [25].

### 3.7 Catch-all "optional filter" queries

```sql
-- Bad: one static query for every combination of optional filters.
SELECT id FROM orders
WHERE ($1::bigint IS NULL OR user_id = $1) AND ($2::text IS NULL OR status = $2);
```

Markus Winand calls this "smart logic" "one of the worst performance anti-patterns of all": one cached plan must serve every combination, so it is planned for the worst case [17]. PostgreSQL's first executions use custom plans that can simplify it, but a later generic plan often scans the table [63]. Build only the predicates you need, still with parameters ([section 12](#12-dynamic-sql-done-safely)) [17].

### 3.8 Quick reference

| Instead of | Write | Or add |
|---|---|---|
| `date(created_at) = $1` | `created_at >= $1 AND created_at < $1 + INTERVAL '1 day'` (`$1` a `timestamptz`) | — |
| `extract(year FROM created_at) = 2026` | `created_at >= '2026-01-01' AND created_at < '2027-01-01'` | — |
| `lower(email) = $1` | same | expression index on `lower(email)` |
| `total_cents + 500 > $1` | `total_cents > $1 - 500` | — |
| `title LIKE '%x%'` | same | `pg_trgm` GIN index, or full-text search |
| `id::text = $1` | `id = $1::bigint` | — |
| `coalesce(deleted_at, 'infinity') > now()` | `(deleted_at IS NULL OR deleted_at > now())` | partial index ([05](05-indexing.md)) |
| `a = $1 OR b = $2` | same (BitmapOr) or `UNION` | one index per column |
| `($1 IS NULL OR col = $1)` | add the predicate only when `$1` is set | — |

## 4. Filtering and joining

### 4.1 Semi-joins: `EXISTS` versus `IN` versus `JOIN`

A **semi-join** returns each left row **at most once** if at least one match exists ("users who placed a paid order").

```sql
-- Good: EXISTS stops at the first match. (u.id IN (SELECT o.user_id ...) is also fine.)
SELECT u.id, u.email
FROM users AS u
WHERE EXISTS (SELECT 1 FROM orders AS o WHERE o.user_id = u.id AND o.status = 'paid');

-- Bad: one row per paid order, then DISTINCT throws the copies away.
SELECT DISTINCT u.id, u.email
FROM users AS u
INNER JOIN orders AS o ON o.user_id = u.id
WHERE o.status = 'paid';
```

PostgreSQL turns `IN (subquery)` and `EXISTS (subquery)` into semi-joins, so all join methods are available [47]; PG 17 also turns correlated `IN` subqueries into joins [26]. GitLab recommends `WHERE EXISTS` "whenever possible" [8]. Join only when you need columns of the other table.

### 4.2 Anti-joins: `NOT EXISTS` versus `NOT IN` versus `LEFT JOIN … IS NULL`

An **anti-join** returns left rows with **no** match ("users who never ordered").

```sql
-- Good: NOT EXISTS (anti-join, NULL-safe).
SELECT u.id FROM users AS u
WHERE NOT EXISTS (SELECT 1 FROM orders AS o WHERE o.user_id = u.id);

-- Good: LEFT JOIN ... IS NULL on a NOT NULL column of the right table.
SELECT u.id FROM users AS u
LEFT JOIN orders AS o ON o.user_id = u.id
WHERE o.id IS NULL;

-- Bad: if any orders.user_id is NULL, this returns no rows at all.
SELECT u.id FROM users AS u
WHERE u.id NOT IN (SELECT o.user_id FROM orders AS o);
```

**The `NOT IN` trap.** `x NOT IN (1, NULL)` means `x <> 1 AND x <> NULL`; the second part is unknown, so the result is never true: "the result of the NOT IN construct will be null, not true" [5]. For the same reason PostgreSQL cannot turn `NOT IN (subquery)` into an anti-join [47]. It uses a hashed subplan (only for small results) or a plain subplan, which is O(N²): performance "can look good in small-scale tests but then slow down by 5 or more orders of magnitude once a size threshold is crossed" [1]. Laurenz Albe: "never use NOT IN with a subquery and always use NOT EXISTS instead" [47].

- `NOT EXISTS` and `LEFT JOIN … IS NULL` get the same anti-join plan [93]. Prefer `NOT EXISTS`: it states the intent and cannot add rows by mistake.
- `NOT IN` with constants that cannot be `NULL` is fine: `status NOT IN ('cancelled', 'refunded')` [1].
- PG 19 beta converts `NOT IN` to an anti-join when it can prove that no `NULL`s exist (PG 19, beta — may change) [31]. The semantics do not change, so keep writing `NOT EXISTS`.

### 4.3 Aggregate before you join (avoid fan-out)

**Fan-out**: joining one parent row to **two** independent child tables returns every item times every payment, so every `sum()` is multiplied.

```sql
-- Bad: an order with 3 items and 2 payments gives 6 rows; both sums are wrong.
SELECT o.id, sum(oi.quantity * oi.unit_price_cents) AS items_cents, sum(p.amount_cents) AS paid_cents
FROM orders AS o
LEFT JOIN order_items AS oi ON oi.order_id = o.id
LEFT JOIN payments AS p ON p.order_id = o.id
GROUP BY o.id;

-- Good: aggregate each child table first, then join one row per order.
WITH item_totals AS (
    SELECT oi.order_id, sum(oi.quantity * oi.unit_price_cents) AS items_cents
    FROM order_items AS oi
    GROUP BY oi.order_id
),
payment_totals AS (
    SELECT p.order_id, sum(p.amount_cents) AS paid_cents
    FROM payments AS p
    GROUP BY p.order_id
)
SELECT o.id, coalesce(it.items_cents, 0) AS items_cents, coalesce(pt.paid_cents, 0) AS paid_cents
FROM orders AS o
LEFT JOIN item_totals AS it ON it.order_id = o.id
LEFT JOIN payment_totals AS pt ON pt.order_id = o.id;
```

A filter such as `WHERE o.id = $1` is pushed into the grouped CTEs (the grouping column is the join key), so this shape also works for one order. PG 19 beta can aggregate before joins on its own ("eager aggregation") to process fewer rows (PG 19, beta — may change) [31]; that is a speed feature, it does not fix a wrong query. A query that answers many questions at once and multiplies rows is Karwin's *Spaghetti Query* [88]: split it into named steps.

### 4.4 `DISTINCT` is a smell; prefer `UNION ALL`

If you add `DISTINCT` to remove duplicate rows, a join is probably wrong: "When you get unwanted duplicates, always review your JOIN predicates" [45]. Use `EXISTS` (4.1) or pre-aggregate (4.3). Legitimate uses: listing distinct values of a column, or cleaning truly duplicated data. Likewise `UNION` de-duplicates the whole result (a sort or hash): write `UNION ALL` unless you need that [45][14]; SQLFluff (AM02) asks you to say which one you mean [10].

### 4.5 Accidental Cartesian products

Symptoms: the row count explodes, sums are too large, the query is slow and memory-hungry. Causes: a comma join without its condition, `ON true` by mistake, or a join on a non-unique column (by `name` instead of `id`). Count rows before and after each join while developing, join on keys, and compare `EXPLAIN` row estimates with what you expect ([06](06-query-optimization-and-explain.md)).

### 4.6 `LATERAL`: a subquery per row

A `LATERAL` subquery in `FROM` can reference columns of earlier `FROM` items and is evaluated once per row of them [51]. Use it for top-N per group (example in 7.3), unpivoting (8.7) and set-returning functions per row. `CROSS JOIN LATERAL (…)` drops left rows without results; `LEFT JOIN LATERAL (…) AS x ON true` keeps them.

### 4.7 Conditional aggregation with `FILTER`

`FILTER (WHERE …)` feeds only some rows to one aggregate [52]. It is standard SQL and replaces `sum(CASE WHEN … END)` [55].

```sql
SELECT date_trunc('month', o.created_at) AS month_start, count(*) AS all_orders,
       count(*) FILTER (WHERE o.status = 'paid') AS paid_orders,
       sum(o.total_cents) FILTER (WHERE o.status = 'paid') AS paid_cents
FROM orders AS o
GROUP BY month_start
ORDER BY month_start;
```

### 4.8 `NULL` essentials

Mishandling `NULL` is Karwin's *Fear of the Unknown* [88]; "NULL is also called UNKNOWN" [45].

- `col = NULL` is never true: use `IS NULL` / `IS NOT NULL`.
- Null-safe comparison: `a IS NOT DISTINCT FROM b` (equal) and `a IS DISTINCT FROM b` (changed) never return `NULL` [5].
- `count(col)` skips `NULL`s, `count(*)` counts rows; `sum()` of zero rows is `NULL`, so write `coalesce(sum(x), 0)` [69].
- `'a' || NULL` is `NULL`; `concat('a', NULL)` is `'a'`.
- `NULL`s sort last ascending and first descending by default [91]; write `NULLS LAST` when it matters.

## 5. Pagination

This section is the library's reference for pagination.

### 5.1 Why `OFFSET` gets slow (and wrong)

```sql
SELECT id, title, created_at FROM documents
WHERE tenant_id = $1
ORDER BY created_at DESC, id DESC
LIMIT 50 OFFSET 4950;                  -- page 100
```

- **Slow**: "The rows skipped by an OFFSET clause still have to be computed inside the server" [4]. Page 100 computes 5,000 rows and discards 4,950 [48]; each page is slower than the last.
- **Wrong under writes**: an insert before the current position repeats a row on the next page; a delete makes one vanish [2][48].
- **Acceptable** for small or bounded results, users who stay on the first pages, or admin screens that need page numbers [48]. Cap the maximum page.

### 5.2 Keyset (seek) pagination

Remember the sort key of the last row shown, and ask for the rows *after* it. The database seeks to that point in the index and reads one page [3].

```sql
-- First page.
SELECT id, title, created_at FROM documents
WHERE tenant_id = $1
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- Next page: $2, $3 = created_at and id of the LAST row of the previous page.
SELECT id, title, created_at FROM documents
WHERE tenant_id = $1 AND (created_at, id) < ($2, $3)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

The row comparison `(created_at, id) < ($2, $3)` works like dictionary order: it means `created_at < $2 OR (created_at = $2 AND id < $3)` [5], and PostgreSQL uses an index for it [3]. Every page costs the same, no row is skipped or repeated, and each page sees fresh data [48]. Limits: no "jump to page 37", and the index must be designed for the query [2][48].

### 5.3 The matching index

```sql
CREATE INDEX documents_tenant_created_id_idx ON documents (tenant_id, created_at, id);
```

- Equality columns first (`tenant_id`), then the `ORDER BY` columns in order.
- B-trees can be read backwards, so this index also serves `ORDER BY created_at DESC, id DESC` [78]. You need `DESC` in the index only for mixed directions (5.5).
- With `ORDER BY … LIMIT n` and a matching index, the first n rows are read "without scanning the remainder at all" [78]. In `EXPLAIN`, expect an `Index Scan` (or `Index Scan Backward`) under `Limit`, and **no** `Sort` ([06](06-query-optimization-and-explain.md)).

### 5.4 Unique tie-breaker, going backwards

If two rows share a `created_at`, their order is undefined and a page boundary between them repeats one row and loses the other. Use "an ORDER BY clause that constrains the result rows into a unique order" [4]: add the primary key last (`ORDER BY created_at DESC, id DESC`) [3][8]. If ids grow with time (identity columns, `uuidv7()` in PG 18+ [25]), ordering by `id` alone is often enough [8].

For the **previous** page, reverse the comparison and the order, then restore display order:

```sql
-- $2, $3 = created_at and id of the FIRST row of the current page.
SELECT p.id, p.title, p.created_at
FROM (
    SELECT id, title, created_at FROM documents
    WHERE tenant_id = $1 AND (created_at, id) > ($2, $3)
    ORDER BY created_at ASC, id ASC
    LIMIT 20
) AS p
ORDER BY p.created_at DESC, p.id DESC;
```

### 5.5 Mixed directions and nullable keys

A row comparison needs every column in the **same** direction. For `ORDER BY score DESC, id ASC`, expand the condition and keep a redundant range on the first column so the index range scan still works:

```sql
CREATE INDEX players_score_id_idx ON players (score DESC, id ASC);

SELECT id, score FROM players
WHERE score <= $1 AND (score < $1 OR (score = $1 AND id > $2))
ORDER BY score DESC, id ASC
LIMIT 20;
```

Sort keys should be `NOT NULL`: a comparison with `NULL` is unknown, so rows with `NULL` keys silently disappear from keyset pages. Otherwise sort on `coalesce(col, <sentinel>)` in both the index and the query.

### 5.6 Keyset cursors in an API (TypeScript)

- Return the last row's key as an **opaque cursor** (for example base64 of `{"created_at": "…", "id": 123}`). It comes back as untrusted input: decode, validate, pass as parameters.
- **Precision trap**: PostgreSQL timestamps have microseconds, a JavaScript `Date` has milliseconds. node-postgres parses `timestamptz` into `Date`, so a cursor built from it can skip or repeat rows. Select the key as text for the cursor (`created_at::text AS cursor_created_at`) and send it back as `$2::timestamptz`, or paginate on a time-ordered `id`.

### 5.7 Total counts

"I have seen many cases where the count(*) queries to calculate the total result set count were the most expensive queries in an application's workload" (Laurenz Albe) [48]. In order of preference [48][49]: (1) show no total, only "next"/"previous"; (2) show an estimate (6.4); (3) show a capped count such as "1,000+" (GitLab's approach [49]); (4) compute an exact count on demand, once, not for every page [48].

```sql
SELECT count(*) AS capped_count               -- 1001 means "more than 1,000"
FROM (SELECT 1 FROM documents WHERE tenant_id = $1 LIMIT 1001) AS capped;
```

### 5.8 Exports and batch jobs

Do not page through a whole table with `OFFSET` to export or process it.

- **Keyset loop** on the primary key: `WHERE id > $1 ORDER BY id LIMIT 1000`, repeated; each batch is short and independent (GitLab's `each_batch` uses this idea [50]).
- **Server-side cursor**: one query, rows fetched in chunks inside **one transaction** [72]. In Node, `pg-cursor` reads results "without loading the entire result-set into memory" [86].
- **`COPY (SELECT …) TO STDOUT`** streams a query result as CSV, text or binary [77]: the natural tool for exports. PG 19 beta adds JSON output (PG 19, beta — may change) [31].
- `WITH HOLD` cursors survive the commit by materializing the result; they are tied to one connection and break with transaction pooling [48][72]. Any long cursor holds a snapshot that blocks `VACUUM`: run big exports on a replica or keep them short ([09](09-operations-and-server-tuning.md)).

```sql
BEGIN;
DECLARE export_cur NO SCROLL CURSOR FOR SELECT id, email, created_at FROM users ORDER BY id;
FETCH 1000 FROM export_cur;          -- repeat until no rows come back
CLOSE export_cur;
COMMIT;
```

### 5.9 Which pagination to use

| Need | Use | Avoid |
|---|---|---|
| Infinite scroll, "next" button, public API | Keyset (5.2) | Deep `OFFSET` |
| Page numbers on small or bounded data | `LIMIT … OFFSET` with a maximum page | Unbounded page numbers |
| Export a table or a big result | `COPY` or a cursor | `OFFSET` loops |
| Background job over all rows | Keyset loop on the primary key | One giant transaction |
| Total count on a big table | Estimate or capped count | Exact `count(*)` on every page |

## 6. Counting

### 6.1 Why exact `count(*)` is slow

PostgreSQL uses **MVCC** (multi-version concurrency control): several versions of a row can exist at once, and each transaction sees only those visible to its snapshot. So no stored row count is true for everybody: `count(*)` must scan the table, or an index plus visibility checks (an index-only scan helps only when the visibility map is current, i.e. after recent vacuums) [40]. Concurrency details: [08](08-transactions-concurrency-locking.md).

### 6.2 `count(*)` versus `count(1)` versus `count(col)`

| Expression | Counts | Notes |
|---|---|---|
| `count(*)` | rows | Idiomatic; the `*` reads no columns [40] |
| `count(1)` | rows | Not faster: slightly slower in PostgreSQL, which checks the argument for `NULL` on each row [40]; jOOQ measured about 10% on PostgreSQL 11 [43]. SQLFluff enforces `count(*)` [12] |
| `count(col)` | non-`NULL` values [69] | Use it on purpose, e.g. after a `LEFT JOIN` |
| `count(DISTINCT col)` | distinct non-`NULL` values | Sort or hash; expensive on big sets |

```sql
-- After a LEFT JOIN, count a column of the right table: 0 (not 1) for users without orders [43].
SELECT u.id, count(o.id) AS order_count
FROM users AS u
LEFT JOIN orders AS o ON o.user_id = u.id
GROUP BY u.id;
```

### 6.3 Existence: `EXISTS`, not `count(*) > 0`

`count(*)` finds every match; `EXISTS` stops at the first. "Thou shalt not use COUNT(*) when EXISTS sufficeth thy needs" [44].

```sql
SELECT count(*) FROM orders WHERE user_id = $1;                        -- Bad, then "> 0" in code
SELECT EXISTS (SELECT 1 FROM orders WHERE user_id = $1) AS has_orders;  -- Good
```

### 6.4 Estimates

```sql
-- Whole table, instant. -1 if never vacuumed or analyzed (PG 14+) [42].
SELECT reltuples::bigint AS estimated_rows FROM pg_class WHERE oid = 'public.orders'::regclass;

-- Any query: read the planner's estimate (adapted from the wiki's count_estimate [41]).
CREATE FUNCTION count_estimate(query text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    plan jsonb;
BEGIN
    EXECUTE format('EXPLAIN (FORMAT JSON) %s', query) INTO plan;
    RETURN (plan -> 0 -> 'Plan' ->> 'Plan Rows')::numeric::bigint;
END;
$$;

-- Pass only trusted, constant SQL: the function runs whatever text it receives [41].
SELECT count_estimate('SELECT 1 FROM orders WHERE status = ''paid''');
```

Estimates can be far off with correlated filters ([06](06-query-optimization-and-explain.md)); "Remember that Google doesn't display exact counts either!" [48]. For an exact, instant count of a big table, maintain a counter table with triggers; it costs write overhead and can become a hot row [40] ([07](07-schema-design-and-patterns.md)). Capped counts: 5.7.

## 7. Top-N per group

"Latest order per user", "3 best products per category": choose by data shape, then measure.

### 7.1 `DISTINCT ON` (PostgreSQL only)

```sql
-- Latest order per user.
SELECT DISTINCT ON (o.user_id) o.user_id, o.id AS order_id, o.total_cents, o.created_at
FROM orders AS o
ORDER BY o.user_id, o.created_at DESC, o.id DESC;
```

`DISTINCT ON` keeps the first row of each group; its expressions must match the leftmost `ORDER BY` expressions, and the rest of the `ORDER BY` decides which row is first [51]. It is short and fast for one row per group over the whole table, but it reads **every** row of every group; PG 18's skip scan does not apply. Franck Pachot shows PG 18 processing 200,000 rows to return 10 [53].

### 7.2 `row_number()` (portable, N rows per group)

```sql
-- Top 3 orders by amount per user.
SELECT r.user_id, r.order_id, r.total_cents
FROM (
    SELECT o.user_id, o.id AS order_id, o.total_cents,
           row_number() OVER (PARTITION BY o.user_id ORDER BY o.total_cents DESC, o.id DESC) AS rn
    FROM orders AS o
) AS r
WHERE r.rn <= 3;
```

Use `rank()` or `dense_rank()` when ties must share a position [90]. PG 15 made `row_number()`, `rank()`, `dense_rank()` and `count()` window functions faster [28].

### 7.3 `LATERAL … LIMIT` (few groups, good index)

```sql
CREATE INDEX orders_user_total_id_idx ON orders (user_id, total_cents DESC, id DESC);

SELECT u.id AS user_id, t.order_id, t.total_cents
FROM users AS u
CROSS JOIN LATERAL (
    SELECT o.id AS order_id, o.total_cents
    FROM orders AS o
    WHERE o.user_id = u.id
    ORDER BY o.total_cents DESC, o.id DESC
    LIMIT 3
) AS t;
```

One short index scan per user, reading 3 entries. Without a table listing the groups, a recursive CTE can emulate a "loose index scan" that jumps between distinct values; it "runs orders of magnitude faster" when they are few [54].

| Situation | Best choice |
|---|---|
| One row per group over the whole table (report, job) | `DISTINCT ON` |
| N > 1 rows per group, ties, portable SQL | `row_number()` / `rank()` |
| Many rows per group, few groups, index on `(group, sort)` | `LATERAL … LIMIT` from the groups table |
| Only the groups shown on one page | `LATERAL … LIMIT` |
| No groups table, few distinct values | Recursive CTE loose index scan [54] |

## 8. Recipes

Short, correct patterns. Add `LIMIT`s for interactive use.

### 8.1 Running totals

```sql
SELECT o.user_id, o.id, o.created_at, o.total_cents,
       sum(o.total_cents) OVER (PARTITION BY o.user_id ORDER BY o.created_at, o.id
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total_cents
FROM orders AS o;
```

The default frame, `RANGE UNBOUNDED PRECEDING`, includes all **peers** (rows with equal sort values) of the current row [52], so tied rows would share one total. Use a unique `ORDER BY` and an explicit `ROWS` frame.

### 8.2 Moving average over 7 days

```sql
WITH daily AS (
    SELECT date_trunc('day', o.created_at) AS day_start, sum(o.total_cents) AS revenue_cents
    FROM orders AS o
    GROUP BY day_start
)
SELECT d.day_start, d.revenue_cents,
       avg(d.revenue_cents) OVER (ORDER BY d.day_start
                                  RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW) AS avg_7_days_cents
FROM daily AS d
ORDER BY d.day_start;
```

`RANGE … INTERVAL '6 days' PRECEDING` covers 7 calendar days even when some days have no rows; `ROWS 6 PRECEDING` would cover 7 *rows*. To show empty days as zero, fill the gaps first (8.9).

### 8.3 Gaps and islands

**Islands** are runs of consecutive values; **gaps** are the holes between them. For consecutive days, `active_day - row_number()` is constant within a run, so it identifies the island [56].

```sql
-- Streaks of consecutive active days per user (UTC days).
WITH active_days AS (
    SELECT DISTINCT e.user_id, (e.occurred_at AT TIME ZONE 'UTC')::date AS active_day
    FROM events AS e
),
islands AS (
    SELECT a.user_id, a.active_day,
           a.active_day - (row_number() OVER (PARTITION BY a.user_id ORDER BY a.active_day))::integer AS island_key
    FROM active_days AS a
)
SELECT i.user_id, min(i.active_day) AS streak_start, max(i.active_day) AS streak_end, count(*) AS streak_days
FROM islands AS i
GROUP BY i.user_id, i.island_key
ORDER BY i.user_id, streak_start;
```

To list the **gaps**, compare each value with the next one, `lead(active_day) OVER (PARTITION BY user_id ORDER BY active_day)`: a gap exists where the next day is more than one day later [56].

### 8.4 Sessionization

A new session starts when more than 30 minutes passed since the user's previous event: flag starts with `lag()`, then number sessions with a running `sum()`.

```sql
WITH flagged AS (
    SELECT e.user_id, e.occurred_at,
           -- First event: lag() is NULL, the comparison is NULL, so ELSE 1 (a new session).
           CASE WHEN e.occurred_at - lag(e.occurred_at) OVER w <= INTERVAL '30 minutes' THEN 0 ELSE 1 END
               AS is_session_start
    FROM events AS e
    WINDOW w AS (PARTITION BY e.user_id ORDER BY e.occurred_at)
),
numbered AS (
    SELECT f.user_id, f.occurred_at,
           sum(f.is_session_start) OVER (PARTITION BY f.user_id ORDER BY f.occurred_at
                                         ROWS UNBOUNDED PRECEDING) AS session_no
    FROM flagged AS f
)
SELECT n.user_id, n.session_no, min(n.occurred_at) AS session_start, max(n.occurred_at) AS session_end
FROM numbered AS n
GROUP BY n.user_id, n.session_no;
```

### 8.5 Find duplicates, then keep only the latest row

```sql
-- Find: emails used by more than one account.
SELECT lower(u.email) AS email_key, count(*) AS copies, array_agg(u.id ORDER BY u.id) AS user_ids
FROM users AS u
GROUP BY lower(u.email)
HAVING count(*) > 1;

-- De-duplicate price_imports(id, sku, price_cents, imported_at): keep the newest row per sku.
DELETE FROM price_imports AS p
USING (
    SELECT pi.id,
           row_number() OVER (PARTITION BY pi.sku ORDER BY pi.imported_at DESC, pi.id DESC) AS rn
    FROM price_imports AS pi
) AS ranked
WHERE p.id = ranked.id AND ranked.rn > 1;
```

Then add a unique constraint so duplicates cannot come back (a schema change: [10](10-safe-schema-migrations.md)). On big tables, delete in batches (9.8). For "latest row per key" **reads**, use `DISTINCT ON` (7.1) or `LATERAL … LIMIT 1` (7.3).

### 8.6 Pivot (rows to columns) with `FILTER` or `crosstab`

```sql
SELECT o.user_id,
       count(*) FILTER (WHERE o.status = 'pending') AS pending,
       count(*) FILTER (WHERE o.status = 'paid') AS paid,
       count(*) FILTER (WHERE o.status = 'cancelled') AS cancelled
FROM orders AS o
GROUP BY o.user_id;

-- Same with crosstab() from the trusted tablefunc extension. Output columns must be
-- declared, and the source query must be ordered [66].
CREATE EXTENSION IF NOT EXISTS tablefunc;
SELECT ct.user_id, ct.pending, ct.paid, ct.cancelled
FROM crosstab(
    $$SELECT user_id, status, count(*) FROM orders GROUP BY 1, 2 ORDER BY 1, 2$$,
    $$VALUES ('pending'), ('paid'), ('cancelled')$$
) AS ct (user_id bigint, pending bigint, paid bigint, cancelled bigint);
```

SQL needs fixed output columns. For a **dynamic** pivot (columns unknown in advance), return one JSON object per row (`jsonb_object_agg(status, order_count)`) and spread it in the application instead of generating SQL. Karwin's 2026 book has a chapter on the *Dynamic Pivot* anti-pattern [89].

### 8.7 Unpivot (columns to rows) with `LATERAL VALUES`

```sql
-- monthly_stats(month_start, signups, orders, refunds) -> one row per metric.
SELECT ms.month_start, v.metric, v.value
FROM monthly_stats AS ms
CROSS JOIN LATERAL (
    VALUES ('signups', ms.signups), ('orders', ms.orders), ('refunds', ms.refunds)
) AS v (metric, value);
```

### 8.8 Time bucketing: `date_trunc` and `date_bin`

```sql
-- Calendar units, computed in a given time zone:
SELECT date_trunc('day', o.created_at, 'Europe/Paris') AS day_start, count(*) AS order_count
FROM orders AS o
GROUP BY day_start
ORDER BY day_start;

-- Any stride, such as 15 minutes (date_bin is PG 14+):
SELECT date_bin(INTERVAL '15 minutes', o.created_at, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS bucket_start,
       count(*) AS order_count
FROM orders AS o
WHERE o.created_at >= now() - INTERVAL '1 day'
GROUP BY bucket_start
ORDER BY bucket_start;
```

`date_bin` aligns buckets to the origin you give; its stride cannot contain months or larger units [67][29].

### 8.9 Fill gaps in a time series with `generate_series`

```sql
SELECT d.day_start, count(o.id) AS order_count     -- count(o.id) is 0 for empty days
FROM generate_series(TIMESTAMPTZ '2026-09-01 00:00:00+00', TIMESTAMPTZ '2026-09-30 00:00:00+00',
                     INTERVAL '1 day') AS d (day_start)
LEFT JOIN orders AS o
    ON o.created_at >= d.day_start AND o.created_at < d.day_start + INTERVAL '1 day'
GROUP BY d.day_start
ORDER BY d.day_start;
```

`count(*)` would return 1 for empty days, because the `LEFT JOIN` still produces one row [57]. For local days across daylight-saving changes, PG 16+ accepts a time zone: `generate_series(start, stop, INTERVAL '1 day', 'Europe/Paris')` [68][27].

### 8.10 Forward-fill (carry the last known value)

```sql
-- readings(sensor_id, measured_at, value): value is sometimes NULL.
SELECT g.sensor_id, g.measured_at, g.value,
       max(g.value) OVER (PARTITION BY g.sensor_id, g.grp) AS value_filled
FROM (
    SELECT r.sensor_id, r.measured_at, r.value,       -- grp increases only on non-NULL values
           count(r.value) OVER (PARTITION BY r.sensor_id ORDER BY r.measured_at ROWS UNBOUNDED PRECEDING) AS grp
    FROM readings AS r
) AS g;
```

Each group holds one known value followed by `NULL`s, so `max()` over the group returns it. `lag()` alone only fills one-row gaps [57]. PG 19 beta adds `IGNORE NULLS`: `last_value(value) IGNORE NULLS OVER (PARTITION BY sensor_id ORDER BY measured_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)` (PG 19, beta — may change) [34].

### 8.11 Percentiles, median and histograms

```sql
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY o.total_cents) AS median_cents,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY o.total_cents) AS p95_cents,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY o.total_cents) AS median_existing_value
FROM orders AS o
WHERE o.created_at >= now() - INTERVAL '30 days';

-- Histogram: 10 buckets of 100.00 from 0 to 1,000.00; bucket 0 = below, 11 = at or above.
SELECT width_bucket(o.total_cents, 0, 100000, 10) AS bucket, count(*) AS order_count
FROM orders AS o
GROUP BY bucket
ORDER BY bucket;
```

- `percentile_cont` interpolates; `percentile_disc` returns a value that exists in the data; both accept an array of fractions [69]. They sort their input, so filter first.
- `width_bucket` returns 0 below the range and `count + 1` at or above the upper bound [70]. For buckets with equal row counts, use `ntile(10) OVER (ORDER BY total_cents)` [57]. Left-join from `generate_series(0, 11)` to show empty buckets.

### 8.12 Random sampling

```sql
SELECT id FROM documents ORDER BY random() LIMIT 10;                           -- Bad on big tables
SELECT id FROM documents TABLESAMPLE SYSTEM (1) ORDER BY random() LIMIT 10;    -- ~1% of pages
CREATE EXTENSION IF NOT EXISTS tsm_system_rows;                                -- trusted [71]
SELECT id FROM documents TABLESAMPLE SYSTEM_ROWS (10);                         -- exactly 10 rows
```

| Method | Reads | Randomness |
|---|---|---|
| `ORDER BY random() LIMIT n` | Whole table | Perfect; fine for small or already-filtered sets |
| `TABLESAMPLE SYSTEM (p)` | About p% of pages | Block-level, subject to "clustering effects" [51] |
| `TABLESAMPLE BERNOULLI (p)` | Whole table | Row-level [51] |
| `TABLESAMPLE SYSTEM_ROWS (n)` | Few pages | Block-level, exact count, no `REPEATABLE` [71] |

Sampling happens **before** `WHERE` [51], so a sample plus a filter can return fewer rows than you want. `ORDER BY random()` on a big table is Karwin's *Random Selection* [88].

### 8.13 Compare two tables

```sql
-- Whole-row differences in both directions (EXCEPT treats two NULLs as equal).
(SELECT 'only_in_staging' AS side, s.id, s.sku, s.price_cents FROM products_staging AS s
 EXCEPT
 SELECT 'only_in_staging', p.id, p.sku, p.price_cents FROM products AS p)
UNION ALL
(SELECT 'only_in_products' AS side, p.id, p.sku, p.price_cents FROM products AS p
 EXCEPT
 SELECT 'only_in_products', s.id, s.sku, s.price_cents FROM products_staging AS s);
```

Use `EXCEPT ALL` when duplicate counts matter. With a key, a `FULL JOIN … ON p.id = s.id WHERE p.id IS NULL OR s.id IS NULL OR (s.sku, s.price_cents) IS DISTINCT FROM (p.sku, p.price_cents)` tells you *how* each row differs (missing on one side, or changed).

### 8.14 Conditional updates

```sql
-- Several outcomes in one pass; only rows that change are touched.
UPDATE orders
SET status = CASE WHEN paid_at IS NOT NULL THEN 'paid' ELSE 'expired' END
WHERE status = 'pending'
  AND (paid_at IS NOT NULL OR created_at < now() - INTERVAL '7 days');

-- Guarded state transition: no row returned = the order was not in the expected state.
UPDATE orders SET status = 'shipped' WHERE id = $1 AND status = 'paid' RETURNING id;

-- Optimistic locking: no row returned = someone else saved first; reload and retry.
UPDATE documents SET title = $3, version = version + 1
WHERE id = $1 AND version = $2
RETURNING version;
```

Concurrency background: [08](08-transactions-concurrency-locking.md).

### 8.15 Hierarchies with a recursive CTE

```sql
-- categories(id, parent_id, name): category 42 and all its descendants.
WITH RECURSIVE tree AS (
    SELECT c.id, c.parent_id, c.name, 0 AS depth
    FROM categories AS c
    WHERE c.id = 42
    UNION ALL
    SELECT c.id, c.parent_id, c.name, t.depth + 1
    FROM categories AS c
    INNER JOIN tree AS t ON c.parent_id = t.id
    WHERE t.depth < 20                         -- depth guard
) CYCLE id SET is_cycle USING path             -- cycle guard (PG 14+)
SELECT tree.id, tree.parent_id, tree.name, tree.depth
FROM tree
WHERE NOT tree.is_cycle
ORDER BY tree.depth, tree.name;
```

The `CYCLE` clause (PG 14+) stops recursion when a row repeats on its own path [39][29]. Tree models (adjacency list, closure table, `ltree`): [07](07-schema-design-and-patterns.md). Walking a tree with one query per level from the application is Karwin's *Naive Trees* [88].

### 8.16 Upsert and return the id ("get or create")

**Problem**: `INSERT … ON CONFLICT DO NOTHING RETURNING id` returns **no row** when the row already exists: "Only rows that were successfully inserted or updated will be returned" [35][38].

| Option | Round trips | Concurrency-safe? | Cost |
|---|---|---|---|
| A. `INSERT … DO NOTHING`, then `SELECT` | 2 | Yes in `READ COMMITTED` (the `SELECT` gets a new snapshot) | Cheapest [38] |
| B. CTE: insert-or-nothing `UNION ALL` select | 1 | Rare race returns 0 rows: retry | Cheap |
| C. Fake update `DO UPDATE SET name = EXCLUDED.name` | 1 | Yes | New row version on every call: bloat, WAL, update triggers, row lock [35][38] |
| D. `ON CONFLICT … DO SELECT RETURNING` | 1 | Yes | PG 19 beta only [33] |

```sql
-- A. Recommended default.
INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING;
SELECT id FROM tags WHERE name = $1;

-- B. One statement. If a concurrent transaction commits the same name while we wait,
--    the SELECT part cannot see it (same snapshot): the result is empty, so retry.
WITH inserted AS (
    INSERT INTO tags (name) VALUES ($1)
    ON CONFLICT (name) DO NOTHING
    RETURNING id
)
SELECT id FROM inserted
UNION ALL
SELECT t.id FROM tags AS t WHERE t.name = $1
LIMIT 1;

-- D. PG 19 (beta — may change): atomic insert-or-get.
INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO SELECT RETURNING id;
```

- In `REPEATABLE READ` or `SERIALIZABLE`, a conflict with a row your snapshot cannot see raises a serialization error; retry the transaction [37].
- Batches: `INSERT INTO tags (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING`, then `SELECT id, name FROM tags WHERE name = ANY($1::text[])`.
- Never "SELECT, then INSERT if missing" in application code: two concurrent requests both see nothing and both insert [38]. Haki Benita concludes that "It may not be possible to guarantee idempotency in a highly concurrent environment using just a single SQL statement" [38]; option A plus a unique constraint is the robust default.

## 9. Writing data well

### 9.1 Multi-row `INSERT`

One statement with many rows saves round trips, parsing and commits; the docs also advise one transaction for many inserts instead of one commit per row [60].

```sql
INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
VALUES ($1, $2, $3, $4), ($5, $6, $7, $8), ($9, $10, $11, $12);
```

A statement carries at most **65,535 parameters** [83] (with 4 columns, 16,383 rows), and each batch size is a different SQL text, which defeats statement caching. The next pattern avoids both problems.

### 9.2 Bulk insert from arrays with `unnest`

Send **one array per column**: 4 parameters whatever the number of rows.

```sql
INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
SELECT t.order_id, t.product_id, t.quantity, t.unit_price_cents
FROM unnest($1::bigint[], $2::bigint[], $3::integer[], $4::bigint[])
     AS t (order_id, product_id, quantity, unit_price_cents);
```

```ts
// node-postgres converts JavaScript arrays into PostgreSQL arrays.
await pool.query(insertItemsSql, [orderIds, productIds, quantities, unitPricesCents]);
```

- Multi-argument `unnest` zips the arrays row by row (shorter ones are padded with `NULL`) and is allowed only in `FROM` [82]. Always cast the array parameters [59].
- Tiger Data measured `INSERT … UNNEST` 2.13x faster than `INSERT … VALUES` at 1,000 rows per batch, mostly from less planning work [59].
- The same shape works with `ON CONFLICT` (9.4) and `UPDATE … FROM unnest(…)` (9.6). Keep batches to a few thousand rows.

### 9.3 `COPY` for big loads

"Loading a large number of rows using COPY is almost always faster than using INSERT, even if PREPARE is used and multiple insertions are batched into a single transaction" [60]. From an application, use `COPY … FROM STDIN` (`\copy` in psql; the `pg-copy-streams` package with node-postgres).

```sql
-- Upsert a CSV file: COPY into a temporary table, then one INSERT ... ON CONFLICT.
BEGIN;
CREATE TEMP TABLE staging_products (sku text NOT NULL, name text NOT NULL, price_cents bigint NOT NULL)
    ON COMMIT DROP;
COPY staging_products (sku, name, price_cents) FROM STDIN WITH (FORMAT csv, HEADER true);
INSERT INTO products AS p (sku, name, price_cents)
SELECT DISTINCT ON (s.sku) s.sku, s.name, s.price_cents      -- one row per key (see 9.4)
FROM staging_products AS s
ORDER BY s.sku
ON CONFLICT (sku) DO UPDATE
SET name = EXCLUDED.name, price_cents = EXCLUDED.price_cents
WHERE (p.name, p.price_cents) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.price_cents);
COMMIT;
```

- Bad input rows: PG 17+ skips them with `ON_ERROR ignore` [26]; PG 18 adds `REJECT_LIMIT` [25]; PG 19 beta adds `ON_ERROR SET_NULL` (PG 19, beta — may change) [31].
- New or emptied table: load first, then create indexes and foreign keys, then `ANALYZE` [60][58].

### 9.4 Upserts with `ON CONFLICT … DO UPDATE`

This is the library's reference for upserts. An **upsert** inserts a row, or updates the existing row with the same unique key. `ON CONFLICT DO UPDATE` "guarantees an atomic INSERT or UPDATE outcome", even under high concurrency [35].

```sql
INSERT INTO products AS p (sku, name, price_cents)
VALUES ($1, $2, $3)
ON CONFLICT (sku) DO UPDATE
SET name = EXCLUDED.name, price_cents = EXCLUDED.price_cents, updated_at = now()
WHERE (p.name, p.price_cents) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.price_cents)
RETURNING p.id;
```

- `EXCLUDED` is the row you tried to insert; the table name or alias (`p`) is the existing row [35].
- The conflict target must match a unique index or constraint. For a **partial** unique index (e.g. `UNIQUE (email) WHERE deleted_at IS NULL`), repeat its predicate: `ON CONFLICT (email) WHERE deleted_at IS NULL` [35].
- The `WHERE … IS DISTINCT FROM` skips no-op updates (no new row version, no WAL), **but** skipped rows are not returned by `RETURNING`, and they are still locked [35].
- One statement must not hit the same row twice: duplicate keys in one batch raise a cardinality violation (`ON CONFLICT DO UPDATE command cannot affect row a second time`) [35]. De-duplicate the input first (`DISTINCT ON`, as in 9.3).
- `NULL` keys never conflict in a default unique index (`NULL`s are distinct); use `UNIQUE NULLS NOT DISTINCT` (PG 15+) if `NULL` must count as a value [28].
- Concurrent multi-row upserts can deadlock when they lock rows in different orders: sort the input by key [36][75].
- A conflicting insert still consumes an identity value, so ids get gaps. That is normal; do not "fix" gaps (Karwin's *Pseudokey Neat-Freak* [88]).
- `DO NOTHING RETURNING` returns nothing for existing rows: see [8.16](#816-upsert-and-return-the-id-get-or-create).

### 9.5 `MERGE` (PG 15+) versus `ON CONFLICT`

`MERGE` (PG 15+ [28]) applies `INSERT`, `UPDATE` and `DELETE` from a source in one statement; PG 17 added `RETURNING` (with `merge_action()`) and `WHEN NOT MATCHED BY SOURCE` [26].

```sql
MERGE INTO products AS p
USING staging_products AS s ON p.sku = s.sku
WHEN MATCHED AND (p.name, p.price_cents) IS DISTINCT FROM (s.name, s.price_cents) THEN
    UPDATE SET name = s.name, price_cents = s.price_cents
WHEN NOT MATCHED THEN
    INSERT (sku, name, price_cents) VALUES (s.sku, s.name, s.price_cents)
WHEN NOT MATCHED BY SOURCE THEN    -- PG 17+: deletes every product absent from staging!
    DELETE;
```

**For concurrent upserts, prefer `ON CONFLICT`.** `MERGE` "does not guarantee that either INSERT or UPDATE will occur"; when a concurrent transaction inserts the same key, it raises a unique violation instead of updating [37][36]. Haki Benita's tests show the same races [38]. Use `MERGE` for batch synchronization (one writer, or with retries) and `ON CONFLICT` for request-time upserts.

### 9.6 Update many rows with different values

```sql
UPDATE products AS p
SET price_cents = v.price_cents
FROM (VALUES ('SKU-1', 1999), ('SKU-2', 2499)) AS v (sku, price_cents)
WHERE p.sku = v.sku AND p.price_cents IS DISTINCT FROM v.price_cents;
```

From the application, replace the `VALUES` list with one array per column: `FROM unnest($1::text[], $2::bigint[]) AS v (sku, price_cents)`. Each target row must match **at most one** source row; otherwise "which one will be used is not readily predictable" [75].

### 9.7 Do not rewrite rows that would not change

Every `UPDATE` writes a new row version even when values are identical: WAL, index work, and dead rows for `VACUUM` [74]. Haki Benita: lower-casing emails touched 1,010,000 rows in about 1.6 s; with a "has it changed?" filter only 10,000 rows were updated, in about 0.3 s [58].

```sql
UPDATE users SET email = lower(email);                                             -- Bad
UPDATE users SET email = lower(email) WHERE email IS DISTINCT FROM lower(email);   -- Good

-- Alternative: the built-in trigger. Name it to fire last (triggers fire in name order) [74].
CREATE TRIGGER z_skip_noop_updates
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();
```

Use `IS DISTINCT FROM` (not `<>`) when columns can be `NULL` [5]. The trigger has a small cost per row, so use it only where many updates are no-ops [74].

### 9.8 Batch large updates and deletes

One giant `UPDATE` or `DELETE` is one giant transaction: long row locks, a burst of WAL (replica lag), and millions of dead rows that `VACUUM` can clean only after the commit. "Updates affecting many rows can have negative effects on system performance, such as table bloat, increased replica lag, and increased lock contention" [75]. Run small batches, each in its own short transaction.

```sql
-- Pattern from the UPDATE/DELETE docs [75][76]. Repeat until it deletes 0 rows.
WITH batch AS (
    SELECT e.ctid
    FROM events AS e
    WHERE e.occurred_at < now() - INTERVAL '90 days'
    ORDER BY e.occurred_at
    LIMIT 5000
    FOR UPDATE SKIP LOCKED
)
DELETE FROM events AS e
USING batch
WHERE e.ctid = batch.ctid;
```

```ts
// Each pool.query() runs in autocommit mode: one short transaction per batch.
let deleted = 0;
do {
  const res = await pool.query(batchDeleteSql);
  deleted = res.rowCount ?? 0;   // optionally pause here if replicas lag
} while (deleted > 0);
```

- `ctid` (the physical row address) is safe here only because each run looks it up again; `ORDER BY` makes batches predictable and avoids deadlocks with writers using the same order; with `SKIP LOCKED`, finish with one pass without it so locked rows are not missed [75].
- For long jobs, walking the primary key in ranges (`WHERE id >= $1 AND id < $2`) gives stable batch boundaries (GitLab's `each_batch` [50]).
- Keep each batch well under a second; consider `VACUUM` between big phases [75]. For time-based retention, dropping partitions is far cheaper (9.11).

### 9.9 Data-modifying CTEs

`INSERT`, `UPDATE`, `DELETE` (and `MERGE`, PG 17+) can run inside `WITH`, passing rows with `RETURNING` [39]:

```sql
-- Archive and delete in one atomic statement (batch it for large volumes, 9.8).
WITH moved AS (
    DELETE FROM events
    WHERE occurred_at < now() - INTERVAL '1 year'
    RETURNING id, user_id, type, occurred_at
)
INSERT INTO events_archive (id, user_id, type, occurred_at)
SELECT m.id, m.user_id, m.type, m.occurred_at
FROM moved AS m;
```

All sub-statements use the **same snapshot** and "cannot 'see' one another's effects on the target tables": `RETURNING` is the only channel between them. They always run to completion, even if nothing reads their output. Never modify the same row twice in one statement; the result "will not be predictable" [39].

### 9.10 `RETURNING` saves round trips

```sql
INSERT INTO orders (user_id, status, total_cents) VALUES ($1, 'pending', $2)
RETURNING id, created_at;

-- PG 18+: old and new values together.
UPDATE orders SET status = 'cancelled' WHERE id = $1
RETURNING old.status AS previous_status, new.status AS current_status;
```

`OLD`/`NEW` in `RETURNING` is PG 18+ for `INSERT`, `UPDATE`, `DELETE` and `MERGE` [25]; before PG 18, `UPDATE … RETURNING` returns only the new values.

### 9.11 Delete big volumes by dropping partitions

When data expires by time (events, logs, audit), partition by time and drop old partitions: "Dropping an individual partition using DROP TABLE, or doing ALTER TABLE DETACH PARTITION, is far faster than a bulk operation", and it avoids the `VACUUM` cost of a bulk `DELETE` [61].

```sql
ALTER TABLE events DETACH PARTITION events_2025_09 CONCURRENTLY;  -- PG 14+, outside a transaction block
DROP TABLE events_2025_09;
```

`DETACH PARTITION … CONCURRENTLY` is PG 14+ [29]. Partitioning design: [07](07-schema-design-and-patterns.md).

## 10. CTEs, subqueries, views and functions

### 10.1 CTE inlining and `MATERIALIZED`

Before PG 12, every CTE was an "optimization fence" (computed separately, no filter push-down). Since PG 12, a CTE that is not recursive, has no side effects and is referenced once is **inlined** into the main query [30]. Override with `AS MATERIALIZED` (compute once, separately) or `AS NOT MATERIALIZED` (inline even when referenced several times) [39].

```sql
-- Referenced twice -> materialized by default -> no index use on big_table.key.
-- NOT MATERIALIZED lets each reference use the index (example from the docs [39]).
WITH w AS NOT MATERIALIZED (SELECT * FROM big_table)
SELECT * FROM w AS w1 INNER JOIN w AS w2 ON w1.key = w2.ref
WHERE w2.key = 123;
```

Use `MATERIALIZED` when a CTE calls an expensive function that must run once per row [39], or to block a plan you measured to be worse. Always comment why.

### 10.2 Recursive CTE guards

- **Cycles**: the `CYCLE` clause (PG 14+) or an array of visited ids; `UNION` instead of `UNION ALL` only helps when whole rows repeat [39].
- **Depth**: carry a `depth` column with a sane maximum (8.15). **Order**: `SEARCH DEPTH FIRST BY …` / `SEARCH BREADTH FIRST BY …` (PG 14+) [39].
- A `LIMIT` in the outer query stops a runaway query during development, but the docs advise against relying on it in production [39]. PG 15 added `recursive_worktable_factor` to tune the planner's size estimate [28].

### 10.3 Views versus functions versus CTEs

| Tool | Use it for | Does the planner see inside? | Watch out for |
|---|---|---|---|
| CTE | Naming steps of one query | Yes, when inlined (10.1) | Scope is one statement |
| View | Reusable named query, stable interface, privileges | Yes: expanded and "pulled up" into the query [79] | Deep stacks (10.4) |
| SQL function (`LANGUAGE sql`, `STABLE`, one `SELECT`) | Reusable query with parameters | Often: inlined when conditions are met [80] | Not inlined if `SECURITY DEFINER`, `VOLATILE`, `STRICT` table function, etc. [80] |
| PL/pgSQL function | Procedural logic, loops, dynamic SQL | No: a black box | Set-returning functions are estimated at 1,000 rows unless you set `ROWS` [92] |
| Materialized view | Expensive results read often, some staleness OK | No: a stored table | Refresh cost; `REFRESH … CONCURRENTLY` needs a unique index on plain columns covering all rows [73] |

```sql
CREATE MATERIALIZED VIEW daily_revenue AS
SELECT date_trunc('day', o.created_at) AS day_start, sum(o.total_cents) AS revenue_cents
FROM orders AS o
WHERE o.status = 'paid'
GROUP BY day_start;

CREATE UNIQUE INDEX daily_revenue_day_start_key ON daily_revenue (day_start);
REFRESH MATERIALIZED VIEW CONCURRENTLY daily_revenue;     -- does not block readers
```

### 10.4 Avoid deep view-on-view stacks

Views are expanded into the query that uses them [79]. A view on views on views drags every join, aggregate and `DISTINCT` of every layer into each query, even when the caller needs two columns of one table. The planner can remove some unused joins (a `LEFT JOIN` to a unique key whose columns are unused; some self-joins in PG 18 [25]), but never aggregates or `DISTINCT`. Keep views one or two levels deep, and write explicit queries for hot paths.

### 10.5 Correlated scalar subqueries

A correlated subquery in the `SELECT` list runs once per outer row and forces a nested loop. Laurenz Albe: "avoid correlated subqueries everywhere except in EXISTS, NOT EXISTS and IN clauses" [47].

```sql
-- Bad on large sets: one subquery per user.
SELECT u.id, (SELECT count(*) FROM orders AS o WHERE o.user_id = u.id) AS order_count
FROM users AS u;

-- Good: aggregate once, then join.
SELECT u.id, coalesce(oc.order_count, 0) AS order_count
FROM users AS u
LEFT JOIN (SELECT o.user_id, count(*) AS order_count FROM orders AS o GROUP BY o.user_id) AS oc
    ON oc.user_id = u.id;
```

For a page of 20 users the scalar subquery (or `LATERAL`) is fine and can be faster, because it touches only those users. Measure.

## 11. Application-side patterns

TypeScript specifics (Prisma, node-postgres, pooling, transactions): [15](15-postgres-from-typescript.md).

### 11.1 N+1 queries

**N+1**: one query for a list, then one query per item. "The n+1 problem occurs when looping through query results and performing one additional query per result" [84]. Each query is fast, so it hides in development; in production a page makes hundreds of round trips. In `pg_stat_statements`, look for cheap queries with a huge `calls` count ([06](06-query-optimization-and-explain.md)).

```ts
// Bad: 1 + 50 queries.
const { rows: users } = await pool.query('SELECT id, email FROM users ORDER BY id LIMIT 50');
for (const user of users) {
  await pool.query('SELECT id, total_cents FROM orders WHERE user_id = $1', [user.id]);
}

// Good: 2 queries, whatever the page size.
const { rows: orders } = await pool.query(
  'SELECT user_id, id, total_cents FROM orders WHERE user_id = ANY($1::bigint[])',
  [users.map((u) => u.id)],
);
```

With Prisma, load relations in the same call (`include`, optionally `relationLoadStrategy: "join"`) or rely on its batching of `findUnique()` calls in the same tick [84].

### 11.2 Pass lists as one array: `= ANY($1)`

```sql
SELECT id, title FROM documents WHERE id IN ($1, $2, $3 /* … $5000 */);   -- Bad: generated list
SELECT id, title FROM documents WHERE id = ANY($1::bigint[]);              -- Good: one array
```

- One parameter, so no 65,535-parameter limit [83], and one SQL text for every list size (prepared statements and `pg_stat_statements` see one query).
- Short fixed lists of constants are fine as `IN ('a', 'b')`; jOOQ measured literal lists faster than arrays for very small lists on an old PostgreSQL [46].
- PG 17 sped up B-tree scans for `IN` / `= ANY` lists [26]; PG 18 gives `IN` lists of different lengths one query id in `pg_stat_statements` [25].
- `x <> ALL($1)` (the array form of `NOT IN`) has the same `NULL` trap [5]. For hundreds of thousands of ids, `COPY` them into a temporary table and join.

### 11.3 Prepared statements and generic plans

A prepared statement is parsed once and can reuse its plan. The first five executions use **custom plans** (planned with the actual values); then PostgreSQL may switch to a **generic plan** if it does not look much more expensive [63]. Generic plans can be bad for skewed data (a rare status versus a common one); `plan_cache_mode` overrides the choice [63]. node-postgres prepares a query given a `name`, once per connection, and warns that most queries "will likely not benefit much" [85]. Pooling and prepared statements: [09](09-operations-and-server-tuning.md), [15](15-postgres-from-typescript.md).

### 11.4 Fewer round trips, short transactions

- Combine work: `RETURNING` (9.10), data-modifying CTEs (9.9), multi-row and array statements (9.1, 9.2, 9.6), and `ON CONFLICT` instead of "SELECT, then INSERT or UPDATE" (also a race [38]).
- Never keep a transaction open while waiting for a user, an HTTP call, a queue or an LLM. Open transactions hold locks and an old snapshot that stops `VACUUM` ([08](08-transactions-concurrency-locking.md), [09](09-operations-and-server-tuning.md)). Do slow work first, then write in a short transaction.

### 11.5 Select only needed columns; bound every result; cache with care

- Values above about 2 kB are compressed and/or stored out of line (TOAST) [62]: list views should not fetch `documents.body` or `chunks.embedding`. Narrow lists also allow index-only scans ([05](05-indexing.md)).
- Every list query has `ORDER BY` and `LIMIT`, with a server-enforced maximum page size: "If application limits are not defined, things can get out of control quickly" [49]. Jobs use batches (9.8); exports use a cursor or `COPY` (5.8).
- Cache expensive, slowly changing results (dashboards, reference data) in a materialized view (10.3) or an application cache with expiry. Do not use a cache to hide a missing index.

## 12. Dynamic SQL done safely

Dynamic SQL is needed for optional filters (3.7), user-chosen sort columns, and table names in maintenance scripts or DDL. SQL injection and privileges: [11](11-security.md).

### 12.1 In the application (TypeScript)

- **Values** always go in parameters; never concatenate them into the SQL text [85].
- **Identifiers** cannot be parameters [85]: map user input to a **whitelist** of known SQL fragments, or quote with `escapeIdentifier` from `pg` [87]. Whitelist `ASC`/`DESC` too.

```ts
const SORT_COLUMNS = { created: 'o.created_at', total: 'o.total_cents' } as const;

function buildOrderSearch(f: { userId?: string; status?: string; sort: keyof typeof SORT_COLUMNS }) {
  const where: string[] = [];
  const values: unknown[] = [];
  if (f.userId !== undefined) { values.push(f.userId); where.push(`o.user_id = $${values.length}`); }
  if (f.status !== undefined) { values.push(f.status); where.push(`o.status = $${values.length}`); }
  const text = `
    SELECT o.id, o.user_id, o.status, o.total_cents, o.created_at
    FROM orders AS o
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${SORT_COLUMNS[f.sort]} DESC, o.id DESC
    LIMIT 50`;
  return { text, values };
}
```

Each filter combination becomes a simple, indexable query, and values stay parameters [17].

### 12.2 In PL/pgSQL: `format()` and `EXECUTE … USING`

```sql
CREATE FUNCTION count_rows_since(p_table text, p_since timestamptz) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    n bigint;
BEGIN
    EXECUTE format('SELECT count(*) FROM %I WHERE created_at >= $1', p_table)
    INTO n
    USING p_since;
    RETURN n;
END;
$$;
```

- `%I` quotes an identifier; `%L` quotes a literal (a null becomes unquoted `NULL`); `%s` inserts text **as is** and is unsafe for user input [65]. Schema-qualified: `format('%I.%I', schema_name, table_name)`.
- Pass values with `USING`: it "is much less prone to SQL-injection attacks since there is no need for quoting or escaping" [64]. `EXECUTE` re-plans on each call with the actual values [64].

## 13. Anti-pattern catalog

*Italic* names are chapters of Bill Karwin's *SQL Antipatterns, Volume 1* (2022) [88]; "Wiki" marks the PostgreSQL wiki's "Don't Do This" [1]. Karwin's 2026 follow-up *More SQL Antipatterns* has chapters named "Non-Sargable Queries", "Pagination: Take It from the Top", "Dynamic Pivot" and "Fear of JOINs" [89], matching sections 3, 5 and 8.6 here.

### 13.1 Design anti-patterns, seen from the query side

Fixes belong to schema design: [07](07-schema-design-and-patterns.md), [03](03-postgresql-features-and-types.md).

| Anti-pattern | Query symptom | Fix |
|---|---|---|
| *Jaywalking* (comma-separated list in a column) | `LIKE '%,b,%'` filters, no FK, no index | Junction table (or a typed array with a GIN index) |
| *Naive Trees* | One query per tree level | Recursive CTE (8.15), closure table, `ltree` |
| *ID Required* | Duplicate pairs in a many-to-many table | Composite primary key on the pair |
| *Keyless Entry* (no foreign keys) | Orphan rows | Foreign keys, indexed on the referencing side |
| *Entity-Attribute-Value* | Pivot-heavy queries on `(entity, name, value text)` | Real columns; `jsonb` for truly sparse data |
| *Polymorphic Associations* | `parent_type` + `parent_id`, no FK possible | One FK column per parent + `CHECK`, or one table per parent |
| *Multicolumn Attributes* | `tag1 = $1 OR tag2 = $1 OR tag3 = $1` | Child table |
| *Metadata Tribbles* | Hand-made `orders_2025`, `orders_2026`; `UNION` everywhere | Native partitioning |
| *Rounding Errors* | Sums off by a cent: floats are inexact [81] | `numeric` or integer cents |
| *31 Flavors* | Adding a status needs DDL (`CHECK`/enum) | Lookup table + foreign key |
| *Phantom Files* | Paths to files that no longer exist | `bytea` when a file must follow transactions and backups; otherwise object storage plus an orphan-cleanup job |
| *Index Shotgun* | Many unused or duplicate indexes, slow writes | Measure first ([05](05-indexing.md)) |
| Wiki: `timestamp` (no time zone), `money`, `char(n)`, default `varchar(n)`, `serial`, quoted upper-case names | Wrong times, rounding, padding, limits, quoting | `timestamptz`, `numeric`, `text` (+ `CHECK`), identity, `snake_case` |

### 13.2 Query and application anti-patterns

| Anti-pattern | Symptom | Why it hurts | Fix |
|---|---|---|---|
| *Implicit Columns* (`SELECT *`, `INSERT` without columns) | Breaks on schema change; slow lists | Extra I/O, TOAST reads, no index-only scans | Explicit lists (2.5) |
| Comma joins | Silent Cartesian products | Join conditions mixed with filters | `INNER JOIN … ON` (2.4) |
| Non-sargable predicates | Seq scan despite an index | Index stores the raw column | Range rewrite, expression index (3) |
| Wiki: `BETWEEN` with timestamps | Midnight rows counted twice | Closed interval | `>= start AND < end` (3.1) |
| Type mismatch (`bigint` vs `numeric`) | Seq scan on a key lookup | The column gets cast | Cast the parameter (3.5) |
| Catch-all `($1 IS NULL OR col = $1)` | Generic plan scans everything | One plan for all combinations | Build needed predicates (3.7, 12) |
| *Fear of the Unknown*; Wiki: `NOT IN (subquery)` | Empty results; O(N²) subplans | `NULL` logic; no anti-join | `NOT EXISTS`, `IS DISTINCT FROM` (4.2, 4.8) |
| `DISTINCT` to hide duplicates; needless `UNION` | Slow sorts, wrong counts | Masks a bad join | Fix the join, `EXISTS`, `UNION ALL` (4.4) |
| *Spaghetti Query* / fan-out | Inflated sums, huge intermediates | One-to-many joins multiply rows | Aggregate, then join (4.3) |
| *Ambiguous Groups* | "must appear in the GROUP BY clause" errors | Value per group undefined | Aggregate, `DISTINCT ON`, window; `any_value()` (PG 16+) [27] |
| `count(*)` for existence | Slow "any?" checks | Counts every match | `EXISTS` (6.3) |
| Exact totals on every page | The count is the slowest query | MVCC: no stored count | Estimate or cap (5.7, 6.4) |
| Deep `OFFSET`; `ORDER BY` without tie-breaker | Slow late pages; rows repeat or vanish | Skipped rows still computed; ties unordered | Keyset + primary key tie-breaker (5) |
| *Random Selection* | Slow "random item" | Full scan per call | `TABLESAMPLE` (8.12) |
| *Poor Man's Search Engine* | Slow search, no ranking | No index for `'%word%'` | `pg_trgm`, full-text search (3.3) |
| Unbounded queries | Memory spikes, timeouts | Grows with the data | `LIMIT`, max page size (11.5) |
| N+1 queries; huge generated `IN` lists | Hundreds of queries; parameter-limit errors | Round trips; no plan reuse | One query per relation, `= ANY($1)` (11.1, 11.2) |
| Row-by-row loops; one `INSERT` per row | Jobs and imports take hours | Fixed cost × N | Set-based statements, `unnest`, `COPY` (1.1, 9.1–9.3) |
| SELECT-then-INSERT | Duplicate-key errors under load | Race between check and insert | `ON CONFLICT` (8.16, 9.4) |
| No-op and fake-upsert updates | Bloat, WAL, triggers for nothing | Each `UPDATE` writes a row version | `IS DISTINCT FROM` (9.4, 9.7) |
| Giant single-transaction `UPDATE`/`DELETE` | Locks, replica lag, bloat | One huge transaction | Batches, partition drops (9.8, 9.11) |
| Long transactions around slow work | Lock waits; `VACUUM` blocked | Old snapshots, held locks | Short transactions (11.4) |
| Correlated scalar subqueries on big sets | Nested loops over millions of rows | One subquery per row | Aggregate and join (10.5) |
| Deep view stacks | Simple queries, huge plans | Every layer is included | Shallow views (10.4) |
| Wiki: rules (`CREATE RULE`) | Surprising rewrites | "They don't do what they look like they do" [1] | Triggers |
| *SQL Injection*; *Readable Passwords* | Leaks, data loss | Input becomes SQL; plain-text secrets | Parameters, whitelists, `%I`/`%L` (12); hashing ([11](11-security.md)) |
| *Pseudokey Neat-Freak* | Code renumbering ids to close gaps | Breaks references | Accept gaps (9.4) |
| *See No Evil* | Swallowed errors, ignored row counts | Silent failures | Check `rowCount`, log failing SQL |
| *Diplomatic Immunity*; *Standard Operating Procedures* | Untested SQL; logic in procedures by default | Regressions; hard to test and deploy | Migrations in Git, tests, this checklist; functions only where they help (10.3) |

## 14. Query review checklist

Apply before merging a query (developers and AI agents alike).

**Correctness**

- [ ] Right rows with `NULL`s, duplicates, empty input, ties and time zones (4.8).
- [ ] Anti-joins use `NOT EXISTS`, never `NOT IN (subquery)` (4.2).
- [ ] No join multiplies rows unexpectedly; child tables are aggregated before joining (4.3).
- [ ] No `DISTINCT` hides a bad join; `UNION ALL` unless de-duplication is needed (4.4).
- [ ] Time filters are half-open ranges on the raw column, in an explicit time zone (3.1).
- [ ] `UPDATE … FROM` matches at most one source row per target row (9.6).
- [ ] Concurrent paths (get-or-create, state changes) are atomic: `ON CONFLICT`, guarded `UPDATE … WHERE state = …`, or retries (8.14, 8.16).

**Performance**

- [ ] Predicates are sargable; parameter types match column types (3).
- [ ] Hot-path filters and sorts are backed by an index, checked with `EXPLAIN (ANALYZE, BUFFERS)` on production-like data ([05](05-indexing.md), [06](06-query-optimization-and-explain.md)).
- [ ] Existence checks use `EXISTS` (6.3).
- [ ] List queries have `ORDER BY` with a unique tie-breaker, and a `LIMIT` (5.4, 11.5).
- [ ] Pagination past the first pages uses keyset, not `OFFSET` (5.2).
- [ ] No exact total count on large tables, or it is capped or estimated (5.7).
- [ ] Only needed columns; large text, `jsonb` and embeddings only when needed (2.5, 11.5).
- [ ] No query inside a loop over results (11.1); lists passed as one array (11.2).
- [ ] Correlated subqueries only in `EXISTS` / `NOT EXISTS` / `IN`, or on small sets (10.5).

**Writes**

- [ ] Bulk writes use multi-row `VALUES`, `unnest` arrays or `COPY` (9.1–9.3).
- [ ] Upserts use `ON CONFLICT` with the right target, skip no-op updates, and handle `RETURNING` for skipped rows (9.4, 8.16).
- [ ] Updates skip unchanged rows with `IS DISTINCT FROM` (9.7).
- [ ] Large `UPDATE`/`DELETE` run in batches with short transactions (9.8).
- [ ] Transactions contain no network calls or user waits (11.4).

**Safety and style**

- [ ] Values are parameters; identifiers come from a whitelist or `%I` / `escapeIdentifier` (12).
- [ ] Explicit `INNER JOIN` / `LEFT JOIN … ON`, qualified columns, explicit column lists (2).
- [ ] `MATERIALIZED` only on purpose, with a comment; recursive CTEs have cycle and depth guards (10.1, 10.2).
- [ ] The SQL passes SQLFluff or follows section 2; comments explain non-obvious rules.

## Sources

1. [Don't Do This](https://wiki.postgresql.org/wiki/Don't_Do_This) — PostgreSQL wiki: NOT IN (NULLs, subplans), BETWEEN, upper-case names, timestamp, char(n), varchar(n), money, serial, rules.
2. [No Offset](https://use-the-index-luke.com/no-offset) — Markus Winand: why OFFSET is slow and drifts; keyset pagination.
3. [Paging Through Results](https://use-the-index-luke.com/sql/partial-results/fetch-next-page) — Markus Winand: seek method, row values, deterministic order, PostgreSQL support.
4. [LIMIT and OFFSET](https://www.postgresql.org/docs/current/queries-limit.html) — PostgreSQL 18 docs: unique ORDER BY; skipped rows still computed.
5. [Row and Array Comparisons](https://www.postgresql.org/docs/current/functions-comparisons.html) — PostgreSQL 18 docs: NOT IN and NULL, row-wise comparison, IS DISTINCT FROM, ANY/ALL.
6. [SQL Style Guide](https://www.sqlstyle.guide/) — Simon Holywell: uppercase keywords, rivers, AS aliases, naming.
7. [SQL Style Guide](https://handbook.gitlab.com/handbook/enterprise-data/platform/sql-style-guide/) — GitLab Data team: SQLFluff setup, uppercase, qualified columns, CTEs, aliases.
8. [SQL Query Guidelines](https://docs.gitlab.com/development/sql/) — GitLab: trigram indexes, plucking IDs, UNION vs OR (800 ms vs 15 ms), EXISTS, order by id.
9. [Default Configuration](https://docs.sqlfluff.com/en/stable/configuration/default_configuration.html) — SQLFluff: rules = all, trailing commas, capitalisation "consistent", 80 columns.
10. [Ambiguous rules](https://docs.sqlfluff.com/en/stable/reference/rules/ambiguous.html) — SQLFluff: AM02 UNION, AM04 SELECT *, AM05 INNER JOIN.
11. [Layout rules](https://docs.sqlfluff.com/en/stable/reference/rules/layout.html) — SQLFluff: LT04 leading/trailing commas.
12. [Convention rules](https://docs.sqlfluff.com/en/stable/reference/rules/convention.html) — SQLFluff: CV04 count(*), CV01 not-equal style.
13. [References rules](https://docs.sqlfluff.com/en/stable/reference/rules/references.html) — SQLFluff: RF02 qualified references.
14. [How we style our SQL](https://docs.getdbt.com/best-practices/how-we-style/2-how-we-style-our-sql) — dbt Labs: lowercase, trailing commas, explicit joins, union all.
15. [Date types](https://use-the-index-luke.com/sql/where-clause/obfuscation/dates) — Markus Winand: functions on date columns; explicit ranges.
16. [Math](https://use-the-index-luke.com/sql/where-clause/obfuscation/math) — Markus Winand: arithmetic on indexed columns.
17. [Smart Logic](https://use-the-index-luke.com/sql/where-clause/obfuscation/smart-logic) — Markus Winand: catch-all filters; dynamic SQL with bind parameters.
18. [LIKE performance tuning](https://use-the-index-luke.com/sql/where-clause/searching-for-ranges/like-performance-tuning) — Markus Winand: avoid leading wildcards.
19. [pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html) — PostgreSQL 18 docs: trigram indexes for LIKE/ILIKE/regex; trusted.
20. [Operator Classes and Operator Families](https://www.postgresql.org/docs/current/indexes-opclass.html) — PostgreSQL 18 docs: text_pattern_ops for LIKE prefixes.
21. [citext](https://www.postgresql.org/docs/current/citext.html) — PostgreSQL 18 docs: limits; nondeterministic collations recommended.
22. [Indexes on Expressions](https://www.postgresql.org/docs/18/indexes-expressional.html) — PostgreSQL 18 docs: lower(col) index; maintenance cost.
23. [Very large integers causing a Sequential Scan](https://pganalyze.com/blog/5mins-postgres-large-integers-causing-sequential-scan-instead-of-using-index) — pganalyze (Lukas Fittl): bigint vs numeric, 1000x slower, cast parameters.
24. [Combining Multiple Indexes](https://www.postgresql.org/docs/18/indexes-bitmap-scans.html) — PostgreSQL 18 docs: OR and bitmap scans.
25. [PostgreSQL 18 release notes](https://www.postgresql.org/docs/release/18.0/) — postgresql.org: skip scan, OR to ANY, RETURNING OLD/NEW, uuidv7, casefold, REJECT_LIMIT, self-join removal, IN-list query ids.
26. [PostgreSQL 17 release notes](https://www.postgresql.org/docs/release/17.0/) — postgresql.org: MERGE RETURNING / NOT MATCHED BY SOURCE, COPY ON_ERROR, IN-list B-tree scans, correlated IN to join.
27. [PostgreSQL 16 release notes](https://www.postgresql.org/docs/release/16.0/) — postgresql.org: any_value(), generate_series with time zone.
28. [PostgreSQL 15 release notes](https://www.postgresql.org/docs/release/15.0/) — postgresql.org: MERGE, NULLS NOT DISTINCT, faster ranking windows, recursive_worktable_factor.
29. [PostgreSQL 14 release notes](https://www.postgresql.org/docs/release/14.0/) — postgresql.org: date_bin, SEARCH/CYCLE, DETACH PARTITION CONCURRENTLY.
30. [PostgreSQL 12 release notes](https://www.postgresql.org/docs/release/12.0/) — postgresql.org: CTE inlining, MATERIALIZED / NOT MATERIALIZED.
31. [Release 19 (beta notes)](https://www.postgresql.org/docs/19/release-19.html) — postgresql.org: NOT IN to anti-join, eager aggregation, COPY JSON and ON_ERROR SET_NULL.
32. [PostgreSQL 19 Beta 4 Released!](https://www.postgresql.org/about/news/postgresql-19-beta-4-released-3386/) — postgresql.org: list of features reverted in beta 4; GA expected October 2026.
33. [INSERT (PostgreSQL 19 beta)](https://www.postgresql.org/docs/19/sql-insert.html) — postgresql.org: ON CONFLICT DO SELECT.
34. [Window Functions (PostgreSQL 19 beta)](https://www.postgresql.org/docs/19/functions-window.html) — postgresql.org: IGNORE NULLS / RESPECT NULLS.
35. [INSERT](https://www.postgresql.org/docs/18/sql-insert.html) — PostgreSQL 18 docs: ON CONFLICT, EXCLUDED, RETURNING rules, cardinality violation, partial index inference.
36. [MERGE](https://www.postgresql.org/docs/18/sql-merge.html) — PostgreSQL 18 docs: WHEN clauses, RETURNING, source ordering against deadlocks.
37. [Transaction Isolation](https://www.postgresql.org/docs/18/transaction-iso.html) — PostgreSQL 18 docs: ON CONFLICT and MERGE under concurrency.
38. [How to Get or Create in PostgreSQL](https://hakibenita.com/postgresql-get-or-create) — Haki Benita: DO NOTHING RETURNING, no-op update bloat, MERGE races.
39. [WITH Queries](https://www.postgresql.org/docs/18/queries-with.html) — PostgreSQL 18 docs: recursion, SEARCH/CYCLE, materialization, data-modifying CTEs.
40. [PostgreSQL count(*) made fast](https://www.cybertec-postgresql.com/en/postgresql-count-made-fast/) — Cybertec (Laurenz Albe): why count is slow, count(1), estimates, counter tables.
41. [Count estimate](https://wiki.postgresql.org/wiki/Count_estimate) — PostgreSQL wiki: reltuples, EXPLAIN-based count_estimate, injection warning.
42. [pg_class](https://www.postgresql.org/docs/18/catalog-pg-class.html) — PostgreSQL 18 docs: reltuples estimate, -1 when never vacuumed or analyzed.
43. [What's Faster? COUNT(*) or COUNT(1)?](https://blog.jooq.org/whats-faster-count-or-count1/) — jOOQ blog (Lukas Eder): ~10% on PostgreSQL 11; counting after LEFT JOIN.
44. [Avoid Using COUNT() When You Could Use EXISTS()](https://blog.jooq.org/avoid-using-count-in-sql-when-you-could-use-exists/) — jOOQ blog (Lukas Eder): EXISTS short-circuits.
45. [10 Common Mistakes Java Developers Make when Writing SQL](https://blog.jooq.org/10-common-mistakes-java-developers-make-when-writing-sql/) — jOOQ blog (Lukas Eder): NULL, in-memory work, UNION ALL, DISTINCT, batching.
46. [IN List or Array?](https://blog.jooq.org/sql-in-predicate-with-in-list-or-with-array-which-is-faster/) — jOOQ blog (Lukas Eder): IN lists vs arrays on PostgreSQL 9.5.
47. [Subqueries and performance in PostgreSQL](https://www.cybertec-postgresql.com/en/subqueries-and-performance-in-postgresql/) — Cybertec (Laurenz Albe): semi/anti-joins, NOT IN, correlated subqueries.
48. [Pagination and the problem of the total result count](https://www.cybertec-postgresql.com/en/pagination-problem-total-result-count/) — Cybertec (Laurenz Albe): OFFSET, WITH HOLD cursors, keyset, counts.
49. [Pagination guidelines](https://docs.gitlab.com/development/database/pagination_guidelines/) — GitLab: keyset preferred, "1000+" counts, database-side pagination.
50. [Iterating tables in batches](https://docs.gitlab.com/development/database/iterating_tables_in_batches/) — GitLab: each_batch on the primary key.
51. [SELECT](https://www.postgresql.org/docs/18/sql-select.html) — PostgreSQL 18 docs: DISTINCT ON, LATERAL, TABLESAMPLE.
52. [Value Expressions](https://www.postgresql.org/docs/18/sql-expressions.html) — PostgreSQL 18 docs: FILTER, default window frame and peers.
53. [First/Last per Group: DISTINCT ON](https://dev.to/franckpachot/firstlast-per-group-postgresql-distinct-on-and-mongodb-distinctscan-performance-1e9d) — Franck Pachot: DISTINCT ON reads every row on PG 18.
54. [Loose indexscan](https://wiki.postgresql.org/wiki/Loose_indexscan) — PostgreSQL wiki: recursive CTE skipping through an index.
55. [The FILTER clause](https://modern-sql.com/feature/filter) — modern-sql.com (Markus Winand): FILTER and its CASE emulation.
56. [Introduction to Gaps and Islands Analysis](https://www.red-gate.com/simple-talk/databases/sql-server/t-sql-programming-sql-server/introduction-to-gaps-and-islands-analysis/) — Simple Talk (Edward Pollack): row-number difference, next-value gaps.
57. [Practical SQL for Data Analysis](https://hakibenita.com/sql-for-data-analysis) — Haki Benita: sampling, percentiles, fills, width_bucket, ntile, generated axes.
58. [Some SQL Tricks of an Application DBA](https://hakibenita.com/sql-tricks-application-dba) — Haki Benita: update only what changes (1.58 s vs 0.30 s), load before constraints.
59. [Boosting Postgres INSERT Performance by 2x With UNNEST](https://www.tigerdata.com/blog/boosting-postgres-insert-performance) — Tiger Data (James Blackwood-Sewell): 2.13x at 1,000 rows; planning cost.
60. [Populating a Database](https://www.postgresql.org/docs/18/populate.html) — PostgreSQL 18 docs: COPY, one transaction, indexes after load, ANALYZE.
61. [Table Partitioning](https://www.postgresql.org/docs/18/ddl-partitioning.html) — PostgreSQL 18 docs: DROP/DETACH partitions instead of bulk DELETE.
62. [TOAST](https://www.postgresql.org/docs/18/storage-toast.html) — PostgreSQL 18 docs: 2 kB threshold.
63. [PREPARE](https://www.postgresql.org/docs/18/sql-prepare.html) — PostgreSQL 18 docs: custom vs generic plans, plan_cache_mode.
64. [PL/pgSQL Basic Statements](https://www.postgresql.org/docs/18/plpgsql-statements.html) — PostgreSQL 18 docs: EXECUTE … USING, quoting, re-planning.
65. [String Functions](https://www.postgresql.org/docs/18/functions-string.html) — PostgreSQL 18 docs: format() %I, %L, %s.
66. [tablefunc](https://www.postgresql.org/docs/18/tablefunc.html) — PostgreSQL 18 docs: crosstab, input ordering; trusted.
67. [Date/Time Functions](https://www.postgresql.org/docs/18/functions-datetime.html) — PostgreSQL 18 docs: date_bin, date_trunc with time zone.
68. [Set Returning Functions](https://www.postgresql.org/docs/18/functions-srf.html) — PostgreSQL 18 docs: generate_series for timestamps.
69. [Aggregate Functions](https://www.postgresql.org/docs/18/functions-aggregate.html) — PostgreSQL 18 docs: count semantics, sum of no rows, percentiles.
70. [Mathematical Functions](https://www.postgresql.org/docs/18/functions-math.html) — PostgreSQL 18 docs: width_bucket.
71. [tsm_system_rows](https://www.postgresql.org/docs/18/tsm-system-rows.html) — PostgreSQL 18 docs: SYSTEM_ROWS sampling; trusted.
72. [DECLARE](https://www.postgresql.org/docs/18/sql-declare.html) — PostgreSQL 18 docs: cursors and WITH HOLD.
73. [REFRESH MATERIALIZED VIEW](https://www.postgresql.org/docs/18/sql-refreshmaterializedview.html) — PostgreSQL 18 docs: CONCURRENTLY needs a unique index.
74. [Trigger Functions](https://www.postgresql.org/docs/18/functions-trigger.html) — PostgreSQL 18 docs: suppress_redundant_updates_trigger; cost of redundant updates.
75. [UPDATE](https://www.postgresql.org/docs/18/sql-update.html) — PostgreSQL 18 docs: one-match rule for FROM, batching with ctid, ordering against deadlocks.
76. [DELETE](https://www.postgresql.org/docs/18/sql-delete.html) — PostgreSQL 18 docs: USING, batched delete.
77. [COPY](https://www.postgresql.org/docs/18/sql-copy.html) — PostgreSQL 18 docs: FROM STDIN / TO, ON_ERROR, REJECT_LIMIT.
78. [Indexes and ORDER BY](https://www.postgresql.org/docs/18/indexes-ordering.html) — PostgreSQL 18 docs: backward scans, ORDER BY + LIMIT.
79. [Views and the Rule System](https://www.postgresql.org/docs/18/rules-views.html) — PostgreSQL 18 docs: views expanded and pulled up.
80. [Inlining of SQL functions](https://wiki.postgresql.org/wiki/Inlining_of_SQL_functions) — PostgreSQL wiki: inlining conditions.
81. [Numeric Types](https://www.postgresql.org/docs/18/datatype-numeric.html) — PostgreSQL 18 docs: numeric for money; floats inexact.
82. [Array Functions](https://www.postgresql.org/docs/18/functions-array.html) — PostgreSQL 18 docs: multi-argument unnest in FROM.
83. [PostgreSQL Limits](https://www.postgresql.org/docs/18/limits.html) — PostgreSQL 18 docs: 65,535 query parameters.
84. [Query optimization](https://www.prisma.io/docs/orm/prisma-client/queries/query-optimization-performance) — Prisma docs: n+1, findUnique batching, relationLoadStrategy.
85. [Queries](https://node-postgres.com/features/queries) — node-postgres docs: parameters, no identifier parameters, prepared statements.
86. [pg-cursor](https://node-postgres.com/apis/cursor) — node-postgres docs: large results without loading all rows.
87. [Utilities](https://node-postgres.com/apis/utilities) — node-postgres docs: escapeIdentifier, escapeLiteral.
88. [SQL Antipatterns, Volume 1](https://pragprog.com/titles/bksap1/sql-antipatterns-volume-1/) — Bill Karwin, Pragmatic Bookshelf (2022): anti-pattern chapter list.
89. [More SQL Antipatterns](https://pragprog.com/titles/bksap2/more-sql-antipatterns/) — Bill Karwin, Pragmatic Bookshelf (2026): chapter list.
90. [Window Functions](https://www.postgresql.org/docs/18/functions-window.html) — PostgreSQL 18 docs: row_number, rank, dense_rank, ntile.
91. [Sorting Rows](https://www.postgresql.org/docs/18/queries-order.html) — PostgreSQL 18 docs: default NULL ordering.
92. [CREATE FUNCTION](https://www.postgresql.org/docs/18/sql-createfunction.html) — PostgreSQL 18 docs: ROWS default 1000.
93. [NOT IN vs. NOT EXISTS vs. LEFT JOIN / IS NULL: PostgreSQL](https://explainextended.com/2009/09/16/not-in-vs-not-exists-vs-left-join-is-null-postgresql/) — Explain Extended (Quassnoi, 2009): same anti-join plan; hashed vs plain subplan.
94. [pg-protocol serializer](https://github.com/brianc/node-postgres/blob/master/packages/pg-protocol/src/serializer.ts) — node-postgres source: Parse sends no parameter types by default.
