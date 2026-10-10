# SQL Fundamentals (Standard SQL, PostgreSQL Flavor)

> Part of the [SQL & PostgreSQL reference library](README.md) · Last researched: 2026-10-05 · Targets PostgreSQL 14–18 (19 beta noted where relevant)

**What this covers.** The core of the SQL language, taught with PostgreSQL as the reference dialect: how a query is evaluated, NULL logic, joins, aggregation, subqueries, CTEs, window functions, set operations, changing data, basic DDL, transactions, types and literals, and everyday functions. It ends with how to "think in sets". PostgreSQL-only syntax and data types are in [03](03-postgresql-features-and-types.md). Performance is in [05](05-indexing.md) and [06](06-query-optimization-and-explain.md). Differences between database products are in [02](02-sql-dialects-compared.md).

## Key rules (TL;DR)

1. Think in sets: one statement that changes 10,000 rows beats a loop that runs 10,000 statements.
2. Remember the logical order: `FROM` → `WHERE` → `GROUP BY` → `HAVING` → window functions → `SELECT` → `DISTINCT` → set operations → `ORDER BY` → `OFFSET`/`LIMIT`.
3. Never write `= NULL` or `<> NULL`; use `IS [NOT] NULL` or `IS [NOT] DISTINCT FROM`.
4. Never use `NOT IN (subquery)`; use `NOT EXISTS`. One NULL in the subquery makes `NOT IN` return no rows.
5. In an outer join, put conditions on the optional table in `ON`, not in `WHERE`.
6. Always add `ORDER BY` with a unique tie-breaker when you use `LIMIT`, `OFFSET` or `FETCH FIRST`.
7. Use `count(*)` to count rows; `count(col)` counts only non-NULL values.
8. Wrap `sum()` and `array_agg()` in `coalesce()` when "no rows" must mean `0` or an empty array.
9. Use `FILTER (WHERE ...)` for conditional aggregates instead of `CASE` inside the aggregate.
10. Write explicit `JOIN ... ON`; do not use `NATURAL JOIN`.
11. Use `EXISTS` for "has at least one" checks; it stops at the first match.
12. Use window functions for running totals, rankings and "top N per group"; set an explicit frame for `last_value()`.
13. Prefer `UNION ALL`; use `UNION` only when you really need duplicates removed.
14. Use `RETURNING` to get generated ids and changed rows back in the same statement.
15. Prefer `GENERATED ... AS IDENTITY` columns over `serial`.
16. Name things in lowercase `snake_case`; never quote identifiers; avoid reserved words like `user` and `order` as names.
17. Single quotes are for strings; double quotes are only for identifiers.
18. Watch integer division: `5 / 2` is `2`. Cast one side to `numeric` when you need decimals.
19. Use half-open time ranges (`>= start AND < end`), not `BETWEEN`, for timestamps.
20. Keep transactions short; in an aborted transaction every command fails until `ROLLBACK`.
21. Use CTEs freely for readability: since PostgreSQL 12 they are inlined when safe; add `MATERIALIZED` only when you want a fence.
22. Use `DELETE`, not `TRUNCATE`, on tables that live traffic reads: `TRUNCATE` takes an `ACCESS EXCLUSIVE` lock and is not MVCC-safe.

## 1. What SQL is

### 1.1 Declarative and set-based

SQL is **declarative**: you describe *what* result you want, not *how* to compute it. The **planner** (also called optimizer) chooses the steps: which index to use, which join method, which order. This is why the same query can run in 2 ms or 2 minutes depending on indexes and statistics (see [06](06-query-optimization-and-explain.md)).

SQL is **set-based**: a statement works on a whole set of rows at once. `UPDATE orders SET status = 'cancelled' WHERE created_at < now() - interval '30 days'` changes every matching row in one operation. You do not write the loop; the database runs it internally, close to the data.

### 1.2 The relational model in brief

E. F. Codd defined the relational model in 1970. Its vocabulary maps to SQL like this:

| Relational theory | SQL word | Meaning |
|---|---|---|
| Relation | Table | A set of rows with the same columns |
| Tuple | Row | One record |
| Attribute | Column | A named value with a type |
| Domain | Data type (or `DOMAIN`) | The allowed values of a column |
| Candidate / primary key | `PRIMARY KEY`, `UNIQUE` | Columns that identify a row |
| Foreign key | `REFERENCES` | A link to a key in another table |

SQL is not a pure implementation of the theory:

- A table can contain **duplicate rows** (SQL works with "bags", also called multisets). Use keys to prevent this.
- SQL has **NULL** and three-valued logic (section 5).
- Rows have **no order**. Without `ORDER BY`, the database may return rows in any order, and the order can change between runs.

### 1.3 The SQL standard

The standard is ISO/IEC 9075, "Database Language SQL". It is public but not free (only Part 1 can be downloaded at no cost) [3]. It has many parts; most features are optional, and only a "Core" set is mandatory [3][2].

| Edition | Highlights (selection) |
|---|---|
| SQL-86, SQL-89 | First standard versions; SQL-89 added integrity constraints [44] |
| SQL-92 | Major revision; the classic base most people learn (explicit `JOIN` syntax, `CASE`, `CAST`) |
| SQL:1999 | Recursive queries (`WITH RECURSIVE`), triggers, regular expressions, arrays [44] |
| SQL:2003 | Window functions, sequences and identity columns, `MERGE`, SQL/XML [44][45], the `FILTER` clause [29] |
| SQL:2008 | `TRUNCATE`, `FETCH FIRST`, `INSTEAD OF` triggers [44] |
| SQL:2011 | Temporal data (`PERIOD FOR`), window function and `FETCH` enhancements [44] |
| SQL:2016 | SQL/JSON functions (`JSON_TABLE`, `JSON_VALUE`, ...), `MATCH_RECOGNIZE`, `LISTAGG` [31] |
| SQL:2019 | Multi-dimensional arrays (SQL/MDA) [3] |
| SQL:2023 | `UNIQUE NULLS [NOT] DISTINCT`, `GREATEST`/`LEAST`, `ANY_VALUE`, hex/octal/binary literals, `_` in numbers, a JSON type, property graph queries (SQL/PGQ) [30] |

PostgreSQL "aims for conformance with the latest official version of the standard where such conformance does not contradict traditional features or common sense". It supports at least 170 of the 177 mandatory Core features of SQL:2023, and no database claims full Core conformance [2].

### 1.4 Why dialects differ

- Most standard features are **optional**, so each product implements a different subset.
- Many products added features **before** the standard defined them (for example `LIMIT`, `AUTO_INCREMENT`, `serial`), and kept their own syntax for compatibility.
- Some behaviors are left to the implementation (for example how unquoted names are folded to upper or lower case).

Result: basic `SELECT`/`INSERT`/`UPDATE`/`DELETE` is portable, but types, functions, upsert, pagination and DDL often are not. See [02](02-sql-dialects-compared.md).

## 2. Statement families

| Family | Meaning | Main statements |
|---|---|---|
| DDL — Data Definition Language | Create and change the structure | `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `COMMENT` |
| DML — Data Manipulation Language | Read and change the data | `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `MERGE` (PG 15+) [46] |
| DCL — Data Control Language | Permissions | `GRANT`, `REVOKE` (see [11](11-security.md)) |
| TCL — Transaction Control Language | Transaction boundaries | `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE SAVEPOINT` |

PostgreSQL has **transactional DDL**: `CREATE TABLE`, `ALTER TABLE` and most other DDL can be rolled back inside a transaction. Database and tablespace operations are the main exceptions [33]. Some commands (`CREATE INDEX CONCURRENTLY`, `VACUUM`, `CREATE DATABASE`) cannot run inside a transaction block at all.

## 3. Logical query processing order

You **write** `SELECT ... FROM ... WHERE ...`, but the database **evaluates** the clauses in a different logical order [1][4]:

| Step | Clause | What happens |
|---|---|---|
| 0 | `WITH` | CTEs are computed (or inlined) and can be used like tables |
| 1 | `FROM`, `JOIN`, `LATERAL` | Build the input rows from tables, joins, subqueries, functions |
| 2 | `WHERE` | Remove rows that are not `TRUE` |
| 3 | `GROUP BY` + aggregates | Form groups; compute `count()`, `sum()`, ... |
| 4 | `HAVING` | Remove groups that are not `TRUE` |
| 5 | Window functions | Compute `OVER (...)` expressions on the grouped rows |
| 6 | `SELECT` list | Compute output expressions; **aliases are created here** |
| 7 | `DISTINCT` / `DISTINCT ON` | Remove duplicate output rows |
| 8 | `UNION` / `INTERSECT` / `EXCEPT` | Combine results of several queries |
| 9 | `ORDER BY` | Sort |
| 10 | `OFFSET`, then `LIMIT` / `FETCH FIRST` | Keep only part of the sorted rows |
| 11 | `FOR UPDATE` / `FOR SHARE` | Lock the returned rows |

This is the *logical* order. The planner may execute things physically in another order (for example push a filter into a scan or read an index that is already sorted), but the result is always as if this order were followed.

