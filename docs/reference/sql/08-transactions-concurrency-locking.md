# Transactions, Concurrency and Locking

> Part of the [SQL & PostgreSQL reference library](README.md) · Last researched: 2026-10-05 · Targets PostgreSQL 14–18 (19 beta noted where relevant)

**What this covers.** How PostgreSQL runs many sessions at the same time without corrupting data: transactions, MVCC (multi-version concurrency control), isolation levels, retries, table and row locks, deadlocks, timeouts, long transactions, and lock monitoring. It ends with concrete rules for application code (TypeScript, Prisma, node-postgres). Schema-change locking in production is covered in [10-safe-schema-migrations.md](10-safe-schema-migrations.md); vacuum tuning is in [09-operations-and-server-tuning.md](09-operations-and-server-tuning.md).

## Key rules (TL;DR)

1. Keep transactions short: open them late, commit early, and never wait for a user or a network call while one is open.
2. Never call external services (HTTP APIs, LLMs, email, queues) inside a database transaction; use an outbox table instead ([07](07-schema-design-and-patterns.md)).
3. Run every statement of a transaction on the same connection: with node-postgres, take a client with `pool.connect()` (not `pool.query()`) for the transaction, and always release it.
4. Read Committed is the default; know that each statement sees a new snapshot and that read-modify-write in application code can lose updates.
5. Prefer atomic SQL (`SET x = x + 1`, `WHERE balance >= $1`) over "read in the app, compute, write back".
6. Use a unique constraint plus `INSERT ... ON CONFLICT` for "create if missing"; never "SELECT then INSERT".
7. Use `SERIALIZABLE` when correctness depends on several rows you read (write skew); then retry on SQLSTATE `40001`.
8. Write one generic retry wrapper: retry the whole transaction on `40001` and `40P01`, with a few attempts and random backoff; keep the transaction body idempotent.
9. Use optimistic concurrency (a `version` column and "0 rows updated = conflict") for edits that span user think-time.
10. Lock rows in a consistent order (`ORDER BY id FOR UPDATE`) to prevent deadlocks; use `FOR NO KEY UPDATE` when you do not change key columns.
11. Use `FOR UPDATE SKIP LOCKED` for queue workers; never for normal reads.
12. Use transaction-level advisory locks (`pg_advisory_xact_lock`) behind a transaction-mode pooler; session-level advisory locks break there.
13. Remember that only `ACCESS EXCLUSIVE` blocks plain `SELECT`, but a waiting `ACCESS EXCLUSIVE` request blocks every later query on the table (lock queue).
14. Set `lock_timeout` for DDL and for code paths that must not wait; set `statement_timeout` per role, not in `postgresql.conf`.
15. Set `idle_in_transaction_session_timeout` for application roles; consider `transaction_timeout` (PG 17+).
16. Treat sequences as non-transactional: gaps are normal; never use them for gapless invoice numbers.
17. Monitor `age(backend_xmin)` and `xact_start` in `pg_stat_activity`; a forgotten open transaction causes bloat for the whole database.
18. Use `pg_blocking_pids()` to find who blocks whom; enable `log_lock_waits` (default on only in PG 19 beta).
19. Use `pg_cancel_backend()` first and `pg_terminate_backend()` only if the session is idle in transaction or does not stop.
20. Do not use two-phase commit (`PREPARE TRANSACTION`) unless you run a real transaction manager; keep `max_prepared_transactions = 0`.
21. Watch transaction ID age (`age(datfrozenxid)`) and multixact age; details in [09](09-operations-and-server-tuning.md).

---

## 1. Transactions

A **transaction** is a group of statements that succeed or fail as one unit. PostgreSQL applies all changes at `COMMIT`, or none of them at `ROLLBACK` (or after an error).

### 1.1 ACID in concrete terms

| Property | Meaning | What it means in PostgreSQL |
|---|---|---|
| Atomicity | All or nothing | After an error inside a transaction, every statement fails with `25P02 in_failed_sql_transaction` until you `ROLLBACK` [28]. Nothing from the transaction is kept. |
| Consistency | Rules always hold | Constraints (`CHECK`, `UNIQUE`, `FOREIGN KEY`, `NOT NULL`) are checked; a violating statement fails. Most checks run per statement; `DEFERRABLE` constraints can wait until commit. |
| Isolation | Concurrent transactions do not see each other's half-done work | Implemented by MVCC snapshots and locks (sections 2–6). The strength depends on the isolation level. |
| Durability | Committed data survives a crash | `COMMIT` returns after the change is written to the write-ahead log (WAL). Settings like `synchronous_commit` trade this for speed ([09](09-operations-and-server-tuning.md)). |

### 1.2 Autocommit and explicit transactions

Without `BEGIN`, every statement runs in its own transaction and commits at its end. This is **autocommit**. One statement is always atomic: an `UPDATE` of one million rows either changes all of them or none.

Use an explicit transaction when several statements must succeed or fail together:

```sql
BEGIN;
UPDATE accounts SET balance = balance - 30 WHERE id = 1;
UPDATE accounts SET balance = balance + 30 WHERE id = 2;
INSERT INTO transfers (from_account, to_account, amount) VALUES (1, 2, 30);
COMMIT;
```

You can set the isolation level and access mode at the start [22]:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
-- or: BEGIN; SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
```

`SET TRANSACTION` must run before the first query or data-modification statement of the transaction [22].

**From Node.js.** A transaction lives on one connection. With node-postgres you must use the same client for all statements: "Do not use transactions with the pool.query method" [43]. Get a client with `pool.connect()`, run `BEGIN` ... `COMMIT`/`ROLLBACK` on it, and call `client.release()` in `finally` [43]. Prisma does this for you with `$transaction` [45]; see [15-postgres-from-typescript.md](15-postgres-from-typescript.md).

**The multi-statement trap.** If you send several statements in one string without parameters (`client.query('UPDATE ...; UPDATE ...')`), PostgreSQL runs them as one implicit transaction: the first error rolls back the earlier statements [27]. This is also why commands that cannot run in a transaction block (such as `CREATE INDEX CONCURRENTLY`) fail when they share a string with other statements. Migration tools are affected; see [10](10-safe-schema-migrations.md#9-applying-the-recipes-with-prisma-migrate).

### 1.3 Savepoints

A **savepoint** is a mark inside a transaction. `ROLLBACK TO SAVEPOINT` undoes only the work done after the mark; the transaction continues [23].

```sql
BEGIN;
INSERT INTO orders (user_id, total) VALUES (7, 120.00);
SAVEPOINT before_coupon;
UPDATE coupons SET used = true WHERE code = 'WELCOME10' AND NOT used;
-- the coupon logic failed: undo only the coupon part
ROLLBACK TO SAVEPOINT before_coupon;
COMMIT;  -- the order is saved, the coupon change is not
```

Use savepoints sparingly. Each savepoint starts a **subtransaction**. Many subtransactions in one transaction (for example a savepoint per row in a loop, or a PL/pgSQL `EXCEPTION` block called for each row) cost performance; postgres.ai documents problems such as subtransaction overflow on replicas [41]. ORMs often implement "nested transactions" with savepoints, so the same caution applies to nested ORM transactions inside loops.

### 1.4 Transactional DDL

In PostgreSQL, most DDL (`CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`, `DROP ...`) is transactional: you can roll it back like data changes [29]. This makes multi-step schema changes safe to test:

```sql
BEGIN;
ALTER TABLE orders ADD COLUMN currency text NOT NULL DEFAULT 'EUR';
CREATE INDEX orders_currency_idx ON orders (currency);
-- check something, then decide
ROLLBACK;  -- both changes disappear
```

Exceptions: a few commands cannot run inside a transaction block at all, for example `CREATE DATABASE`, `DROP DATABASE`, `CREATE TABLESPACE`, `VACUUM`, `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, and `ALTER SYSTEM`.

Warning: DDL inside a transaction keeps its lock (often `ACCESS EXCLUSIVE`) until the transaction ends. Several DDL statements in one transaction hold several strong locks at once. See [10](10-safe-schema-migrations.md).

---

## 2. MVCC: many versions of each row

**MVCC** (multi-version concurrency control) means that PostgreSQL keeps several versions of a row. Each statement reads a consistent **snapshot** of the data. As the documentation says, "reading never blocks writing and writing never blocks reading" [3].

