# PostgreSQL Features and Data Types

> Part of the [SQL & PostgreSQL reference library](README.md) · Last researched: 2026-10-05 · Targets PostgreSQL 14–18 (19 beta noted where relevant)

**What this covers.** What PostgreSQL adds on top of standard SQL: which data types to choose (and which to avoid), identity columns, PostgreSQL-only query syntax (`DISTINCT ON`, `ON CONFLICT`, `MERGE`, `RETURNING`, arrays...), JSON/JSONB, generated columns, special constraints, functions/procedures/triggers, `COPY`, `LISTEN/NOTIFY`, views, partitioning syntax, extensions, `psql`, and a "what's new per version" table. Standard SQL basics are in [01](01-sql-fundamentals.md); indexes for these features are in [05](05-indexing.md); design advice is in [07](07-schema-design-and-patterns.md).

## Key rules (TL;DR)

1. Store points in time as `timestamptz`, never as `timestamp` (without time zone).
2. Use `text` (plus a `CHECK` when you need rules); never `char(n)`; use `varchar(n)` only for a real limit.
3. Store money as `numeric` (or integer cents); never `money`, `real` or `double precision`.
4. Use `bigint GENERATED ALWAYS AS IDENTITY` for new integer keys; do not use `serial` in new tables.
5. For UUID keys prefer `uuidv7()` (PG 18+) over random v4 for index locality; it reveals the creation time.
6. Use `jsonb`, not `json`; keep fields you filter, join or constrain in normal columns.
7. Prefer a `CHECK` or a lookup table to an `enum` when the list of values may shrink or be reordered.
8. Forbid overlaps with range types plus `EXCLUDE USING gist` (or `WITHOUT OVERLAPS` keys, PG 18+).
9. Use `INSERT ... ON CONFLICT` for concurrent upserts; use `MERGE` (PG 15+) for batch synchronization.
10. Add `RETURNING` to writes instead of a second `SELECT`.
11. Use `DISTINCT ON` (with a matching `ORDER BY`) or `LATERAL` for "latest row per group".
12. Label functions with the strictest true volatility; never mark a function `IMMUTABLE` if it depends on settings or tables.
13. Prefer `LANGUAGE sql` functions with `BEGIN ATOMIC` bodies (PG 14+) for simple logic; use PL/pgSQL when you need control flow.
14. Avoid `EXCEPTION` blocks in hot paths: each one starts a subtransaction.
15. Keep triggers small; for bulk auditing use statement-level triggers with transition tables.
16. Load data with `COPY` / `\copy`, not row-by-row `INSERT`.
17. Use `LISTEN/NOTIFY` as a wake-up signal, not as a durable queue.
18. Add constraints to large tables with `NOT VALID`, then `VALIDATE CONSTRAINT`.
19. Set `security_invoker = true` (PG 15+) on views over tables that use row-level security.
20. Give a materialized view a unique index before using `REFRESH ... CONCURRENTLY`.
21. Install only maintained extensions you need; prefer trusted ones.
22. In `psql` scripts, always enable `ON_ERROR_STOP`.
23. Check the version tag of each feature against the oldest server you support.

## 1. Choosing data types

### 1.1 Quick decision table

| Need | Use | Avoid | Why |
|---|---|---|---|
| Whole numbers | `integer`; `bigint` for keys and counters that grow | `numeric` for integers | Fixed size, fast |
| Money, exact decimals | `numeric(p, s)` or `bigint` cents | `money`, `real`, `double precision` | Exact arithmetic |
| Measurements, scores | `double precision` | `numeric` when speed matters | Fast, approximate is OK |
| Text | `text` (+ `CHECK`) | `char(n)`, arbitrary `varchar(255)` | Same speed, fewer surprises |
| Point in time | `timestamptz` | `timestamp`, `timestamptz(0)`, `timetz` | Unambiguous instant |
| Calendar day | `date` | `timestamp` at midnight | Clear meaning |
| Duration | `interval` | integer seconds without unit | Calendar-aware math |
| Yes/no | `boolean` | `char(1)`, `smallint` flags | Self-documenting |
| Opaque ids | `uuid` (v7 when possible) | `text` holding UUIDs | 16 bytes, validated |
| Binary data | `bytea` (small); object storage (large) | Large objects for normal blobs | Simple |
| Semi-structured data | `jsonb` | `json` (unless you need exact text) | Indexable, faster |
| Small list of simple values | arrays (`text[]`) | comma-separated `text` | Typed, indexable |
| Periods, intervals of values | range types (`tstzrange`, `daterange`) | two loose columns without checks | Overlap operators, constraints |
| Fixed list of labels | `CHECK (x IN (...))`, lookup table, or `enum` | free text | Data quality |
| IP addresses | `inet`, `cidr` | `text` | Validation, network operators |

The PostgreSQL wiki page "Don't Do This" is the reference for what to avoid [1].

### 1.2 Integers

| Type | Size | Range |
|---|---|---|
| `smallint` | 2 bytes | -32,768 to 32,767 |
| `integer` | 4 bytes | about ±2.1 billion |
| `bigint` | 8 bytes | about ±9.2 × 10^18 |

`integer` "offers the best balance between range, storage size, and performance"; `bigint` is for when `integer` is not enough [2]. For **primary and foreign keys of tables that grow**, use `bigint` from day one: changing a key from `integer` to `bigint` later rewrites the table and every referencing table. The extra 4 bytes per row rarely matter.

### 1.3 Exact vs approximate numbers, and money

```sql
SELECT 0.1::double precision + 0.2::double precision = 0.3;  -- false (binary floating point)
SELECT 0.1::numeric + 0.2::numeric = 0.3;                    -- true  (exact decimal)
```

- `numeric(p, s)` is exact and "especially recommended for storing monetary amounts", but slower than integers and floats [2].
- `real` / `double precision` are inexact. Use them for measurements, not money [2].
- **Do not use `money`**: its fractional precision and output format depend on the `lc_monetary` setting, it stores no currency, and restoring a dump into a database with a different `lc_monetary` can fail [1][3].

```sql
-- Bad
price money

-- Good: amount + currency code
price_amount   numeric(12,2) NOT NULL CHECK (price_amount >= 0),
price_currency text NOT NULL CHECK (price_currency ~ '^[A-Z]{3}$')   -- ISO 4217 code

-- Also good: integer minor units (cents); convert at the edges of the application
price_cents    bigint NOT NULL CHECK (price_cents >= 0)
```

From TypeScript, node-postgres returns `numeric` and `bigint` as strings by default to avoid precision loss; see [15](15-postgres-from-typescript.md).

### 1.4 Text: text, varchar(n), char(n)

"There is no performance difference among these three types", apart from extra space for the padded `char(n)` and a length check for `varchar(n)`; `char(n)` is usually the slowest [4].

- `text` and `varchar` (no length) accept any length up to about 1 GB [4].
- `char(n)` pads with spaces and ignores trailing spaces in comparisons — a source of surprises. Avoid it, even for fixed-length codes: it does not reject short values, it pads them [1][4].
- `varchar(n)` is fine when the limit is a **real rule**. Do not pick `varchar(255)` "by default": an arbitrary limit just causes production errors later [1].

```sql
-- Bad
country_code char(2),
display_name varchar(255)

-- Good: express the actual rules
country_code text CHECK (country_code ~ '^[A-Z]{2}$'),
display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100)
```

**Case-insensitive text** (for example emails). Three options:

```sql
-- Option 1 (simple, portable): unique index on lower()
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
SELECT * FROM users WHERE lower(email) = lower($1);

-- Option 2: a nondeterministic ICU collation
CREATE COLLATION case_insensitive (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
CREATE TABLE subscribers (email text COLLATE case_insensitive NOT NULL UNIQUE);

-- Option 3: the citext extension (older approach)
CREATE EXTENSION IF NOT EXISTS citext;
CREATE TABLE newsletter (email citext NOT NULL UNIQUE);
```

The `citext` documentation itself suggests considering nondeterministic collations instead: they handle more Unicode cases correctly [5]. Nondeterministic collations cost some performance and do not support every operation; `LIKE` works with them only since PG 18 [6][10].

### 1.5 Date and time

| Type | Size | Stores | Use for |
|---|---|---|---|
| `timestamptz` (`timestamp with time zone`) | 8 bytes | An absolute instant (UTC internally) | Events: created_at, paid_at, expires_at |
| `timestamp` (`without time zone`) | 8 bytes | A date and time with no zone | Rare: abstract or "wall clock" times |
| `date` | 4 bytes | A calendar day | Birthdays, billing days |
| `time` | 8 bytes | Time of day | Opening hours |
| `interval` | 16 bytes | Months, days and microseconds separately | Durations, offsets |
| `timetz` | 12 bytes | Time of day with offset | Do not use |

Source: [7]. Key facts:

- `timestamptz` values are **stored in UTC** and converted to the session `TimeZone` for display [7]. Input with an offset (`2026-10-05 10:00+02`) is converted correctly; input without an offset uses the session time zone.
- `timestamptz` **does not remember** the original time zone. If you need it (for example "the user's local zone"), store an IANA zone name in a separate `text` column.
- Plain `timestamp` "just stores a date and time"; the database cannot convert it to an instant, and arithmetic across DST changes can be wrong [1]. Storing UTC in a `timestamp` column is also discouraged [1].
- Writing just `timestamp` means `timestamp without time zone` (SQL standard) [7].
- Avoid `timestamptz(0)`/`timestamp(0)`: precision 0 **rounds** instead of truncating, so a value can land in the future; use `date_trunc()` when you need whole seconds [1].
- Avoid `timetz` and `CURRENT_TIME` (which returns `timetz`) [1][7].
- `interval` keeps months, days and microseconds separate because a month has 28–31 days and a day can have 23 or 25 hours at a DST change [7].
- Use full zone names (`Europe/Paris`), not abbreviations (`CET`), which are fixed offsets without DST rules [7].

```sql
-- Bad
created_at timestamp DEFAULT now()            -- loses the instant; depends on session zone

-- Good
created_at timestamptz NOT NULL DEFAULT now(),
user_time_zone text NOT NULL DEFAULT 'UTC'    -- IANA name, only if you need local display
```

### 1.6 boolean

`boolean` takes 1 byte and has three states: `true`, `false`, `NULL`. Add `NOT NULL DEFAULT false` unless "unknown" is a real state.

### 1.7 uuid

`uuid` stores 128 bits (16 bytes) and always prints in lower-case hyphenated form [8].

| Function | Version | Result |
|---|---|---|
| `gen_random_uuid()` | Core since PG 13 [9] | Random UUID version 4 |
| `uuidv4()` | PG 18+ | Alias of `gen_random_uuid()` [10] |
| `uuidv7([shift interval])` | PG 18+ | Time-ordered UUID version 7 [10][11] |
| `uuid_extract_timestamp(uuid)` | PG 17+ | Timestamp from a v1 or v7 UUID [11] |
| `uuid_extract_version(uuid)` | PG 17+ | The version number [11] |