### 3.1 Consequences

- **`WHERE` cannot use a `SELECT` alias** — the alias does not exist yet. The PostgreSQL docs: an output column name can be used in `ORDER BY` and `GROUP BY`, "but not in the `WHERE` or `HAVING` clauses; there you must write out the expression instead" [1].
- **`WHERE` cannot use aggregates** (groups do not exist yet). Filter groups with `HAVING`.
- **Window functions are allowed only in the `SELECT` list and `ORDER BY`** [4]. To filter on them, wrap the query.
- **`ORDER BY` can use aliases and output positions**, because it runs after `SELECT`.
- With `DISTINCT`, `ORDER BY` can only use expressions that are in the select list [4].

```sql
-- Bad: ERROR: column "total_with_tax" does not exist
SELECT id, total * 1.2 AS total_with_tax
FROM orders
WHERE total_with_tax > 100;

-- Good: repeat the expression...
SELECT id, total * 1.2 AS total_with_tax
FROM orders
WHERE total * 1.2 > 100;

-- Good: ...or compute it in a subquery or CTE first
SELECT *
FROM (SELECT id, total * 1.2 AS total_with_tax FROM orders) AS t
WHERE t.total_with_tax > 100;
```

```sql
-- Bad: ERROR: window functions are not allowed in WHERE
SELECT id, user_id FROM orders
WHERE row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) = 1;

-- Good: compute the window function first, filter outside
SELECT id, user_id
FROM (
  SELECT id, user_id,
         row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
  FROM orders
) AS ranked
WHERE rn = 1;
```

## 4. SELECT in depth

The examples in this document use this small schema:

```sql
CREATE TABLE users (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       text NOT NULL UNIQUE,
  full_name   text NOT NULL,
  country     text,                          -- NULL = unknown
  manager_id  bigint REFERENCES users (id),  -- NULL = no manager
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users (id),
  status      text NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')),
  total       numeric(12,2) NOT NULL CHECK (total >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

### 4.1 Expressions, aliases, CASE

```sql
SELECT
  o.id,
  o.total,
  o.total * 0.2                                  AS vat,          -- arithmetic
  upper(o.status)                                AS status_label, -- function call
  CASE                                                            -- searched CASE
    WHEN o.total >= 1000 THEN 'large'
    WHEN o.total >= 100  THEN 'medium'
    ELSE 'small'
  END                                            AS size_class,
  CASE o.status                                                   -- simple CASE
    WHEN 'paid'    THEN 1
    WHEN 'shipped' THEN 2
    ELSE 0
  END                                            AS progress
FROM orders AS o;
```

- `AS` is optional for column aliases, but write it: it is clearer and avoids clashes with keywords.
- A `CASE` without `ELSE` returns `NULL` when nothing matches.
- PostgreSQL does not define the evaluation order of sub-expressions. When order matters (for example to avoid division by zero), `CASE` is the documented way to force it [5].

### 4.2 COALESCE, NULLIF, GREATEST, LEAST

```sql
SELECT
  coalesce(u.country, 'unknown')  AS country,              -- first non-NULL argument
  greatest(o.total - 10, 0)       AS total_after_voucher,  -- never below 0
  least(o.total, 500)             AS capped_total
FROM orders o
JOIN users u ON u.id = o.user_id;

-- NULLIF: turn a zero divisor into NULL instead of an error
SELECT campaign, clicks::numeric / NULLIF(impressions, 0) AS click_rate
FROM ad_stats;
```

- `coalesce()` evaluates only the arguments it needs [32].
- `NULLIF(a, b)` returns `NULL` when `a = b`, otherwise `a` [32].
- In PostgreSQL, `greatest()`/`least()` **ignore NULLs** and return NULL only if all arguments are NULL. The SQL standard (and some other products) return NULL if *any* argument is NULL [32].

### 4.3 DISTINCT

```sql
SELECT DISTINCT country FROM users;            -- one row per distinct country (NULL counts once)
SELECT count(DISTINCT country) FROM users;     -- NULL is not counted
```

`DISTINCT` usually means a sort or a hash of the whole result. If you add `DISTINCT` to "fix" duplicate rows, check your joins first: duplicates often come from a missing join condition. PostgreSQL also has `DISTINCT ON` — see [03](03-postgresql-features-and-types.md).

### 4.4 ORDER BY and NULLS FIRST / LAST

```sql
SELECT id, full_name, country
FROM users
ORDER BY country ASC NULLS LAST, full_name, id;
```

- Default: `NULLS LAST` for `ASC` and `NULLS FIRST` for `DESC` ("nulls are larger than non-nulls") [1]. Other databases differ; be explicit when it matters.
- Add a **unique tie-breaker** (often the primary key) as the last sort key. Otherwise rows with equal values can come back in a different order each time, and pages can overlap or skip rows.

### 4.5 LIMIT, OFFSET, FETCH FIRST ... WITH TIES

```sql
-- PostgreSQL / MySQL / SQLite style
SELECT id, total FROM orders ORDER BY total DESC, id LIMIT 10 OFFSET 20;

-- SQL-standard style (also PostgreSQL)
SELECT id, total FROM orders ORDER BY total DESC, id
OFFSET 20 ROWS FETCH FIRST 10 ROWS ONLY;

-- WITH TIES (PG 13+): also return rows that tie with the last row
SELECT id, total FROM orders ORDER BY total DESC
FETCH FIRST 3 ROWS WITH TIES;
```

- Without `ORDER BY`, `LIMIT` returns an unpredictable subset [1].
- `WITH TIES` requires `ORDER BY` [1].
- `OFFSET n` still reads and throws away `n` rows, so deep pages get slow and can drift when rows are inserted [28]. For APIs, use keyset pagination — see [04](04-query-patterns-and-antipatterns.md).

## 5. NULL and three-valued logic

`NULL` means "unknown" or "no value". It is not zero and not an empty string. Any comparison with `NULL` gives **UNKNOWN** (shown as `NULL`), not `TRUE` or `FALSE` [6].

### 5.1 Truth tables

| `a` | `b` | `a AND b` | `a OR b` |
|---|---|---|---|
| TRUE | UNKNOWN | UNKNOWN | TRUE |
| FALSE | UNKNOWN | FALSE | UNKNOWN |
| UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |

`NOT UNKNOWN` is `UNKNOWN`. Important asymmetry:

- `WHERE`, `HAVING`, `JOIN ... ON` keep a row only if the condition is **TRUE**.
- A `CHECK` constraint **passes** if the expression is TRUE **or NULL** [9]. `CHECK (total >= 0)` accepts a NULL `total`; add `NOT NULL` if needed.

### 5.2 Testing for NULL

```sql
-- Bad: always UNKNOWN, returns no rows
SELECT * FROM users WHERE country = NULL;

-- Good
SELECT * FROM users WHERE country IS NULL;
SELECT * FROM users WHERE country IS NOT NULL;

-- NULL-safe comparison: treats NULL like a normal value
SELECT * FROM users WHERE country IS DISTINCT FROM 'FR';      -- includes NULL countries
SELECT * FROM users WHERE country IS NOT DISTINCT FROM $1;    -- works when $1 is NULL
```

`1 IS DISTINCT FROM NULL` is `TRUE`, and `NULL IS NOT DISTINCT FROM NULL` is `TRUE` [6]. Use it for "has this value changed?" checks, for example in triggers: `WHEN (OLD.status IS DISTINCT FROM NEW.status)`.

Two small helpers: `num_nulls(a, b, c)` and `num_nonnulls(a, b, c)` count NULL / non-NULL arguments [6]. Useful in `CHECK` constraints such as "exactly one of these columns is set": `CHECK (num_nonnulls(card_id, iban) = 1)`.

### 5.3 NULL in aggregates

- Aggregates **skip NULL inputs**: `avg(rating)` averages only non-NULL ratings.
- `count(*)` counts rows; `count(col)` counts non-NULL values of `col` [16].
- Except `count`, aggregates return **NULL when there are no rows**: `sum()` of zero rows is `NULL`, not `0`, and `array_agg()` returns `NULL`, not an empty array [16].

```sql
SELECT
  count(*)                    AS orders,            -- 0 when no rows
  coalesce(sum(total), 0)     AS revenue,           -- 0 instead of NULL
  coalesce(array_agg(id), '{}') AS order_ids        -- empty array instead of NULL
FROM orders
WHERE user_id = 42;
```

### 5.4 The NOT IN trap

If the subquery returns at least one NULL, `x NOT IN (...)` can never be TRUE, so the query returns **no rows** [8][14]. `NOT IN` is also hard for the planner to optimize [8].

```sql
-- Bad: "users who manage nobody". Returns NOTHING, because the top boss
-- has manager_id = NULL, so the subquery contains a NULL.
SELECT id FROM users
WHERE id NOT IN (SELECT manager_id FROM users);