### 2.1 Row versions: `xmin` and `xmax`

Each stored row version (a **tuple**) has hidden header fields [31]:

- `xmin`: the ID of the transaction that created this version.
- `xmax`: the ID of the transaction that deleted or updated it (0 if none).
- `ctid`: the physical location; for an updated row it points to the newer version.

You can read them as system columns:

```sql
SELECT xmin, xmax, ctid, id, balance FROM accounts WHERE id = 1;
--  xmin | xmax | ctid  | id | balance
--   812 |    0 | (0,1) |  1 |  100.00

UPDATE accounts SET balance = 90 WHERE id = 1;

SELECT xmin, xmax, ctid, id, balance FROM accounts WHERE id = 1;
--  xmin | xmax | ctid  | id | balance
--   815 |    0 | (0,7) |  1 |   90.00   -- a new row version at a new location
```

### 2.2 Snapshots and visibility

A **snapshot** records which transactions were finished when it was taken. Its text form is `xmin:xmax:xip_list`: all transactions before `xmin` are finished, all from `xmax` on had not started, and `xip_list` lists the ones still running [32]. A row version is visible if its creating transaction committed before the snapshot and its deleting transaction (if any) did not.

```sql
SELECT pg_current_snapshot();     -- e.g. 812:820:815,817
SELECT pg_current_xact_id_if_assigned();  -- NULL until the transaction writes
```

When is the snapshot taken? In Read Committed, at the start of **each statement**. In Repeatable Read and Serializable, once, at the **first statement** of the transaction [32][1].

### 2.3 UPDATE writes a new version; dead tuples need VACUUM

An `UPDATE` does not change the row in place. It marks the old version as deleted (sets `xmax`) and inserts a new version. A `DELETE` only sets `xmax`. Old versions that no running transaction can still see are **dead tuples**. `VACUUM` (usually autovacuum) removes them and makes the space reusable. Too many dead tuples cause **bloat**: tables and indexes become larger and slower. Vacuum tuning is in [09](09-operations-and-server-tuning.md).

Consequences for schema and code:

- A frequently updated row creates many dead versions. Updating a wide row to change one small column copies the whole row.
- `UPDATE big_table SET col = ...` without a `WHERE` writes a new version of every row and can roughly double the table's size until vacuum frees the old versions.
- Batch large updates and let vacuum work between batches ([10](10-safe-schema-migrations.md)).

### 2.4 HOT updates

A **HOT update** (heap-only tuple) avoids new index entries. It is possible when (1) the update changes no column used by an index (BRIN indexes excepted), and (2) the new version fits on the same page [5]. HOT updates are cheaper and their old versions can be cleaned during normal reads [5].

How to get more HOT updates:

- Do not index columns that change very often (for example `updated_at`, counters), unless queries need it.
- Lower `fillfactor` on heavily updated tables to leave free space on each page [5]:

```sql
ALTER TABLE sessions SET (fillfactor = 80);  -- applies to newly written pages
```

- Check the ratio:

```sql
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) AS hot_pct
FROM pg_stat_user_tables
ORDER BY n_tup_upd DESC
LIMIT 10;
```

### 2.5 Why long transactions are harmful

VACUUM can only remove a dead row version if no transaction might still need it. The oldest snapshot still in use defines the **xmin horizon**: dead rows newer than this horizon are kept [35]. One long transaction (even an idle one) therefore blocks cleanup in **every table of the database**, not only in the tables it touched. `VACUUM VERBOSE` then reports dead row versions that "cannot be removed yet" [35].

Brandur Leach measured this on a job-queue table: with one transaction left open for an hour, dead rows accumulated, and taking the next job became much slower while the backlog grew [38]. The same happens to any hot table (sessions, queues, counters).

The xmin horizon is held back by [35]:

1. Long-running or idle-in-transaction sessions.
2. Replication slots that are not consumed (logical or physical).
3. Forgotten prepared transactions (two-phase commit).
4. Long queries on a standby when `hot_standby_feedback = on`.

Section 10 shows how to find each one.

---

## 3. Isolation levels

The **isolation level** decides which concurrent changes a transaction can see and which anomalies are possible.

### 3.1 The standard table and PostgreSQL

PostgreSQL accepts the four SQL-standard levels but implements three: Read Uncommitted behaves like Read Committed [1].

| Level | Dirty read | Non-repeatable read | Phantom read | Serialization anomaly |
|---|---|---|---|---|
| Read Uncommitted | Not in PG | Possible | Possible | Possible |
| Read Committed (default) | No | Possible | Possible | Possible |
| Repeatable Read | No | No | Not in PG | Possible |
| Serializable | No | No | No | No |

Source: PostgreSQL docs, Table 13.1 [1].

Definitions:

- **Dirty read**: you see data that another transaction has not committed.
- **Non-repeatable read**: you read a row twice and get different values because another transaction committed in between.
- **Phantom read**: you run the same `WHERE` query twice and get a different set of rows.
- **Lost update**: two transactions read the same value, both compute a new value, and the second write silently overwrites the first.
- **Write skew**: two transactions read overlapping data, then each updates a different row; each change is fine alone, but together they break a rule.
- **Read-only anomaly**: a read-only transaction sees a state that could not exist in any serial order of the other transactions [30].

The extended view, for PostgreSQL behavior:

| Anomaly | Read Committed | Repeatable Read | Serializable |
|---|---|---|---|
| Dirty read | Prevented | Prevented | Prevented |
| Non-repeatable read | Possible | Prevented | Prevented |
| Phantom read | Possible | Prevented | Prevented |
| Lost update (app does read, then write) | Possible | Prevented: second writer gets `40001` | Prevented: `40001` |
| Lost update (atomic `SET x = x + 1`) | Prevented | Prevented | Prevented |
| Write skew | Possible | Possible | Prevented: `40001` |
| Read-only anomaly | Possible | Possible | Prevented |

Sources: [1][30][33][34].

### 3.2 Read Committed (the default)

Each statement sees a snapshot taken when **that statement** starts [1]. Two `SELECT`s in the same transaction can see different data.

**Re-check of updated rows.** When an `UPDATE`, `DELETE`, or `SELECT ... FOR UPDATE` finds a row that a concurrent transaction is changing, it waits for that transaction. If the other transaction commits, PostgreSQL re-evaluates the `WHERE` clause on the **new** version of the row and applies the change to that new version [1]. This is why atomic updates are safe:

```sql
-- Two sessions run this at the same time. The second one waits,
-- then re-reads the committed balance and subtracts again. No update is lost.
UPDATE accounts SET balance = balance - 30
WHERE id = 1 AND balance >= 30
RETURNING balance;
```

**Lost-update risk.** The re-check does not help when the application computes the new value from an earlier read:

```sql
-- Bad: read-modify-write in application code (Read Committed)
SELECT balance FROM accounts WHERE id = 1;   -- app reads 100, computes 100 - 30 = 70
UPDATE accounts SET balance = 70 WHERE id = 1;
-- If another session also read 100 and wrote 50, one of the two changes is lost.

-- Good: let the database compute it in one statement
UPDATE accounts SET balance = balance - 30 WHERE id = 1 AND balance >= 30;
```

If the logic is too complex for one statement, lock the row first (`SELECT ... FOR UPDATE`, section 7.2), use optimistic concurrency (section 7.3), or use Repeatable Read or Serializable with retries.

**Mixed snapshots.** Because a locked row is re-read in its newest version while other rows come from the statement snapshot, `SELECT ... FOR UPDATE` with joins can return combinations that never existed together. Laurenz Albe shows a bill whose total includes an item that the same query does not return [37]. Use a higher isolation level when you need a fully consistent view.

`MERGE` and `INSERT ... ON CONFLICT DO UPDATE` follow similar rules: in Read Committed, `ON CONFLICT DO UPDATE` always ends in either an insert or an update, and `MERGE` re-evaluates its `WHEN` conditions on the updated row version [1].

### 3.3 Repeatable Read (snapshot isolation)

The transaction sees one snapshot, taken at its first statement [1]. Every read in the transaction is consistent. This is called **snapshot isolation**.

If the transaction tries to update or lock a row that another transaction changed and committed after the snapshot, it fails [1]:

```
ERROR:  could not serialize access due to concurrent update
```