```sql
CREATE TABLE chunks (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),          -- PG 18+; use gen_random_uuid() on 14–17
  document_id bigint NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  content     text NOT NULL
);
```

Random v4 keys spread inserts over the whole index: values that are next to each other in the index were inserted at very different times and live in different places in the table. In a Cybertec test with 10 million rows, an index-only scan needed about 8.5 million extra buffer accesses with random UUIDs and was about 2.3 times slower than with sequential keys; the author recommends a sequential variant such as UUIDv7 [12]. Trade-off: anyone who sees a v7 UUID can read its creation time (`uuid_extract_timestamp`), so do not use v7 where that leaks private information. Choosing between `bigint` and `uuid` keys is discussed in [07](07-schema-design-and-patterns.md).

The `uuid-ossp` extension is no longer needed for v4/v7 generation; `pgcrypto`'s `gen_random_uuid()` now just calls the core function [10][13].

### 1.8 bytea

`bytea` stores binary strings (hashes, small files, encrypted values). Values are compressed and moved out of line automatically when large (TOAST, see 4.9), up to 1 GB per value [14]. For large user files, keep the file in object storage and store its key and metadata in PostgreSQL.

### 1.9 Arrays

Any type can be an array: `text[]`, `bigint[]`. Arrays are **1-based**.

```sql
CREATE TABLE articles (
  id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL,
  tags  text[] NOT NULL DEFAULT '{}'
);

SELECT * FROM articles WHERE 'postgres' = ANY (tags);            -- has this tag
SELECT * FROM articles WHERE tags @> ARRAY['postgres', 'sql'];   -- has all these tags
SELECT * FROM articles WHERE tags && ARRAY['postgres', 'mysql'];  -- has any of these tags
SELECT cardinality(tags), array_to_string(tags, ', ') FROM articles;
```

`@>`, `<@` and `&&` can use a GIN index (see [05](05-indexing.md)). Operators and functions: [15].

Use an array for a short list of simple values that you read and write as a whole. Use a **child table** when elements need foreign keys, their own columns, or individual updates.

### 1.10 Range and multirange types

A range is one value that holds a lower and an upper bound. Built-in range types: `int4range`, `int8range`, `numrange`, `tsrange`, `tstzrange`, `daterange`. Each has a multirange type (`tstzmultirange`, ...) that holds several non-overlapping ranges (multiranges: PG 14+) [16][36].

```sql
SELECT '[2026-10-01, 2026-10-05)'::daterange;                    -- [ = inclusive, ) = exclusive
SELECT tstzrange(now(), now() + interval '1 hour');              -- default bounds '[)'
SELECT daterange('2026-10-01', NULL);                            -- unbounded upper end
SELECT int4range(1, 10) && int4range(5, 20);                     -- overlaps: true
SELECT daterange('2026-10-01', '2026-10-10') @> date '2026-10-03'; -- contains: true
SELECT lower(r), upper(r), isempty(r) FROM (SELECT int4range(3, 7) AS r) AS t;
SELECT '{[1,3), [5,8)}'::int4multirange;                         -- PG 14+
```

Discrete ranges (`int4range`, `int8range`, `daterange`) are normalized to the `[)` form [16]. Use half-open `[)` ranges for time: consecutive periods touch without overlapping. Ranges become very powerful with exclusion constraints (6.1) and temporal keys (6.2).

### 1.11 Enums

```sql
CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');
ALTER TYPE order_status ADD VALUE 'refunded' AFTER 'shipped';
ALTER TYPE order_status RENAME VALUE 'cancelled' TO 'canceled';
```

| Pros | Cons |
|---|---|
| 4 bytes per value; typo-proof | Values **cannot be removed** or reordered without recreating the type [17] |
| Sorts in declaration order | Comparing two different enum types needs casts [17] |
| Self-documenting in the schema | Adding a value is DDL (a migration) |

Alternatives: `text` with `CHECK (status IN (...))` (easy to change, readable) or a lookup table with a foreign key (values become data, can carry labels). Choose an enum for lists that almost never change (for example days of the week); choose a lookup table when the business edits the list. `ALTER TYPE ... ADD VALUE` can run in a transaction, but the new value cannot be used before that transaction commits, unless the enum type itself was created in the same transaction (PG 17+) [31].

### 1.12 Domains

A domain is a type with reusable constraints [18].

```sql
CREATE DOMAIN email_address AS text
  CHECK (VALUE ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

CREATE DOMAIN positive_amount AS numeric(12,2)
  CHECK (VALUE > 0);

CREATE TABLE invoices (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email    email_address NOT NULL,     -- put NOT NULL on the column, not in the domain
  amount   positive_amount NOT NULL
);
```

The docs advise allowing NULL in the domain and adding `NOT NULL` on columns: NULLs can appear in domain-typed values anyway, for example from an outer join [18]. Domain `CHECK` expressions must be immutable and cannot use subqueries [18].

### 1.13 Composite types

`CREATE TYPE address AS (street text, city text, postal_code text, country text);` defines a row type. Every table also defines a composite type with its name, which is why `SELECT u FROM users u` returns whole rows and `jsonb_agg(u)` works. Composite **columns** are rarely a good idea: separate columns are easier to index and constrain. Composite types are useful for function arguments and results.

### 1.14 Network types

`inet` holds a host address with an optional netmask (`192.168.0.1/24`); `cidr` holds a network and rejects bits right of the mask (`192.168.0.0/24`); `macaddr` holds MAC addresses. They validate input and provide operators (contains, same family...), so use them instead of `text` [19].

### 1.15 Types and features to avoid

| Avoid | Use instead | Reason |
|---|---|---|
| `timestamp` for events | `timestamptz` | Not an instant [1] |
| `timestamptz(0)` | `date_trunc()` | Rounds up into the future [1] |
| `timetz`, `CURRENT_TIME` | `timestamptz`, `time` + zone column | Questionable semantics [1][7] |
| `char(n)` | `text` + `CHECK` | Silent padding [1] |
| `varchar(n)` by default | `text` | Arbitrary limits break later [1] |
| `money` | `numeric` | Locale-dependent, no currency [1] |
| `serial` / `bigserial` | `GENERATED ... AS IDENTITY` | Odd permissions and dependencies [1] |
| Rules (`CREATE RULE`) | Triggers | "Don't do what they look like they do" [1] |
| Table inheritance | Declarative partitioning | Superseded [1] |
| `SQL_ASCII` database encoding | `UTF8` | No encoding checks [1] |

## 2. Identity columns and sequences

An identity column takes its values from an implicit sequence [26].

```sql
CREATE TABLE invoices_numbered (
  id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ref bigint GENERATED BY DEFAULT AS IDENTITY (START WITH 1000 INCREMENT BY 1) UNIQUE
);

-- ALWAYS rejects explicit values unless you override on purpose (data migrations)
INSERT INTO invoices_numbered (id, ref) OVERRIDING SYSTEM VALUE VALUES (1, 1);

-- After manual inserts into a BY DEFAULT column, move the sequence past the max value
SELECT setval(pg_get_serial_sequence('invoices_numbered', 'ref'),
              (SELECT max(ref) FROM invoices_numbered));
```

- `GENERATED ALWAYS`: a user value is accepted only with `OVERRIDING SYSTEM VALUE`; updates to other values are rejected. `GENERATED BY DEFAULT`: user values win [26]. Prefer `ALWAYS`: it prevents accidental collisions with the sequence.
- Identity columns are `NOT NULL` but **not unique by themselves**; add `PRIMARY KEY`/`UNIQUE` [20].
- `pg_get_serial_sequence()` also works for identity columns [21].
- Why not `serial`? It creates a separate sequence object with ownership, permission and dump quirks; identity columns are standard SQL and simpler to manage [1].
- **Gaps are normal**: `nextval()` is never rolled back, `INSERT ... ON CONFLICT` consumes values before detecting conflicts, and a crash can skip values. Sequences "cannot be used to obtain gapless sequences" [22]. For invoice numbers that must be gapless, use a counter row updated in the same transaction (and accept the serialization).
- `CACHE n` (default 1) pre-allocates values per session: faster, but values come out of order across sessions and unused cached values are lost [23].

## 3. PostgreSQL-specific query syntax

### 3.1 DISTINCT ON

Keeps the **first row** of each group of rows that have equal `DISTINCT ON` expressions. The `ORDER BY` must start with the same expressions and then decide which row is "first" [24].

```sql
-- Latest order of each user
SELECT DISTINCT ON (user_id) user_id, id, total, created_at
FROM orders
ORDER BY user_id, created_at DESC, id DESC;
```

Without an `ORDER BY` the chosen row is unpredictable [24]. For few groups with many rows each, a `LATERAL` query with `LIMIT 1` can be faster (see [01](01-sql-fundamentals.md) and [06](06-query-optimization-and-explain.md)).

### 3.2 LATERAL, FILTER, UPDATE ... FROM, DELETE ... USING

These are explained with examples in [01](01-sql-fundamentals.md): `LATERAL` (6.5), `FILTER` (7.2), `UPDATE ... FROM` and `DELETE ... USING` (12.2–12.3). `FILTER` and `LATERAL` are standard SQL; `UPDATE ... FROM` and `DELETE ... USING` are PostgreSQL extensions.

### 3.3 RETURNING, with OLD and NEW (PG 18+)

`RETURNING` works on `INSERT`, `UPDATE`, `DELETE`, and `MERGE` (PG 17+). Before PG 18 it returned the new row for `INSERT`/`UPDATE` and the old row for `DELETE`. Since PG 18 you can ask for both with the aliases `old` and `new` [10][25].

```sql
-- PG 18+: return before and after values of an update
UPDATE products
SET price = round(price * 1.05, 2)
WHERE sku = 'BOOK-42'
RETURNING sku, old.price AS old_price, new.price AS new_price;

-- PG 18+: did the upsert insert or update? (old is NULL for an insert)
INSERT INTO product_stock AS s (product_id, quantity) VALUES (42, 5)
ON CONFLICT (product_id) DO UPDATE SET quantity = s.quantity + EXCLUDED.quantity
RETURNING new.product_id, old.quantity IS NULL AS inserted, new.quantity;
```

If `old`/`new` clash with your own names, rename them: `RETURNING WITH (OLD AS o, NEW AS n) o.price, n.price` [25][26].

### 3.4 INSERT ... ON CONFLICT (upsert)