-- Good: NOT EXISTS is NULL-safe and plans as an anti-join
SELECT u.id FROM users AS u
WHERE NOT EXISTS (SELECT 1 FROM users AS r WHERE r.manager_id = u.id);
```

`NOT IN` with a constant list (`status NOT IN ('cancelled', 'pending')`) is fine as long as the list has no NULL.

### 5.5 NULLs and UNIQUE

By default, two NULLs are **not equal** for a unique constraint, so a `UNIQUE` column can hold many NULLs [9]. Since PG 15 you can change this [46]:

```sql
CREATE TABLE api_keys (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id  bigint NOT NULL REFERENCES users (id),
  label    text,
  UNIQUE NULLS NOT DISTINCT (user_id, label)   -- PG 15+: only one NULL label per user
);
```

## 6. Joins

### 6.1 Join types

| Join | Returns |
|---|---|
| `[INNER] JOIN` | Only pairs that match the condition |
| `LEFT [OUTER] JOIN` | All rows from the left; NULLs on the right when no match |
| `RIGHT [OUTER] JOIN` | All rows from the right (rewrite as `LEFT JOIN` for readability) |
| `FULL [OUTER] JOIN` | All rows from both sides; NULLs where no match |
| `CROSS JOIN` | Every combination (rows × rows) |
| `NATURAL JOIN` | Joins on all columns with the same name — **avoid** |

```sql
-- Inner join: orders with their user
SELECT o.id, o.total, u.email
FROM orders AS o
JOIN users  AS u ON u.id = o.user_id;

-- Left join: every user, with order count (0 when no orders)
SELECT u.id, u.email, count(o.id) AS order_count
FROM users AS u
LEFT JOIN orders AS o ON o.user_id = u.id
GROUP BY u.id;

-- Self join: each user with the name of their manager
SELECT e.full_name AS employee, m.full_name AS manager
FROM users AS e
LEFT JOIN users AS m ON m.id = e.manager_id;

-- Cross join: a calendar of every user × every month of 2026
SELECT u.id, m.month
FROM users AS u
CROSS JOIN generate_series(date '2026-01-01', date '2026-12-01', interval '1 month') AS m(month);
```

Note `count(o.id)`, not `count(*)`: with a `LEFT JOIN`, a user without orders still produces one row (with NULL `o.id`), so `count(*)` would say 1.

### 6.2 ON vs USING vs NATURAL

- `ON` is the general form; use it by default.
- `USING (user_id)` joins on columns with the same name and outputs the column once. It is "reasonably safe" because only listed columns are used [7]. Since PG 14 you can give the join an alias: `JOIN orders USING (user_id) AS j` [26].
- `NATURAL JOIN` joins on *every* column with the same name. It is "considerably more risky": adding a column such as `created_at` to both tables silently changes the join [7]. Do not use it.
- Avoid old comma joins (`FROM a, b WHERE a.id = b.a_id`): a forgotten condition becomes a silent cross join.

### 6.3 Filter placement in outer joins: ON vs WHERE

A condition in `ON` is applied **before** the outer join adds NULL rows; a condition in `WHERE` is applied **after**. For inner joins this does not matter; for outer joins "it matters a lot" [7].

```sql
-- Bad: the WHERE filter removes users without paid orders (o.status is NULL for them),
-- so the LEFT JOIN silently becomes an INNER JOIN.
SELECT u.id, count(o.id) AS paid_orders
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE o.status = 'paid'
GROUP BY u.id;

-- Good: filter the optional side in ON; every user stays in the result
SELECT u.id, count(o.id) AS paid_orders
FROM users u
LEFT JOIN orders o ON o.user_id = u.id AND o.status = 'paid'
GROUP BY u.id;
```

Rule: conditions on the **preserved** table (the left side of `LEFT JOIN`) go in `WHERE`; conditions on the **optional** table go in `ON`.

### 6.4 Semi-join (EXISTS) and anti-join (NOT EXISTS)

A **semi-join** returns rows from A that have at least one match in B, without duplicating A. An **anti-join** returns rows from A that have no match in B.

```sql
-- Semi-join: users with at least one paid order (each user once)
SELECT u.id, u.email
FROM users u
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status = 'paid');

-- Anti-join: users who never ordered
SELECT u.id, u.email
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id);

-- Equivalent anti-join with LEFT JOIN (also fine)
SELECT u.id, u.email
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE o.id IS NULL;
```

`EXISTS` stops as soon as one row is found; the select list inside does not matter, and `SELECT 1` is the usual convention [14]. A plain `JOIN` instead of `EXISTS` returns a user once *per order* — a common source of wrong counts.

### 6.5 LATERAL

`LATERAL` lets a subquery in `FROM` refer to columns of tables listed **before** it [7]. Think "for each row on the left, run this subquery". It is the cleanest way to get "top N per group".

```sql
-- The 3 most recent orders of each user (users without orders are kept)
SELECT u.id, u.email, recent.id AS order_id, recent.total
FROM users AS u
LEFT JOIN LATERAL (
  SELECT o.id, o.total
  FROM orders AS o
  WHERE o.user_id = u.id
  ORDER BY o.created_at DESC, o.id DESC
  LIMIT 3
) AS recent ON true;
```

`LEFT JOIN LATERAL ... ON true` keeps left rows even when the subquery returns nothing [7]. With an index on `orders (user_id, created_at)` this is usually very fast (see [05](05-indexing.md)).

## 7. Aggregation

### 7.1 GROUP BY and HAVING

```sql
SELECT u.country, count(*) AS orders, sum(o.total) AS revenue
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status <> 'cancelled'          -- filters rows (before grouping)
GROUP BY u.country
HAVING sum(o.total) > 10000            -- filters groups (after grouping)
ORDER BY revenue DESC;
```

- Every selected column must be grouped or inside an aggregate. Exception: if you group by a table's **primary key**, you may select other columns of that table, because they are *functionally dependent* on the key [7]: `GROUP BY u.id` allows `u.email`.
- Put row filters in `WHERE`, not in `HAVING`: it is clearer and lets the database discard rows earlier.

### 7.2 FILTER: conditional aggregates

```sql
SELECT
  date_trunc('month', created_at)                  AS month,
  count(*)                                         AS all_orders,
  count(*) FILTER (WHERE status = 'paid')          AS paid_orders,
  sum(total) FILTER (WHERE status = 'paid')        AS paid_revenue
FROM orders
GROUP BY 1
ORDER BY 1;
```

`FILTER` is standard SQL (SQL:2003) but few products support it; the portable form is `sum(CASE WHEN status = 'paid' THEN total END)` [29].

### 7.3 GROUPING SETS, ROLLUP, CUBE

These compute several groupings in one pass.

```sql
SELECT u.country, o.status, count(*) AS orders,
       GROUPING(u.country, o.status) AS level   -- 0 = detail, 1 = status subtotal, 3 = grand total
FROM orders o JOIN users u ON u.id = o.user_id
GROUP BY ROLLUP (u.country, o.status)
ORDER BY u.country NULLS LAST, o.status NULLS LAST;
```

- `ROLLUP (a, b)` = `GROUPING SETS ((a, b), (a), ())`.
- `CUBE (a, b)` = every combination: `(a, b), (a), (b), ()` [7].
- Subtotal rows show `NULL` in the rolled-up columns. `GROUPING()` tells a "subtotal NULL" from a "real NULL" [16].
- `GROUP BY DISTINCT` (PG 14+) removes duplicate grouping sets produced by combining several `ROLLUP`/`CUBE` [7][26].

### 7.4 Ordered aggregates: string_agg, array_agg, json_agg

The output of these aggregates depends on input order, so give an `ORDER BY` inside the call. For multi-argument aggregates the `ORDER BY` goes **after all arguments** [5].

```sql
SELECT
  u.id,
  string_agg(o.status, ', ' ORDER BY o.created_at)   AS status_history,
  array_agg(o.id ORDER BY o.created_at DESC)         AS order_ids_newest_first,
  jsonb_agg(jsonb_build_object('id', o.id, 'total', o.total) ORDER BY o.id) AS orders_json
FROM users u
JOIN orders o ON o.user_id = u.id
GROUP BY u.id;
```

Do not rely on `ORDER BY` in a subquery to order aggregate input; joins can reorder rows [16].

### 7.5 Ordered-set aggregates: median, percentiles, mode

```sql
SELECT
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY total) AS median_total,     -- interpolated
  percentile_disc(0.95) WITHIN GROUP (ORDER BY total) AS p95_total,        -- an actual value
  mode()                WITHIN GROUP (ORDER BY status) AS most_common_status
FROM orders;
```

Other useful aggregates: `bool_and()`/`bool_or()`, `min()`/`max()`, and `any_value()` (PG 16+) for "any value of this column in the group" [16][19].

## 8. Subqueries

### 8.1 Kinds of subqueries

| Kind | Returns | Example use |
|---|---|---|
| Scalar | One column, at most one row | A value in `SELECT` or `WHERE` |
| Row | One row, several columns | `WHERE (a, b) = (SELECT x, y ...)` |
| Table (derived table) | Any rows and columns | In `FROM`, like a temporary table |

```sql
-- Scalar subquery in SELECT (correlated: it uses u.id from the outer query)
SELECT u.id,
       (SELECT max(o.created_at) FROM orders o WHERE o.user_id = u.id) AS last_order_at