The SQLSTATE is `40001` (`serialization_failure`) [28]. The application must roll back and run the whole transaction again [1]. This "first updater wins" rule prevents lost updates [33].

**Write skew is still possible.** Classic example (from Kleppmann's *Designing Data-Intensive Applications* [34]): a hospital needs at least one doctor on call per shift.

```sql
CREATE TABLE on_call (
  doctor_id bigint PRIMARY KEY,
  shift_id  bigint NOT NULL,
  on_call   boolean NOT NULL
);
-- Doctors 1 and 2 are on call for shift 7. Both ask to leave at the same time.

-- Session A (doctor 1)
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM on_call WHERE shift_id = 7 AND on_call;   -- 2: "someone else stays"

-- Session B (doctor 2), at the same time
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM on_call WHERE shift_id = 7 AND on_call;   -- 2

-- Session A
UPDATE on_call SET on_call = false WHERE doctor_id = 1;
COMMIT;

-- Session B
UPDATE on_call SET on_call = false WHERE doctor_id = 2;
COMMIT;   -- succeeds: now nobody is on call
-- Each transaction updated a different row, so there was no write conflict to detect.
```

Fixes: run both at `SERIALIZABLE` (one gets `40001`), or lock the rows the decision depends on (`SELECT ... FROM on_call WHERE shift_id = 7 AND on_call FOR UPDATE`), or turn the rule into a constraint.

Repeatable Read is good for: reports and exports that need a consistent view, and for read-only API endpoints that run several queries.

### 3.4 Serializable (SSI)

Serializable guarantees that the result is the same as if the committed transactions had run one at a time, in some order. PostgreSQL implements it with **Serializable Snapshot Isolation (SSI)**: snapshot isolation plus tracking of read/write dependencies [1]. It records what each transaction read with **predicate locks** (`SIReadLock` in `pg_locks`); these locks never block anyone, they only detect dangerous patterns [1].

When it detects a dangerous pattern, one transaction fails with `40001` [1]:

```
ERROR:  could not serialize access due to read/write dependencies among transactions
```

The error can come at any statement or at `COMMIT`, and sometimes for transactions that would have been fine (false positives) [30]. You **must** retry [1][4]. In return you can drop most manual locking [1].

Performance advice from the documentation [1]:

- Declare transactions `READ ONLY` when possible.
- Keep transactions small; do not leave sessions "idle in transaction".
- Control the number of active connections (use a pool).
- Remove explicit `SELECT ... FOR UPDATE/SHARE` that Serializable makes unnecessary.
- Sequential scans take a relation-level predicate lock and cause more failures; good indexes help.
- If many failures come from lock-table promotion, raise `max_pred_locks_per_transaction` (default 64 [8]) and related settings.

For long reports at Serializable, use `SERIALIZABLE READ ONLY DEFERRABLE`: it may wait at the start for a safe snapshot, then runs without risk of a serialization failure and without SSI overhead [22]. This is the only case where Serializable blocks while Repeatable Read does not [1].

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE;
SELECT ... ;  -- long, consistent report
COMMIT;
```

All transactions that must be protected from each other need to run at Serializable; a Serializable transaction does not protect you from concurrent Read Committed writers.

### 3.5 Choosing a level

| Level | Use when | Avoid when |
|---|---|---|
| Read Committed | Default for OLTP work; single-statement atomic updates; code that locks explicitly or uses constraints | Logic that reads several rows, decides, then writes, without locks |
| Repeatable Read | Consistent multi-query reads (reports, exports, paginated snapshots); read-modify-write of single rows with retry | Rules that span rows you do not update (write skew) |
| Serializable | Business rules that span rows (booking, quotas, balances across accounts); you prefer "retry" over "think about every lock" | You cannot retry (side effects inside the transaction); very long write transactions under heavy contention |

Set a default per role or per database if most of your code needs one level: `ALTER ROLE app SET default_transaction_isolation = 'serializable';` [7][26]. With Prisma, pass `isolationLevel` to `$transaction` [45].

---

## 4. Retrying failed transactions

### 4.1 Which errors to retry

| SQLSTATE | Name | Retry? |
|---|---|---|
| `40001` | `serialization_failure` | Yes, always; retry the whole transaction [4] |
| `40P01` | `deadlock_detected` | Yes [4] |
| `23505` | `unique_violation` | Only when it is really a race (two sessions picked the same new key after reading existing keys); otherwise it is a real error [4] |
| `23P01` | `exclusion_violation` | Same as `23505` [4] |
| `55P03` | `lock_not_available` (from `lock_timeout` or `NOWAIT`) | Sometimes: retry later with backoff (typical for DDL), or return "busy" to the caller |
| `57014` | `query_canceled` (from `statement_timeout` or cancel) | Usually no: the query is too slow; fix it |
| `25P03`, `25P04` | idle-in-transaction / transaction timeout | No: the session was terminated; fix the code path |

Codes from the PostgreSQL error appendix [28].

### 4.2 Make the whole transaction retryable

"It is important to retry the complete transaction, including all logic that decides which SQL to issue and/or which values to use" [4]. PostgreSQL has no automatic retry for this reason [4]. Rules:

- Re-read data inside the retried function. Never reuse values read in a failed attempt.
- No side effects inside the transaction body (no HTTP calls, no emails, no in-memory counters). If the transaction is retried, side effects would run twice; if it rolls back, they cannot be undone [39].
- Make the operation idempotent: an idempotency key column with a unique constraint lets a client resend safely.
- Limit attempts (for example 3–5) and add random backoff (jitter) so retries do not collide again.
- Be careful with errors during `COMMIT` when the connection breaks: you may not know whether it committed. An idempotency key (or `pg_xact_status()` on a saved transaction ID [19]) resolves the doubt.

### 4.3 A retry wrapper in TypeScript (node-postgres)

```ts
import type { Pool, PoolClient } from 'pg';

type Isolation = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

export async function runInTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>, // database work only: no HTTP, no email
  { isolation = 'SERIALIZABLE' as Isolation, maxAttempts = 5 } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    let destroy = false;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`); // fixed union type, not user input
      const result = await work(client);
      await client.query('COMMIT'); // SERIALIZABLE can also fail here with 40001
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { destroy = true; }); // broken connection
      const code = (err as { code?: string }).code;
      if (!code || !RETRYABLE.has(code) || attempt >= maxAttempts) throw err;
      const delayMs = Math.random() * Math.min(1_000, 25 * 2 ** attempt); // full jitter
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } finally {
      client.release(destroy); // true = destroy the client instead of reusing it [44]
    }
  }
}
```

Usage:

```ts
await runInTransaction(pool, async (c) => {
  const { rows } = await c.query(
    'SELECT count(*)::int AS n FROM on_call WHERE shift_id = $1 AND on_call', [7]);
  if (rows[0].n < 2) throw new Error('Last doctor on call cannot leave');
  await c.query('UPDATE on_call SET on_call = false WHERE doctor_id = $1', [1]);
});
```

**With Prisma.** Prisma reports serialization failures as `P2034` ("Transaction failed due to a write conflict or a deadlock. Please retry your transaction") [46]. Since Prisma 7.10.0, PostgreSQL deadlocks (`40P01`) are also reported as `P2034` [47]. Prisma's documentation recommends `isolationLevel: Serializable` plus a retry loop on `P2034` [45]. Interactive transactions default to `maxWait: 2000` ms and `timeout: 5000` ms [45]; a transaction that runs longer is rolled back.

---

## 5. Table-level locks

Every statement takes a lock on each table it uses. Most locks are weak and never conflict with normal traffic. A few are strong. Locks are held until the **end of the transaction**, not the end of the statement.

### 5.1 The eight lock modes

From weakest to strongest [2]:

| Mode | Typical statements that take it | Conflicts with |
|---|---|---|
| `ACCESS SHARE` | `SELECT` | `ACCESS EXCLUSIVE` only |
| `ROW SHARE` | `SELECT ... FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE` | `EXCLUSIVE`, `ACCESS EXCLUSIVE` |
| `ROW EXCLUSIVE` | `INSERT`, `UPDATE`, `DELETE`, `MERGE` | `SHARE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, `ACCESS EXCLUSIVE` |
| `SHARE UPDATE EXCLUSIVE` | `VACUUM` (not `FULL`), `ANALYZE`, `CREATE INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, `CREATE STATISTICS`, `COMMENT ON`, `ALTER TABLE ... VALIDATE CONSTRAINT`, some other `ALTER TABLE`/`ALTER INDEX` forms | itself, `SHARE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, `ACCESS EXCLUSIVE` |
| `SHARE` | `CREATE INDEX` (without `CONCURRENTLY`) | `ROW EXCLUSIVE`, `SHARE UPDATE EXCLUSIVE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, `ACCESS EXCLUSIVE` |
| `SHARE ROW EXCLUSIVE` | `CREATE TRIGGER`, `ALTER TABLE ... ADD FOREIGN KEY` (on both tables) | `ROW EXCLUSIVE` and everything stronger, including itself |
| `EXCLUSIVE` | `REFRESH MATERIALIZED VIEW CONCURRENTLY` | everything except `ACCESS SHARE` |
| `ACCESS EXCLUSIVE` | `DROP TABLE`, `TRUNCATE`, `VACUUM FULL`, `CLUSTER`, `REFRESH MATERIALIZED VIEW`, most `ALTER TABLE` forms, `LOCK TABLE` without a mode | everything, including plain `SELECT` |

Key sentence from the docs: "Only an `ACCESS EXCLUSIVE` lock blocks a `SELECT` (without `FOR UPDATE/SHARE`) statement" [2].

### 5.2 Which common statement blocks what

| Statement | Lock | Blocks reads? | Blocks writes? |
|---|---|---|---|
| `SELECT` | `ACCESS SHARE` | No | No |
| `INSERT` / `UPDATE` / `DELETE` / `MERGE` | `ROW EXCLUSIVE` (+ row locks) | No | Only on the same rows |
| `CREATE INDEX` | `SHARE` | No | Yes, for the whole build |
| `CREATE INDEX CONCURRENTLY` | `SHARE UPDATE EXCLUSIVE` | No | No (but waits for older transactions) |
| `REINDEX` (plain) | `SHARE` on table, `ACCESS EXCLUSIVE` on the index | Queries that use the index | Yes |
| `REINDEX CONCURRENTLY` | `SHARE UPDATE EXCLUSIVE` | No | No |
| Most `ALTER TABLE` (add column, set default, rename, drop column, set type...) | `ACCESS EXCLUSIVE` | Yes | Yes |
| `ALTER TABLE ... ADD FOREIGN KEY` | `SHARE ROW EXCLUSIVE` on both tables | No | Yes, while it validates |
| `ALTER TABLE ... VALIDATE CONSTRAINT` | `SHARE UPDATE EXCLUSIVE` | No | No |
| `VACUUM` / `ANALYZE` | `SHARE UPDATE EXCLUSIVE` | No | No |
| `VACUUM FULL` / `CLUSTER` | `ACCESS EXCLUSIVE` | Yes | Yes |
| `TRUNCATE` / `DROP TABLE` | `ACCESS EXCLUSIVE` | Yes | Yes |
| `REFRESH MATERIALIZED VIEW` | `ACCESS EXCLUSIVE` | Yes | Yes |
| `REFRESH MATERIALIZED VIEW CONCURRENTLY` | `EXCLUSIVE` | No | Other refreshes and DDL on the view wait |

Sources: [2], [48] for `REINDEX`, [49] for the constraint forms of `ALTER TABLE` (see [10](10-safe-schema-migrations.md) for every `ALTER TABLE` form). Autovacuum yields: a conflicting lock request cancels a normal autovacuum, but not one running "to prevent wraparound" [6]. So a DDL statement can wait behind an anti-wraparound vacuum.

### 5.3 Simplified conflict matrix

`X` = the two modes conflict (one waits for the other) [2].

| Requested \ Held | AS | RS | RE | SUE | S | SRE | E | AE |
|---|---|---|---|---|---|---|---|---|
| ACCESS SHARE (AS) | | | | | | | | X |
| ROW SHARE (RS) | | | | | | | X | X |
| ROW EXCLUSIVE (RE) | | | | | X | X | X | X |
| SHARE UPDATE EXCLUSIVE (SUE) | | | | X | X | X | X | X |
| SHARE (S) | | | X | X | | X | X | X |
| SHARE ROW EXCLUSIVE (SRE) | | | X | X | X | X | X | X |
| EXCLUSIVE (E) | | X | X | X | X | X | X | X |
| ACCESS EXCLUSIVE (AE) | X | X | X | X | X | X | X | X |

### 5.4 The lock queue effect

Lock requests wait in a queue. A new request must wait if it conflicts with a lock that is **held** or with a request that is **already waiting** ahead of it. `pg_blocking_pids()` calls the second case a "soft block" [19].

The dangerous sequence [40][41]:

1. Session A runs a long `SELECT` on `orders` (holds `ACCESS SHARE`).
2. Session B runs `ALTER TABLE orders ADD COLUMN note text;`. It needs `ACCESS EXCLUSIVE`, which conflicts with A, so it waits.
3. Every new query on `orders`, even a plain `SELECT`, conflicts with B's waiting request and queues behind it.
4. The application stops working on `orders` until A finishes, although the `ALTER` itself would take a millisecond.

GoCardless had about 15 seconds of API downtime from this pattern during a "fast" migration [40].

The fix is to make the DDL give up quickly and retry [41]:

```sql
SET lock_timeout = '2s';   -- wait at most 2 s for the lock, then fail with 55P03
ALTER TABLE orders ADD COLUMN note text;
-- on failure: wait a little, check for long transactions, retry
```

Full recipes, retry loops, and tooling are in [10-safe-schema-migrations.md](10-safe-schema-migrations.md).

### 5.5 Explicit `LOCK TABLE`

You rarely need `LOCK TABLE`. It is useful when a short transaction must take a strong lock first and then run several statements (for example a table swap). Always combine it with `lock_timeout`, or use `NOWAIT`:

```sql
BEGIN;
SET LOCAL lock_timeout = '1s';
LOCK TABLE orders IN SHARE ROW EXCLUSIVE MODE;  -- blocks writers, not readers
-- ... statements that need a stable table ...
COMMIT;
```

---

## 6. Row-level locks

Row locks protect single rows. They never block plain `SELECT` (MVCC), only other writers and lockers of the **same rows**.

### 6.1 The four row lock modes

| Mode | Taken by | Blocks |
|---|---|---|
| `FOR UPDATE` | `SELECT ... FOR UPDATE`, `DELETE`, `UPDATE` that changes a key column (a column with a unique index usable by a foreign key) | All other row locks and writes on the row |
| `FOR NO KEY UPDATE` | `SELECT ... FOR NO KEY UPDATE`, any other `UPDATE` | Everything except `FOR KEY SHARE` |
| `FOR SHARE` | `SELECT ... FOR SHARE` | Writes and `FOR UPDATE` / `FOR NO KEY UPDATE` |
| `FOR KEY SHARE` | `SELECT ... FOR KEY SHARE`, foreign key checks on the referenced row | `DELETE` and key changes (`FOR UPDATE`) only |

Conflict matrix (`X` = conflict) [2]:

| Requested \ Held | FOR KEY SHARE | FOR SHARE | FOR NO KEY UPDATE | FOR UPDATE |
|---|---|---|---|---|
| FOR KEY SHARE | | | | X |
| FOR SHARE | | | X | X |
| FOR NO KEY UPDATE | | X | X | X |
| FOR UPDATE | X | X | X | X |

### 6.2 Foreign keys take row locks

When you insert or update a child row (for example `order_items.order_id`), PostgreSQL locks the referenced parent row (`orders`) with `FOR KEY SHARE` [36]. This lock does not conflict with a normal `UPDATE` of the parent (`FOR NO KEY UPDATE`). It does conflict with `SELECT ... FOR UPDATE` on the parent.

Practical rule from Laurenz Albe: a `FOR UPDATE` lock is only needed if you will delete the row or change its key; otherwise use `FOR NO KEY UPDATE` [36]. This avoids many deadlocks between parent updates and child inserts.

```sql
-- Bad: blocks concurrent inserts of order_items for this order
SELECT * FROM orders WHERE id = $1 FOR UPDATE;
-- Good: same protection against concurrent updates, no conflict with FK checks
SELECT * FROM orders WHERE id = $1 FOR NO KEY UPDATE;
```

### 6.3 `NOWAIT` and `SKIP LOCKED`

- `NOWAIT`: if a row is already locked, fail at once with `55P03` instead of waiting [14].
- `SKIP LOCKED`: skip rows that are locked and return the others. "Skipping locked rows provides an inconsistent view of the data, so this is not suitable for general purpose work, but can be used to avoid lock contention with multiple consumers accessing a queue-like table" [14].

Both apply only to row locks; the table-level `ROW SHARE` lock is still taken normally [14]. Since PG 18, `log_lock_failures` can log `NOWAIT` failures [9][13].

Other rules for locking clauses [14]:

- Not allowed with `GROUP BY`, `DISTINCT`, `HAVING`, `WINDOW`, or aggregates.
- In Read Committed, `ORDER BY ... FOR UPDATE` can return rows out of order if the sort column changed while waiting. At Repeatable Read and above this case raises `40001` instead.

### 6.4 Multixacts

The row header has room for only one locker. When several transactions lock the same row (for example many `FOR KEY SHARE` locks from child inserts), PostgreSQL stores the group as a **multixact** ID [6]. Multixact IDs also wrap around and need vacuum freezing (section 12). Workloads with many concurrent foreign-key inserts on the same parent rows create many multixacts.

---

## 7. Concurrency patterns

### 7.1 Atomic updates instead of read-modify-write

Put the computation and the check in one statement. Read Committed re-checks the row after waiting (section 3.2), so no update is lost.

```sql
-- Decrement stock only if enough is left; returns 0 rows if not
UPDATE products SET stock = stock - $2
WHERE id = $1 AND stock >= $2
RETURNING stock;
```

Check the affected row count in the application: 0 rows means "not enough stock" or "no such product".

### 7.2 Pessimistic locking (`SELECT ... FOR UPDATE`)

Lock the rows first when the logic needs several steps:

```sql
BEGIN;
SELECT id, status, total FROM orders WHERE id = $1 FOR NO KEY UPDATE;
-- application checks status = 'pending', computes the refund, etc.
UPDATE orders SET status = 'refunded' WHERE id = $1;
INSERT INTO refunds (order_id, amount) VALUES ($1, $2);
COMMIT;
```

Rules: lock as few rows as possible, keep the transaction short, and lock in a stable order (section 8.4). Use `NOWAIT` when the caller prefers an immediate "busy" answer.

### 7.3 Optimistic concurrency (version column)

For edits that take user think-time (a form open for minutes), do not hold a lock. Keep a version number and check it when saving:

```sql
ALTER TABLE documents ADD COLUMN version integer NOT NULL DEFAULT 0;

-- Save: succeeds only if nobody saved since we loaded version 7
UPDATE documents
SET title = $1, body = $2, version = version + 1
WHERE id = $3 AND version = 7;
-- 0 rows updated => conflict: reload, merge or show "someone else changed this"
```

Prisma documents the same pattern with `updateMany` and a check of the returned `count` [45].

### 7.4 Unique constraints as concurrency control

The database is the only place that sees all concurrent requests. A unique constraint is the cheapest, most reliable way to prevent duplicates.

```sql
-- Bad: race condition. Two requests both see "no row", both insert.
SELECT id FROM users WHERE email = $1;
INSERT INTO users (email) VALUES ($1);

-- Good: the unique index decides; the statement is atomic
CREATE UNIQUE INDEX users_email_key ON users (email);   -- once, in a migration
INSERT INTO users (email) VALUES ($1)
ON CONFLICT (email) DO NOTHING
RETURNING id;   -- no row returned => the user already existed
```

`INSERT ... ON CONFLICT DO UPDATE` "guarantees an atomic INSERT or UPDATE outcome ... even under high concurrency" [15]. It cannot update the same row twice in one statement (cardinality violation) [15]. Upsert recipes are in [04-query-patterns-and-antipatterns.md](04-query-patterns-and-antipatterns.md). PostgreSQL 19 adds `ON CONFLICT DO SELECT ... RETURNING` to return the existing row (PG 19, beta — may change) [10].

Other constraints work the same way: an exclusion constraint prevents overlapping bookings (`EXCLUDE USING gist (room_id WITH =, during WITH &&)`), and a partial unique index enforces "one active row per user".

### 7.5 `MERGE` under concurrency

`MERGE` (PG 15+) is convenient but is **not** an atomic upsert. Under concurrent inserts it can fail with a unique violation; the documentation suggests `INSERT ... ON CONFLICT` "as an alternative statement which offers the ability to run an UPDATE if a concurrent INSERT occurs" [16]. Use `MERGE` for batch synchronization jobs that run alone (or that retry on `23505`), and `ON CONFLICT` for concurrent request handling.

### 7.6 Advisory locks

An **advisory lock** is a lock on a number that you choose; PostgreSQL does not attach any meaning to it [2]. Use it to make sure only one worker runs a task (a cron job, a per-tenant import).

| Kind | Functions | Released | Notes |
|---|---|---|---|
| Transaction-level | `pg_advisory_xact_lock(key)`, `pg_try_advisory_xact_lock(key)` | Automatically at commit/rollback | Preferred; works with transaction-mode poolers |
| Session-level | `pg_advisory_lock(key)`, `pg_try_advisory_lock(key)`, `pg_advisory_unlock(key)` | Explicit unlock or session end | Ignores rollback; must be unlocked as many times as locked [2] |

Keys are one `bigint` or two `integer` values [18].

```sql
-- Only one "nightly invoice" run per tenant at a time
BEGIN;
SELECT pg_try_advisory_xact_lock(1001, 42) AS got_lock;  -- 1001 = job type, 42 = tenant_id
-- got_lock = false => another worker is running it: COMMIT and skip
-- ... do the work ...
COMMIT;  -- the lock is released here
```

Pitfalls:

- **Transaction-mode poolers** (PgBouncer `pool_mode = transaction`, many managed poolers) give your next transaction a different server connection. Session-level advisory locks are listed as "Never" supported in transaction pooling [42]. A session lock can stay held on a pooled server connection and block others. Use transaction-level locks there.
- Do not call a lock function in a query with `LIMIT` over many rows: the `LIMIT` may apply after locking, leaving unexpected locks [2].
- Advisory locks use the shared lock table (`max_locks_per_transaction`) [2].
- Prisma Migrate takes a session-level advisory lock (`pg_advisory_lock(72707369)`) during `migrate dev`, `deploy` and `resolve` [50]; run migrations on a direct connection, not through a transaction-mode pooler (see [10](10-safe-schema-migrations.md#9-applying-the-recipes-with-prisma-migrate)).

### 7.7 Queue consumers with `SKIP LOCKED` (locking side)

Queue table design (status columns, retries, cleanup) is in [07-schema-design-and-patterns.md](07-schema-design-and-patterns.md). The locking part: each worker claims a batch of rows that no other worker holds.

```sql
WITH next_jobs AS (
  SELECT id
  FROM jobs
  WHERE status = 'queued' AND run_at <= now()
  ORDER BY run_at
  LIMIT 10
  FOR UPDATE SKIP LOCKED
)
UPDATE jobs AS j
SET status = 'running', started_at = now(), attempts = j.attempts + 1
FROM next_jobs
WHERE j.id = next_jobs.id
RETURNING j.id, j.payload;
```

Commit right after claiming; do the slow work (LLM calls, HTTP) **outside** the transaction, then mark the job done in a second short transaction. Holding the row lock during the work keeps a transaction open and harms vacuum (section 2.5). Index the queue on the claim condition (for example a partial index `WHERE status = 'queued'`).

### 7.8 Hot rows and counters

A **hot row** is a row that many transactions update (a global counter, a "last order number" row, an account balance shared by all requests). Every update waits for the previous one to commit, so throughput is limited by transaction length.

Options:

- Update the hot row as the **last** statement of the transaction, to hold its lock for the shortest time.
- Sharded counters: spread updates over N rows and sum on read.

```sql
CREATE TABLE post_view_counts (
  post_id bigint   NOT NULL,
  shard    smallint NOT NULL,
  views    bigint   NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, shard)
);
-- increment one random shard of 16
INSERT INTO post_view_counts (post_id, shard, views)
VALUES ($1, floor(random() * 16)::smallint, 1)
ON CONFLICT (post_id, shard) DO UPDATE SET views = post_view_counts.views + 1;
-- read
SELECT sum(views) AS views FROM post_view_counts WHERE post_id = $1;
```

- Append-only: insert one row per event and aggregate periodically (or on read).
- Batch in the application or a queue, then apply one update per batch.

### 7.9 Sequences are not transactional

`nextval()` never rolls back: "transaction aborts or database crashes can result in gaps in the sequence of assigned values" [17]. `INSERT ... ON CONFLICT` also consumes values before detecting the conflict [17]. Identity and `serial` columns use sequences, so their gaps are normal. Never use them for numbers that must be gapless (legal invoice numbers); use a counter row locked in the same transaction instead, and accept that it serializes those inserts.

### 7.10 Pattern chooser

| Problem | Pattern |
|---|---|
| Change a value based on itself | Atomic `UPDATE ... SET x = x + $1 WHERE ...` |
| Create if missing, no duplicates | Unique constraint + `INSERT ... ON CONFLICT` |
| Multi-step change to one or a few rows, short | `SELECT ... FOR NO KEY UPDATE`, then update |
| Edit with user think-time | Optimistic version column |
| Rule across several rows (quotas, on-call, double booking) | `SERIALIZABLE` + retry, or a constraint (exclusion, unique partial index) |
| One worker per task | `pg_try_advisory_xact_lock` |
| Many workers on a queue | `FOR UPDATE SKIP LOCKED` |
| Very hot counter | Sharded counter or append-only events |

---

## 8. Deadlocks

A **deadlock** is a cycle of waits: transaction A waits for a lock held by B, and B waits for a lock held by A. Neither can continue.

### 8.1 How they happen

```sql
-- Session A
BEGIN;
UPDATE accounts SET balance = balance - 10 WHERE id = 1;   -- A locks row 1

-- Session B
BEGIN;
UPDATE accounts SET balance = balance - 5 WHERE id = 2;    -- B locks row 2

-- Session A
UPDATE accounts SET balance = balance + 10 WHERE id = 2;   -- A waits for B

-- Session B
UPDATE accounts SET balance = balance + 5 WHERE id = 1;    -- B waits for A: deadlock
-- After deadlock_timeout, PostgreSQL aborts one of them with 40P01.
```

Deadlocks happen with row locks even if you never lock explicitly [2]. Other common causes: foreign key checks combined with `SELECT ... FOR UPDATE` on parent rows [36], multi-row `UPDATE`s that visit rows in different orders, and lock upgrades (two transactions each hold `FOR SHARE`, then both want `FOR UPDATE`).

### 8.2 Detection

A waiting session checks for a deadlock after `deadlock_timeout` (default `1s`) [8]. PostgreSQL aborts one of the transactions with `40P01 deadlock_detected`; which one "is difficult to predict and should not be relied upon" [2]. The other transactions continue. Retry the aborted one (section 4).

### 8.3 Reading the deadlock message

Example from the server log [36]:

```
ERROR:  deadlock detected
DETAIL:  Process 19674 waits for ShareLock on transaction 1109; blocked by process 19718.
         Process 19718 waits for ShareLock on transaction 1108; blocked by process 19674.
HINT:  See server log for query details.
CONTEXT:  while locking tuple (0,1) in relation "parent"
```

How to read it:

- "waits for ShareLock on transaction N" means: waiting for a **row lock** held by transaction N (row lock waits appear as waits on the holder's transaction ID [20]).
- `CONTEXT` shows the row (`(page,item)` tuple ID) and table.
- The statements shown are only the last ones. The deadlock needs **earlier** statements of the same transactions that took the first locks [36]. Log enough to reconstruct them: add `%p` (process ID) and `%x` (transaction ID) to `log_line_prefix`, and correlate with application logs [36].

### 8.4 Prevention

1. Acquire locks in a consistent order. "The best defense against deadlocks is generally to avoid them by being certain that all applications using a database acquire locks on multiple objects in a consistent order" [2].

```sql
-- Good: lock both accounts in id order, then update in any order
BEGIN;
SELECT id FROM accounts WHERE id = ANY($1::bigint[]) ORDER BY id FOR NO KEY UPDATE;
UPDATE accounts SET balance = balance - $2 WHERE id = $3;
UPDATE accounts SET balance = balance + $2 WHERE id = $4;
COMMIT;
```

2. Take the strongest lock you will need first; avoid upgrading from `FOR SHARE` to `FOR UPDATE` [2].
3. Use `FOR NO KEY UPDATE` instead of `FOR UPDATE` unless you delete the row or change its key [36].
4. Keep transactions short; fewer locks held for less time means fewer cycles.
5. Retry on `40P01` [4].

---

## 9. Timeouts

All of these are `0` (disabled) by default [7].

| Setting | What it limits | Effect when hit | SQLSTATE | Version |
|---|---|---|---|---|
| `statement_timeout` | Duration of one statement | Cancels the statement | `57014` | all |
| `lock_timeout` | Time waiting for one lock (table, row, or other object) | Cancels the statement | `55P03` | all |
| `idle_in_transaction_session_timeout` | Time idle inside an open transaction | **Terminates the session** | `25P03` | all |
| `transaction_timeout` | Total duration of a transaction (explicit or single-statement) | **Terminates the session** | `25P04` | PG 17+ [11] |
| `idle_session_timeout` | Time idle outside a transaction | **Terminates the session** | `57P05` | PG 14+ [12] |

Notes from the documentation [7]:

- Setting `statement_timeout`, `lock_timeout` or `transaction_timeout` in `postgresql.conf` "is not recommended because it would affect all sessions" (including maintenance and migrations).
- `lock_timeout` applies to each lock attempt separately. A `lock_timeout` equal to or larger than `statement_timeout` is pointless, because the statement timeout fires first.
- If `transaction_timeout` is shorter than or equal to `idle_in_transaction_session_timeout` or `statement_timeout`, the longer timeout is ignored. Prepared transactions are not subject to `transaction_timeout`.
- `idle_in_transaction_session_timeout` exists to stop idle sessions from holding locks and from blocking vacuum.
- Be careful with `idle_session_timeout` behind connection poolers, which may not expect the server to close connections.

### 9.1 Where to set them

From most general to most specific (later wins): database, role, role in database, session, transaction [26][25].

```sql
-- Application role: protect the database from slow queries and forgotten transactions
ALTER ROLE app_user SET statement_timeout = '15s';
ALTER ROLE app_user SET lock_timeout = '5s';
ALTER ROLE app_user SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE app_user SET transaction_timeout = '120s';      -- PG 17+

-- Reporting role: longer queries allowed
ALTER ROLE reporting SET statement_timeout = '10min';

-- One endpoint that must not wait for locks
BEGIN;
SET LOCAL lock_timeout = '200ms';
SET LOCAL statement_timeout = '2s';
UPDATE orders SET status = 'paid' WHERE id = $1;
COMMIT;
```

The values above are examples; tune them to your workload. Role settings apply only to **new** sessions [26]. `SET LOCAL` lasts until the end of the transaction; outside a transaction block it only emits a warning [25]. A plain `SET` inside a transaction persists after commit for the rest of the session [25]; with a pool, that leaks into later users of the same connection, so prefer `SET LOCAL`.

From node-postgres, the client config accepts `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout`; `query_timeout` is a client-side timer [44]. Behind a transaction-mode pooler, session `SET` does not stick to your next transaction [42]; use role-level settings or `SET LOCAL`.

---

## 10. Long-running transactions

### 10.1 Why they are harmful

- They hold the **xmin horizon** back: vacuum cannot remove dead rows anywhere in the database, so tables and indexes bloat (section 2.5) [35].
- They keep every lock they took until the end; a forgotten `BEGIN` after an `UPDATE` blocks other writers on that row forever.
- They block DDL (and, through the lock queue, everything behind the DDL) (section 5.4).
- They delay freezing, which pushes the database toward transaction ID wraparound (section 12) [6].
- Forgotten **prepared transactions** (two-phase commit) and unused **replication slots** have the same effect on vacuum and survive restarts [35][24].

### 10.2 Finding them

Oldest open transactions:

```sql
SELECT pid, usename, application_name, client_addr, state,
       now() - xact_start   AS xact_age,
       now() - state_change AS in_state_for,
       age(backend_xmin)    AS xmin_age,      -- in transactions, not time
       wait_event_type, wait_event,
       left(query, 100)     AS last_query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_start
LIMIT 20;
```

`state = 'idle in transaction'` means the client opened a transaction and is not sending anything: usually an application bug (missing commit, an exception path without rollback, or slow code between queries) [21].

The other horizon holders [35]:

```sql
SELECT slot_name, slot_type, active, xmin, catalog_xmin
FROM pg_replication_slots
ORDER BY greatest(age(xmin), age(catalog_xmin)) DESC NULLS LAST;

SELECT gid, prepared, owner, database, age(transaction) AS xid_age
FROM pg_prepared_xacts
ORDER BY prepared;

SELECT application_name, client_addr, backend_xmin
FROM pg_stat_replication
ORDER BY age(backend_xmin) DESC NULLS LAST;
```

### 10.3 Stopping a session

| Function | Effect | Use when |
|---|---|---|
| `pg_cancel_backend(pid)` | Cancels the current query; the session stays connected | A query runs too long |
| `pg_terminate_backend(pid [, timeout_ms])` | Ends the whole session; its transaction rolls back | The session is idle in transaction, or cancel did not help |

Both require the same role (or membership) or the `pg_signal_backend` privilege; only superusers can signal superuser sessions [18]. With a `timeout`, `pg_terminate_backend` waits until the process is gone [18].

```sql
-- Terminate sessions idle in a transaction for more than 10 minutes
SELECT pid, pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND state_change < now() - interval '10 minutes'
  AND pid <> pg_backend_pid();
```

Remove a forgotten prepared transaction with `ROLLBACK PREPARED 'gid';` and an unused slot with `SELECT pg_drop_replication_slot('slot_name');` [35] (check with the owners first).

---

## 11. Lock monitoring

### 11.1 Who blocks whom

`pg_blocking_pids(pid)` returns the sessions that block a given session, including "soft" blocks by requests ahead in the queue [19]. It is the recommended way to find blockers [20]. It takes a short exclusive look at the lock manager, so do not call it in a tight loop [19].

```sql
SELECT blocked.pid                 AS blocked_pid,
       now() - blocked.query_start AS waiting_for,
       left(blocked.query, 80)     AS blocked_query,
       blocking.pid                AS blocking_pid,
       blocking.state              AS blocking_state,
       now() - blocking.xact_start AS blocking_xact_age,
       left(blocking.query, 80)    AS blocking_query
FROM pg_stat_activity AS blocked
CROSS JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS b(pid)
JOIN pg_stat_activity AS blocking ON blocking.pid = b.pid
ORDER BY waiting_for DESC;
```

A blocker PID of `0` means a prepared transaction holds the lock [19].

### 11.2 `pg_locks`

`pg_locks` shows table-level and other heavyweight locks, held (`granted = true`) or awaited [20]. Row locks are stored on disk, not in this view; a session waiting for a row lock shows as waiting for the **transaction ID** of the holder (`locktype = 'transactionid'`) [20].

```sql
SELECT l.pid, l.locktype, l.relation::regclass AS relation, l.mode, l.granted,
       l.waitstart,                       -- PG 14+ [12]
       a.state, left(a.query, 80) AS query
FROM pg_locks AS l
JOIN pg_stat_activity AS a USING (pid)
WHERE l.relation = 'orders'::regclass
ORDER BY l.granted DESC, l.waitstart;
```

### 11.3 Logging

- `log_lock_waits = on` logs any lock wait longer than `deadlock_timeout` [9][8]. It is `off` by default in PG 14–18 [9] and `on` by default in PG 19 (PG 19, beta — may change) [10]. Turn it on; it is cheap and explains most "random" slowdowns.
- `log_lock_failures` (PG 18+) logs lock failures from `SELECT ... NOWAIT` [9][13].
- Lower `deadlock_timeout` only to investigate; it also controls when lock waits are logged [8].
- PG 19 adds a `pg_stat_lock` view with per-lock-type statistics (PG 19, beta — may change) [10].

### 11.4 Wait events

`pg_stat_activity.wait_event_type` tells you what a session waits for [21]. `Lock` means a heavyweight lock; the `wait_event` names the object type: `relation` (table), `transactionid` (row lock holder), `tuple`, `advisory`, `virtualxid` (for example `CREATE INDEX CONCURRENTLY` waiting for older transactions) [21]. `LWLock`, `IO`, `IPC` and `Client` are internal or I/O waits, not row/table locks. The `pg_wait_events` view (PG 17+) describes each event [11].

```sql
SELECT wait_event_type, wait_event, count(*)
FROM pg_stat_activity
WHERE state = 'active'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

---

## 12. Transaction ID and multixact wraparound (brief)

Transaction IDs are 32-bit numbers. To keep comparisons correct, vacuum must **freeze** old rows before IDs wrap around after about 2 billion transactions [6]. Autovacuum forces an anti-wraparound vacuum when a table's age passes `autovacuum_freeze_max_age` (default 200 million) [6]. If freezing falls behind, PostgreSQL warns when 40 million transactions remain and stops assigning new transaction IDs when 3 million remain [6]. PG 19 raises the warning threshold to 100 million (PG 19, beta — may change) [10]. Multixact IDs (section 6.4) have the same problem and their own settings [6].

The usual cause is the same as for bloat: something holds the xmin horizon (section 10). Monitor:

```sql
SELECT datname,
       age(datfrozenxid)    AS xid_age,
       mxid_age(datminmxid) AS multixact_age
FROM pg_database
ORDER BY xid_age DESC;
```

Alert well before 200 million and investigate long transactions and slots first. Details and tuning: [09-operations-and-server-tuning.md](09-operations-and-server-tuning.md).

---

## 13. Application rules

1. **Short transactions.** Open the transaction just before the first write that needs it; commit right after the last. Never keep one open across user input, a page render, or a `sleep`.
2. **No external calls inside a transaction.** HTTP requests, LLM calls, emails, payment APIs and message brokers cannot be rolled back and can be slow. If the transaction rolls back or is retried, the side effect is wrong or doubled [39]. Write an outbox row in the transaction and let a worker do the call after commit ([07](07-schema-design-and-patterns.md)).
3. **One connection per transaction, always released.** Use `pool.connect()` + `try/finally` + `client.release()`; forgetting `release()` exhausts the pool [44]. Prisma interactive transactions time out after 5 s by default [45]; do not raise that limit to hide slow work.
4. **Handle failures explicitly.** Roll back on any error; retry `40001`/`40P01` with the whole transaction (section 4).
5. **Prefer constraints and atomic statements over application checks.** They are correct under any concurrency.
6. **Set protective timeouts** on application roles (section 9).
7. **Avoid two-phase commit.** `PREPARE TRANSACTION` "is not intended for use in applications"; keep `max_prepared_transactions = 0` (the default) unless you run a transaction manager [24].
8. **Cross-system consistency** (database + queue + external API): use the transactional outbox, idempotent consumers, and sagas (a sequence of local transactions with compensating actions) instead of distributed transactions ([07](07-schema-design-and-patterns.md)) [39].
9. **Monitor** long transactions, blocked sessions, deadlocks and wraparound age (sections 10–12).

---

## Sources

1. [13.2. Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html) — PostgreSQL 18 docs: levels, anomaly table, Read Committed re-check, MERGE/ON CONFLICT in Read Committed, Repeatable Read and SSI errors, Serializable performance advice.
2. [13.3. Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) — PostgreSQL docs: table and row lock modes, conflict tables, deadlocks, advisory locks and the LIMIT pitfall.
3. [13.1. Introduction (Concurrency Control)](https://www.postgresql.org/docs/current/mvcc-intro.html) — PostgreSQL docs: MVCC, snapshots, readers and writers do not block each other.
4. [13.5. Serialization Failure Handling](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html) — PostgreSQL docs: retry 40001 and 40P01, caution for 23505/23P01, retry the complete transaction.
5. [65.7. Heap-Only Tuples (HOT)](https://www.postgresql.org/docs/current/storage-hot.html) — PostgreSQL docs: HOT conditions, fillfactor, monitoring.
6. [24.1. Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html) — PostgreSQL docs: XID and multixact wraparound, thresholds, autovacuum lock behavior.
7. [19.11. Client Connection Defaults](https://www.postgresql.org/docs/current/runtime-config-client.html) — PostgreSQL docs: statement/lock/idle/transaction timeouts, defaults and warnings, default_transaction_isolation.
8. [19.12. Lock Management](https://www.postgresql.org/docs/current/runtime-config-locks.html) — PostgreSQL docs: deadlock_timeout, max_locks_per_transaction, max_pred_locks_per_transaction defaults.
9. [19.8. Error Reporting and Logging (PG 18)](https://www.postgresql.org/docs/18/runtime-config-logging.html) — PostgreSQL 18 docs: log_lock_waits default off, log_lock_failures.
10. [PostgreSQL 19 Release Notes (Beta 4)](https://www.postgresql.org/docs/19/release-19.html) — postgresql.org: log_lock_waits on by default, pg_stat_lock, wraparound warning at 100 million, ON CONFLICT DO SELECT, max_locks_per_transaction 128.
11. [PostgreSQL 17 Release Notes](https://www.postgresql.org/docs/release/17.0/) — postgresql.org: transaction_timeout, pg_wait_events.
12. [PostgreSQL 14 Release Notes](https://www.postgresql.org/docs/release/14.0/) — postgresql.org: idle_session_timeout, pg_locks.waitstart.
13. [PostgreSQL 18 Release Notes](https://www.postgresql.org/docs/release/18.0/) — postgresql.org: log_lock_failures.
14. [SELECT (The Locking Clause)](https://www.postgresql.org/docs/current/sql-select.html) — PostgreSQL docs: NOWAIT, SKIP LOCKED, restrictions, ORDER BY caveat.
15. [INSERT (ON CONFLICT)](https://www.postgresql.org/docs/current/sql-insert.html) — PostgreSQL docs: atomic upsert guarantee, cardinality rule, arbiters.
16. [MERGE](https://www.postgresql.org/docs/current/sql-merge.html) — PostgreSQL docs: concurrency note recommending ON CONFLICT.
17. [9.17. Sequence Manipulation Functions](https://www.postgresql.org/docs/current/functions-sequence.html) — PostgreSQL docs: nextval is never rolled back, gaps.
18. [9.28. System Administration Functions](https://www.postgresql.org/docs/current/functions-admin.html) — PostgreSQL docs: pg_cancel_backend, pg_terminate_backend, advisory lock functions.
19. [9.27. System Information Functions](https://www.postgresql.org/docs/current/functions-info.html) — PostgreSQL docs: pg_blocking_pids (hard/soft blocks, cost), pg_current_xact_id, pg_xact_status.
20. [pg_locks](https://www.postgresql.org/docs/current/view-pg-locks.html) — PostgreSQL docs: columns, waitstart, row locks shown as transaction ID waits.
21. [27.2. The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html) — PostgreSQL docs: pg_stat_activity states, backend_xmin, wait event types and Lock wait events.
22. [SET TRANSACTION](https://www.postgresql.org/docs/current/sql-set-transaction.html) — PostgreSQL docs: isolation, READ ONLY, DEFERRABLE.
23. [SAVEPOINT](https://www.postgresql.org/docs/current/sql-savepoint.html) — PostgreSQL docs: savepoint semantics.
24. [PREPARE TRANSACTION](https://www.postgresql.org/docs/current/sql-prepare-transaction.html) — PostgreSQL docs: not for applications, max_prepared_transactions.
25. [SET](https://www.postgresql.org/docs/current/sql-set.html) — PostgreSQL docs: SET vs SET LOCAL behavior.
26. [ALTER ROLE](https://www.postgresql.org/docs/current/sql-alterrole.html) — PostgreSQL docs: per-role and per-database settings and precedence.
27. [55.2. Message Flow (Multiple Statements in a Simple Query)](https://www.postgresql.org/docs/current/protocol-flow.html) — PostgreSQL docs: implicit transaction for multi-statement strings.
28. [Appendix A. PostgreSQL Error Codes](https://www.postgresql.org/docs/current/errcodes-appendix.html) — PostgreSQL docs: SQLSTATE values used here.
29. [Transactional DDL in PostgreSQL: A Competitive Analysis](https://wiki.postgresql.org/wiki/Transactional_DDL_in_PostgreSQL:_A_Competitive_Analysis) — PostgreSQL wiki: DDL rollback.
30. [SSI](https://wiki.postgresql.org/wiki/SSI) — PostgreSQL wiki: write skew, read-only anomaly, false positives.
31. [The Internals of PostgreSQL, 5.2 Tuple Structure](https://www.interdb.jp/pg/pgsql05/02.html) — Hironobu Suzuki: t_xmin, t_xmax, t_cid, t_ctid.
32. [The Internals of PostgreSQL, 5.5 Transaction Snapshot](https://www.interdb.jp/pg/pgsql05/05.html) — Hironobu Suzuki: snapshot format, when snapshots are taken.
33. [The Internals of PostgreSQL, 5.8 Preventing Lost Updates](https://www.interdb.jp/pg/pgsql05/08.html) — Hironobu Suzuki: first-updater-win.
34. [Designing Data-Intensive Applications](https://dataintensive.net/) — Martin Kleppmann (O'Reilly): transactions chapter, write skew example.
35. [Four reasons why VACUUM won't remove dead rows from a table](https://www.cybertec-postgresql.com/en/reasons-why-vacuum-wont-remove-dead-rows/) — Cybertec, Laurenz Albe: xmin horizon holders and detection queries.
36. [Debugging deadlocks in PostgreSQL](https://www.cybertec-postgresql.com/en/debugging-deadlocks-in-postgresql/) — Cybertec, Laurenz Albe: reading deadlock messages, FOR KEY SHARE from foreign keys, FOR NO KEY UPDATE.
37. [Transaction anomalies with SELECT FOR UPDATE](https://www.cybertec-postgresql.com/en/transaction-anomalies-with-select-for-update/) — Cybertec, Laurenz Albe: inconsistent results in Read Committed.
38. [Postgres Job Queues & Failure By MVCC](https://brandur.org/postgres-queues) — Brandur Leach: long transactions degrade queue tables.
39. [Using Atomic Transactions to Power an Idempotent API](https://brandur.org/http-transactions) — Brandur Leach: foreign state mutations, staged jobs, retries.
40. [Zero-downtime Postgres migrations - the hard parts](https://gocardless.com/blog/zero-downtime-postgres-migrations-the-hard-parts) — GoCardless, Chris Sinjakli: lock queue incident.
41. [Zero-downtime Postgres schema migrations need this: lock_timeout and retries](https://postgres.ai/blog/20210923-zero-downtime-postgres-schema-migrations-lock-timeout-and-retries) — postgres.ai, Nikolay Samokhvalov: lock queue, lock_timeout with retries, subtransaction caveats.
42. [PgBouncer features](https://www.pgbouncer.org/features.html) — PgBouncer: session features not supported in transaction pooling (SET, session advisory locks).
43. [Transactions](https://node-postgres.com/features/transactions) — node-postgres docs: same client for a transaction, no pool.query.
44. [Client](https://node-postgres.com/apis/client) and [Pool](https://node-postgres.com/apis/pool) — node-postgres docs: timeout options, release(destroy), pool exhaustion.
45. [Transactions and batch queries (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions) — Prisma docs: interactive transaction defaults, isolation levels, P2034 retry, optimistic concurrency.
46. [Error message reference (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/reference/error-reference) — Prisma docs: P2034 and related codes.
47. [Prisma 7.10.0 release notes](https://github.com/prisma/orm/releases/tag/7.10.0) — GitHub, Prisma: 40P01 reported as P2034.
48. [REINDEX](https://www.postgresql.org/docs/current/sql-reindex.html) — PostgreSQL docs: locks of plain and concurrent REINDEX.
49. [ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) — PostgreSQL docs: lock level per subform, NOT VALID and VALIDATE CONSTRAINT locks.
50. [Prisma schema engine: Postgres advisory lock](https://github.com/prisma/prisma-engines/blob/main/schema-engine/connectors/sql-schema-connector/src/flavour/postgres.rs) — GitHub, prisma-engines source: `SELECT pg_advisory_lock(72707369)` with a timeout.