```sql
CREATE TABLE product_stock (
  product_id bigint PRIMARY KEY,
  quantity   integer NOT NULL CHECK (quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Insert, or add to the existing quantity
INSERT INTO product_stock AS s (product_id, quantity)
VALUES (42, 5)
ON CONFLICT (product_id) DO UPDATE
SET quantity   = s.quantity + EXCLUDED.quantity,     -- EXCLUDED = the row we tried to insert
    updated_at = now()
RETURNING product_id, quantity;

-- Insert if absent, otherwise leave it alone
INSERT INTO tags (name) VALUES ('postgres')
ON CONFLICT (name) DO NOTHING;

-- Update only when the incoming version is newer (table: cached_pages(url PRIMARY KEY, body, version))
INSERT INTO cached_pages AS c (url, body, version) VALUES ($1, $2, $3)
ON CONFLICT (url) DO UPDATE
SET body = EXCLUDED.body, version = EXCLUDED.version
WHERE c.version < EXCLUDED.version;
```

Rules and pitfalls [27]:

- **Conflict target.** `DO UPDATE` needs one: a column list (`ON CONFLICT (email)`), an expression list, or `ON CONSTRAINT name`. Prefer the column list ("inference"): it keeps working if the index is rebuilt under another name. `DO NOTHING` without a target handles any unique or exclusion conflict.
- **Partial unique indexes** need the same predicate in the target:

```sql
CREATE TABLE accounts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text NOT NULL,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX accounts_live_email_key ON accounts (email) WHERE deleted_at IS NULL;

INSERT INTO accounts (email) VALUES ($1)
ON CONFLICT (email) WHERE deleted_at IS NULL DO NOTHING;
```

- **Atomic.** `DO UPDATE` guarantees an insert or an update even under high concurrency.
- **One touch per row.** If two input rows conflict on the same key in one statement, you get a "cannot affect row a second time" error. De-duplicate the input first.
- `DO NOTHING ... RETURNING` returns **no row** for conflicting inputs. Patterns to "get or create" an id are in [04](04-query-patterns-and-antipatterns.md). **(PG 19, beta — may change)**: `ON CONFLICT DO SELECT ... RETURNING` returns the existing row (optionally locked with `FOR UPDATE`/`FOR SHARE`); `RETURNING` is required with it [28][29].
- Exclusion constraints cannot be arbiters for `DO UPDATE`; only non-deferrable unique constraints/indexes can [27].
- Each attempt consumes identity/sequence values, even when it ends as an update (gaps, see section 2) [22].

### 3.5 MERGE (PG 15+)

`MERGE` joins a source to a target and runs a different action for matched and unmatched rows [30].

```sql
MERGE INTO product_stock AS t
USING stock_feed AS s
   ON s.product_id = t.product_id
WHEN MATCHED AND s.quantity = 0 THEN
  DELETE
WHEN MATCHED THEN
  UPDATE SET quantity = s.quantity, updated_at = now()
WHEN NOT MATCHED THEN                       -- in source, not in target
  INSERT (product_id, quantity) VALUES (s.product_id, s.quantity)
WHEN NOT MATCHED BY SOURCE THEN             -- PG 17+: in target, not in source
  DELETE
RETURNING merge_action(), t.product_id;     -- PG 17+
```

| | `INSERT ... ON CONFLICT` | `MERGE` |
|---|---|---|
| Available | PostgreSQL 9.5+ | PG 15+; `RETURNING`, `NOT MATCHED BY SOURCE`, views as targets: PG 17+ [31] |
| Standard SQL | No | Yes |
| Needs a unique index | Yes (the arbiter) | No (any join condition) |
| Can delete | No | Yes |
| Concurrent inserts of the same key | Handled atomically | Can fail with a unique violation [30] |
| A target row matched by 2 source rows | Error | Error (cardinality violation) [30] |

Rule of thumb: online upserts from the application → `ON CONFLICT`. Batch synchronization from a staging table → `MERGE`. The docs themselves suggest `ON CONFLICT` as the alternative when concurrent inserts are expected [30].

### 3.6 generate_series

```sql
SELECT generate_series(1, 5);                         -- 1, 2, 3, 4, 5
SELECT generate_series(0, 100, 25);                   -- 0, 25, 50, 75, 100
SELECT generate_series(date '2026-10-01', date '2026-10-07', interval '1 day')::date AS day;

-- PG 16+: steps computed in a given time zone (correct days across a DST change)
SELECT generate_series(timestamptz '2026-03-28 00:00 Europe/Paris',
                       timestamptz '2026-03-31 00:00 Europe/Paris',
                       interval '1 day', 'Europe/Paris');
```

A zero step is an error; a series in the wrong direction returns no rows [32][40]. Typical use: fill gaps in reports with a `LEFT JOIN` from the series (example in [01](01-sql-fundamentals.md), 17.2).

### 3.7 unnest, multi-argument unnest, WITH ORDINALITY

```sql
-- One row per element, with its position
SELECT t.tag, t.pos
FROM unnest(ARRAY['sql', 'postgres', 'jsonb']) WITH ORDINALITY AS t(tag, pos);

-- Several arrays in parallel ("zip"); shorter arrays are padded with NULL. Only in FROM.
SELECT * FROM unnest(ARRAY[1, 2, 3], ARRAY['a', 'b']) AS t(id, label);   -- row 3: (3, NULL)
```

Multi-argument `unnest` is the standard way to send many rows from an application in one statement (one array parameter per column) [15][24]. `WITH ORDINALITY` adds a `bigint` row number to any set-returning function [24].

### 3.8 Row constructors and row comparison

`(a, b) < (x, y)` compares element by element from left to right and stops at the first unequal pair [33]. This is exactly what keyset pagination needs:

```sql
-- Next page after the last row seen (created_at = $1, id = $2)
SELECT id, created_at, total
FROM orders
WHERE (created_at, id) < ($1, $2)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

A matching index on `(created_at, id)` makes this fast; details in [04](04-query-patterns-and-antipatterns.md) and [05](05-indexing.md).

### 3.9 ANY / ALL with arrays

```sql
SELECT * FROM orders WHERE id = ANY ($1::bigint[]);           -- one parameter for N values
SELECT * FROM orders WHERE status <> ALL (ARRAY['cancelled', 'pending']);
```

`x = ANY(array)` is false for an empty array, and NULL (not false) if no element matches and the array contains a NULL [33].

### 3.10 Pattern matching: LIKE, ILIKE, regular expressions

| Operator | Meaning |
|---|---|
| `LIKE`, `NOT LIKE` | Wildcards `%` (any text) and `_` (one character) |
| `ILIKE` | Case-insensitive `LIKE` (PostgreSQL extension) |
| `~`, `~*` | POSIX regex match (case-sensitive / insensitive) |
| `!~`, `!~*` | Regex non-match |
| `^@`, `starts_with()` | Prefix test |

```sql
SELECT * FROM users WHERE email ILIKE '%@example.com';
SELECT * FROM users WHERE full_name ~* '^jea?n';
SELECT regexp_replace('2026-10-05', '(\d+)-(\d+)-(\d+)', '\3/\2/\1');   -- 05/10/2026
```

Source: [34]. Only left-anchored patterns (`'abc%'`) can use a B-tree index; for `'%abc%'` use `pg_trgm` (see [12](12-full-text-and-vector-search.md)). Regular expressions from untrusted users can be built to run very long; the docs advise a statement timeout if you must accept them [34]. PG 15 added `regexp_count`, `regexp_instr`, `regexp_like`, `regexp_substr` [35].

### 3.11 TABLESAMPLE

```sql
SELECT * FROM events TABLESAMPLE SYSTEM (1);                     -- ~1% of pages: fast, clumpy
SELECT * FROM events TABLESAMPLE BERNOULLI (1) REPEATABLE (42);  -- ~1% of rows: slower, even
```

`SYSTEM` picks whole blocks; `BERNOULLI` scans the table and picks rows; `REPEATABLE(seed)` gives the same sample while the table does not change [24]. Useful for quick statistics on huge tables.

### 3.12 GROUP BY DISTINCT (PG 14+)

`GROUP BY DISTINCT ROLLUP (a, b), ROLLUP (a, c)` removes the duplicate grouping sets that the combination would otherwise produce [24][36]. See [01](01-sql-fundamentals.md), 7.3.

### 3.13 Row locking clauses

`SELECT ... FOR UPDATE | FOR NO KEY UPDATE | FOR SHARE | FOR KEY SHARE [NOWAIT | SKIP LOCKED]` locks the returned rows. `SKIP LOCKED` skips rows locked by others and is meant for queue-like tables with several consumers [24]. Lock semantics are in [08](08-transactions-concurrency-locking.md); queue table design is in [07](07-schema-design-and-patterns.md).

## 4. JSON and JSONB

### 4.1 json vs jsonb

| | `json` | `jsonb` |
|---|---|---|
| Storage | Exact input text | Parsed binary format |
| Whitespace, key order, duplicate keys | Kept | Not kept (last duplicate wins) |
| Read speed | Re-parsed on each use | Fast |
| Indexing (GIN), containment `@>` | No | Yes |

"In general, most applications should prefer to store JSON data as `jsonb`" [37]. `jsonb` numbers follow `numeric` rules and reject `NaN`/`Infinity` [37].

The examples below use:

```sql
CREATE TABLE documents (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title      text NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO documents (title, metadata) VALUES
  ('Q3 report', '{"author": {"id": 7, "name": "Ana"}, "tags": ["finance", "q3"], "pages": 12, "draft": false}');
```

### 4.2 Operators

```sql
SELECT
  metadata -> 'author'              AS author_json,  -- jsonb: {"id": 7, "name": "Ana"}
  metadata -> 'author' ->> 'name'   AS author_name,  -- text:  Ana
  metadata #>> '{author,name}'      AS same_name,    -- text via a path
  metadata -> 'tags' -> 0           AS first_tag,    -- jsonb: "finance"
  (metadata ->> 'pages')::int       AS pages         -- ->> gives text; cast it
FROM documents;

SELECT * FROM documents WHERE metadata @> '{"draft": false}';           -- contains
SELECT * FROM documents WHERE metadata @> '{"tags": ["finance"]}';      -- array contains element
SELECT * FROM documents WHERE metadata ? 'tags';                        -- top-level key exists
SELECT * FROM documents WHERE metadata ?| ARRAY['summary', 'abstract']; -- any of these keys
SELECT * FROM documents WHERE metadata ?& ARRAY['author', 'tags'];      -- all of these keys
```

| Operator | Returns | Meaning |
|---|---|---|
| `->` | `jsonb` | Field by key, or array element by index (0-based) |
| `->>` | `text` | Same, as text |
| `#>`, `#>>` | `jsonb` / `text` | Value at a path (`'{a,b,0}'`) |
| `@>`, `<@` | `boolean` | Contains / is contained by |
| `?`, `?\|`, `?&` | `boolean` | Key (or string element) exists: one / any / all |
| `@?`, `@@` | `boolean` | JSON path exists / JSON path predicate is true |
| `\|\|` | `jsonb` | Concatenate (shallow merge) |
| `-`, `#-` | `jsonb` | Delete a key / an index / a path |

Source: [38]. Containment ignores array order and duplicates; `'[1, 2, [1, 3]]' @> '[1, 3]'` is false because nesting must match [37]. `->>` on a missing key returns NULL, not an error.

### 4.3 Subscripting (PG 14+)

```sql
SELECT metadata['author']['name'] FROM documents;                 -- jsonb "Ana" (with quotes)
UPDATE documents SET metadata['draft'] = 'true' WHERE id = 1;     -- the new value must be jsonb
SELECT * FROM documents WHERE metadata['author']['name'] = '"Ana"';  -- compare jsonb with jsonb
```

The result of a subscript is `jsonb`, so compare it with a `jsonb` literal (`'"Ana"'`, note the double quotes) [37]. Assigning to a path in a NULL column creates the structure; assigning past the end of an array pads it with NULLs [37].

### 4.4 Changing jsonb values

```sql
UPDATE documents SET metadata = jsonb_set(metadata, '{author,name}', '"Ana Silva"') WHERE id = 1;
UPDATE documents SET metadata = metadata || '{"reviewed": true}' WHERE id = 1;     -- add/replace keys
UPDATE documents SET metadata = metadata - 'draft' WHERE id = 1;                   -- remove a key
UPDATE documents SET metadata = metadata #- '{author,id}' WHERE id = 1;            -- remove at a path
UPDATE documents SET metadata = jsonb_insert(metadata, '{tags,0}', '"urgent"') WHERE id = 1;  -- insert in array
```

- `||` merges only the **top level**; nested objects are replaced, not merged [38].
- `jsonb_set()` is strict: if the new value is SQL `NULL`, the result is `NULL` and the whole column is wiped. Use `jsonb_set_lax()` (its default turns SQL NULL into JSON `null`) or `coalesce` [38].
- Every update writes a **new version of the whole row**, including the whole document, even if you change one key [37][39].

### 4.5 Building JSON

```sql
-- Classic functions (all supported versions)
SELECT jsonb_build_object('id', u.id, 'email', u.email,
                          'orders', coalesce(jsonb_agg(o.id ORDER BY o.id) FILTER (WHERE o.id IS NOT NULL), '[]'))
FROM users u LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.id;

SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM orders GROUP BY status) AS s;

-- SQL/JSON standard constructors (PG 16+)
SELECT JSON_OBJECT('id': id, 'title': title) FROM documents;
SELECT JSON_ARRAYAGG(title ORDER BY title) FROM documents;
SELECT '{"a": 1}' IS JSON OBJECT;                                -- validation predicate
```

PG 16 added `JSON_ARRAY`, `JSON_ARRAYAGG`, `JSON_OBJECT`, `JSON_OBJECTAGG` and `IS JSON` [40]; PG 17 added `JSON()`, `JSON_SCALAR()` and `JSON_SERIALIZE()` [31]. Note (PG 19, beta — may change): `json_array()` over a query that returns no rows will return `[]` instead of NULL [28].

### 4.6 SQL/JSON path (PG 12+)

JSON path is a small query language for documents [38][41].

```sql
-- All tags (one row each)
SELECT jsonb_path_query(metadata, '$.tags[*]') FROM documents;

-- Documents with more than 10 pages (index-friendly operators @? and @@)
SELECT * FROM documents WHERE metadata @? '$.pages ? (@ > 10)';
SELECT * FROM documents WHERE metadata @@ '$.pages > 10';

-- Pass parameters as variables instead of building strings
SELECT * FROM documents
WHERE jsonb_path_exists(metadata, '$.tags[*] ? (@ == $tag)', jsonb_build_object('tag', $1::text));
```

Paths run in **lax** mode by default (structural mismatches are tolerated); add `strict` to get errors instead [38]. PG 17 added conversion methods such as `.integer()`, `.date()`, `.timestamp_tz()` [31]. (PG 19, beta — may change): string methods `lower()`, `upper()`, `ltrim()`, `rtrim()`, `btrim()`, `initcap()`, `replace()`, `split_part()` [28].

### 4.7 JSON_EXISTS, JSON_QUERY, JSON_VALUE, JSON_TABLE (PG 17+)

```sql
SELECT JSON_VALUE(metadata, '$.pages' RETURNING int)        AS pages,      -- scalar, typed
       JSON_QUERY(metadata, '$.tags[*]' WITH WRAPPER)       AS tags,       -- JSON array of matches
       JSON_EXISTS(metadata, '$.author ? (@.id == 7)')      AS by_author_7
FROM documents;

-- JSON_TABLE: turn a JSON array into rows and typed columns
SELECT d.id, jt.*
FROM documents AS d,
     JSON_TABLE(d.metadata, '$.tags[*]'
       COLUMNS (
         tag_no FOR ORDINALITY,
         tag    text PATH '$'
       )) AS jt;
```

`JSON_VALUE` and `JSON_QUERY` return NULL by default when the path finds nothing or fails; change this with `... ON EMPTY` / `... ON ERROR` [38]. `JSON_TABLE` also supports `NESTED PATH` for nested arrays and `EXISTS` columns [38].

### 4.8 When to use jsonb vs normal columns

| Use normal columns when the field... | `jsonb` is fine when the data... |
|---|---|
| Appears in `WHERE`, `JOIN`, `ORDER BY`, `GROUP BY` often | Is optional, sparse or rare per row |
| Needs `NOT NULL`, `CHECK`, `UNIQUE`, or a foreign key | Has a shape you do not control (webhooks, API payloads) |
| Is updated on its own, often | Is read and written as a whole |
| Exists for (almost) every row | Varies by type of item (product attributes) |

Laurenz Albe (Cybertec) lists the classic mistakes: modeling regular columns as JSON, storing tables as JSON arrays, embedding foreign keys, frequent partial updates, constraints and complex searches in JSON. His rule: "The less you need to process the data inside the database, the better it is to store them as JSON" [39]. The docs give a similar design rule: keep documents to a manageable size because any update locks the whole row [37]. A good compromise: keep core fields as columns and the rest in a `jsonb` column; promote a JSON field to a real column (or a generated column, section 5) when queries start to depend on it. Indexing `jsonb` (GIN `jsonb_ops` vs `jsonb_path_ops`, expression indexes): [05](05-indexing.md).

### 4.9 Large documents and TOAST

When a row is wider than about 2 kB, PostgreSQL compresses large values and/or moves them to a separate TOAST table ("The Oversized-Attribute Storage Technique"); one value can hold up to 1 GB [14]. Consequences:

- Reading a field from a large `jsonb` value means fetching and decompressing the whole value.
- An `UPDATE` that does not change a TOASTed value does not rewrite it; an `UPDATE` that changes one key of a large document rewrites the whole document [14][37].
- Compression is `pglz` by default; `lz4` is available per column or via `default_toast_compression` (PG 14+, if the server was built with LZ4) [36].

Keep hot, small fields out of big documents, and split rarely-read large payloads (raw text, embeddings, original files) into their own table when they are not needed on every read.

## 5. Generated columns

A generated column is computed from other columns of the same row [26].

```sql
CREATE TABLE line_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quantity    integer NOT NULL,
  unit_price  numeric(12,2) NOT NULL,
  total       numeric(14,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,   -- PG 12+
  title       text NOT NULL,
  title_lower text GENERATED ALWAYS AS (lower(title)) VIRTUAL                    -- PG 18+
);
```

| | `STORED` (PG 12+) | `VIRTUAL` (PG 18+) |
|---|---|---|
| Computed | On `INSERT`/`UPDATE`, saved on disk | When read; no storage |
| Default kind | Before PG 18 the only kind | **Default since PG 18** when you omit the keyword [10][26] |
| Can be indexed | Yes | No |
| Expression limits | Immutable functions; same row only; no other generated columns | Same, plus only built-in functions and types [26] |

- You cannot write to a generated column. Always write `STORED` or `VIRTUAL` explicitly, so the schema means the same thing on every version.
- `ALTER TABLE ... ALTER COLUMN ... SET EXPRESSION AS (...)` changes the expression (PG 17+); for `STORED` it rewrites the table [31][42].
- A classic use: a `tsvector` column for full-text search, stored and indexed (see [12](12-full-text-and-vector-search.md)).

## 6. PostgreSQL-specific constraints

### 6.1 Exclusion constraints

An exclusion constraint generalizes `UNIQUE`: no two rows may satisfy all the listed operator comparisons. It creates an index (usually GiST) [16][26].

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- lets GiST handle "=" on bigint

CREATE TABLE room_bookings (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id bigint NOT NULL,
  during  tstzrange NOT NULL,
  EXCLUDE USING gist (room_id WITH =, during WITH &&)   -- same room AND overlapping time
);

INSERT INTO room_bookings (room_id, during) VALUES (1, '[2026-10-05 09:00+00, 2026-10-05 10:00+00)');
INSERT INTO room_bookings (room_id, during) VALUES (1, '[2026-10-05 09:30+00, 2026-10-05 11:00+00)');
-- ERROR: conflicting key value violates exclusion constraint
```

### 6.2 Temporal keys: WITHOUT OVERLAPS and PERIOD (PG 18+)

PG 18 adds temporal primary keys, unique constraints and foreign keys [10][26]:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE prices (
  product_id bigint NOT NULL,
  valid      daterange NOT NULL,
  price      numeric(12,2) NOT NULL,
  PRIMARY KEY (product_id, valid WITHOUT OVERLAPS)            -- PG 18+
);

CREATE TABLE promotions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id bigint NOT NULL,
  valid      daterange NOT NULL,
  FOREIGN KEY (product_id, PERIOD valid)
    REFERENCES prices (product_id, PERIOD valid)               -- PG 18+
);
```

- `WITHOUT OVERLAPS` applies to the **last** column, which must be a range or multirange; the other columns are compared for equality. The constraint uses a GiST index, and non-range columns need `btree_gist` [26].
- `PERIOD` in a foreign key: the referenced rows (together) must **fully cover** the referencing period [26].
- The SQL-standard `UPDATE/DELETE ... FOR PORTION OF` was planned for PG 19 but was **reverted in 19 beta 4** [28][43].

### 6.3 Deferrable constraints

```sql
ALTER TABLE order_items
  ADD CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders (id)
  DEFERRABLE INITIALLY IMMEDIATE;

BEGIN;
SET CONSTRAINTS order_items_order_fk DEFERRED;   -- check at COMMIT instead of per statement
-- ... insert children before parents, swap unique values, etc.
COMMIT;
```

`UNIQUE`, `PRIMARY KEY`, `EXCLUDE` and foreign keys can be deferrable; `NOT NULL` and `CHECK` cannot [26]. Deferrable unique constraints cannot be `ON CONFLICT` arbiters [27] and are slower to check, so use them only where needed (for example when swapping positions in an ordered list).

### 6.4 NOT VALID, then VALIDATE

Adding a `CHECK` or foreign key normally scans the whole table while holding a lock. With `NOT VALID`, the scan is skipped; new and updated rows are still checked. Later, `VALIDATE CONSTRAINT` scans with a weaker `SHARE UPDATE EXCLUSIVE` lock that does not block reads or writes [42].

```sql
ALTER TABLE orders ADD CONSTRAINT orders_total_positive CHECK (total >= 0) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_total_positive;
```

PG 18 also allows `NOT VALID` for `NOT NULL` constraints and stores `NOT NULL` constraints with names in `pg_constraint` [10]. The full zero-downtime recipes are in [10](10-safe-schema-migrations.md).

### 6.5 NOT ENFORCED (PG 18+)

`CHECK` and foreign key constraints can be declared `NOT ENFORCED`: they document a rule that the database does not check [10][26]. (PG 19, beta — may change): `ALTER CONSTRAINT ... [NOT] ENFORCED` also works for `CHECK` constraints [28].

## 7. Functions, procedures and triggers

### 7.1 SQL functions vs PL/pgSQL functions

```sql
-- SQL function with an SQL-standard body (PG 14+): parsed at creation, dependencies tracked
CREATE FUNCTION order_total(p_order_id bigint)
RETURNS numeric
LANGUAGE sql
STABLE
BEGIN ATOMIC
  SELECT coalesce(sum(quantity * unit_price), 0)
  FROM order_items
  WHERE order_id = p_order_id;
END;

-- Single-expression form
CREATE FUNCTION slugify(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN trim(BOTH '-' FROM regexp_replace(lower(p_text), '[^a-z0-9]+', '-', 'g'));

-- PL/pgSQL: variables, IF, loops, error handling
CREATE FUNCTION apply_discount(p_order_id bigint, p_pct numeric)
RETURNS numeric
LANGUAGE plpgsql
AS $$
DECLARE
  v_total numeric;
BEGIN
  IF p_pct NOT BETWEEN 0 AND 50 THEN
    RAISE EXCEPTION 'discount % out of range', p_pct USING ERRCODE = 'check_violation';
  END IF;

  UPDATE orders SET total = round(total * (1 - p_pct / 100), 2)
  WHERE id = p_order_id
  RETURNING total INTO v_total;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % not found', p_order_id USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_total;
END;
$$;
```

- The `BEGIN ATOMIC` / `RETURN` form works only for `LANGUAGE sql`. It is parsed when the function is created, and dependencies are tracked so `DROP ... CASCADE` behaves correctly; string bodies (`AS $$...$$`) are parsed at run time [44].
- Simple SQL functions can be **inlined** into the calling query by the planner; PL/pgSQL functions are always a black box for the planner.

### 7.2 Volatility: IMMUTABLE, STABLE, VOLATILE

| Category | Promise | Examples | Allowed in index expressions |
|---|---|---|---|
| `VOLATILE` (default) | None; may change data; re-evaluated for every row | `random()`, `nextval()`, `clock_timestamp()` | No |
| `STABLE` | Same result for the same arguments within one statement; no writes | `now()`, functions that read tables | No (but usable in index scan conditions) |
| `IMMUTABLE` | Same result forever for the same arguments | `lower(text)`, arithmetic | Yes |

Source: [45]. Label each function with "the strictest volatility category that is valid" — it lets the planner pre-compute and use indexes [45]. Never mark a function `IMMUTABLE` if its result depends on a setting such as `TimeZone`, on a table, or on anything that can change: the planner may fold it into a constant and reuse a stale value, and an expression index built on it can return wrong results [45].

Since PG 17, functions used in expression indexes and materialized views run with a safe `search_path` during maintenance (`VACUUM`, `REINDEX`, `REFRESH ...`); such functions must schema-qualify names or set `search_path` themselves [31].

### 7.3 Other function options

| Option | Meaning | Default |
|---|---|---|
| `STRICT` (`RETURNS NULL ON NULL INPUT`) | Not called if any argument is NULL; result is NULL | `CALLED ON NULL INPUT` |
| `PARALLEL SAFE / RESTRICTED / UNSAFE` | Can run in parallel workers / only in the leader / forces a serial plan | `UNSAFE` |
| `SECURITY DEFINER` | Runs with the owner's privileges | `SECURITY INVOKER` |
| `SET search_path = ...` | Fixes settings while the function runs | Caller's settings |
| `COST n`, `ROWS n` | Hints for the planner | 100 (non-C), 1000 rows for set-returning |
| `LEAKPROOF` | Reveals nothing through errors; matters for RLS / security barrier views | Not leakproof |

Source: [44]. A `PARALLEL UNSAFE` function (the default) in a query forces a serial plan for the whole query; mark pure functions `PARALLEL SAFE`. Always give `SECURITY DEFINER` functions a fixed `search_path` ending with `pg_temp` (see [11](11-security.md)) [44].

### 7.4 Procedures and transaction control

Procedures (`CREATE PROCEDURE`, called with `CALL`, PG 11+) return no value but can **commit and roll back** inside their body [46][47]; `OUT` parameters exist since PG 14 [36].

```sql
CREATE PROCEDURE archive_old_orders(p_batch integer DEFAULT 5000)
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows integer;
BEGIN
  LOOP
    WITH moved AS (
      DELETE FROM orders
      WHERE id IN (SELECT id FROM orders
                   WHERE created_at < now() - interval '2 years'
                   ORDER BY id LIMIT p_batch)
      RETURNING *
    )
    INSERT INTO orders_archive SELECT * FROM moved;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    EXIT WHEN v_rows = 0;
    COMMIT;                -- release locks and let VACUUM work between batches
  END LOOP;
END;
$$;

CALL archive_old_orders();
```

Transaction control works only when `CALL` (or `DO`) is not inside an explicit transaction block and not called from a function; it is also impossible inside a block with an `EXCEPTION` handler [48]. Most drivers and ORMs wrap calls in a transaction: check before relying on `COMMIT` in procedures.

### 7.5 DO blocks

`DO` runs an anonymous PL/pgSQL block once; useful in migrations and admin scripts [49].

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_readonly') THEN
    CREATE ROLE app_readonly NOLOGIN;
  END IF;
END
$$;
```

### 7.6 PL/pgSQL essentials

```sql
CREATE FUNCTION refresh_user_stats(p_user_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r        record;                                  -- one row of any shape
  v_tag    text;
  v_count  integer := 0;
BEGIN
  -- Syntax demo only: in real code use SELECT count(*) instead of a loop
  FOR r IN SELECT id, total FROM orders WHERE user_id = p_user_id LOOP   -- loop over a query
    v_count := v_count + 1;
  END LOOP;

  FOREACH v_tag IN ARRAY ARRAY['vip', 'beta'] LOOP                        -- loop over an array
    RAISE DEBUG 'tag %', v_tag;
  END LOOP;

  -- Dynamic SQL: identifiers with %I, values with USING (never concatenate input)
  EXECUTE format('UPDATE %I SET order_count = $1 WHERE id = $2', 'users')
  USING v_count, p_user_id;

  RAISE NOTICE 'user % has % orders', p_user_id, v_count;
EXCEPTION
  WHEN undefined_column THEN
    RAISE WARNING 'users.order_count does not exist yet';
END;
$$;
```

- `RAISE` levels: `DEBUG`, `LOG`, `INFO`, `NOTICE`, `WARNING`, `EXCEPTION` (default; aborts the transaction). `USING ERRCODE`, `DETAIL`, `HINT` add structured information; the default SQLSTATE is `P0001` [50].
- `ASSERT condition, 'message'` is for catching bugs, not for normal errors [50].
- **Exception blocks are expensive**: "A block containing an EXCEPTION clause is significantly more expensive to enter and exit than a block without one" [51]. Each such block is a subtransaction; when it catches an error, the database changes made inside the block are rolled back [51]. Do not wrap every statement of a hot loop in `BEGIN ... EXCEPTION`.
- `GET DIAGNOSTICS v = ROW_COUNT` gives the rows affected; `FOUND` is set after `SELECT INTO`, `UPDATE`, `DELETE`... [51].
- `RETURN QUERY SELECT ...` and `RETURN NEXT` build the result of a set-returning function [51].

### 7.7 Triggers

| Timing | Row level | Statement level | Typical use |
|---|---|---|---|
| `BEFORE` | Tables | Tables, views | Normalize or validate `NEW`; set `updated_at` |
| `AFTER` | Tables | Tables, views | Audit, queue an event, maintain summaries |
| `INSTEAD OF` | Views | — | Make a complex view writable |

Source: [52]. Rules [52][53]:

- A `BEFORE ... FOR EACH ROW` trigger returns `NEW` (possibly modified) to continue, or `NULL` to **skip** the operation for that row. Return values of `AFTER` and statement-level triggers are ignored.
- `WHEN (condition)` avoids calling the function at all when nothing relevant changed.
- `REFERENCING NEW TABLE AS ... OLD TABLE AS ...` (transition tables) gives an `AFTER ... FOR EACH STATEMENT` trigger all changed rows at once — much cheaper than a row trigger for bulk changes.
- Triggers of the same kind fire in **alphabetical order** of their names.
- `CREATE OR REPLACE TRIGGER` exists since PG 14 [36].

```sql
-- Keep updated_at current (BEFORE row trigger)
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER products_set_updated_at
BEFORE UPDATE ON products
FOR EACH ROW
WHEN (OLD.* IS DISTINCT FROM NEW.*)          -- skip no-op updates
EXECUTE FUNCTION set_updated_at();

-- Bulk-friendly audit (AFTER statement trigger with a transition table)
CREATE FUNCTION audit_price_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO price_audit (product_id, old_price, new_price, changed_at)
  SELECT o.id, o.price, n.price, now()
  FROM old_rows o JOIN new_rows n USING (id)
  WHERE o.price IS DISTINCT FROM n.price;
  RETURN NULL;
END;
$$;

CREATE TRIGGER products_audit_price
AFTER UPDATE ON products
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION audit_price_changes();
```

(The examples assume `products.updated_at` and a `price_audit` table.) Trigger-based audit design is covered in [07](07-schema-design-and-patterns.md).

### 7.8 Event triggers

Event triggers fire on database-wide events, not on table rows: `ddl_command_start`, `ddl_command_end`, `sql_drop`, `table_rewrite`, and `login` (PG 17+) [31][54]. Uses: block or log DDL, enforce naming rules. Only superusers can create them [74]. A buggy `login` trigger can prevent all logins; the docs' escape hatch is setting `event_triggers = false` (PG 17+) in the connection string or configuration [54].

### 7.9 Logic in the database or in the application?

| Put it in the database | Keep it in the application |
|---|---|
| Integrity rules: `NOT NULL`, `CHECK`, `UNIQUE`, foreign keys, `EXCLUDE` | Workflows that call external services (email, payments, LLM APIs) |
| Set-based data changes that would otherwise move many rows over the network | Logic that changes often and needs fast unit tests and code review |
| Values that indexes or many queries need (generated columns) | CPU-heavy computation (the primary database is a shared, expensive resource) |
| Audit trails that must not be bypassable | Logic that must work with several databases |
| Small, stable helpers used in SQL (`slugify`) | Anything that needs request context (user session, feature flags) |

Why: the database is the only place that sees every write, so rules placed there cannot be skipped by a buggy client or a manual fix. Moving computation into the server also removes round trips [55]. But PL/pgSQL is harder to test, debug, deploy and observe than application code, and the primary is the hardest part of the system to scale. Default for this project: constraints in the database, business workflows in TypeScript, small SQL functions only when they remove real round trips or are needed by indexes.

## 8. COPY and psql \copy

`COPY` moves data between a table and a file or stream, much faster than `INSERT` [56].

```sql
-- Server-side file (needs superuser or pg_read_server_files / pg_write_server_files)
COPY users (email, full_name, country) FROM '/var/lib/postgresql/import/users.csv'
WITH (FORMAT csv, HEADER true);

-- Stream from/to the client (what drivers and psql use)
COPY users (email, full_name) FROM STDIN WITH (FORMAT csv);
COPY (SELECT id, email FROM users WHERE country = 'FR') TO STDOUT WITH (FORMAT csv, HEADER);

-- Skip malformed rows instead of failing (PG 17+), with a safety limit (PG 18+)
COPY users (email, full_name) FROM STDIN
WITH (FORMAT csv, ON_ERROR ignore, REJECT_LIMIT 100, LOG_VERBOSITY verbose);
```

```text
-- psql: the file is read/written on YOUR machine, with your permissions
\copy users (email, full_name) FROM 'users.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT * FROM orders WHERE created_at >= '2026-01-01') TO 'orders_2026.csv' CSV HEADER
```

| Option | Meaning | Version |
|---|---|---|
| `FORMAT text \| csv \| binary` | File format | All |
| `HEADER true` | First line has column names | CSV all; text format PG 15+ [35] |
| `HEADER MATCH` | Header names must match the table columns (`COPY FROM`) | PG 15+ [57] |
| `FREEZE` | Load rows already frozen; only if the table was created or truncated in the same transaction | All |
| `DEFAULT 'str'` | Marker string meaning "use the column default" | PG 16+ [40] |
| `ON_ERROR ignore` | Skip rows with conversion errors (`COPY FROM`, text/CSV) | PG 17+ [31] |
| `REJECT_LIMIT n` | Fail if more than n rows are skipped | PG 18+ [10] |
| `LOG_VERBOSITY verbose \| silent` | Report skipped rows / stay quiet (`silent` PG 18+) | PG 17+ |
| `WHERE condition` | Load only matching rows | All |

Source: [56]. `ON_ERROR ignore` skips only data-type conversion errors, not constraint violations. Do not confuse server-side `COPY ... FROM 'file'` (the file must be on the database server) with `\copy` (the file is on the client) [56]. (PG 19, beta — may change): `COPY TO ... (FORMAT json)`, `COPY FROM ... (ON_ERROR set_null)`, and `COPY TO` directly from partitioned tables [28]. From Node.js, use the `pg-copy-streams` package (see [15](15-postgres-from-typescript.md)).

## 9. LISTEN / NOTIFY

```sql
LISTEN document_ingested;                                      -- in the consumer session
NOTIFY document_ingested, '{"document_id": 42}';               -- constant payload
SELECT pg_notify('document_ingested', json_build_object('document_id', 42)::text);  -- computed
```

Facts [58]:

- Notifications are **transactional**: delivered only if the sending transaction commits, and only between the listener's transactions.
- Identical notifications (same channel and payload) in one transaction are delivered once.
- Payload limit: under 8000 bytes by default. Send an id, not the data.
- The queue is 8 GB in a standard installation; if it fills (for example because a listening session stays in a long transaction), `NOTIFY` fails at commit.
- Delivery order follows commit order.

Limits in practice:

- **Not durable**: a listener that is disconnected misses messages. Use a queue table as the source of truth and `NOTIFY` only to wake workers (see [07](07-schema-design-and-patterns.md)).
- **Commit serialization**: transactions that issued `NOTIFY` take a global lock at commit to keep queue order; Recall.ai traced production stalls with many concurrent writers to this lock [59].
- **Poolers**: `LISTEN` needs a dedicated session; it does not work through PgBouncer in transaction mode (see [09](09-operations-and-server-tuning.md)).

## 10. Views and materialized views

### 10.1 Views

```sql
CREATE VIEW paid_orders
WITH (security_invoker = true)       -- PG 15+: check permissions and RLS as the caller
AS
SELECT id, user_id, total, created_at
FROM orders
WHERE status = 'paid'
WITH CASCADED CHECK OPTION;          -- inserts/updates through the view must stay visible in it
```

- By default a view accesses its tables with the **owner's** privileges; with `security_invoker = true` (PG 15+) the caller's privileges and row-level security policies apply [60][35]. Use it on views over RLS-protected tables (see [11](11-security.md)).
- `security_barrier = true` makes the view's own `WHERE` run before user-supplied conditions, so functions in user conditions cannot leak hidden rows (only `LEAKPROOF` functions are pushed down) [60].
- **Automatically updatable views**: one table in `FROM`, no `DISTINCT`, `GROUP BY`, `HAVING`, `LIMIT`, `OFFSET`, set operations, aggregates or window functions at the top level. They accept `INSERT`, `UPDATE`, `DELETE` and `MERGE` [60]. Other views need `INSTEAD OF` triggers.
- `CREATE OR REPLACE VIEW` can only add columns at the end; it cannot rename or retype existing ones [60].

### 10.2 Materialized views

```sql
CREATE MATERIALIZED VIEW daily_revenue AS
SELECT created_at::date AS day, sum(total) AS revenue, count(*) AS orders
FROM orders
WHERE status = 'paid'
GROUP BY 1
WITH DATA;

CREATE UNIQUE INDEX daily_revenue_day_key ON daily_revenue (day);
REFRESH MATERIALIZED VIEW CONCURRENTLY daily_revenue;
```

- A plain `REFRESH` takes an `ACCESS EXCLUSIVE` lock: readers wait. `CONCURRENTLY` lets readers continue but needs a **unique index on plain columns** (no expression, no `WHERE`) and an already populated view [61].
- A refresh recomputes everything; there is no built-in incremental refresh. Schedule it (for example with `pg_cron`) or maintain a summary table with triggers or batch jobs.
- `ORDER BY` in the defining query is not guaranteed to be kept [61]. The `MAINTAIN` privilege (PG 17+) allows non-owners to refresh [31].

## 11. Declarative partitioning (syntax only)

A partitioned table is a parent that routes rows to child tables (partitions) by a partition key [62].

```sql
CREATE TABLE events (
  id          bigint GENERATED ALWAYS AS IDENTITY,       -- identity on partitioned tables: PG 17+
  occurred_at timestamptz NOT NULL,
  tenant_id   bigint NOT NULL,
  payload     jsonb NOT NULL,
  PRIMARY KEY (id, occurred_at)                          -- must include the partition key
) PARTITION BY RANGE (occurred_at);

CREATE TABLE events_2026_10 PARTITION OF events
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');      -- lower bound inclusive, upper exclusive
CREATE TABLE events_default PARTITION OF events DEFAULT; -- rows that fit nowhere else

-- LIST and HASH partitioning
CREATE TABLE tenants_data (tenant_id bigint NOT NULL, region text NOT NULL)
  PARTITION BY LIST (region);
CREATE TABLE tenants_data_eu PARTITION OF tenants_data FOR VALUES IN ('eu-west', 'eu-central');

CREATE TABLE sessions (id uuid NOT NULL, user_id bigint NOT NULL) PARTITION BY HASH (user_id);
CREATE TABLE sessions_p0 PARTITION OF sessions FOR VALUES WITH (MODULUS 4, REMAINDER 0);

-- Detach without blocking queries (PG 14+), attach an existing table
ALTER TABLE events DETACH PARTITION events_2026_10 CONCURRENTLY;
ALTER TABLE events ATTACH PARTITION events_2026_10
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
```

- An index created on the parent is created on every partition. To avoid a long lock, create it `ON ONLY` the parent, build each partition's index `CONCURRENTLY`, then `ALTER INDEX ... ATTACH PARTITION` [62].
- Primary keys and unique constraints must include all partition key columns [62].
- Queries prune partitions when the `WHERE` clause constrains the partition key [62].
- (PG 19, beta — may change): `ALTER TABLE ... MERGE PARTITIONS` / `SPLIT PARTITIONS` were **reverted** in beta 4 [43].

When and how to partition (key choice, partition count, retention with `pg_partman`) is in [07](07-schema-design-and-patterns.md).

## 12. Extensions

### 12.1 Installing extensions

```sql
SELECT name, default_version, installed_version FROM pg_available_extensions ORDER BY name;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER EXTENSION pg_trgm UPDATE;          -- after upgrading the extension's package
\dx                                       -- psql: list installed extensions
```

- An extension must be **available on the server** (files installed) before `CREATE EXTENSION`; managed services publish allow-lists.
- Since PG 13, **trusted** extensions can be installed by non-superusers with `CREATE` privilege on the database [63][9]. `citext`, `pgcrypto` and `pg_trgm` are trusted [5][13][64].
- Some modules also need `shared_preload_libraries` and a server restart (for example `pg_stat_statements`) [65].

### 12.2 Useful contrib modules (shipped with PostgreSQL)

| Module | One-line purpose |
|---|---|
| `pg_stat_statements` | Statistics for every normalized query; the first tool for slow-query work (needs preload) [65]; see [06](06-query-optimization-and-explain.md) |
| `auto_explain` | Logs plans of slow statements automatically (loaded as a library, not with `CREATE EXTENSION`) |
| `pg_trgm` | Trigram similarity; GIN/GiST indexes for `LIKE '%x%'`, `ILIKE`, regex [64] |
| `pgcrypto` | Hashing, `crypt()` password hashes, PGP encryption [13] |
| `citext` | Case-insensitive text type [5] |
| `hstore` | Key/value pairs in one column (mostly replaced by `jsonb`) |
| `ltree` | Hierarchical labels (`a.b.c`) with path queries; see [07](07-schema-design-and-patterns.md) |
| `btree_gin`, `btree_gist` | B-tree-like operators in GIN/GiST indexes; needed for mixed `EXCLUDE` constraints |
| `unaccent` | Removes accents; used in full-text search configurations |
| `postgres_fdw` | Query tables in another PostgreSQL server |
| `pg_buffercache` | Shows what is in shared buffers |
| `pgstattuple` | Measures table/index bloat precisely |
| `amcheck` | Verifies B-tree (and heap) consistency; detects corruption |
| `pg_prewarm` | Loads relations into cache, for example after a restart |
| `uuid-ossp` | Extra UUID algorithms; not needed for v4 (core) or v7 (PG 18 core) |

Full list: [63]. Details per tool: [13](13-tools-by-use-case.md).

### 12.3 Major third-party extensions

| Extension | One-line purpose | Status (checked 2026-10) |
|---|---|---|
| `pgvector` | `vector`, `halfvec`, `sparsevec`, `bit` types with HNSW and IVFFlat indexes | Active; 0.8.x; supports Postgres 13+ [66]; see [12](12-full-text-and-vector-search.md) |
| PostGIS | Geospatial types, functions and indexes | Active [67] |
| TimescaleDB | Time-series: hypertables, compression, continuous aggregates | Active; maintained by Tiger Data (formerly Timescale); Apache 2.0 core plus Timescale License parts [68] |
| Citus | Distributed PostgreSQL (sharding across nodes) | Active; Microsoft-owned Citus Data; AGPL-3.0; v14.x supports PG 18 [69] |
| `pg_partman` | Automatic creation and retention of time/number partitions | Active; v5 supports only declarative partitioning; needs PG 14+ [70] |
| `pg_cron` | Cron-style job scheduler inside the database | Active (Citus Data); installed in one database per cluster; needs preload [71] |

## 13. psql essentials

`psql` is the official command-line client. Meta-commands start with a backslash and are handled by psql itself, not by the server [72].

| Command | Purpose |
|---|---|
| `\l`, `\c dbname` | List databases, connect to one |
| `\dt`, `\dv`, `\dm`, `\di`, `\ds` | List tables, views, materialized views, indexes, sequences |
| `\d name`, `\d+ name` | Describe a table/view/index (`+` adds size, storage, comments) |
| `\df`, `\sf name` | List functions; show a function's source |
| `\dn`, `\du`, `\dp` | Schemas, roles, privileges |
| `\dx`, `\dconfig pattern` | Extensions; server settings matching a pattern (PG 15+) [35] |
| `\x auto` | Expanded (vertical) output when rows are too wide |
| `\timing on` | Print the duration of each statement |
| `\e`, `\ef name` | Edit the query buffer / a function in `$EDITOR` |
| `\i file`, `\ir file` | Run a file (`\ir`: path relative to the current script) |
| `\gexec` | Run each value of the result as a SQL statement |
| `\gset` | Store a one-row result into psql variables |
| `\watch 5` | Re-run the query every 5 seconds |
| `\errverbose` | Show the last error with all details |
| `\copy` | Client-side `COPY` (section 8) |
| `\conninfo` | Show current connection (tabular since PG 18) [10] |

```text
-- Variables and safe interpolation
\set user_id 42
SELECT * FROM orders WHERE user_id = :user_id;
\set email 'ana@example.com'
SELECT * FROM users WHERE email = :'email';          -- quoted as an SQL literal
\set tbl orders
SELECT count(*) FROM :"tbl";                          -- quoted as an SQL identifier

-- Generate and run statements
SELECT format('ANALYZE %I.%I', schemaname, relname)
FROM pg_stat_user_tables WHERE last_analyze IS NULL AND last_autoanalyze IS NULL
\gexec

-- Monitor
SELECT state, count(*) FROM pg_stat_activity GROUP BY state \watch 2
```

Scripts: run them with errors stopping execution, ideally in one transaction:

```text
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f migration.sql
```

Without `ON_ERROR_STOP`, psql continues after an error and the script half-applies. A sample `~/.psqlrc` (psql also reads version-specific files such as `~/.psqlrc-18` in preference; start with `-X` to skip them) [72]:

```text
\set QUIET 1
\pset null '(null)'
\x auto
\timing on
\set ON_ERROR_ROLLBACK interactive
\set COMP_KEYWORD_CASE upper
\set HISTCONTROL ignoredups
\set HISTFILE ~/.psql_history-:DBNAME
\set PROMPT1 '%n@%/%R%# '
\unset QUIET
```

`ON_ERROR_ROLLBACK interactive` puts an implicit savepoint before each statement in interactive sessions, so a typo does not abort your open transaction [72]. (PG 19, beta — may change): `\pset display_true` / `display_false` control how booleans print [28].

## 14. What's new for application developers

| Version (release) | Most relevant items |
|---|---|
| **PG 14** (2021-09-30) | Multirange types; `jsonb` subscripting; `SEARCH`/`CYCLE` in recursive CTEs; `GROUP BY DISTINCT`; SQL-standard function bodies (`BEGIN ATOMIC`); `OUT` parameters for procedures; `date_bin()`, `string_to_table()`, negative `split_part()`; `CREATE OR REPLACE TRIGGER`; `DETACH PARTITION CONCURRENTLY`; libpq pipeline mode; default `password_encryption` = `scram-sha-256`; `EXTRACT` returns `numeric` [36] |
| **PG 15** (2022-10-13) | `MERGE`; `UNIQUE NULLS NOT DISTINCT`; `security_invoker` views; FK `ON DELETE SET NULL (cols)`; `regexp_count/instr/like/substr`; `COPY ... HEADER MATCH`; **no `CREATE` on schema `public` for ordinary users in new databases**; `jsonlog` logging; `\dconfig` [35][57] |
| **PG 16** (2023-09-14) | SQL/JSON constructors (`JSON_OBJECT`, `JSON_ARRAY`, `..._AGG`) and `IS JSON`; `any_value()`; `pg_input_is_valid()`; numeric literals `0x`, `0o`, `0b`, `1_000`; subquery in `FROM` without alias; time-zone-aware `generate_series()`, `date_add()`/`date_subtract()`; `COPY ... DEFAULT`; psql `\bind`; logical replication from standbys; `pg_stat_io` [40] |
| **PG 17** (2024-09-26) | `JSON_TABLE`, `JSON_EXISTS`, `JSON_QUERY`, `JSON_VALUE`; `MERGE ... RETURNING` + `merge_action()`, `WHEN NOT MATCHED BY SOURCE`, views as targets; `COPY ... ON_ERROR ignore`; `random(min, max)`; `uuid_extract_timestamp()`; `transaction_timeout`; identity columns and exclusion constraints on partitioned tables; `AT LOCAL`; login event triggers; `MAINTAIN` privilege; safe `search_path` during maintenance (incompatibility) [31] |
| **PG 18** (2025-09-25) | `uuidv7()`; virtual generated columns, now the **default** kind; `OLD`/`NEW` in `RETURNING`; temporal `WITHOUT OVERLAPS` keys and `PERIOD` foreign keys; `NOT ENFORCED` constraints, `NOT NULL ... NOT VALID`; `COPY ... REJECT_LIMIT`; `casefold()`, `array_sort()`, `array_reverse()`; B-tree skip scan; asynchronous I/O; `EXPLAIN ANALYZE` shows buffers by default; `pg_upgrade` keeps planner statistics; data checksums on by default in `initdb`; MD5 passwords deprecated; OAuth authentication [10] |
| **PG 19** (beta 4, 2026-09-24 — may change) | Window functions `IGNORE NULLS`/`RESPECT NULLS`; `INSERT ... ON CONFLICT DO SELECT ... RETURNING`; `COPY TO ... FORMAT json`, `COPY FROM ... ON_ERROR set_null`; `REPACK [CONCURRENTLY]` replaces `VACUUM FULL`/`CLUSTER`; `uuid` ↔ `bytea` casts; `random()` for dates/timestamps; `error_on_null()`; more `jsonpath` string methods; JIT **off** by default; `standard_conforming_strings` always on; empty `json_array()` returns `[]`. **Reverted in beta 4**: SQL/PGQ property graphs, `FOR PORTION OF`, `MERGE/SPLIT PARTITIONS`, online checksum changes [28][43] |

Release dates and support windows: [73]. PG 14 reaches end of support on 2026-11-12 [73], so new projects should target PG 17 or 18.

## Sources

1. [Don't Do This](https://wiki.postgresql.org/wiki/Don%27t_Do_This) — PostgreSQL wiki: types and features to avoid (timestamp, char(n), varchar(n), money, serial, rules, inheritance, SQL_ASCII).
2. [Numeric Types](https://www.postgresql.org/docs/current/datatype-numeric.html) — PostgreSQL docs: integer ranges, numeric for money, float inexactness, serial as notation.
3. [Monetary Types](https://www.postgresql.org/docs/current/datatype-money.html) — PostgreSQL docs: lc_monetary dependency and dump/restore caution.
4. [Character Types](https://www.postgresql.org/docs/current/datatype-character.html) — PostgreSQL docs: no performance difference, char(n) padding, 1 GB limit.
5. [citext](https://www.postgresql.org/docs/current/citext.html) — PostgreSQL docs: limitations, nondeterministic collations tip, trusted.
6. [Collation Support](https://www.postgresql.org/docs/current/collation.html) — PostgreSQL docs: nondeterministic ICU collations and their limits.
7. [Date/Time Types](https://www.postgresql.org/docs/current/datatype-datetime.html) — PostgreSQL docs: storage, UTC storage of timestamptz, interval fields, timetz advice, zone names.
8. [UUID Type](https://www.postgresql.org/docs/current/datatype-uuid.html) — PostgreSQL docs: 128-bit storage, input/output formats, v4 and v7 support.
9. [PostgreSQL 13 Release Notes](https://www.postgresql.org/docs/release/13.0/) — PostgreSQL: gen_random_uuid() in core, trusted extensions.
10. [PostgreSQL 18 Release Notes](https://www.postgresql.org/docs/release/18.0/) — PostgreSQL: uuidv7/uuidv4, virtual generated columns as default, OLD/NEW in RETURNING, temporal constraints, NOT ENFORCED, NOT NULL NOT VALID, COPY REJECT_LIMIT, LIKE with nondeterministic collations, \conninfo.
11. [UUID Functions](https://www.postgresql.org/docs/current/functions-uuid.html) — PostgreSQL docs: gen_random_uuid, uuidv4, uuidv7(shift), extraction functions.
12. [Unexpected downsides of UUID keys in PostgreSQL](https://www.cybertec-postgresql.com/en/unexpected-downsides-of-uuid-keys-in-postgresql/) — Cybertec (Ants Aasma): locality cost of random UUIDs, UUIDv7 recommendation.
13. [pgcrypto](https://www.postgresql.org/docs/current/pgcrypto.html) — PostgreSQL docs: trusted, crypt(), gen_random_uuid obsolete wrapper.
14. [TOAST](https://www.postgresql.org/docs/current/storage-toast.html) — PostgreSQL docs: 2 kB threshold, 1 GB limit, storage strategies, unchanged values not rewritten.
15. [Array Functions and Operators](https://www.postgresql.org/docs/current/functions-array.html) — PostgreSQL docs: @>, &&, unnest (multi-argument), array_sort/array_reverse.
16. [Range Types](https://www.postgresql.org/docs/current/rangetypes.html) — PostgreSQL docs: built-in ranges and multiranges, bounds, exclusion constraint examples.
17. [Enumerated Types](https://www.postgresql.org/docs/current/datatype-enum.html) — PostgreSQL docs: 4 bytes, ordering, no removal of values.
18. [CREATE DOMAIN](https://www.postgresql.org/docs/current/sql-createdomain.html) — PostgreSQL docs: domains, NOT NULL advice, immutable checks.
19. [Network Address Types](https://www.postgresql.org/docs/current/datatype-net-types.html) — PostgreSQL docs: inet vs cidr, why not text.
20. [Identity Columns](https://www.postgresql.org/docs/current/ddl-identity-columns.html) — PostgreSQL docs: NOT NULL but not unique, partitions.
21. [System Information Functions](https://www.postgresql.org/docs/current/functions-info.html) — PostgreSQL docs: pg_get_serial_sequence works for identity columns.
22. [Sequence Manipulation Functions](https://www.postgresql.org/docs/current/functions-sequence.html) — PostgreSQL docs: no gapless sequences, ON CONFLICT consumes values.
23. [CREATE SEQUENCE](https://www.postgresql.org/docs/current/sql-createsequence.html) — PostgreSQL docs: CACHE behavior across sessions.
24. [SELECT](https://www.postgresql.org/docs/current/sql-select.html) — PostgreSQL docs: DISTINCT ON, TABLESAMPLE, WITH ORDINALITY, GROUP BY DISTINCT, locking clauses.
25. [Returning Data from Modified Rows](https://www.postgresql.org/docs/current/dml-returning.html) — PostgreSQL docs: RETURNING per command, old/new aliases (old is NULL for plain inserts).
26. [CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html) — PostgreSQL docs: identity ALWAYS vs BY DEFAULT, generated columns STORED/VIRTUAL, WITHOUT OVERLAPS, PERIOD, EXCLUDE, DEFERRABLE, NOT ENFORCED.
27. [INSERT](https://www.postgresql.org/docs/current/sql-insert.html) — PostgreSQL docs: ON CONFLICT targets, inference, EXCLUDED, atomicity, cardinality rule, arbiters.
28. [PostgreSQL 19 Release Notes (beta)](https://www.postgresql.org/docs/19/release-19.html) — PostgreSQL 19beta4: IGNORE NULLS, ON CONFLICT DO SELECT, COPY JSON, REPACK, incompatibilities.
29. [INSERT (PG 19 beta)](https://www.postgresql.org/docs/19/sql-insert.html) — PostgreSQL 19beta4 docs: DO SELECT syntax and RETURNING requirement.
30. [MERGE](https://www.postgresql.org/docs/current/sql-merge.html) — PostgreSQL docs: syntax, merge_action(), concurrency, cardinality.
31. [PostgreSQL 17 Release Notes](https://www.postgresql.org/docs/release/17.0/) — PostgreSQL: JSON_TABLE and SQL/JSON query functions, MERGE RETURNING / NOT MATCHED BY SOURCE, COPY ON_ERROR, login event triggers, MAINTAIN, SET EXPRESSION, enum values usable in the creating transaction, search_path change.
32. [Set Returning Functions](https://www.postgresql.org/docs/current/functions-srf.html) — PostgreSQL docs: generate_series signatures and rules.
33. [Row and Array Comparisons](https://www.postgresql.org/docs/current/functions-comparisons.html) — PostgreSQL docs: ANY with arrays, row-wise comparison.
34. [Pattern Matching](https://www.postgresql.org/docs/current/functions-matching.html) — PostgreSQL docs: LIKE/ILIKE, POSIX regex, regex DoS caution.
35. [PostgreSQL 15 Release Notes](https://www.postgresql.org/docs/release/15.0/) — PostgreSQL: MERGE, NULLS NOT DISTINCT, security invoker views, regexp functions, public schema.
36. [PostgreSQL 14 Release Notes](https://www.postgresql.org/docs/release/14.0/) — PostgreSQL: multiranges, jsonb subscripting, SEARCH/CYCLE, GROUP BY DISTINCT, BEGIN ATOMIC, CREATE OR REPLACE TRIGGER, LZ4 TOAST compression.
37. [JSON Types](https://www.postgresql.org/docs/current/datatype-json.html) — PostgreSQL docs: json vs jsonb, document design, containment, subscripting.
38. [JSON Functions and Operators](https://www.postgresql.org/docs/current/functions-json.html) — PostgreSQL docs: operators, jsonb_set/jsonb_set_lax, shallow || merge, path language (lax/strict), JSON_EXISTS/JSON_QUERY/JSON_VALUE, JSON_TABLE, ON EMPTY/ON ERROR defaults.
39. [JSON in PostgreSQL: how to use it right](https://www.cybertec-postgresql.com/en/json-postgresql-how-to-use-it-right/) — Cybertec (Laurenz Albe): JSON anti-patterns and good uses.
40. [PostgreSQL 16 Release Notes](https://www.postgresql.org/docs/release/16.0/) — PostgreSQL: SQL/JSON constructors, IS JSON, COPY DEFAULT, any_value, numeric literals, time-zone-aware generate_series.
41. [PostgreSQL 12 Release Notes](https://www.postgresql.org/docs/release/12.0/) — PostgreSQL: SQL/JSON path, stored generated columns, CTE inlining.
42. [ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) — PostgreSQL docs: NOT VALID, VALIDATE CONSTRAINT lock level, SET EXPRESSION.
43. [PostgreSQL 19 Beta 4 Released!](http://www.mail-archive.com/pgsql-announce@lists.postgresql.org/msg01761.html) — pgsql-announce: features reverted in beta 4, GA timeline.
44. [CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html) — PostgreSQL docs: BEGIN ATOMIC bodies, STRICT, PARALLEL, SECURITY DEFINER, COST/ROWS, LEAKPROOF.
45. [Function Volatility Categories](https://www.postgresql.org/docs/current/xfunc-volatility.html) — PostgreSQL docs: VOLATILE/STABLE/IMMUTABLE and mislabeling hazards.
46. [CREATE PROCEDURE](https://www.postgresql.org/docs/current/sql-createprocedure.html) — PostgreSQL docs: procedures vs functions, CALL, BEGIN ATOMIC.
47. [PostgreSQL 11 Release Notes](https://www.postgresql.org/docs/release/11.0/) — PostgreSQL: procedures with transaction control.
48. [Transaction Management (PL/pgSQL)](https://www.postgresql.org/docs/current/plpgsql-transactions.html) — PostgreSQL docs: COMMIT/ROLLBACK in procedures and their restrictions.
49. [DO](https://www.postgresql.org/docs/current/sql-do.html) — PostgreSQL docs: anonymous code blocks.
50. [Errors and Messages (PL/pgSQL)](https://www.postgresql.org/docs/current/plpgsql-errors-and-messages.html) — PostgreSQL docs: RAISE levels and options, ASSERT.
51. [Control Structures (PL/pgSQL)](https://www.postgresql.org/docs/current/plpgsql-control-structures.html) — PostgreSQL docs: loops, RETURN QUERY, EXCEPTION cost and rollback.
52. [CREATE TRIGGER](https://www.postgresql.org/docs/current/sql-createtrigger.html) — PostgreSQL docs: timings, transition tables, WHEN, firing order.
53. [Trigger Functions (PL/pgSQL)](https://www.postgresql.org/docs/current/plpgsql-trigger.html) — PostgreSQL docs: return values, NEW/OLD/TG_OP, examples.
54. [Overview of Event Trigger Behavior](https://www.postgresql.org/docs/current/event-trigger-definition.html) — PostgreSQL docs: events incl. login, event_triggers escape hatch.
55. [PL/pgSQL Overview](https://www.postgresql.org/docs/current/plpgsql-overview.html) — PostgreSQL docs: round-trip savings of server-side logic.
56. [COPY](https://www.postgresql.org/docs/current/sql-copy.html) — PostgreSQL docs: options, ON_ERROR, REJECT_LIMIT, FREEZE, COPY vs \copy.
57. [COPY (PostgreSQL 15)](https://www.postgresql.org/docs/15/sql-copy.html) — PostgreSQL 15 docs: HEADER MATCH (absent in [COPY 14](https://www.postgresql.org/docs/14/sql-copy.html), where HEADER is CSV-only).
58. [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html) — PostgreSQL docs: transactional delivery, payload limit, queue size, ordering.
59. [Postgres LISTEN/NOTIFY does not scale](https://www.recall.ai/blog/postgres-listen-notify-does-not-scale) — Recall.ai (Elliot Levin, 2025): global lock at commit with NOTIFY.
60. [CREATE VIEW](https://www.postgresql.org/docs/current/sql-createview.html) — PostgreSQL docs: security_invoker, security_barrier, updatable views, check option.
61. [REFRESH MATERIALIZED VIEW](https://www.postgresql.org/docs/current/sql-refreshmaterializedview.html) — PostgreSQL docs: CONCURRENTLY requirements, locks, MAINTAIN.
62. [Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) — PostgreSQL docs: range/list/hash, attach/detach, partitioned indexes, limitations, pruning.
63. [Additional Supplied Modules and Extensions](https://www.postgresql.org/docs/current/contrib.html) — PostgreSQL docs: contrib list, trusted extensions.
64. [pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html) — PostgreSQL docs: trusted, index-supported operators.
65. [pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html) — PostgreSQL docs: shared_preload_libraries requirement.
66. [pgvector](https://github.com/pgvector/pgvector) — GitHub: types, HNSW/IVFFlat, Postgres 13+, version 0.8.x.
67. [PostGIS](https://postgis.net/) — PostGIS project: spatial extension.
68. [TimescaleDB](https://github.com/timescale/timescaledb) — GitHub: maintained by Tiger Data, dual licensing.
69. [Citus](https://github.com/citusdata/citus) — GitHub: distributed Postgres, AGPL-3.0, Citus 14.x for PG 18.
70. [pg_partman](https://github.com/pgpartman/pg_partman) — GitHub: v5 declarative-only, PG 14+, background worker.
71. [pg_cron](https://github.com/citusdata/pg_cron) — GitHub: scheduler, one database per cluster, preload.
72. [psql](https://www.postgresql.org/docs/current/app-psql.html) — PostgreSQL docs: meta-commands, variables and interpolation, psqlrc, ON_ERROR_ROLLBACK.
73. [Versioning Policy](https://www.postgresql.org/support/versioning/) — PostgreSQL: supported versions, release and end-of-life dates.
74. [CREATE EVENT TRIGGER](https://www.postgresql.org/docs/current/sql-createeventtrigger.html) — PostgreSQL docs: superuser-only, TAG filter.