FROM users u;

-- Derived table in FROM (uncorrelated). Since PG 16 the alias is optional.
SELECT country, avg(order_count) AS avg_orders_per_user
FROM (
  SELECT u.country, count(o.id) AS order_count
  FROM users u LEFT JOIN orders o ON o.user_id = u.id
  GROUP BY u.id
) AS per_user
GROUP BY country;
```

- A scalar subquery that returns **more than one row** is an error; **zero rows** gives NULL.
- A **correlated** subquery refers to the outer query and is logically re-evaluated per outer row. The planner often turns `EXISTS`/`IN` subqueries into joins; a scalar subquery in `SELECT` may really run once per row. For many rows, a join or `LATERAL` is usually better (see [06](06-query-optimization-and-explain.md)).

### 8.2 IN, ANY, ALL, EXISTS

```sql
SELECT * FROM orders WHERE user_id IN (SELECT id FROM users WHERE country = 'FR');
SELECT * FROM orders WHERE total > ALL (SELECT total FROM orders WHERE status = 'cancelled');
SELECT * FROM orders WHERE total > ANY (SELECT total FROM orders WHERE status = 'cancelled');
```

- `IN` is `= ANY`; `NOT IN` is `<> ALL` [14].
- `ANY` is FALSE for an empty subquery; `ALL` is **TRUE** for an empty subquery [14]. So `total > ALL (empty)` keeps every row.
- If no value matches and the list contains a NULL, `IN` gives NULL (not FALSE) and `NOT IN` gives NULL (not TRUE) [14].
- With arrays, use `= ANY($1)` instead of building `IN ($1, $2, ...)` strings: one parameter, any length [15]. Node.js details: [PostgreSQL from TypeScript](15-postgres-from-typescript.md).

## 9. Common table expressions (WITH)

### 9.1 Plain CTEs

A CTE gives a name to a subquery, which makes long queries readable.

```sql
WITH paid AS (
  SELECT user_id, sum(total) AS revenue
  FROM orders
  WHERE status = 'paid'
  GROUP BY user_id
)
SELECT u.email, p.revenue
FROM paid p
JOIN users u ON u.id = p.user_id
ORDER BY p.revenue DESC
LIMIT 10;
```

### 9.2 Materialization (PG 12+)

Since PostgreSQL 12, a CTE is **inlined** into the main query (like a subquery) when it is non-recursive, has no side effects (no volatile functions, not a data-modifying statement), and is referenced **only once** [10][24]. Otherwise it is materialized: computed once into a temporary result, which has no indexes.

```sql
-- Force computing once (useful when an expensive function must run only once per row)
WITH w AS MATERIALIZED (SELECT id, expensive_score(payload) AS score FROM documents)
SELECT * FROM w a JOIN w b ON a.score = b.score;

-- Force inlining even if referenced twice (lets filters reach the base table)
WITH w AS NOT MATERIALIZED (SELECT * FROM orders)
SELECT * FROM w a JOIN w b ON a.user_id = b.user_id WHERE a.id = 123;
```

Old advice "CTEs are an optimization fence" is true only for PostgreSQL 11 and older, or when the rules above force materialization.

### 9.3 Recursive CTEs

Form: a non-recursive part, then `UNION [ALL]`, then a recursive part that references the CTE. The database repeats the recursive part on the rows produced by the previous step until no new rows appear [10]. `UNION` (not `ALL`) discards duplicates, which can stop some cycles; `UNION ALL` is faster.

```sql
CREATE TABLE categories (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id  bigint REFERENCES categories (id),
  name       text NOT NULL
);

-- A tree, with depth and a depth-first sort order (SEARCH: PG 14+)
WITH RECURSIVE tree AS (
  SELECT id, parent_id, name, 1 AS depth
  FROM categories
  WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, c.parent_id, c.name, t.depth + 1
  FROM categories c
  JOIN tree t ON c.parent_id = t.id
) SEARCH DEPTH FIRST BY name SET sort_order
SELECT repeat('  ', depth - 1) || name AS label
FROM tree
ORDER BY sort_order;
```

```sql
-- A graph that can contain cycles (CYCLE: PG 14+)
CREATE TABLE links (source_id bigint NOT NULL, target_id bigint NOT NULL);

WITH RECURSIVE reachable AS (
  SELECT l.target_id AS node_id
  FROM links l
  WHERE l.source_id = 1
  UNION ALL
  SELECT l.target_id
  FROM links l
  JOIN reachable r ON l.source_id = r.node_id
) CYCLE node_id SET is_cycle USING path
SELECT DISTINCT node_id FROM reachable WHERE NOT is_cycle;
```

- `SEARCH DEPTH FIRST | BREADTH FIRST BY col SET ordercol` adds a sort column [10].
- `CYCLE col SET is_cycle USING path` adds a flag and a path column and stops following a cycle [10].
- Before PG 14, track the path yourself with an array (`path || id`, `NOT id = ANY(path)`).
- Always make sure recursion ends; for safety you can add `WHERE depth < 100` in the recursive part.
- For number or date series, `generate_series()` is simpler than a recursive CTE.

Tree storage designs (adjacency list, ltree, closure table) are covered in [07](07-schema-design-and-patterns.md).

### 9.4 Data-modifying CTEs

`INSERT`, `UPDATE`, `DELETE` (and `MERGE` in PG 17+) can appear in `WITH`, usually with `RETURNING` [10].

```sql
-- Move old cancelled orders to an archive table in one atomic statement
WITH moved AS (
  DELETE FROM orders
  WHERE status = 'cancelled' AND created_at < now() - interval '1 year'
  RETURNING *
)
INSERT INTO orders_archive
SELECT * FROM moved;
```

Rules [10]:

- Each data-modifying sub-statement runs **exactly once**, to completion, even if the main query does not read its output.
- All sub-statements and the main query see the **same snapshot**: they cannot see each other's changes. `RETURNING` is the only way to pass changed rows along.
- Do not modify the same row twice in one statement; the result is not predictable.

## 10. Window functions

A window function computes a value **for each row** from a set of related rows (the "window"), **without** collapsing rows like `GROUP BY` does. Window functions run after `GROUP BY`/`HAVING` [7].

### 10.1 Syntax

```text
function(args) OVER (
  [PARTITION BY expr, ...]          -- split rows into independent groups
  [ORDER BY expr [ASC|DESC], ...]   -- order inside each partition
  [frame_clause]                    -- which rows around the current row
)
frame_clause:
  { ROWS | RANGE | GROUPS } BETWEEN frame_start AND frame_end [ EXCLUDE ... ]
frame_start / frame_end:
  UNBOUNDED PRECEDING | n PRECEDING | CURRENT ROW | n FOLLOWING | UNBOUNDED FOLLOWING
EXCLUDE:
  CURRENT ROW | GROUP | TIES | NO OTHERS
```

- `ROWS` counts physical rows. `RANGE` uses value distance (`RANGE BETWEEN interval '7 days' PRECEDING AND CURRENT ROW`, needs exactly one `ORDER BY` column). `GROUPS` counts groups of **peers** (rows with equal `ORDER BY` values) [5].
- `GROUPS`, `RANGE` with an offset, and `EXCLUDE` are available since PG 11 [25].

### 10.2 The default frame trap

The default frame is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. With `ORDER BY`, that means "from the partition start to the **last peer** of the current row". Without `ORDER BY`, it means the whole partition [5]. Two consequences:

1. A running `sum()` gives the **same value to tied rows** (they are peers). Use `ROWS` for a strict row-by-row running total.
2. `last_value()` returns the current row (or its last peer), not the partition's last row [11].

```sql
-- Bad: last_value() only sees rows up to the current one
SELECT id, user_id,
       last_value(total) OVER (PARTITION BY user_id ORDER BY created_at) AS "last?"
FROM orders;

