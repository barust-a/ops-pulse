# Safe Schema Migrations (Zero Downtime)

> Part of the [SQL & PostgreSQL reference library](README.md) · Last researched: 2026-10-05 · Targets PostgreSQL 14–18 (19 beta noted where relevant)

**What this covers.** How to change a PostgreSQL schema while the application keeps running: the principles (expand/contract, deploy order, backfills), the lock hazards, a cookbook of safe recipes for each common change, automated tools and linters, and a dedicated section on applying the recipes with **Prisma Migrate** (plain `migration.sql` files). Lock modes and the lock queue are explained in depth in [08-transactions-concurrency-locking.md](08-transactions-concurrency-locking.md); backups and upgrades are in [09-operations-and-server-tuning.md](09-operations-and-server-tuning.md).

## Key rules (TL;DR)

1. Treat migrations as code: versioned, reviewed, linted in CI, and never edited after they ran anywhere shared.
2. Every migration must work with the code that is running now and with the next release (backward compatible).
3. Make breaking changes with expand/contract: add the new thing, migrate code and data, then remove the old thing in a later release.
4. Run additive migrations before the code that needs them; run removals after the code stopped using the old object.
5. Start every DDL migration with a short `lock_timeout` (about 1–10 s) and retry on failure; never let DDL wait in the lock queue.
6. Check for long-running transactions before running DDL on a busy table.
7. Take at most one strong lock per transaction; do not combine several heavy DDL statements or DDL plus a long backfill in one transaction.
8. Add columns as nullable or with a constant default (fast since PG 11); a volatile default rewrites the table.
9. Add `NOT NULL` with `CHECK (...) NOT VALID` + `VALIDATE` + `SET NOT NULL` (any version), or `ADD CONSTRAINT ... NOT NULL col NOT VALID` + `VALIDATE` (PG 18+).
10. Add foreign keys and check constraints as `NOT VALID`, then `VALIDATE CONSTRAINT` in a separate transaction.
11. Create, drop and rebuild indexes with `CONCURRENTLY`, outside a transaction block; clean up `INVALID` indexes after a failure.
12. Add unique constraints and primary keys with `CREATE UNIQUE INDEX CONCURRENTLY` + `ADD CONSTRAINT ... USING INDEX`.
13. Avoid in-place type changes that rewrite the table (for example `int` → `bigint`); use a new column, a sync trigger, a batched backfill, and a swap.
14. Never rename or drop a column or table that running code still uses; with Prisma, use `@map` or `@ignore` to decouple code names from the database.
15. Backfill data in small batches with pauses, outside the schema migration, and watch vacuum and replication lag.
16. Enum values can be added (not used in the same transaction) but not removed; removing one rewrites the table.
17. Prefer roll-forward fixes over down migrations; take a backup / check PITR before risky steps.
18. Test migrations on a production-sized copy and measure lock times; lint them with Squawk in CI.
19. With Prisma Migrate: generate with `--create-only`, edit the SQL, keep Prisma's object names, and know your version's execution mode (one implicit transaction before 7.4.0, one statement at a time from 7.4.0).
20. Run `prisma migrate deploy` from CI/CD on a direct connection (not through a transaction-mode pooler).

---

## 1. Principles

### 1.1 Migrations are code

- Store each migration as a numbered file in git. Review it like code; the reviewer reads the **SQL**, not only the ORM schema diff.
- Never edit a migration that already ran on a shared database. Tools store a checksum; Prisma warns on every `migrate deploy` when an applied migration changed [46].
- Name objects explicitly (constraints, indexes) so later migrations can refer to them.
- Keep one purpose per migration. Small migrations are easier to review, retry and roll forward.

### 1.2 Backward compatibility

During a rolling deploy, old and new application versions run at the same time, and both use the same database. So every schema state must work with **both** versions:

- Adding things (tables, nullable columns, indexes) is compatible.
- Removing or renaming things breaks the old version.
- Making things stricter (`NOT NULL`, new `CHECK`, new `UNIQUE`) breaks any version that still writes invalid data.

### 1.3 Expand / contract (parallel change)

**Parallel change**, also called **expand and contract**, splits a breaking change into three phases [31]:

1. **Expand**: add the new structure next to the old one (new column, new table). Old code keeps working.
2. **Migrate**: deploy code that writes both (or a trigger that syncs them), backfill old rows, then switch reads to the new structure.
3. **Contract**: when no running code uses the old structure, remove it.

Each phase is a separate deploy and can be paused or reverted safely. Prisma's documentation recommends the same pattern for column changes on data in use [44].

### 1.4 Deploy order

| Change | When to run the migration |
|---|---|
| New table, new nullable column, new index, `NOT VALID` constraint | **Before** deploying code that uses it |
| `NOT NULL`, validated `CHECK`/`FOREIGN KEY`, `UNIQUE` that the new code respects | **After** all running code writes valid data (GitLab runs these as "post-deployment" migrations [21]) |
| Drop column, drop table, drop old enum value usage | **After** deploying code that no longer reads or writes it |
| Rename, type change | Expand/contract across two or three deploys |
| Data backfill | After the expand step, before switching reads; as a separate job |

GitLab classifies migrations by timing: regular migrations (run before the deploy, about 3 minutes or less), post-deployment migrations (after the deploy, about 10 minutes or less), and batched background migrations for longer data changes, where each single query stays under 1 second [20].

### 1.5 Separate schema changes from data changes

Schema changes should be fast and take short locks. Data backfills are slow and should run in batches. If you put both in one transaction, the DDL lock stays held for the whole backfill. strong_migrations: "backfilling in the same transaction that alters a table keeps the table locked for the duration of the backfill" [22]. Run backfills as a separate script, job or migration (section 7).

### 1.6 Forward-only versus down migrations

- **Down migrations** (reverse scripts) look safe but rarely are: they cannot restore dropped data, and the database may have changed since. Prisma can generate a down script with `prisma migrate diff`, but it reverts only the schema, not data or custom SQL [48].
- Braintree's `pg_ha_migrations` disallows automatic rollback: schema changes are rolled forward with new migrations [19].
- Practical rule: design each step to be **safe to leave in place** (expand steps are) and fix problems with a new migration. Keep a backup or point-in-time recovery for the rare real disaster ([09](09-operations-and-server-tuning.md)).

### 1.7 Test with production-like data

A migration that is instant on a laptop can take hours on a very large table, or wait a long time behind production traffic. Test on a restored copy of production (or a branch/clone with similar size), measure duration and locks, and test with concurrent load when possible (section 10).

---

## 2. Lock hazards

### 2.1 What blocks what

Most `ALTER TABLE` forms take `ACCESS EXCLUSIVE`, which blocks even plain `SELECT` [1][2]. Some take weaker locks [1]:

| Operation | Lock on the table |
|---|---|
| Most `ALTER TABLE` (add/drop/rename column, set/drop default, set type, set/drop `NOT NULL`, add `CHECK`/`UNIQUE`/`PRIMARY KEY`) | `ACCESS EXCLUSIVE` |
| `ADD FOREIGN KEY` | `SHARE ROW EXCLUSIVE` on **both** tables (blocks writes) |
| `VALIDATE CONSTRAINT` | `SHARE UPDATE EXCLUSIVE` (+ `ROW SHARE` on the referenced table for a foreign key) |
| `SET STATISTICS`, fillfactor/autovacuum storage parameters, `CLUSTER ON` | `SHARE UPDATE EXCLUSIVE` |
| `ATTACH PARTITION` | `SHARE UPDATE EXCLUSIVE` on the parent, `ACCESS EXCLUSIVE` on the attached table and the default partition |
| `DETACH PARTITION` (plain) | `ACCESS EXCLUSIVE` on the parent [7] |
| `DETACH PARTITION ... CONCURRENTLY` (PG 14+) | `SHARE UPDATE EXCLUSIVE` on the parent; `ACCESS EXCLUSIVE` on the partition at the end [1] |
| `CREATE INDEX` | `SHARE` (blocks writes) |
| `CREATE INDEX CONCURRENTLY` | `SHARE UPDATE EXCLUSIVE` |
| `CREATE TRIGGER` | `SHARE ROW EXCLUSIVE` |

A lock is held until the **end of the transaction**. Two consequences:

- A fast `ACCESS EXCLUSIVE` statement is harmless only if the transaction commits right after it.
- Several DDL statements in one transaction accumulate locks; `pg_ha_migrations` disables transactional DDL by default for this reason (multiple exclusive locks held until the end increase blocking and deadlock risk) [19]. GitLab allows only one foreign key per transaction, because each one locks the referenced table too [20].

### 2.2 The lock queue