-- Good: make the frame cover the whole partition...
SELECT id, user_id,
       last_value(total) OVER (
         PARTITION BY user_id ORDER BY created_at
         ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS last_total
FROM orders;

-- ...or, simpler: first_value() with the opposite order
SELECT id, user_id,
       first_value(total) OVER (PARTITION BY user_id ORDER BY created_at DESC) AS last_total
FROM orders;
```

### 10.3 Ranking functions

For scores 100, 90, 90, 80 ordered descending [11]:

| score | `row_number()` | `rank()` | `dense_rank()` | `percent_rank()` | `cume_dist()` | `ntile(2)` |
|---|---|---|---|---|---|---|
| 100 | 1 | 1 | 1 | 0 | 0.25 | 1 |
| 90 | 2 | 2 | 2 | 0.333 | 0.75 | 1 |
| 90 | 3 | 2 | 2 | 0.333 | 0.75 | 2 |
| 80 | 4 | 4 | 3 | 1 | 1 | 2 |

- `row_number()`: unique numbers; ties get an arbitrary order unless you add a tie-breaker.
- `rank()`: ties share a rank, with gaps. `dense_rank()`: ties share a rank, no gaps.

### 10.4 Offset and value functions

```sql
SELECT
  id, user_id, created_at, total,
  lag(total)  OVER w                   AS previous_total,   -- NULL for the first row
  lead(total, 1, 0) OVER w             AS next_total,       -- default 0 instead of NULL
  total - lag(total) OVER w            AS change,
  first_value(total) OVER w            AS first_total,
  nth_value(total, 2) OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS second_total
FROM orders
WINDOW w AS (PARTITION BY user_id ORDER BY created_at, id);
```

- `lag`/`lead` look at the row `n` positions before/after in the partition.
- `first_value`/`last_value`/`nth_value` read from the **frame** (see 10.2).
- PostgreSQL 14–18 do not support `IGNORE NULLS` [11]. **(PG 19, beta — may change)**: `lead`, `lag`, `first_value`, `last_value` and `nth_value` accept `IGNORE NULLS` / `RESPECT NULLS` [12].

### 10.5 Aggregates as window functions

Any normal aggregate becomes a window function with `OVER`:

```sql
SELECT
  id, user_id, created_at, total,
  sum(total) OVER (PARTITION BY user_id ORDER BY created_at, id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total,
  avg(total) OVER (PARTITION BY user_id ORDER BY created_at, id
                   ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)         AS moving_avg_3,
  sum(total) OVER (PARTITION BY user_id)                             AS user_total,
  round(100.0 * total / sum(total) OVER (PARTITION BY user_id), 1)   AS pct_of_user
FROM orders;
```

```sql
-- 7-day rolling revenue by calendar time (RANGE with an interval offset)
SELECT day, revenue,
       sum(revenue) OVER (ORDER BY day
                          RANGE BETWEEN interval '6 days' PRECEDING AND CURRENT ROW) AS revenue_7d
FROM (
  SELECT created_at::date AS day, sum(total) AS revenue
  FROM orders GROUP BY 1
) AS daily;
```

### 10.6 Named windows

The `WINDOW` clause names a window definition so several functions can share it (see the example in 10.4). A reference can add a frame: `OVER (w ROWS BETWEEN ...)`.

## 11. Set operations

| Operator | Result | Duplicates |
|---|---|---|
| `UNION ALL` | Rows of both queries | Kept (fast, no sort) |
| `UNION` | Rows of both queries | Removed (sort or hash) |
| `INTERSECT [ALL]` | Rows present in both | Removed / kept with `ALL` |
| `EXCEPT [ALL]` | Rows of the first not in the second | Removed / kept with `ALL` |

```sql
-- Bad when duplicates are impossible or acceptable: UNION pays for a de-duplication step
SELECT email FROM users WHERE country = 'FR'
UNION
SELECT email FROM users WHERE country = 'BE';

-- Good
SELECT email FROM users WHERE country = 'FR'
UNION ALL
SELECT email FROM users WHERE country = 'BE';

-- Users who ordered in 2025 but not in 2026
SELECT user_id FROM orders WHERE created_at >= '2025-01-01' AND created_at < '2026-01-01'
EXCEPT
SELECT user_id FROM orders WHERE created_at >= '2026-01-01' AND created_at < '2027-01-01';
```

- Both queries need the same number of columns with compatible types ("union compatible"); output column names come from the first query [47].
- A final `ORDER BY`/`LIMIT` applies to the **combined** result. To sort or limit one branch, put it in parentheses [47].
- `INTERSECT` binds more tightly than `UNION` and `EXCEPT`; use parentheses when you mix them [47].
- Set operations treat NULLs as equal when comparing rows (unlike `=`).

## 12. Modifying data

### 12.1 INSERT

```sql
-- Single row, returning generated values
INSERT INTO users (email, full_name, country)
VALUES ('ana@example.com', 'Ana Silva', 'PT')
RETURNING id, created_at;

-- Many rows in one statement (much faster than one INSERT per row)
INSERT INTO users (email, full_name, country) VALUES
  ('bo@example.com',  'Bo Chen',   'FR'),
  ('cy@example.com',  'Cy Dubois', NULL);

-- INSERT ... SELECT: copy or transform rows inside the database
INSERT INTO orders_archive (id, user_id, status, total, created_at)
SELECT id, user_id, status, total, created_at
FROM orders
WHERE created_at < '2024-01-01';

-- Use all defaults
INSERT INTO audit_events DEFAULT VALUES;
```

- Always list the target columns. `INSERT INTO t VALUES (...)` breaks when a column is added.
- `DEFAULT` can be used as a value: `VALUES (DEFAULT, 'x')`.
- For very large loads, `COPY` is faster than `INSERT` (see [03](03-postgresql-features-and-types.md)).

### 12.2 UPDATE, UPDATE ... FROM

```sql
UPDATE orders
SET status = 'shipped'
WHERE id = 1001
RETURNING id, status;

-- Update several columns at once from a row
UPDATE users
SET (full_name, country) = ('Ana M. Silva', 'BR')
WHERE id = 7;

-- UPDATE ... FROM: use other tables in the update (PostgreSQL syntax)
UPDATE orders AS o
SET status = 'cancelled'
FROM users AS u
WHERE u.id = o.user_id
  AND u.email LIKE '%@spam.example'
  AND o.status = 'pending';
```

The join in `UPDATE ... FROM` must produce **at most one row per target row**. If a target row matches several source rows, only one is used, and which one "is not readily predictable" [17]. Do not repeat the target table in `FROM` unless you want a self-join [17].

### 12.3 DELETE, DELETE ... USING

```sql
DELETE FROM orders WHERE id = 1001 RETURNING *;

-- DELETE ... USING: delete based on another table (PostgreSQL syntax)
DELETE FROM orders AS o
USING users AS u
WHERE u.id = o.user_id
  AND u.email LIKE '%@spam.example';

-- Portable alternative
DELETE FROM orders
WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@spam.example');
```

Always test the `WHERE` with a `SELECT` first, and run destructive statements inside a transaction (`BEGIN; ... ; ROLLBACK;`) when working by hand.

### 12.4 RETURNING

`RETURNING` sends back rows changed by `INSERT`, `UPDATE`, `DELETE` and `MERGE` (`MERGE ... RETURNING` is PG 17+). It saves a round trip and avoids race conditions between "write" and "read back". In PG 18+, `RETURNING` can read both versions of a row with `old` and `new` [27]:

```sql
UPDATE orders SET total = total * 0.9
WHERE id = 1001
RETURNING old.total AS old_total, new.total AS new_total;   -- PG 18+
```

### 12.5 TRUNCATE vs DELETE

| | `DELETE FROM t` | `TRUNCATE t` |
|---|---|---|
| Speed on large tables | Row by row, slow | Very fast (does not scan) |
| Disk space | Reclaimed later by `VACUUM` | Reclaimed immediately |
| `WHERE` clause | Yes | No (all rows) |
| Row triggers | `ON DELETE` fire | Not fired; `ON TRUNCATE` fires |
| Lock | Row locks | `ACCESS EXCLUSIVE` (blocks all reads and writes) |
| MVCC-safe | Yes | No: concurrent transactions with an older snapshot see an empty table |
| Rollback | Yes | Yes |
| Identity/sequences | Unchanged | `RESTART IDENTITY` resets them |

Source: [18]. Use `TRUNCATE` for test data, staging tables and batch jobs; use `DELETE` (in batches) on tables that live traffic reads.

### 12.6 Upsert (insert or update) — short intro

"Insert this row, or update it if it already exists" is called **upsert**. PostgreSQL offers two tools:

```sql
-- INSERT ... ON CONFLICT: atomic even under high concurrency
INSERT INTO users (email, full_name)
VALUES ('ana@example.com', 'Ana Silva')
ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
RETURNING id;

-- MERGE (PG 15+): synchronize a table with a source; standard SQL
MERGE INTO users AS u
USING staging_users AS s ON s.email = u.email
WHEN MATCHED THEN UPDATE SET full_name = s.full_name
WHEN NOT MATCHED THEN INSERT (email, full_name) VALUES (s.email, s.full_name);
```

`ON CONFLICT DO UPDATE` "guarantees an atomic INSERT or UPDATE outcome" under concurrency [20]; `MERGE` can still fail with a unique violation when another session inserts the same key at the same time [13]. Details: syntax in [03](03-postgresql-features-and-types.md), patterns and pitfalls in [04](04-query-patterns-and-antipatterns.md).

## 13. DDL essentials

### 13.1 CREATE TABLE and constraints

```sql
CREATE TABLE products (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku          text NOT NULL UNIQUE,
  name         text NOT NULL,
  price        numeric(12,2) NOT NULL CHECK (price >= 0),
  discount_pct numeric(5,2) NOT NULL DEFAULT 0
               CONSTRAINT discount_range CHECK (discount_pct BETWEEN 0 AND 100),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id    bigint NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id  bigint NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  quantity    integer NOT NULL CHECK (quantity > 0),
  unit_price  numeric(12,2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
```

| Constraint | Guarantees | Notes |
|---|---|---|
| `NOT NULL` | Value is present | Add it to every column that must have a value |
| `DEFAULT expr` | Value used when the column is omitted | Not a constraint; `now()` is evaluated per row |
| `PRIMARY KEY` | `UNIQUE` + `NOT NULL`; one per table | Creates a unique B-tree index |
| `UNIQUE` | No two equal non-NULL values | Creates an index; see 5.5 for NULLs |
| `CHECK (expr)` | Expression is not FALSE | NULL passes; must not query other tables |
| `REFERENCES` (foreign key) | Value exists in the parent table | **No index is created on the referencing column** [9] |

Name your constraints (`CONSTRAINT discount_range CHECK (...)`): error messages and migrations become clearer. Naming conventions are in [07](07-schema-design-and-patterns.md).

### 13.2 Foreign key actions

What happens to child rows when a parent row is deleted (`ON DELETE`) or its key changes (`ON UPDATE`) [9]:

| Action | Effect |
|---|---|
| `NO ACTION` (default) | Error if children exist; the check can be deferred to the end of the transaction |
| `RESTRICT` | Error if children exist; checked immediately, never deferred |
| `CASCADE` | Delete (or update) the children too |
| `SET NULL [(cols)]` | Set the child's FK column(s) to NULL; column list PG 15+ [46] |
| `SET DEFAULT [(cols)]` | Set the child's FK column(s) to their default; column list PG 15+ [46] |

Index the referencing columns yourself (for example `order_items (product_id)`): without it, every delete on the parent scans the child table. See [05](05-indexing.md).

### 13.3 ALTER TABLE basics

```sql
ALTER TABLE users ADD COLUMN phone text;
ALTER TABLE users ALTER COLUMN phone SET DEFAULT '';
ALTER TABLE users RENAME COLUMN phone TO phone_number;
ALTER TABLE users DROP COLUMN phone_number;
ALTER TABLE orders ADD CONSTRAINT orders_total_max CHECK (total < 1000000);
```

Many `ALTER TABLE` forms take a strong lock or rewrite the table. On a live database, follow [10](10-safe-schema-migrations.md).

### 13.4 Views and materialized views

```sql
-- A view is a stored query; it holds no data and always shows current rows
CREATE VIEW active_users AS
SELECT id, email, full_name FROM users WHERE country IS NOT NULL;

-- A materialized view stores the result; refresh it when you want new data
CREATE MATERIALIZED VIEW monthly_revenue AS
SELECT date_trunc('month', created_at) AS month, sum(total) AS revenue
FROM orders WHERE status = 'paid'
GROUP BY 1;

CREATE UNIQUE INDEX ON monthly_revenue (month);        -- needed for CONCURRENTLY
REFRESH MATERIALIZED VIEW CONCURRENTLY monthly_revenue; -- readers are not blocked
```

Simple views (one table, no aggregates/`DISTINCT`/`LIMIT`/set operations) are automatically updatable [34]. View security options (`security_invoker`, PG 15+) are in [03](03-postgresql-features-and-types.md) and [11](11-security.md).

### 13.5 Schemas

A schema is a namespace inside a database: `app.users` and `audit.users` are different tables. Unqualified names are looked up through `search_path` (default: `"$user", public`). In databases created with PG 15+, ordinary users can no longer create objects in the `public` schema; databases upgraded from older versions keep their old permissions [46]. Security aspects of `search_path` are in [11](11-security.md).

```sql
CREATE SCHEMA app;
CREATE TABLE app.settings (key text PRIMARY KEY, value jsonb NOT NULL);
SET search_path = app, public;   -- for this session
```

### 13.6 Temporary tables

```sql
CREATE TEMP TABLE import_rows (email text, full_name text) ON COMMIT DROP;
```

A temporary table is visible only to the current session and disappears at session end. With `ON COMMIT DROP` it disappears at the end of the transaction (so create it after `BEGIN`); `ON COMMIT DELETE ROWS` empties it at each commit. Careful with connection poolers in transaction mode: session state does not survive between transactions (see [09](09-operations-and-server-tuning.md)).

### 13.7 Sequences and identity columns

```sql
-- Preferred (SQL standard, PG 10+)
id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY      -- rejects manual values
id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY  -- accepts manual values

-- Legacy PostgreSQL shorthand; avoid in new tables
id bigserial PRIMARY KEY
```

- `GENERATED ALWAYS` accepts a user value only with `OVERRIDING SYSTEM VALUE`; `BY DEFAULT` lets user values win [35].
- An identity column is `NOT NULL` but **not unique by itself**: add `PRIMARY KEY` or `UNIQUE` [36].
- Sequence values are never rolled back, so **gaps are normal** (failed inserts, `ON CONFLICT`, crashes). Never use them for gapless numbers such as invoice numbers [37].

More in [03](03-postgresql-features-and-types.md).

## 14. Transactions

A transaction groups statements into one all-or-nothing unit [38].

```sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;            -- or ROLLBACK; to cancel everything

BEGIN;
INSERT INTO orders (user_id, status, total) VALUES (1, 'pending', 50);
SAVEPOINT before_items;
INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (999, 1, 1, 50);
-- ERROR (for example a foreign key violation)
ROLLBACK TO SAVEPOINT before_items;   -- undo only the failed part
COMMIT;                               -- the order row is kept
```

- Without `BEGIN`, each statement runs in its own transaction ("autocommit") [38].
- After an error inside a transaction block, the transaction is **aborted**: every following command fails until `ROLLBACK` (or `ROLLBACK TO SAVEPOINT`) [38].
- **ACID**: *Atomicity* (all or nothing), *Consistency* (constraints hold after commit), *Isolation* (concurrent transactions do not see each other's uncommitted work), *Durability* (committed data survives a crash).
- The default isolation level is **Read Committed**: each statement sees data committed before it started [39].
- Keep transactions short. Never wait for user input or a slow HTTP call while a transaction is open.

Isolation levels, locks, deadlocks and retries: [08](08-transactions-concurrency-locking.md). Transactions from Node.js: [15](15-postgres-from-typescript.md).

## 15. Types, casting and conversion pitfalls

### 15.1 Three ways to cast

```sql
SELECT CAST('42' AS integer);   -- SQL standard
SELECT '42'::integer;           -- PostgreSQL (historical) syntax
SELECT integer '42';            -- "type 'string'" form, for literals only
```

All three work in PostgreSQL; `CAST` is the portable one [21]. A quoted literal without a cast starts as type `unknown` and gets its type from context [22].

### 15.2 Few implicit casts

PostgreSQL has few implicit casts, especially to `text`, so that conversions are never surprising [22].

```sql
-- Bad: ERROR: operator does not exist: bigint = text
SELECT * FROM orders WHERE id = '42'::text;

-- Good: compare values of the same type
SELECT * FROM orders WHERE id = 42;
SELECT * FROM orders WHERE id = $1::bigint;   -- cast the parameter, not the column
```

Cast the **parameter**, not the column: `WHERE created_at::date = $1` cannot use a normal index on `created_at`; `WHERE created_at >= $1::date AND created_at < $1::date + 1` can (`date + 1` is the next day; see [05](05-indexing.md)).

Check if a string is a valid value without raising an error (PG 16+): `SELECT pg_input_is_valid('2026-02-30', 'date');` returns `false` [19].

### 15.3 Integer division and numeric precision

```sql
SELECT 5 / 2;            -- 2      (integer division truncates toward zero)
SELECT -5 / 2;           -- -2
SELECT 5 / 2.0;          -- 2.5000000000000000
SELECT 5::numeric / 2;   -- 2.5000000000000000
SELECT round(100.0 * 7 / 9, 2);   -- 77.78  (percentage with 2 decimals)
```

Integer division truncates toward zero [40]. Typical bug: `count(*) FILTER (...) / count(*)` is always 0 or 1. Multiply by `100.0` or cast first.

- `numeric` is exact (use it for money); `real`/`double precision` are approximate (see [03](03-postgresql-features-and-types.md)).
- `round(numeric)` rounds ties away from zero; for `double precision` it depends on the platform [40].

## 16. Identifiers and literals

### 16.1 Case folding

Unquoted identifiers and keywords are case-insensitive; PostgreSQL **folds unquoted names to lowercase**. The SQL standard says to fold to *uppercase*, so this is a known difference [21].

```sql
CREATE TABLE Accounts (Id int);    -- creates table "accounts" with column "id"
SELECT ID FROM ACCOUNTS;           -- works: all unquoted names fold to lowercase

CREATE TABLE "Customers" ("Id" int);  -- quoted: names keep their exact case
SELECT Id FROM Customers;             -- ERROR: relation "customers" does not exist
SELECT "Id" FROM "Customers";         -- you must quote them in every query, forever
```

Rule: use lowercase `snake_case` names and never quote them. ORMs that generate `"CamelCase"` names force quoting in every hand-written query; map them to `snake_case` (for Prisma, see [15](15-postgres-from-typescript.md)). Identifiers longer than **63 bytes** are silently truncated [21].

### 16.2 Single quotes vs double quotes

- `'text'` (single quotes) is a **string literal**. Escape a quote by doubling it: `'Dianne''s horse'` [21].
- `"name"` (double quotes) is an **identifier** (table, column). `"select"` is a valid column name; `select` is a keyword [21].

```sql
-- Bad: double quotes mean "column named paid"
SELECT * FROM orders WHERE status = "paid";   -- ERROR: column "paid" does not exist
-- Good
SELECT * FROM orders WHERE status = 'paid';
```

### 16.3 Escape strings and dollar quoting

- Backslashes are normal characters in standard strings (`standard_conforming_strings = on` is the default since 9.1) [21]. Use `E'...'` for C-style escapes: `E'line1\nline2'`. In PostgreSQL 19 beta, this setting can no longer be turned off **(PG 19, beta — may change)** [41].
- **Dollar quoting** avoids escaping in function bodies: `$$Dianne's horse$$` or `$body$ ... $body$` [21].

### 16.4 Reserved words

Words like `user`, `order`, `group`, `table`, `select`, `limit` are reserved or special. `CREATE TABLE user (...)` fails; `user` alone even returns the current role name. Use plural or more specific names: `users`, `orders`, `user_groups`.

### 16.5 Numeric literals (PG 16+)

`1_000_000`, `0x1F`, `0o17`, `0b1010` are accepted since PG 16 [19][21].

## 17. Everyday functions

### 17.1 Strings

| Function | Example | Result |
|---|---|---|
| `\|\|` | `'Post' \|\| 'greSQL'` | `PostgreSQL` (NULL if any side is NULL) |
| `concat(a, b, ...)` | `concat('a', NULL, 'b')` | `ab` (ignores NULLs) |
| `concat_ws(sep, ...)` | `concat_ws(', ', 'Paris', NULL, 'FR')` | `Paris, FR` |
| `format()` | `format('%I = %L', 'col', 'O''Reilly')` | `col = 'O''Reilly'` |
| `lower`, `upper`, `initcap` | `initcap('hi THOMAS')` | `Hi Thomas` |
| `length`, `octet_length` | `octet_length('josé')` | `5` (bytes) |
| `trim`, `btrim`, `ltrim`, `rtrim` | `trim('  x  ')` | `x` |
| `substring`, `left`, `right` | `left('abcde', 2)` | `ab` |
| `position`, `strpos` | `strpos('high', 'ig')` | `2` (1-based) |
| `replace` | `replace('a-b-c', '-', '/')` | `a/b/c` |
| `split_part` | `split_part('a,b,c', ',', -1)` | `c` (negative index PG 14+) |
| `starts_with`, `^@` | `'alphabet' ^@ 'alph'` | `true` |
| `regexp_replace` | `regexp_replace('a1b2', '\d', '', 'g')` | `ab` |
| `string_to_table` | `string_to_table('a,b', ',')` | 2 rows (PG 14+) |

Source: [42]. `format()` with `%I` (identifier) and `%L` (literal) is the safe way to build dynamic SQL in PL/pgSQL; never concatenate user input (see [11](11-security.md)).

### 17.2 Date and time

```sql
SELECT now();                     -- timestamptz: start of the current TRANSACTION
SELECT clock_timestamp();         -- real current time (changes during a statement)
SELECT current_date;              -- date in the session time zone
SELECT date_trunc('month', now());                       -- first instant of the month
SELECT date_trunc('day', now(), 'Europe/Paris');         -- midnight in Paris
SELECT extract(year FROM now()), extract(dow FROM now()); -- numeric results (PG 14+)
SELECT now() + interval '7 days', now() - interval '2 hours';
SELECT age(timestamp '2026-10-05', timestamp '1990-03-15'); -- 36 years 6 mons 20 days
SELECT now() AT TIME ZONE 'Asia/Tokyo';                  -- timestamptz → local time in Tokyo
SELECT date_bin('15 minutes', timestamp '2026-10-05 10:44', timestamp '2000-01-01'); -- 10:30
```

- `now()` and `CURRENT_TIMESTAMP` return the **transaction start time**; they do not change inside a transaction. `clock_timestamp()` does [43].
- `date_trunc(field, timestamptz, zone)` truncates in the given time zone [43]. This form is immutable since PG 16, so it can be used in index expressions [19].
- `extract()` returns `numeric` since PG 14 (it was `double precision` before) [26].
- `AT TIME ZONE` converts between `timestamp` and `timestamptz` (see [03](03-postgresql-features-and-types.md) for the type rules). `AT LOCAL` (PG 17+) uses the session time zone [43].
- `date_bin()` (PG 14+) groups timestamps into fixed buckets such as 15 minutes [43].
- `interval '1 day'` and `interval '24 hours'` differ across a daylight-saving change [43].
- Never use the string `'now'` as a column default: write `DEFAULT now()` [43].

```sql
-- One row per day, including days without orders
SELECT d::date AS day, count(o.id) AS orders
FROM generate_series(date '2026-09-01', date '2026-09-30', interval '1 day') AS d
LEFT JOIN orders o
       ON o.created_at >= d AND o.created_at < d + interval '1 day'
GROUP BY d
ORDER BY d;
```

```sql
-- Bad: BETWEEN includes the end bound, so midnight of Oct 1 is counted in both months
SELECT count(*) FROM orders
WHERE created_at BETWEEN '2026-09-01' AND '2026-10-01';

-- Good: half-open range [start, end)
SELECT count(*) FROM orders
WHERE created_at >= '2026-09-01' AND created_at < '2026-10-01';
```

`BETWEEN` is fine for integers and dates, but not for timestamps [8].

### 17.3 Math

| Function | Example | Result |
|---|---|---|
| `round(x, n)` | `round(2.345, 2)` | `2.35` |
| `trunc(x)` | `trunc(-42.8)` | `-42` |
| `ceil`, `floor` | `floor(-42.8)` | `-43` |
| `abs`, `mod` / `%` | `7 % 3` | `1` |
| `power`, `sqrt` | `power(2, 10)` | `1024` |
| `random()` | `random()` | `0 <= x < 1` |
| `random(min, max)` | `random(1, 6)` | integer 1..6 inclusive (PG 17+) |
| `div(a, b)` | `div(9, 4)` | `2` |

Source: [40]. `^` is left-associative: `2 ^ 3 ^ 3` is `512` [40].

### 17.4 Conditional

`CASE`, `coalesce`, `NULLIF`, `greatest`, `least` — see sections 4.1 and 4.2.

## 18. Think in sets

Most slow application code that uses a database does one of these: a loop of single-row statements, the "N+1 queries" pattern, or row-by-row processing in a cursor. Each statement costs a round trip, parsing and planning; inside the server, a set-based statement lets the planner choose joins, indexes and sometimes parallel workers. The PostgreSQL docs list the cost of client/server round trips explicitly [23]. Rewrite loops as single statements:

### 18.1 Loop of updates → one UPDATE

```text
-- Bad (application pseudo-code): one round trip per order
for (const o of await db.query('SELECT id, total FROM orders WHERE status = $1', ['pending']))
  await db.query('UPDATE orders SET total = $1 WHERE id = $2', [o.total * 0.9, o.id]);
```

```sql
-- Good: one statement, one round trip, one transaction
UPDATE orders SET total = total * 0.9 WHERE status = 'pending';
```

### 18.2 N+1 queries → one query with a join or ANY

```sql
-- Bad: SELECT * FROM orders WHERE user_id = $1   (executed once per user)

-- Good: one query for all users of the page
SELECT * FROM orders WHERE user_id = ANY($1::bigint[]);   -- $1 = [1, 2, 3, ...]

-- Or join and aggregate in the database
SELECT u.id, u.email,
       coalesce(jsonb_agg(o ORDER BY o.created_at) FILTER (WHERE o.id IS NOT NULL), '[]') AS orders
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.id = ANY($1::bigint[])
GROUP BY u.id;
```

### 18.3 Insert loop → multi-row INSERT or unnest

```sql
-- Good: pass arrays as parameters and insert all rows at once
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT 1001, product_id, quantity, unit_price
FROM unnest($1::bigint[], $2::int[], $3::numeric[]) AS t(product_id, quantity, unit_price);
```

### 18.4 Cursor computing per-row values → window function

```sql
-- Good: running balance per account without any loop
SELECT account_id, booked_at, amount,
       sum(amount) OVER (PARTITION BY account_id ORDER BY booked_at, id
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
FROM ledger_entries;
```

### 18.5 "Check, then write" → one conditional statement

```sql
-- Bad: SELECT stock ...; if (stock >= 1) UPDATE ...   (race condition between the two)

-- Good: the condition and the write happen atomically (assumes a products.stock column)
UPDATE products SET stock = stock - 1
WHERE id = 42 AND stock >= 1
RETURNING stock;            -- no row returned = out of stock
```

### 18.6 When a loop is still right

- **Very large changes** (millions of rows): process in batches of a few thousand rows per transaction to limit lock time and WAL bursts (see [04](04-query-patterns-and-antipatterns.md) and [10](10-safe-schema-migrations.md)).
- **Per-row side effects outside the database** (sending an email, calling an API): read a batch, act, then mark the batch done in one statement.
- Logic that SQL cannot express clearly. Even then, keep each step set-based.

## Sources

1. [SELECT](https://www.postgresql.org/docs/current/sql-select.html) — PostgreSQL 18 docs: processing order, aliases in WHERE/HAVING, NULLS FIRST/LAST defaults, LIMIT without ORDER BY, WITH TIES, GROUP BY DISTINCT, DISTINCT ON.
2. [Appendix D. SQL Conformance](https://www.postgresql.org/docs/current/features.html) — PostgreSQL docs: SQL:2023 conformance (170 of 177 Core features), parts covered.
3. [The SQL Standard](https://modern-sql.com/standard) — modern-sql.com (Markus Winand): ISO 9075 parts, availability, editions.
4. [A Beginner's Guide to the True Order of SQL Operations](https://blog.jooq.org/a-beginners-guide-to-the-true-order-of-sql-operations/) — jOOQ blog (Lukas Eder): logical order including window functions and its consequences.
5. [Value Expressions](https://www.postgresql.org/docs/current/sql-expressions.html) — PostgreSQL docs: window frame syntax and default frame, FILTER, aggregate ORDER BY, evaluation order.
6. [Comparison Functions and Operators](https://www.postgresql.org/docs/current/functions-comparison.html) — PostgreSQL docs: `= NULL`, IS DISTINCT FROM, num_nulls.
7. [Table Expressions](https://www.postgresql.org/docs/current/queries-table-expressions.html) — PostgreSQL docs: NATURAL/USING risk, ON vs WHERE in outer joins, LATERAL, grouping sets, functional dependency, window processing.
8. [Don't Do This](https://wiki.postgresql.org/wiki/Don%27t_Do_This) — PostgreSQL wiki: NOT IN, BETWEEN with timestamps, upper-case names.
9. [Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html) — PostgreSQL docs: CHECK and NULL, NULLS NOT DISTINCT, FK actions, no automatic FK index.
10. [WITH Queries (CTEs)](https://www.postgresql.org/docs/current/queries-with.html) — PostgreSQL docs: recursion, SEARCH/CYCLE, materialization, data-modifying CTEs.
11. [Window Functions](https://www.postgresql.org/docs/current/functions-window.html) — PostgreSQL 18 docs: ranking/value functions, last_value frame note, no IGNORE NULLS.
12. [Window Functions (PG 19 beta)](https://www.postgresql.org/docs/19/functions-window.html) — PostgreSQL 19beta4 docs: IGNORE NULLS / RESPECT NULLS.
13. [MERGE](https://www.postgresql.org/docs/current/sql-merge.html) — PostgreSQL docs: syntax, concurrency notes, RETURNING with merge_action().
14. [Subquery Expressions](https://www.postgresql.org/docs/current/functions-subquery.html) — PostgreSQL docs: EXISTS, IN/NOT IN NULL semantics, ANY/ALL on empty sets.
15. [Row and Array Comparisons](https://www.postgresql.org/docs/current/functions-comparisons.html) — PostgreSQL docs: IN lists, ANY with arrays, row comparison.
16. [Aggregate Functions](https://www.postgresql.org/docs/current/functions-aggregate.html) — PostgreSQL docs: count(*) vs count(col), NULL on no rows, ordered-set aggregates, GROUPING.
17. [UPDATE](https://www.postgresql.org/docs/current/sql-update.html) — PostgreSQL docs: UPDATE ... FROM determinism, multi-column SET, RETURNING old/new.
18. [TRUNCATE](https://www.postgresql.org/docs/current/sql-truncate.html) — PostgreSQL docs: speed, locks, triggers, MVCC safety, RESTART IDENTITY.
19. [PostgreSQL 16 Release Notes](https://www.postgresql.org/docs/release/16.0/) — PostgreSQL: any_value, pg_input_is_valid, numeric literal formats, optional subquery alias, immutable date_trunc with zone.
20. [INSERT](https://www.postgresql.org/docs/current/sql-insert.html) — PostgreSQL docs: ON CONFLICT atomicity, OVERRIDING SYSTEM VALUE.
21. [Lexical Structure](https://www.postgresql.org/docs/current/sql-syntax-lexical.html) — PostgreSQL docs: case folding, quoting, E'' strings, dollar quoting, 63-byte names, casts.
22. [Type Conversion Overview](https://www.postgresql.org/docs/current/typeconv-overview.html) — PostgreSQL docs: unknown literals, few implicit casts.
23. [PL/pgSQL Overview](https://www.postgresql.org/docs/current/plpgsql-overview.html) — PostgreSQL docs: cost of client/server round trips.
24. [PostgreSQL 12 Release Notes](https://www.postgresql.org/docs/release/12.0/) — PostgreSQL: CTE inlining, MATERIALIZED / NOT MATERIALIZED.
25. [PostgreSQL 11 Release Notes](https://www.postgresql.org/docs/release/11.0/) — PostgreSQL: GROUPS frames, RANGE offsets, frame exclusion.
26. [PostgreSQL 14 Release Notes](https://www.postgresql.org/docs/release/14.0/) — PostgreSQL: SEARCH/CYCLE, GROUP BY DISTINCT, JOIN USING alias, EXTRACT numeric, date_bin.
27. [PostgreSQL 18 Release Notes](https://www.postgresql.org/docs/release/18.0/) — PostgreSQL: OLD/NEW in RETURNING.
28. [We need tool support for keyset pagination (No Offset)](https://use-the-index-luke.com/no-offset) — use-the-index-luke.com (Markus Winand): why OFFSET degrades and drifts.
29. [The FILTER clause](https://modern-sql.com/feature/filter) — modern-sql.com (Markus Winand): FILTER in SQL:2003, CASE workaround.
30. [SQL:2023 is finished: Here is what's new](https://peter.eisentraut.org/blog/2023/04/04/sql-2023-is-finished-here-is-whats-new) — Peter Eisentraut: SQL:2023 feature list.
31. [What's New in SQL:2016](https://modern-sql.com/blog/2017-06/whats-new-in-sql-2016) — modern-sql.com (Markus Winand): MATCH_RECOGNIZE, SQL/JSON, LISTAGG.
32. [Conditional Expressions](https://www.postgresql.org/docs/current/functions-conditional.html) — PostgreSQL docs: CASE, COALESCE, NULLIF, GREATEST/LEAST NULL handling.
33. [Transactional DDL in PostgreSQL: A Competitive Analysis](https://wiki.postgresql.org/wiki/Transactional_DDL_in_PostgreSQL:_A_Competitive_Analysis) — PostgreSQL wiki: rollback of DDL and its exceptions.
34. [CREATE VIEW](https://www.postgresql.org/docs/current/sql-createview.html) — PostgreSQL docs: automatically updatable views, check option.
35. [CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html) — PostgreSQL docs: identity columns ALWAYS vs BY DEFAULT.
36. [Identity Columns](https://www.postgresql.org/docs/current/ddl-identity-columns.html) — PostgreSQL docs: NOT NULL but not unique.
37. [Sequence Manipulation Functions](https://www.postgresql.org/docs/current/functions-sequence.html) — PostgreSQL docs: values not reclaimed, no gapless sequences.
38. [Transactions (tutorial)](https://www.postgresql.org/docs/current/tutorial-transactions.html) — PostgreSQL docs: BEGIN/COMMIT, implicit transactions, savepoints, aborted state.
39. [Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html) — PostgreSQL docs: Read Committed is the default.
40. [Mathematical Functions and Operators](https://www.postgresql.org/docs/current/functions-math.html) — PostgreSQL docs: integer division, rounding, random(min, max), `^` associativity.
41. [PostgreSQL 19 Release Notes (beta)](https://www.postgresql.org/docs/19/release-19.html) — PostgreSQL 19 beta: standard_conforming_strings forced on, IGNORE NULLS.
42. [String Functions and Operators](https://www.postgresql.org/docs/current/functions-string.html) — PostgreSQL docs: concat, format, split_part, starts_with, string_to_table.
43. [Date/Time Functions and Operators](https://www.postgresql.org/docs/current/functions-datetime.html) — PostgreSQL docs: now() vs clock_timestamp(), date_trunc with zone, date_bin, AT TIME ZONE/AT LOCAL, DST note, 'now' in defaults.
44. [SQL — Standardization history](https://en.wikipedia.org/wiki/SQL) — Wikipedia: what each edition of the standard added.
45. [Merge (SQL)](https://en.wikipedia.org/wiki/Merge_(SQL)) — Wikipedia: MERGE introduced in SQL:2003, extended in SQL:2008.
46. [PostgreSQL 15 Release Notes](https://www.postgresql.org/docs/release/15.0/) — PostgreSQL: MERGE, UNIQUE NULLS NOT DISTINCT, public schema CREATE permission removed, FK SET NULL column lists.
47. [Combining Queries (UNION, INTERSECT, EXCEPT)](https://www.postgresql.org/docs/current/queries-union.html) — PostgreSQL docs: union compatibility, duplicates, precedence, parentheses.