A DDL statement that waits for its lock blocks every later query on the table, because later requests queue behind it (details in [08](08-transactions-concurrency-locking.md#54-the-lock-queue-effect)) [15][16]. A "1 ms" `ALTER TABLE` waiting behind one slow `SELECT` stops all traffic on the table for as long as the `SELECT` runs. GoCardless lost about 15 seconds of API availability this way [15].

### 2.3 Always set `lock_timeout` (and `statement_timeout`)

With `lock_timeout`, a DDL that cannot get its lock quickly fails with `55P03 lock_not_available` instead of blocking everyone [9]:

```sql
SET lock_timeout = '3s';
SET statement_timeout = '30s';   -- protects against a surprise rewrite or scan
ALTER TABLE orders ADD COLUMN note text;
RESET lock_timeout;
RESET statement_timeout;
```

How long? Pick the longest pause your application can tolerate. Published defaults differ: Squawk suggests `lock_timeout = '1s'` and `statement_timeout = '5s'` [24]; strong_migrations suggests `lock_timeout` 10 seconds and a long `statement_timeout` (1 hour) so that long-but-safe steps can finish [22]; postgres.ai uses values as low as 50 ms with many retries [16]. Use a short `statement_timeout` for steps that must be instant (metadata-only `ALTER TABLE`), and a long or disabled one for steps that are slow by design (`CREATE INDEX CONCURRENTLY`, `VALIDATE CONSTRAINT`, backfills). On PG 17+, also make sure `transaction_timeout` does not kill long index builds; GitLab sets it to 0 together with `statement_timeout` for such steps [20].

Setting timeouts on the role that runs migrations works with every tool and through poolers [22]:

```sql
ALTER ROLE migrator SET lock_timeout = '5s';
ALTER ROLE migrator SET statement_timeout = '0';  -- long steps allowed; add SET per file for fast steps
```

### 2.4 Retry when the lock timeout fires

A lock timeout is not an error in your SQL; it means "busy now". Retry after a short pause [16][24].

Shell loop around a single-statement migration file (`PGOPTIONS` passes the setting to the new session, as in Squawk's example) [16][24]:

```bash
until PGOPTIONS='-c lock_timeout=2s' psql -X -v ON_ERROR_STOP=1 -f add_note_column.sql; do
  echo "lock not available, retrying in 5s"; sleep 5
done
```

(Add a maximum number of attempts in real scripts, and retry only files that are safe to re-run.)

Retry inside the database with a `DO` block, based on postgres.ai's version with exponential backoff and jitter [16]:

```sql
DO $$
DECLARE
  attempt int;
BEGIN
  PERFORM set_config('lock_timeout', '500ms', true);   -- true = only for this transaction
  FOR attempt IN 1..20 LOOP
    BEGIN
      ALTER TABLE orders ADD COLUMN note text;
      RETURN;                                   -- success
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(random() * least(10, 0.05 * 2 ^ attempt));  -- seconds, with jitter
    END;
  END LOOP;
  RAISE EXCEPTION 'could not get the lock after 20 attempts';
END $$;
```

Caveats: each `EXCEPTION` block is a subtransaction, and the whole `DO` block is one transaction that stays open while it sleeps; keep the number of attempts and the total wait moderate [16]. A `DO` block cannot contain `CREATE INDEX CONCURRENTLY`. Ruby tools do the same with helpers: GitLab's `with_lock_retries` [20], strong_migrations' `lock_timeout_retries` [22], `pg_ha_migrations`' `safely_acquire_lock_for_table` (which also checks for long-running queries before each attempt) [19].

### 2.5 Check for long transactions first

Before a DDL on a busy table, check what could block it:

```sql
-- Sessions that touch the table, and the oldest open transactions
SELECT a.pid, a.state, now() - a.xact_start AS xact_age, l.mode, l.granted,
       left(a.query, 80) AS query
FROM pg_locks l
JOIN pg_stat_activity a USING (pid)
WHERE l.relation = 'orders'::regclass
ORDER BY a.xact_start;

SELECT max(now() - xact_start) AS oldest_xact FROM pg_stat_activity
WHERE xact_start IS NOT NULL;
```

postgres.ai suggests treating transactions older than about a minute as a warning sign before deploying DDL [16]. Also watch for an autovacuum running "to prevent wraparound": unlike a normal autovacuum, it is **not** interrupted by a conflicting lock request, so your DDL will wait for it [8].

### 2.6 Pre-flight template

```sql
-- 1. Fail fast instead of queueing
SET lock_timeout = '3s';
-- 2. Limit the step; set to '0' only for steps that are slow by design
SET statement_timeout = '15s';
-- 3. The DDL: one strong lock, committed immediately
ALTER TABLE orders ADD COLUMN note text;
-- 4. Restore session settings for the next file run on the same connection
RESET lock_timeout;
RESET statement_timeout;
```

---

## 3. Cookbook: columns

Each recipe gives the lock, the risk, and the safe way. In all recipes, "with `lock_timeout`" means the pre-flight settings of section 2.6.

### 3.1 Add a column

| Form | Table rewrite? | Notes |
|---|---|---|
| `ADD COLUMN note text` (nullable, no default) | No | Metadata only [1] |
| `ADD COLUMN status text NOT NULL DEFAULT 'new'` (constant default) | No (PG 11+) | The default is stored in the catalog and returned for existing rows [1] |
| `ADD COLUMN imported_at timestamptz DEFAULT now()` | No | `now()` is stable, not volatile: evaluated once, all existing rows get the same value [1] |
| `ADD COLUMN public_id uuid DEFAULT gen_random_uuid()` (also `clock_timestamp()`, `random()`, PG 18 `uuidv7()`) | **Yes** | A volatile default is computed per row: full rewrite under `ACCESS EXCLUSIVE` [1] |
| Identity column, `serial`, stored generated column, domain with constraints | **Yes** | [1][22] |
| `GENERATED ALWAYS AS (...) VIRTUAL` (PG 18+) | No | "Adding a virtual generated column never requires a rewrite" [1]; `VIRTUAL` is the default in PG 18 [71] |
| `ADD COLUMN x text NOT NULL` without a default | Fails if the table has rows | Add nullable, backfill, then 3.2 |

Even the fast forms take `ACCESS EXCLUSIVE` for a moment, so use `lock_timeout`.

Safe recipe for a volatile default:

```sql
-- Migration 1: fast
SET lock_timeout = '3s';
ALTER TABLE documents ADD COLUMN public_id uuid;
ALTER TABLE documents ALTER COLUMN public_id SET DEFAULT gen_random_uuid();  -- new rows only
RESET lock_timeout;
-- Then: backfill old rows in batches (section 7), then add NOT NULL (section 3.2)
```

### 3.2 Add `NOT NULL` to an existing column

**Risk.** `ALTER COLUMN ... SET NOT NULL` scans the whole table while holding `ACCESS EXCLUSIVE` [1].

**Recipe A (all supported versions).** A valid `CHECK (col IS NOT NULL)` lets `SET NOT NULL` skip the scan [1] (this works since PG 12 [25]):

```sql
-- Migration 1: fast (ACCESS EXCLUSIVE for a moment). New writes are checked from now on.
SET lock_timeout = '3s';
ALTER TABLE users ADD CONSTRAINT users_email_not_null CHECK (email IS NOT NULL) NOT VALID;
RESET lock_timeout;

-- (fix or backfill existing NULL rows here)

-- Migration 2: full scan, but only SHARE UPDATE EXCLUSIVE: reads and writes continue
ALTER TABLE users VALIDATE CONSTRAINT users_email_not_null;

-- Migration 3: fast, no scan thanks to the valid CHECK
SET lock_timeout = '3s';
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT users_email_not_null;  -- now redundant
RESET lock_timeout;
```

**Recipe B (PG 18+).** PostgreSQL 18 can add a named not-null constraint as `NOT VALID` and validate it later "without holding access exclusive lock" [10][11]:

```sql
SET lock_timeout = '3s';
ALTER TABLE users ADD CONSTRAINT users_email_not_null NOT NULL email NOT VALID;  -- no scan
RESET lock_timeout;

ALTER TABLE users VALIDATE CONSTRAINT users_email_not_null;  -- scan, SHARE UPDATE EXCLUSIVE
```

Cautions for recipe B:

- Validate with `VALIDATE CONSTRAINT`. Running `ALTER COLUMN ... SET NOT NULL` on a column with an invalid not-null constraint also validates it [1][11], but `SET NOT NULL` takes `ACCESS EXCLUSIVE` for the whole scan.
- While the constraint is invalid, `pg_attribute.attnotnull` is already `true`, so "it's possible that NULL rows are present in the column even when that's set to true" [11]. Tools that read only `attnotnull` (introspection, ORMs) may think the column is already `NOT NULL`. Validate soon after the backfill.

### 3.3 Set or change a default

`ALTER COLUMN ... SET DEFAULT` only changes the catalog; it affects future inserts, not existing rows [1]. It still takes `ACCESS EXCLUSIVE` for a moment.

```sql
SET lock_timeout = '3s';
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'pending';
RESET lock_timeout;
```

Order with code: set the default **before** deploying code that stops sending the value.

### 3.4 Change a column type

Changing the type "will normally cause the entire table and its indexes to be rewritten" under `ACCESS EXCLUSIVE` [1]. Exceptions exist when the old type is binary-compatible with the new one [1]:

| Change | Rewrite? | Index rebuild? |
|---|---|---|
| `varchar(n)` → `varchar(m)`, m > n | No [22] | No |
| `varchar(n)` → `text`, or `text` → `varchar` without length | No [1][22] | No (same collation) [1] |
| `numeric(p,s)` → `numeric(p2,s)` with p2 > p, or → unconstrained `numeric` | No [22] | |
| `timestamp` → `timestamptz` | No only when the session `TimeZone` is UTC [22]; otherwise yes | |
| `cidr` → `inet` | No [22] | |
| Change of collation | No | Yes [1] |
| `int` → `bigint` (and `bigint` → `int`) | **Yes** [30] | Yes |
| `json` → `jsonb`, `text` → `integer`, any `USING` expression that changes values | **Yes** | Yes |
| `text` → `varchar(n)`, or a smaller `varchar(n)` | Not on the safe lists [22]; treat as unsafe and test | |

Tip: to limit length, keep `text` and add `CHECK (length(col) <= n) NOT VALID` + `VALIDATE` instead of changing to `varchar(n)`.

Crunchy Data suggests verifying on a copy: if `pg_relation_filenode('table')` changes after the `ALTER`, the table was rewritten [30].

**Safe recipe for a rewriting change (expand/contract)** — example `events.payload json` → `jsonb`:

```sql
-- Release 1, migration before the deploy (expand): new column + sync trigger
SET lock_timeout = '3s';
ALTER TABLE events ADD COLUMN payload_jsonb jsonb;

CREATE FUNCTION events_sync_payload() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Copy only when the old column was written. (json has no "=" operator,
  -- so the trigger uses UPDATE OF payload instead of comparing OLD and NEW.)
  IF NEW.payload IS NOT NULL THEN
    NEW.payload_jsonb := NEW.payload::jsonb;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER events_sync_payload
  BEFORE INSERT OR UPDATE OF payload ON events
  FOR EACH ROW EXECUTE FUNCTION events_sync_payload();   -- SHARE ROW EXCLUSIVE, short
RESET lock_timeout;

-- Then: backfill in batches (section 7)
--   UPDATE events SET payload_jsonb = payload::jsonb
--   WHERE id >= $1 AND id < $2 AND payload_jsonb IS NULL;
-- Then: indexes CONCURRENTLY and NOT NULL (3.2) on the new column if needed

-- Release 2 (code only): read payload_jsonb, write BOTH columns
-- (pods of release 1 still read payload during the rollout)

-- Release 3, migration before the deploy: the old column must accept NULL
SET lock_timeout = '3s';
ALTER TABLE events ALTER COLUMN payload DROP NOT NULL;   -- only if it was NOT NULL
RESET lock_timeout;
-- Release 3 (code): write payload_jsonb only (with Prisma: @map("payload_jsonb"))

-- Release 3, migration after the deploy (contract)
SET lock_timeout = '3s';
DROP TRIGGER events_sync_payload ON events;
DROP FUNCTION events_sync_payload();
ALTER TABLE events DROP COLUMN payload;
RESET lock_timeout;
```

Renaming `payload_jsonb` back to `payload` at the end is another breaking rename; keep the new name (map it in the ORM) or do one more expand/contract. GitLab ships helpers that automate this pattern (`change_column_type_concurrently`, then a cleanup migration) [21].

### 3.5 Rename a column

`RENAME COLUMN` is instant but breaks every running query that uses the old name. Options:

1. **Do not rename in the database.** If only the name in code is wrong, rename it in the ORM. Prisma's `@map` maps a field name to a different column name, with no migration at all [51].
2. **Expand/contract.** Add the new column, keep both in sync with a trigger, backfill, switch reads and writes, then drop the old column [21][22]:

```sql
-- Expand: users.name -> users.full_name
SET lock_timeout = '3s';
ALTER TABLE users ADD COLUMN full_name text;

CREATE FUNCTION users_sync_full_name() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.full_name := COALESCE(NEW.full_name, NEW.name);
    NEW.name      := COALESCE(NEW.name, NEW.full_name);
  ELSIF NEW.name IS DISTINCT FROM OLD.name THEN         -- old code wrote "name"
    NEW.full_name := NEW.name;
  ELSIF NEW.full_name IS DISTINCT FROM OLD.full_name THEN -- new code wrote "full_name"
    NEW.name := NEW.full_name;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER users_sync_full_name
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_sync_full_name();
RESET lock_timeout;
-- Backfill: UPDATE users SET full_name = name WHERE id >= $1 AND id < $2 AND full_name IS NULL;
-- Deploy code using full_name; then contract: drop trigger, function, and users.name.
```

3. **Views.** Tools such as pgroll and Reshape expose each schema version through views, so a rename is only a different view definition [36][39].

### 3.6 Drop a column

`DROP COLUMN` is fast: it "does not physically remove the column, but simply makes it invisible"; the space is reclaimed as rows are rewritten later [1]. The risk is running code that still reads or writes it.

1. Release 1: stop using the column in code. If the column is `NOT NULL` without a default, first make it nullable (`ALTER COLUMN ... DROP NOT NULL`) or give it a default, or the new code's inserts will fail. With Prisma, mark the field `@ignore` (excluded from Prisma Client, still in the schema, so no `DROP` is generated) [51].
2. Release 2: drop it with `lock_timeout`. Dropping a column also drops indexes and constraints on it; views that use it block the drop unless `CASCADE` (check first).

```sql
SET lock_timeout = '3s';
ALTER TABLE users DROP COLUMN IF EXISTS legacy_flags;
RESET lock_timeout;
```

GitLab spreads this over three releases: ignore the column, drop it in a post-deployment migration, then remove the ignore rule [21]. strong_migrations does the same with `ignored_columns` [22].

### 3.7 Change an `int` primary key to `bigint`

**Why.** `integer` ends at 2,147,483,647 [32]. `ALTER COLUMN id TYPE bigint` rewrites the table and all its indexes under `ACCESS EXCLUSIVE` [1][30]. Prisma's `Int @id @default(autoincrement())` creates a `SERIAL` (integer) column, so large Prisma tables can hit this.

Check how close sequences are to their limit (compare with the column type too):

```sql
SELECT schemaname, sequencename, data_type, last_value, max_value,
       round(100.0 * last_value / max_value, 2) AS pct_used
FROM pg_sequences
WHERE last_value IS NOT NULL
ORDER BY pct_used DESC
LIMIT 20;
```

**Recipe** (summarized from Crunchy Data and GitLab [32][21]; test it on a copy first):

1. Add `id_new bigint` (nullable, no default): fast.
2. Add a `BEFORE INSERT OR UPDATE` trigger `orders_sync_id` (function `orders_sync_id()`) that sets `NEW.id_new := NEW.id`.
3. Backfill `id_new` in batches (section 7).
4. `CREATE UNIQUE INDEX CONCURRENTLY orders_id_new_key ON orders (id_new);`
5. Make `id_new` not null without a long lock (3.2).
6. Convert every referencing column in child tables to `bigint` the same way.
7. Swap in one short transaction:

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';
LOCK TABLE orders IN ACCESS EXCLUSIVE MODE;
ALTER TABLE orders DROP CONSTRAINT orders_pkey;          -- referencing FKs must be dropped first
ALTER TABLE orders RENAME COLUMN id TO id_old;
ALTER TABLE orders RENAME COLUMN id_new TO id;
ALTER TABLE orders ALTER COLUMN id_old DROP DEFAULT;
ALTER TABLE orders ALTER COLUMN id SET DEFAULT nextval('orders_id_seq');
ALTER SEQUENCE orders_id_seq AS bigint OWNED BY orders.id; -- re-own, or DROP COLUMN id_old drops it
ALTER TABLE orders ADD CONSTRAINT orders_pkey PRIMARY KEY USING INDEX orders_id_new_key;
DROP TRIGGER orders_sync_id ON orders;   -- its function refers to the old column names
DROP FUNCTION orders_sync_id();
COMMIT;
```

8. Recreate the foreign keys with `NOT VALID` + `VALIDATE` (4.1); later drop `id_old` and the helper `CHECK`.

`ADD PRIMARY KEY USING INDEX` needs the column to be `NOT NULL`; with the valid `CHECK (id IS NOT NULL)` from step 5 this does not scan [1]. Identity columns own their sequence through the identity; adapt the default/sequence steps. Crunchy Data notes that the full procedure "demands coordination with the entire database" because of foreign keys [32].

---

## 4. Cookbook: constraints

### 4.1 Add a foreign key

**Risk.** `ADD FOREIGN KEY` takes `SHARE ROW EXCLUSIVE` on both tables and scans the child table to validate existing rows; writes to both tables wait [1]. (Older articles say `ACCESS EXCLUSIVE`; that described old PostgreSQL versions [15].)

```sql
-- Migration 1: fast, no scan. New rows are checked from now on.
SET lock_timeout = '3s';
ALTER TABLE order_items
  ADD CONSTRAINT order_items_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders (id) NOT VALID;
RESET lock_timeout;

-- Migration 2 (separate transaction): scan with SHARE UPDATE EXCLUSIVE on order_items
-- and ROW SHARE on orders; normal reads and writes continue [1]
ALTER TABLE order_items VALIDATE CONSTRAINT order_items_order_id_fkey;
```

Also index the referencing column (`CREATE INDEX CONCURRENTLY order_items_order_id_idx ON order_items (order_id)`): PostgreSQL does not create it automatically, and deletes on the parent scan the child table [72]. Add only one foreign key per transaction [20].

### 4.2 Add a `CHECK` constraint

Same two steps [1][22]:

```sql
SET lock_timeout = '3s';
ALTER TABLE orders ADD CONSTRAINT orders_total_nonnegative CHECK (total >= 0) NOT VALID;
RESET lock_timeout;

ALTER TABLE orders VALIDATE CONSTRAINT orders_total_nonnegative;
```

`NOT VALID` is also useful when old rows are known to violate the rule: new violations are blocked at once, and old rows can be fixed before validation [1]. PG 18 also adds `NOT ENFORCED` `CHECK` and foreign key constraints, which are never checked [10]; they document intent but do not protect data.

### 4.3 Add a unique constraint or primary key

**Risk.** `ADD CONSTRAINT ... UNIQUE` builds the index while holding `ACCESS EXCLUSIVE` [28].

```sql
-- Step 1: build the index without blocking writes (must run outside a transaction block)
CREATE UNIQUE INDEX CONCURRENTLY users_email_key ON users (email);

-- Step 2: attach it as a constraint (fast; the index is renamed to the constraint name)
SET lock_timeout = '3s';
ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE USING INDEX users_email_key;
RESET lock_timeout;
```

Rules for `USING INDEX` [1]: b-tree, default sort order, no expressions, not partial; not supported on partitioned tables. For `PRIMARY KEY USING INDEX`, columns that are not yet `NOT NULL` get a `SET NOT NULL`, which scans the table unless a valid `CHECK (col IS NOT NULL)` exists (3.2).

Do you need step 2? A unique index alone already enforces uniqueness, works as an `ON CONFLICT` arbiter, and can be the target of a foreign key ("columns from a non-partial unique index") [72]. Prisma itself models `@unique` as a unique index [58].

If existing rows contain duplicates, step 1 fails and leaves an `INVALID` index that **still enforces uniqueness** for new writes [3]. Drop it (`DROP INDEX CONCURRENTLY`), clean the duplicates, retry.

### 4.4 Exclusion constraints

Exclusion constraints cannot be added as `NOT VALID`; adding one blocks reads and writes while every row is checked [22]. Create them when the table is new or small, or plan a maintenance window.

---

## 5. Cookbook: indexes

Index types and design are in [05-indexing.md](05-indexing.md). This section covers only how to change indexes safely.

### 5.1 Create an index

```sql
-- Bad on a live table: SHARE lock blocks all writes for the whole build
CREATE INDEX orders_user_id_idx ON orders (user_id);

-- Good: writes continue
CREATE INDEX CONCURRENTLY orders_user_id_idx ON orders (user_id);
```

Rules for `CREATE INDEX CONCURRENTLY` [3]:

- It cannot run inside a transaction block (and so not inside a multi-statement string; see [08](08-transactions-concurrency-locking.md#12-autocommit-and-explicit-transactions)).
- It scans the table twice and waits for older transactions; it takes longer than a normal build and adds load.
- Only one concurrent index build per table at a time; it conflicts with `VACUUM` and DDL on the same table (`SHARE UPDATE EXCLUSIVE`).
- On failure (deadlock, duplicate key, cancel, timeout) it leaves an `INVALID` index that is ignored by queries but still costs write time. Drop it and retry, or rebuild with `REINDEX INDEX CONCURRENTLY` [3].
- It keeps a snapshot while it runs, so a very long build holds back vacuum's xmin horizon. PostgreSQL 14.0 shipped an optimization that avoided this; it was reverted in 14.4 because it could miss rows, and indexes built concurrently on 14.0–14.3 should be rebuilt [17].
- `statement_timeout` (and `transaction_timeout` on PG 17+) must allow the full build [20].
- `IF NOT EXISTS` is convenient for retries, but it also skips an existing **invalid** index with the same name. Check validity after the build.

Find invalid indexes and watch progress:

```sql
SELECT indexrelid::regclass AS index_name, indrelid::regclass AS table_name
FROM pg_index
WHERE NOT indisvalid;

SELECT pid, relid::regclass AS table_name, index_relid::regclass AS index_name, phase,
       blocks_done, blocks_total, lockers_done, lockers_total
FROM pg_stat_progress_create_index;   -- phases include 'waiting for old snapshots' [73]
```

**Partitioned tables.** `CREATE INDEX CONCURRENTLY` is not supported on the partitioned parent [3]. Create the parent index with `ON ONLY` (it starts invalid), build each partition's index concurrently, then attach them; the parent index becomes valid when every partition has one [7]:

```sql
CREATE INDEX measurement_unitsales_idx ON ONLY measurement (unitsales);
CREATE INDEX CONCURRENTLY measurement_y2026m10_unitsales_idx ON measurement_y2026m10 (unitsales);
ALTER INDEX measurement_unitsales_idx ATTACH PARTITION measurement_y2026m10_unitsales_idx;
-- repeat for each partition
```

### 5.2 Drop an index

```sql
DROP INDEX CONCURRENTLY IF EXISTS orders_status_idx;
```

Limits [4]: one index per statement; no `CASCADE`, so it cannot drop an index that backs a `UNIQUE` or `PRIMARY KEY` constraint; not in a transaction block; not for indexes on partitioned tables. A plain `DROP INDEX` takes `ACCESS EXCLUSIVE` on the table [4].

### 5.3 Rebuild an index

```sql
REINDEX INDEX CONCURRENTLY orders_user_id_idx;
```

`REINDEX CONCURRENTLY` takes `SHARE UPDATE EXCLUSIVE` and lets writes continue; plain `REINDEX` blocks writes and blocks queries that use the index [5]. If it fails, it leaves an invalid index whose name ends in `_ccnew` (drop it and retry) or `_ccold` (the rebuild worked; just drop the old one) [5]. It cannot run in a transaction block and skips exclusion-constraint indexes [5].

---

## 6. Cookbook: tables, enums, partitions, rewrites

### 6.1 Rename a table

Renaming breaks running code. Either use expand/contract (new table, dual writes, backfill, switch, drop) [22], or keep the old name alive with a view for one release:

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE customer RENAME TO customers;
CREATE VIEW customer AS SELECT * FROM customers;   -- simple view: automatically updatable
COMMIT;
-- deploy code that uses "customers"; next release: DROP VIEW customer;
```

Simple single-table views accept `INSERT`, `UPDATE`, `DELETE` and (PG 17+) `MERGE` [74]. A `SELECT *` view keeps the column list from creation time; columns added later are not visible through it [74]. With Prisma, `@@map` can keep the model name while the table name changes [51].

### 6.2 Drop a table

1. Remove all code that reads or writes the table; deploy.
2. Drop the foreign keys that reference it, one per migration, with `lock_timeout` and retries [21].
3. Optional safety net: rename it first (`ALTER TABLE invoices_old RENAME TO invoices_old_deprecated;`) and wait some days; a rename is easy to undo.
4. `DROP TABLE` with `lock_timeout` (`ACCESS EXCLUSIVE`) [2].

### 6.3 Enum changes

| Change | How | Risk |
|---|---|---|
| Add a value | `ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'refunded' AFTER 'paid';` | Fast. Inside a transaction block, the new value "cannot be used until after the transaction has been committed" [6]: put it in its own migration, before any migration or code that uses it. |
| Rename a value | `ALTER TYPE ... RENAME VALUE` | Fast, but running code still sends the old label. Use expand/contract: add the new value, update code, backfill, stop using the old one [22]. |
| Remove a value | Not supported | Requires a new type and `ALTER COLUMN ... TYPE new_type USING col::text::new_type`: a table rewrite under `ACCESS EXCLUSIVE`. Prisma generates exactly this pattern when you remove an enum value [58]. Often better: leave the old value unused. |

If the set of values changes often, prefer `text` with a `CHECK (status IN (...))` constraint (replace it with `NOT VALID` + `VALIDATE`) or a lookup table with a foreign key ([07](07-schema-design-and-patterns.md)).

### 6.4 Convert a big table to a partitioned table

"It is not possible to turn a regular table into a partitioned table" [7]. But an existing table can become a **partition** of a new partitioned table [7]. Outline (based on the PostgreSQL docs and the pg_partman online method [7][35]), for `orders` partitioned by `created_at`, with boundary `B` = a date a few days in the future:

1. Create `orders_p` (`PARTITION BY RANGE (created_at)`) with the same columns, defaults (including `nextval('orders_id_seq')`), and a primary key that includes the partition key, for example `(id, created_at)`. Unique constraints on a partitioned table must include all partition columns [35].
2. Create partitions for `[B, B + 1 month)` and later.
3. On the old table, prepare everything that `ATTACH` would otherwise build or scan under lock:
   - the old table must already have every `NOT NULL` and `CHECK` constraint of the new parent [1] (so `created_at` must be `NOT NULL`: recipe 3.2);
   - every index of the new parent must already exist on the old table, built `CONCURRENTLY` (for example `CREATE UNIQUE INDEX CONCURRENTLY orders_id_created_at_key ON orders (id, created_at);`, attached as a constraint with `USING INDEX` if the parent has the matching constraint). A valid equivalent index is reused by `ATTACH`; a missing one is built while the lock is held [1];
   - `ALTER TABLE orders ADD CONSTRAINT orders_before_b CHECK (created_at IS NOT NULL AND created_at < 'B') NOT VALID;` then `VALIDATE CONSTRAINT` (a valid `CHECK` lets `ATTACH` skip its scan) [1][7].
   - Rehearse the swap on a copy and confirm that the `ATTACH` finishes instantly.
4. Swap in one short transaction with `lock_timeout`: rename `orders` → `orders_legacy`, rename `orders_p` → `orders`, then `ALTER TABLE orders ATTACH PARTITION orders_legacy FOR VALUES FROM (MINVALUE) TO ('B');` (`SHARE UPDATE EXCLUSIVE` on the parent, `ACCESS EXCLUSIVE` on `orders_legacy`) [1].
5. Later, move old rows into proper partitions in batches if needed, or keep the legacy partition and detach it when the data expires (`DETACH PARTITION ... CONCURRENTLY`, PG 14+).

Hard parts: foreign keys that **reference** the old table must be recreated against the partitioned table, whose key now includes `created_at`; pg_partman's author knows no method without an outage for incoming foreign keys [35]. Grants, triggers, views and the ORM model must follow the rename. pg_partman's alternative attaches the old table as the `DEFAULT` partition and moves rows out with `partition_data_proc` [35]. PG 19 had planned `MERGE PARTITIONS`/`SPLIT PARTITIONS` commands, but they were reverted in beta 4 [14]. Partition design itself is covered in [07](07-schema-design-and-patterns.md).

### 6.5 Large rewrites without long locks

`VACUUM FULL` and `CLUSTER` rewrite a table under `ACCESS EXCLUSIVE` for the whole run [2]. Online alternatives (to remove bloat or re-order rows; they do not change column types):

| Tool | How it works | Locks | Requirements |
|---|---|---|---|
| pg_repack (extension) | Copies the table, tracks changes with triggers, swaps | `ACCESS EXCLUSIVE` only briefly at the start and at the final swap; `SHARE UPDATE EXCLUSIVE` otherwise [33] | Primary key or unique index on `NOT NULL` columns; superuser or owner; supports PG 9.5–19 [33] |
| pg_squeeze (extension, Cybertec) | Copies the table, captures changes with logical decoding, background worker | Exclusive lock only to finish; `squeeze.max_xlock_time` limits it [34] | `wal_level = logical`; identity index (primary key or replica identity) [34] |
| `REPACK (CONCURRENTLY)` (PG 19, beta — may change) | New built-in command that replaces `VACUUM FULL` and `CLUSTER` [12]; logical decoding captures changes during the copy | `ACCESS EXCLUSIVE` only briefly to swap files [13] | Primary key or index-based replica identity; not partitioned or unlogged; not in a transaction block; a free slot in `max_repack_replication_slots` [13] |
| Logical replication to a new table or cluster | Copy + stream changes, then switch | Short cutover | See [09](09-operations-and-server-tuning.md) |

All of them need free disk space for a full copy of the table and its indexes [13][33].

---

## 7. Backfills

### 7.1 Rules

1. **Separate job.** Do not backfill in the transaction that changes the schema [22]. Use a script, a job, or a migration that runs outside a transaction.
2. **Small batches, committed one by one.** Each statement should be short; GitLab requires single queries in background migrations to stay under 1 second [20].
3. **Throttle.** Sleep between batches so the primary, autovacuum and replicas keep up [22].
4. **Idempotent and resumable.** Use `WHERE new_col IS NULL` and key ranges, so a restart does not redo or break work.
5. **Keep new rows correct** during the backfill with a default or a sync trigger (section 3.4).
6. **Watch** dead tuples, replication lag and I/O; run `VACUUM (ANALYZE)` on the table after a large backfill.

### 7.2 Batch by primary-key range

Key ranges keep each batch cheap; a `WHERE new_col IS NULL ... LIMIT` scan gets slower as the backfill progresses because it re-reads finished rows.

From the application (node-postgres):

```ts
// Backfill users.email_normalized in batches of 5,000 ids. Each query autocommits.
const { rows: [r] } = await pool.query('SELECT min(id) AS min_id, max(id) AS max_id FROM users');
for (let start = Number(r.min_id); start <= Number(r.max_id); start += 5_000) {
  await pool.query(
    `UPDATE users SET email_normalized = lower(email)
     WHERE id >= $1 AND id < $2 AND email_normalized IS NULL`,
    [start, start + 5_000],
  );
  await new Promise((resolve) => setTimeout(resolve, 100)); // throttle
}
```

Inside the database, a procedure can commit after each batch (transaction control works only when the procedure is called at top level, not inside an explicit transaction block) [43]:

```sql
CREATE PROCEDURE backfill_users_email_normalized(batch_size int DEFAULT 5000)
LANGUAGE plpgsql AS $$
DECLARE
  next_id bigint;
  last_id bigint;
BEGIN
  SELECT min(id), max(id) INTO next_id, last_id FROM users;
  WHILE next_id <= last_id LOOP
    UPDATE users SET email_normalized = lower(email)
    WHERE id >= next_id AND id < next_id + batch_size
      AND email_normalized IS NULL;
    COMMIT;                                   -- one transaction per batch
    PERFORM pg_sleep_for('100 milliseconds');
    next_id := next_id + batch_size;
  END LOOP;
END $$;

CALL backfill_users_email_normalized();
DROP PROCEDURE backfill_users_email_normalized(int);
```

---

## 8. Tools

The full tool catalog is in [13-tools-by-use-case.md](13-tools-by-use-case.md). This section covers what matters for zero-downtime work.

### 8.1 Tools that automate expand/contract

| Tool | How it works | Status (checked 2026-10) |
|---|---|---|
| **pgroll** (Xata) | Each migration (JSON/YAML operations) creates a new versioned schema made of **views** over the real tables. Breaking column changes create a new column, backfill it, and keep old and new in sync with triggers. `pgroll start` exposes both versions; clients choose one with `search_path`; `pgroll complete` removes the old version; rollback is instant [36]. Uses `lock_timeout` 500 ms by default (`--lock-timeout`) and batched backfills (`--backfill-batch-size`, default 1000; `--backfill-batch-delay`) [37]. `pgroll convert` turns SQL generated by ORMs (Drizzle, Alembic, Django examples) into pgroll operations [38]. | Active, Apache-2.0, release v0.16.3 (2026-09); works with PostgreSQL 14+ [36] |
| **Reshape** | Same idea: views encapsulate tables, triggers translate writes between old and new schema; `reshape migration start` / `complete` / `abort` [39]. | Active, release v0.11.2 (2026-09); designed for PostgreSQL 12+ [39] |

Trade-offs: the application must connect through the versioned schema (set `search_path` per deployment), every migration is written in the tool's format instead of plain SQL, and triggers add write overhead during the migration window. They fit teams that deploy often and want automatic expand/contract; for an ORM-driven project, the manual recipes above are usually enough.

### 8.2 Migration runners and transactions

What matters for zero downtime is whether the runner wraps migrations in a transaction, and how you opt out for `CONCURRENTLY` statements.

| Tool | Default transaction behavior | How to run `CREATE INDEX CONCURRENTLY` |
|---|---|---|
| Prisma Migrate 7 | Depends on version (section 9.1) | Section 9.4 |
| Drizzle (`drizzle-orm` migrator used by `drizzle-kit migrate`) | All pending migrations run inside **one** transaction (PostgreSQL migrator source) [62] | Not possible in that run; execute it separately |
| node-pg-migrate | One shared transaction for the run by default; `--no-single-transaction` runs each migration in its own [64] | `pgm.noTransaction()` in that migration [64] |
| graphile-migrate | One transaction per migration | `--! no-transaction` header; the file must then contain exactly one statement [65] |
| dbmate | "Migrations are run atomically inside a transaction" [63] | `-- migrate:up transaction:false` [63] |
| Flyway | Transaction per migration | Script config `executeInTransaction=false` [66] |
| Liquibase | Transaction per changeset | `runInTransaction="false"` on the changeset [68] |
| Sqitch | The default PostgreSQL deploy template wraps the script in `BEGIN;` ... `COMMIT;` [67] | Remove the `BEGIN`/`COMMIT` in that script |
| Atlas | `--tx-mode file` (one transaction per file) by default; also `all` and `none` [42] | `-- atlas:txmode none` directive in the file [42] |

### 8.3 Migration linters

Linters read the SQL and flag dangerous statements before they reach production. They do not know your table sizes or traffic: a passing lint is necessary, not sufficient. Squawk says it directly: "A migration that passes Squawk's lint is not automatically safe to run" [24].

**Squawk** (CLI `squawk`, npm `squawk-cli`, GitHub Action; active, v2.67.0 on 2026-10-04) [23][29]. Key rules [23]:

| Rule | Flags |
|---|---|
| `require-concurrent-index-creation` / `require-concurrent-index-deletion` | `CREATE`/`DROP INDEX` without `CONCURRENTLY` |
| `ban-concurrent-index-creation-in-transaction` | `CONCURRENTLY` inside a transaction (it would fail) |
| `constraint-missing-not-valid` | `ADD CONSTRAINT` (check / foreign key) without `NOT VALID` |
| `adding-foreign-key-constraint` | Foreign key added in a way that blocks writes |
| `disallowed-unique-constraint` | `ADD CONSTRAINT ... UNIQUE` without `USING INDEX` [28] |
| `adding-not-nullable-field` | `SET NOT NULL` that scans under `ACCESS EXCLUSIVE` [25] |
| `adding-required-field` | New `NOT NULL` column without a default |
| `adding-field-with-default` | Default that causes a rewrite (volatile), generated columns [27] |
| `adding-serial-primary-key-field` | Adding a `serial` primary key (rewrite) |
| `changing-column-type` | `ALTER COLUMN ... TYPE` |
| `renaming-column`, `renaming-table` | Renames that break running code |
| `ban-drop-column`, `ban-drop-table`, `ban-drop-not-null`, `ban-drop-database` | Destructive or client-breaking changes |
| `require-lock-timeout`, `require-statement-timeout` (formerly `require-timeout-settings`) | Missing `SET lock_timeout` / `statement_timeout` in the file [75] |
| `prefer-robust-stmts` | Missing `IF [NOT] EXISTS`, so a partly applied migration cannot be retried [26] |
| `transaction-nesting`, `ban-uncommitted-transaction` | Broken `BEGIN`/`COMMIT` structure |
| `prefer-bigint-over-int`, `prefer-identity`, `prefer-text-field`, `prefer-timestamptz` | Schema style defaults |

Useful flags: `--pg-version` and `--assume-in-transaction` ("Assume that a transaction will wrap each SQL file when run by a migration tool") [29]. For Prisma 7.4+ files do not use `--assume-in-transaction`; for older Prisma versions do.

**strong_migrations** (Ruby on Rails gem). Not usable in a Node project, but its README is one of the best lists of dangerous operations with safe alternatives: removing, renaming or changing the type of a column; renaming a table; adding auto-increment or stored generated columns; non-concurrent indexes; references; foreign keys; check, unique and exclusion constraints; `json` columns; volatile defaults; `SET NOT NULL`; renaming enum values; backfilling [22].

**Atlas lint** (`atlas migrate lint`) groups checks as destructive (DS1xx), data-dependent (MF1xx), backward-incompatible (BC1xx) and PostgreSQL-specific; the concurrent-index (PG101–PG105, PG108, PG109) and blocking-change (PG301–PG320) analyzers are marked Pro (paid) [41].

**eugene** (Rust CLI; active, 0.8.3 on 2026-03-11) has two modes: `eugene lint` analyzes SQL syntax trees without a database, and `eugene trace` runs the migration in a transaction on a temporary PostgreSQL, records the locks it takes, then rolls back [40].

---

## 9. Applying the recipes with Prisma Migrate

This project uses Prisma Migrate (Prisma ORM 7) with plain `migration.sql` files, and node-postgres at runtime. Prisma generates correct SQL, but not zero-downtime SQL: it creates indexes without `CONCURRENTLY`, validates foreign keys immediately, and does not set timeouts. You fix that by editing the generated file before it is applied.

### 9.1 How Prisma runs a `migration.sql` (version matters)

Prisma's v7 documentation does not describe transaction behavior for PostgreSQL migrations; the engine's design notes say Migrate does not wrap migrations in a transaction by default [59]. What actually happens, from the engine source and GitHub issues:

| Prisma version | How the file is sent | Consequences |
|---|---|---|
| Up to 7.3.x (the 6.19.x patch releases do not mention the change) | The whole file as one simple-query message | PostgreSQL runs a multi-statement message as one implicit transaction [18]: the file is all-or-nothing. Statements that cannot run in a transaction block (`CREATE/DROP INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, `VACUUM`) fail with `P3018` unless they are the **only** statement in the file [52][53]. |
| 7.4.0 and later (Feb 2026) | The engine splits the file into statements with a SQL parser and sends them **one by one** on the same connection [54][56] | `CONCURRENTLY` works next to other statements. Each statement **autocommits**: if statement 3 fails, statements 1–2 stay applied. Wrap statements that must be atomic in your own `BEGIN; ... COMMIT;`. If the parser cannot parse the file, the engine falls back to sending the whole file at once (old behavior) [54]. |
| 7.8.0 and later | Same splitting also for the shadow-database replay used by `migrate dev` [55][57] | Before 7.8.0, `migrate dev` could fail with `P3006` ("CREATE INDEX CONCURRENTLY cannot run inside a transaction block") on a migration with several concurrent index statements, even though `migrate deploy` worked [55]. |

Check the version with `npx prisma --version` and write migrations for the version you run. Files written as "one risky statement per migration" work the same in every version.

### 9.2 Workflow: generate, edit, apply

```bash
# 1. Edit schema.prisma, then create the migration WITHOUT applying it
npx prisma migrate dev --create-only --name add_order_user_id_index

# 2. Edit prisma/migrations/<timestamp>_add_order_user_id_index/migration.sql

# 3. Apply locally; migrate dev first replays the history in the shadow database
npx prisma migrate dev

# 4. Commit schema.prisma and the whole prisma/migrations folder (with migration_lock.toml)
# 5. Production (CI/CD): apply pending migrations
npx prisma migrate deploy
```

Sources: `--create-only` creates a migration without applying it [49][44]; the migrations folder must be committed, and applied migrations must not be edited or deleted [46]. In Prisma 7, `migrate dev` no longer runs `prisma generate` or seeds automatically, and the CLI reads the database URL from `prisma.config.ts` [49].

Rules for edits:

- **Keep Prisma's object names** (for example `"Order_userId_idx"`, `"OrderItem_orderId_fkey"`, `"User_email_key"`). Change *how* the object is created, not *what* is created; otherwise the next `migrate dev` sees a difference and generates a rename or a drop.
- Keep the final schema identical to what `schema.prisma` describes. After hand-written steps, run `npx prisma migrate dev --create-only` again: if Prisma wants to generate another migration, the SQL and the schema disagree.
- Never edit a migration after it ran on a shared database: `migrate deploy` warns on every run and `migrate dev` asks to reset [46].

Generating a migration without a database (no shadow database needed): extract the previous commit's schema folder to a temporary directory (`git archive HEAD prisma | tar -x -C <tmp>`), then run `npx prisma migrate diff --from-schema <tmp>/prisma --to-schema prisma/ --script` and save the output as `prisma/migrations/<YYYYMMDDHHMMSS>_<snake_name>/migration.sql`. Record that method in the file's banner. Applying and checking for drift (`migrate dev`, `migrate status`) still need a database.

### 9.3 Timeouts in Prisma migrations

**Option A (recommended): role-level settings** for the role that runs `migrate deploy`. It works with every Prisma version, every file layout, and poolers [22]:

```sql
CREATE ROLE prisma_migrator LOGIN PASSWORD '...';   -- plus the privileges it needs
ALTER ROLE prisma_migrator SET lock_timeout = '5s';
ALTER ROLE prisma_migrator SET statement_timeout = '0';   -- long steps (CIC, VALIDATE) allowed
```

**Option B: settings inside the file.** Put `SET` at the top and `RESET` at the end. A session `SET` stays active on the connection, so without `RESET` it also applies to the next migrations of the same `migrate deploy` run [53]:

```sql
SET lock_timeout = '3s';
SET statement_timeout = '15s';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "note" TEXT;

RESET lock_timeout;
RESET statement_timeout;
```

Before 7.4 the whole file is one transaction, so the `SET` is undone if the migration fails [18][70]; from 7.4 each statement runs on its own and the `SET` stays until `RESET` or the end of the session.

**Option C: explicit transaction with `SET LOCAL`** for statements that must be atomic:

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE "Order" ADD COLUMN "currency" TEXT;                 -- existing rows stay NULL
ALTER TABLE "Order" ALTER COLUMN "currency" SET DEFAULT 'EUR';  -- new rows get 'EUR'
COMMIT;
```

Both statements are fast catalog changes; the block makes them atomic, and `SET LOCAL` ends with the transaction [70]. Do not put `CONCURRENTLY` statements inside such a block.

### 9.4 `CREATE INDEX CONCURRENTLY` with Prisma

For `@@index([userId])`, Prisma generates a blocking build:

```sql
-- CreateIndex
CREATE INDEX "Order_userId_idx" ON "Order"("userId");
```

Edit it (same name):

```sql
-- CreateIndex
CREATE INDEX CONCURRENTLY "Order_userId_idx" ON "Order"("userId");
```

- **Prisma 7.4+**: this can sit next to other statements, outside any `BEGIN`/`COMMIT` block [54]. Use 7.8+ if `migrate dev` must replay files with several concurrent indexes [55].
- **Before 7.4**: the file must contain only this statement; create one migration per index (run `--create-only`, edit, apply, repeat) [52].
- `@unique` / `@@unique` generate `CREATE UNIQUE INDEX "..._key"`; add `CONCURRENTLY` the same way and keep it an index (Prisma models it as an index; a unique index is enough for uniqueness, `ON CONFLICT` and foreign keys [72]).
- Set a long enough `statement_timeout` for the build (Option A or B).
- If the build fails, the migration is marked failed **and** an `INVALID` index remains. Drop it (`DROP INDEX CONCURRENTLY "Order_userId_idx";`), mark the migration rolled back, and deploy again (9.7) [3][47].
- A tip from the community for very large tables: build the index by hand with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` before the deploy; the migration then contains the same `IF NOT EXISTS` statement and finishes instantly, while fresh databases (CI, local) still get the index [52]. Verify that the hand-built index is valid first.

### 9.5 What Prisma generates, and the safe edit

| Schema change | Prisma generates (PostgreSQL) | Risk | Safe edit |
|---|---|---|---|
| New optional field | `ALTER TABLE "T" ADD COLUMN "c" TEXT;` | Short `ACCESS EXCLUSIVE` | Add timeouts (9.3) |
| New required field with a constant default or `@default(now())` | `ADD COLUMN ... NOT NULL DEFAULT ...` (`now()` becomes `DEFAULT CURRENT_TIMESTAMP` [58]) | Fast (non-volatile default, PG 11+) | Add timeouts |
| New required field without default | `ADD COLUMN ... NOT NULL` | Fails on a non-empty table [47] | Optional field → backfill → `NOT NULL` (3.2), over several migrations |
| Optional → required | `ALTER COLUMN "c" SET NOT NULL` | Full scan under `ACCESS EXCLUSIVE` | Recipe 3.2 |
| `@@index`, `@unique` | `CREATE [UNIQUE] INDEX "..." ON ...` [58] | Blocks writes during the build | `CONCURRENTLY` (9.4) |
| New relation | `ALTER TABLE ... ADD CONSTRAINT "..._fkey" FOREIGN KEY ... ON DELETE ... ON UPDATE ...` [58] | Validation blocks writes on both tables | Append `NOT VALID`; `VALIDATE CONSTRAINT` in the **next** migration (4.1) |
| Field type change | `ALTER COLUMN "c" SET DATA TYPE ...` [58] | Usually a rewrite under `ACCESS EXCLUSIVE` | Expand/contract (3.4) |
| Renamed field | `DROP COLUMN` + `ADD COLUMN` (data loss!) [44] | Data loss | `@map("old_name")`, or `RENAME COLUMN` with expand/contract (3.5) |
| Removed field | `DROP COLUMN` | Breaks running old code | `@ignore` first, drop in a later release (3.6) |
| Enum value added | `ALTER TYPE "E" ADD VALUE '...'` [58] | Unusable in the same transaction | Own migration, before its first use |
| Enum value removed | `BEGIN; CREATE TYPE "E_new" ...; ALTER TABLE ... ALTER COLUMN ... TYPE "E_new" USING (...::text::"E_new"); ...; COMMIT;` [58] | Table rewrite under `ACCESS EXCLUSIVE` | Avoid; keep the value or move to `text` + `CHECK` |

Why the foreign key validation goes in the **next** migration: before Prisma 7.4, `ADD ... NOT VALID` and `VALIDATE` in the same file would run in one implicit transaction, and the `SHARE ROW EXCLUSIVE` lock from the first statement would be held during the whole validation scan.

```sql
-- Migration A (edited): 20261005090000_add_order_item_order_fk/migration.sql
SET lock_timeout = '3s';
-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
RESET lock_timeout;

-- Migration B (hand-written, created with --create-only on an unchanged schema)
ALTER TABLE "OrderItem" VALIDATE CONSTRAINT "OrderItem_orderId_fkey";
```

### 9.6 Expand/contract with Prisma: a rename example

Goal: rename column `users.name` to `full_name` without downtime.

```prisma
// Release 1 (expand): add the new field; the old field stays but becomes optional
model User {
  id       Int     @id @default(autoincrement())
  name     String?                      // was: String (DROP NOT NULL is a fast catalog change)
  fullName String? @map("full_name")
  @@map("users")
}
```

Generate with `--create-only`, then add the sync trigger from 3.5 to the migration. Making `name` optional lets Prisma Client create users without it; the trigger still fills it for old application instances. Order: deploy the migration, backfill old rows (section 7), then deploy the code that reads and writes `fullName`.

```prisma
// Release 2: code reads and writes fullName only; hide the old field from Prisma Client
model User {
  id       Int     @id @default(autoincrement())
  name     String? @ignore
  fullName String? @map("full_name")
  @@map("users")
}
```

`@ignore` removes the field from Prisma Client but keeps it in the schema, so Migrate does not drop it; a required field without default would disable `create`, so it stays optional [51].

```prisma
// Release 3 (contract): remove the field; Prisma generates DROP COLUMN "name"
model User {
  id       Int     @id @default(autoincrement())
  fullName String? @map("full_name")
  @@map("users")
}
```

Edit the release 3 migration to drop the trigger and function before the column. If you only wanted a better name in code, skip all of this: `name String @map("name")` → `fullName String @map("name")` changes nothing in the database [51].

### 9.7 Failed migrations

- `migrate deploy` stops with `P3018` ("A migration failed to apply"); later runs stop with `P3009` ("migrate found failed migrations in the target database") until you resolve it [69].
- Read the error in the `logs` column of `_prisma_migrations` [47]. With Prisma 7.4+, check which statements of the file were already applied (they autocommitted).
- Then either [47]:
  - undo the partial changes (and drop any `INVALID` index), run `npx prisma migrate resolve --rolled-back <migration_name>`, fix the cause, and run `migrate deploy` again; or
  - finish the remaining statements by hand and run `npx prisma migrate resolve --applied <migration_name>`.
- Make files easy to retry: one risky statement per file, `IF NOT EXISTS` / `IF EXISTS` guards (Squawk `prefer-robust-stmts`) [26].
- A `lock_timeout` failure is the easy case: the failed statement changed nothing. Resolve as rolled back and deploy again later.

### 9.8 Deploying with Prisma

- Run `prisma migrate deploy` from CI/CD, not from a laptop [45]. It applies pending migrations, warns about modified ones, and does not detect drift or use a shadow database [45].
- It takes a session advisory lock (`pg_advisory_lock(72707369)`) so two deploys cannot run at once; the wait has a 10-second timeout that cannot be configured [45][60]. `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK` (since 5.3.0) disables it [45]; use that only if you can guarantee a single migration runner.
- Use a **direct** connection for Migrate, not a transaction-mode pooler: through PgBouncer it can fail with `prepared statement "s0" already exists` [50], and session-level advisory locks and `SET` do not work in transaction pooling ([08](08-transactions-concurrency-locking.md#76-advisory-locks)). In Prisma 7, set the URL used by the CLI in `prisma.config.ts` [49].
- Order: run `migrate deploy` (expand steps) before the new application version starts; put contract steps (drops, `NOT NULL`, validations that need new code) in a later release.

### 9.9 Heads-up: Prisma 8

Prisma 8 is a release candidate (v8.0.0-rc.14 on 2026-09-30). Its documentation describes TypeScript migration files and states that "one `npx prisma db migrate` run on PostgreSQL is one transaction, so `rawSql` cannot run `CREATE INDEX CONCURRENTLY`" [61]. Re-check this section before upgrading.

---

## 10. Testing and rollout

1. **Rehearse on production-sized data.** Restore a recent backup (or use a clone/branch of similar size) and run the migration there. Measure duration. Check for rewrites: `SELECT pg_relation_filenode('orders');` before and after [30].
2. **Measure locks.** While the migration runs on the copy, watch `pg_locks` and `pg_stat_activity` from another session ([08](08-transactions-concurrency-locking.md#11-lock-monitoring)), or use `eugene trace` to list the locks each statement takes [40].
3. **Rehearse under load** if the table is hot: run a simple read/write load generator during the test and watch for waits.
4. **Check immutability mechanically.** A script compares the migrations folder with the merge-base of the main branch (`git diff --name-status <merge-base> -- prisma/migrations`) and fails on any committed migration that was modified, renamed or deleted; only additions pass. Run it before committing and in CI, so "never edit an applied migration" does not rest on memory.
5. **Lint in CI.** Run Squawk on every new `migration.sql` (for example `squawk prisma/migrations/*/migration.sql`, or the GitHub Action) [23][29]; fail the build on errors; require a written reason to ignore a rule.
6. **Backups.** Before risky steps (drops, type changes, large backfills), confirm that backups and point-in-time recovery work ([09](09-operations-and-server-tuning.md)).
7. **Rollback plan.** Write it in the PR: what to do if the migration fails halfway, and how to roll forward. Expand steps can usually stay in place.
8. **Timing.** Run steps that need a strong lock at low traffic; avoid running during long batch jobs, backups or an anti-wraparound vacuum on the same table [8].
9. **Observe after deploy.** Watch error rates, lock waits (`log_lock_waits`), replication lag, dead tuples, and query latency. Check for `INVALID` indexes.

---

## 11. Migration pull-request checklist

Copy into the PR description and tick each line.

- [ ] The migration works with the code currently in production **and** with the new code (backward compatible).
- [ ] Breaking changes use expand/contract; the contract step is planned for a later release.
- [ ] Deploy order is stated (migration before or after the code deploy).
- [ ] The SQL was reviewed, not only the ORM schema diff; Prisma object names are unchanged.
- [ ] Every DDL statement on an existing table runs with `lock_timeout` (role-level or `SET` + `RESET`), and the retry plan is known.
- [ ] At most one strong lock per transaction; no DDL mixed with a long backfill.
- [ ] Indexes are created/dropped/rebuilt with `CONCURRENTLY`, outside `BEGIN`/`COMMIT`; Prisma version supports the file layout (9.1).
- [ ] New foreign keys and checks use `NOT VALID`, validated in a separate migration.
- [ ] `NOT NULL` on existing columns uses `CHECK ... NOT VALID` + `VALIDATE` (or PG 18 `NOT NULL ... NOT VALID`).
- [ ] No table rewrite on a large table (no volatile default, no rewriting type change); if unavoidable, expand/contract or a maintenance window is planned.
- [ ] No rename or drop of anything the running code still uses (`@map`/`@ignore` used where helpful).
- [ ] Enum changes: new values in their own migration; no value removal on large tables.
- [ ] Backfills are batched, throttled, idempotent, and run outside the schema migration.
- [ ] Tested on a production-sized copy: duration and locks measured.
- [ ] Squawk passes (or each ignored rule is justified).
- [ ] No committed migration was edited, renamed or deleted (the immutability check passes).
- [ ] Backup / PITR checked for risky steps; rollback or roll-forward plan written.
- [ ] Monitoring plan for the deploy (lock waits, errors, replication lag, invalid indexes).

---

## Sources

1. [ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) — PostgreSQL 18 docs: lock level per subform, rewrites and exceptions, NOT VALID / VALIDATE CONSTRAINT, USING INDEX, ATTACH/DETACH PARTITION, DROP COLUMN, virtual generated columns.
2. [13.3. Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) — PostgreSQL docs: lock modes, which commands take them, conflicts.
3. [CREATE INDEX (Building Indexes Concurrently)](https://www.postgresql.org/docs/current/sql-createindex.html) — PostgreSQL docs: two scans, waits, not in a transaction block, INVALID indexes, unique caveat, partitioned tables.
4. [DROP INDEX](https://www.postgresql.org/docs/current/sql-dropindex.html) — PostgreSQL docs: CONCURRENTLY limits.
5. [REINDEX](https://www.postgresql.org/docs/current/sql-reindex.html) — PostgreSQL docs: concurrent rebuild steps, _ccnew/_ccold cleanup, locks.
6. [ALTER TYPE](https://www.postgresql.org/docs/current/sql-altertype.html) — PostgreSQL docs: ADD VALUE inside a transaction block, ordering notes.
7. [5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) — PostgreSQL docs: no in-place conversion, attaching tables, CHECK to skip scans, ON ONLY index procedure.
8. [24.1. Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html) — PostgreSQL docs: anti-wraparound autovacuum is not interrupted by lock requests.
9. [19.11. Client Connection Defaults](https://www.postgresql.org/docs/current/runtime-config-client.html) — PostgreSQL docs: lock_timeout, statement_timeout, transaction_timeout.
10. [PostgreSQL 18 Release Notes](https://www.postgresql.org/docs/release/18.0/) — postgresql.org: NOT VALID not-null constraints, NOT ENFORCED constraints, virtual generated columns.
11. [pgsql: Allow NOT NULL constraints to be added as NOT VALID](https://www.postgresql.org/message-id/E1u1q8z-0039ha-0U%40gemulon.postgresql.org) — pgsql-committers, Álvaro Herrera (2025-04-07): behavior, attnotnull caveat.
12. [PostgreSQL 19 Release Notes (Beta 4)](https://www.postgresql.org/docs/19/release-19.html) — postgresql.org: REPACK and REPACK CONCURRENTLY.
13. [REPACK (PostgreSQL 19 beta)](https://www.postgresql.org/docs/19/sql-repack.html) — PostgreSQL 19 docs: CONCURRENTLY mechanism, restrictions, locks, disk space.
14. [PostgreSQL 19 Beta 4 Released!](https://www.postgresql.org/about/news/postgresql-19-beta-4-released-3386/) — postgresql.org (2026-09-24): reverted features including MERGE/SPLIT PARTITIONS.
15. [Zero-downtime Postgres migrations - the hard parts](https://gocardless.com/blog/zero-downtime-postgres-migrations-the-hard-parts) — GoCardless, Chris Sinjakli: lock queue incident, lock_timeout, splitting changes.
16. [Zero-downtime Postgres schema migrations need this: lock_timeout and retries](https://postgres.ai/blog/20210923-zero-downtime-postgres-schema-migrations-lock-timeout-and-retries) — postgres.ai, Nikolay Samokhvalov: retries with backoff and jitter, long-transaction checks, subtransaction caveat.
17. [PostgreSQL 14.4 Release Notes](https://www.postgresql.org/docs/release/14.4/) — postgresql.org: CONCURRENTLY index corruption fix and revert.
18. [55.2. Message Flow (Multiple Statements in a Simple Query)](https://www.postgresql.org/docs/current/protocol-flow.html) — PostgreSQL docs: implicit transaction for multi-statement messages.
19. [pg_ha_migrations](https://github.com/braintree/pg_ha_migrations) — Braintree (PayPal): no automatic rollback, transactional DDL disabled, safe lock acquisition with retries.
20. [Migration Style Guide](https://docs.gitlab.com/development/migration_style_guide/) — GitLab: migration types and time limits, with_lock_retries, one foreign key per transaction, statement/transaction timeout for index builds.
21. [Avoiding downtime in migrations](https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/) — GitLab: dropping/renaming columns, type changes, int to bigint, dropping tables, NOT NULL in post-deploy.
22. [strong_migrations README](https://github.com/ankane/strong_migrations) — Andrew Kane: dangerous operations and safe alternatives, safe type changes, backfilling, timeouts and retries.
23. [Squawk rules](https://squawkhq.com/docs/rules) — Squawk: list of lint rules.
24. [Applying migrations safely](https://squawkhq.com/docs/safe_migrations) — Squawk: lock_timeout 1s, statement_timeout 5s, retries, lint is not enough.
25. [adding-not-nullable-field](https://squawkhq.com/docs/adding-not-nullable-field) — Squawk: CHECK NOT VALID recipe, PG 12+ scan skip.
26. [prefer-robust-stmts](https://squawkhq.com/docs/prefer-robust-stmts) — Squawk: IF [NOT] EXISTS for retryable migrations.
27. [adding-field-with-default (rule source)](https://github.com/sbdchd/squawk/blob/master/docs/docs/adding-field-with-default.md) — Squawk: non-volatile defaults since PG 11, volatile default recipe, generated columns.
28. [disallowed-unique-constraint](https://squawkhq.com/docs/disallowed-unique-constraint) — Squawk: unique constraint via concurrent index.
29. [Squawk README](https://github.com/sbdchd/squawk) — GitHub: install, CLI usage, --pg-version, --assume-in-transaction.
30. [When Does ALTER TABLE Require a Rewrite?](https://www.crunchydata.com/blog/when-does-alter-table-require-a-rewrite) — Crunchy Data, Greg Sabino Mullane (2025): testing rewrites with pg_relation_filenode, int/bigint rewrites.
31. [ParallelChange](https://martinfowler.com/bliki/ParallelChange.html) — martinfowler.com, Danilo Sato: expand, migrate, contract.
32. [The Integer at the End of the Universe: Integer Overflow in Postgres](https://www.crunchydata.com/blog/the-integer-at-the-end-of-the-universe-integer-overflow-in-postgres) — Crunchy Data, Jesse Soyland (2023): int to bigint procedure, monitoring.
33. [pg_repack documentation](https://github.com/reorg/pg_repack/blob/master/doc/pg_repack.rst) — reorg/pg_repack: requirements, supported versions, lock behavior.
34. [pg_squeeze README](https://github.com/cybertec-postgresql/pg_squeeze) — Cybertec: logical decoding, identity index, wal_level, max_xlock_time.
35. [pg_partman HowTo: Partitioning an Existing Table](https://github.com/pgpartman/pg_partman/blob/development/doc/pg_partman_howto.md) — pg_partman: offline and online methods, unique key and foreign key limits.
36. [pgroll README](https://github.com/xataio/pgroll) — Xata: views per schema version, expand/contract, triggers, PostgreSQL 14+.
37. [pgroll CLI docs](https://github.com/xataio/pgroll/tree/main/docs/cli) — Xata: --lock-timeout default 500 ms, backfill batch flags.
38. [Use pgroll with ORMs](https://github.com/xataio/pgroll/blob/main/docs/guides/orms.mdx) — Xata: pgroll convert for ORM-generated SQL.
39. [Reshape README](https://github.com/fabianlindfors/reshape) — Fabian Lindfors: views and triggers, start/complete/abort.
40. [eugene documentation](https://kaveland.no/eugene/) — Robin Kåveland: lint and trace modes.
41. [Migration analyzers](https://atlasgo.io/lint/analyzers) — Atlas: lint checks for PostgreSQL, Pro analyzers.
42. [Applying migrations (transaction modes)](https://atlasgo.io/versioned/apply) — Atlas: --tx-mode and atlas:txmode none.
43. [41.8. Transaction Management (PL/pgSQL)](https://www.postgresql.org/docs/current/plpgsql-transactions.html) — PostgreSQL docs: COMMIT inside procedures called at top level.
44. [Customizing migrations (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/customizing-migrations) — Prisma docs: --create-only workflow, rename example (DROP + ADD), expand and contract.
45. [Development and production (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/development-and-production) — Prisma docs: migrate deploy behavior, advisory locking, CI/CD.
46. [About migration histories (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-migrate/understanding-prisma-migrate/migration-histories) — Prisma docs: do not edit applied migrations, commit the folder.
47. [Patching & hotfixing (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/patching-and-hotfixing) — Prisma docs: failed migrations, migrate resolve --rolled-back / --applied, logs column.
48. [Generating down migrations (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/generating-down-migrations) — Prisma docs: migrate diff down scripts and their limits.
49. [prisma migrate dev (v7 CLI)](https://www.prisma.io/docs/cli/v7/migrate/dev) — Prisma docs: shadow database, --create-only, no automatic generate in v7, URL from prisma.config.ts.
50. [Limitations and known issues (Prisma ORM v7)](https://github.com/prisma/web/blob/main/apps/docs/content/docs/orm/v7/prisma-migrate/understanding-prisma-migrate/limitations-and-known-issues.mdx) — Prisma docs source: PgBouncer error with Migrate.
51. [Prisma schema reference (v7)](https://github.com/prisma/web/blob/main/apps/docs/content/docs/orm/v7/reference/prisma-schema-reference.mdx) — Prisma docs source: @ignore, @@ignore, @map, @@map.
52. [Support CREATE INDEX CONCURRENTLY (PostgreSQL) #14456](https://github.com/prisma/orm/issues/14456) — Prisma GitHub: P3018 error, single-statement workaround, manual pre-build tip, closed as fixed in 7.4.0.
53. [Confusing transaction semantics in Postgres migrations #22922](https://github.com/prisma/orm/issues/22922) — Prisma GitHub: multi-statement files run as one transaction, SET persisting across migrations.
54. [feat: support CREATE INDEX CONCURRENTLY in migrations (prisma-engines #5767)](https://github.com/prisma/prisma-engines/pull/5767) — Prisma GitHub: statement splitting, fallback when parsing fails.
55. [fix: support concurrent indexes in shadow db replay (prisma-engines #5799)](https://github.com/prisma/prisma-engines/pull/5799) — Prisma GitHub: shadow database replay fix.
56. [Prisma 7.4.0 release notes](https://github.com/prisma/orm/releases/tag/7.4.0) — Prisma GitHub (2026-02-11): CREATE INDEX CONCURRENTLY fix.
57. [Prisma 7.8.0 release notes](https://github.com/prisma/orm/releases/tag/7.8.0) — Prisma GitHub (2026-04-22): migrate dev shadow replay fix.
58. [Prisma schema engine: PostgreSQL renderer](https://github.com/prisma/prisma-engines/blob/main/schema-engine/connectors/sql-schema-connector/src/flavour/postgres/renderer.rs) — prisma-engines source: generated SQL for indexes, foreign keys, enums, defaults, type changes.
59. [Schema engine ARCHITECTURE.md](https://github.com/prisma/prisma-engines/blob/main/schema-engine/ARCHITECTURE.md) — prisma-engines: why Migrate does not wrap migrations in a transaction by default.
60. [Prisma schema engine: Postgres flavour (advisory lock)](https://github.com/prisma/prisma-engines/blob/main/schema-engine/connectors/sql-schema-connector/src/flavour/postgres.rs) — prisma-engines source: pg_advisory_lock(72707369) with timeout.
61. [Editing a migration (Prisma ORM 8)](https://www.prisma.io/docs/orm/migrations/editing-a-migration) — Prisma docs: Prisma 8 migrations run in one transaction.
62. [drizzle-orm PostgreSQL dialect (migrate)](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/pg-core/dialect.ts) — Drizzle source: all pending migrations in one transaction.
63. [dbmate README](https://github.com/amacneil/dbmate) — dbmate: migrations run in a transaction, transaction:false option.
64. [node-pg-migrate docs](https://github.com/salsita/node-pg-migrate/tree/main/docs/src) — node-pg-migrate: single-transaction default, pgm.noTransaction().
65. [graphile-migrate README](https://github.com/graphile/migrate) — Graphile: --! no-transaction, single statement only.
66. [Flyway Script Configuration](https://github.com/flyway/flyway/blob/main/documentation/Reference/Script%20Configuration.md) — Redgate Flyway docs source: executeInTransaction.
67. [Sqitch PostgreSQL deploy template](https://github.com/sqitchers/sqitch/blob/develop/etc/templates/deploy/pg.tmpl) — Sqitch: BEGIN/COMMIT in deploy scripts.
68. [Liquibase PostgresDatabase.java](https://github.com/liquibase/liquibase/blob/main/liquibase-standard/src/main/java/liquibase/database/core/PostgresDatabase.java) — Liquibase source: runInTransaction="false" changesets.
69. [Error message reference (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/reference/error-reference) — Prisma docs: P3006, P3009, P3018.
70. [SET](https://www.postgresql.org/docs/current/sql-set.html) — PostgreSQL docs: SET vs SET LOCAL, rollback behavior.
71. [CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html) — PostgreSQL docs: VIRTUAL default for generated columns, NOT ENFORCED, deferrable constraints.
72. [5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html) — PostgreSQL docs: what a foreign key may reference, indexing referencing columns.
73. [27.4. Progress Reporting](https://www.postgresql.org/docs/current/progress-reporting.html) — PostgreSQL docs: pg_stat_progress_create_index phases.
74. [CREATE VIEW](https://www.postgresql.org/docs/current/sql-createview.html) — PostgreSQL docs: automatically updatable views, SELECT * column list fixed at creation.
75. [require-timeout-settings](https://squawkhq.com/docs/require-timeout-settings) — Squawk: timeout rule, split into require-lock-timeout and require-statement-timeout.
