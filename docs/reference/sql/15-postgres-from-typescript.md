# Using PostgreSQL from TypeScript and Node.js

> Part of the [SQL & PostgreSQL reference library](README.md) · Last researched: 2026-10-05 · Targets PostgreSQL 14–18 (19 beta noted where relevant)

**What this covers.** How a TypeScript/Node.js application should talk to PostgreSQL: choosing a data-access layer, the node-postgres (`pg`) driver in depth, Prisma ORM 7 with the `@prisma/adapter-pg` driver adapter, common patterns (transactions, retries, bulk writes, streaming, timeouts, shutdown), type safety, testing with real databases, and observability. Security topics (injection, roles, RLS context) are in [11-security.md](11-security.md); query recipes are in [04-query-patterns-and-antipatterns.md](04-query-patterns-and-antipatterns.md).

Versions checked on the npm registry on 2026-10-05 [66]: `pg` 8.23.1, `postgres` (postgres.js) 3.4.9, `kysely` 0.29.6, `drizzle-orm` 0.45.3 (1.0 in release candidate), `@prisma/client` 7.10.0, `typeorm` 1.1.1, `@mikro-orm/core` 7.2.3, `@electric-sql/pglite` 0.5.8, `testcontainers` 12.2.0. Driver behaviors described below (type parsing, error fields, protocol modes) were checked with `pg` 8.23.1 against PostgreSQL 18.3 (PGlite).

## Key rules (TL;DR)

1. Create **one** pool per process (or one `PrismaClient`) and reuse it; never create a pool per request.
2. Size pools so that *instances × pool max* stays well below the server's `max_connections`; use an external pooler when instances scale automatically.
3. Always release checked-out clients in `finally`; release a broken client with `release(err)` so it is destroyed.
4. Run a transaction on **one** checked-out client (`BEGIN` … `COMMIT`/`ROLLBACK`), never with `pool.query`.
5. Keep transactions short: no HTTP calls, e-mails, queue publishing or LLM calls inside them.
6. Set `statement_timeout` (server-side) for every role or session; `query_timeout` in `pg` only stops waiting on the client side.
7. Retry the **whole** transaction on SQLSTATE `40001` and `40P01` (Prisma: `P2034`), with backoff and a retry limit.
8. Pass every value as a parameter; for identifiers use allow-lists (see [11-security.md](11-security.md)).
9. Know the default type mapping: `bigint`/`count(*)` and `numeric` arrive as strings in `pg`, as `BigInt` and `Decimal` in Prisma; `date` becomes a local-midnight `Date`.
10. Prefer `timestamptz` columns; `timestamp` without time zone is read in the Node process's local time zone.
11. Batch writes with `INSERT ... SELECT * FROM unnest($1::type[], ...)` or `COPY`; batch reads with `= ANY($1)`.
12. Stream large results with a cursor or `pg-query-stream`; do not load millions of rows into memory.
13. Use `LISTEN` on a dedicated long-lived client, never through a transaction-mode pooler.
14. Map database errors by `error.code` (SQLSTATE) and `error.constraint`, which requires named constraints.
15. In Prisma 7, pass the pool settings to `PrismaPg` (defaults changed from Prisma 6), or pass your own `pg.Pool` to share it with raw `pg` code.
16. In Prisma interactive transactions, use the `tx` client for every query; the defaults are `maxWait` 2 s and `timeout` 5 s.
17. Use `$queryRaw` tagged templates, `Prisma.sql` and `Prisma.join`; treat `$queryRawUnsafe` and `Prisma.raw` as dangerous.
18. Put what the Prisma schema cannot express (exclusion constraints, triggers, RLS, extensions, `CHECK`) in migration SQL; declare unknown types with `Unsupported("...")`.
19. Validate JSON/JSONB columns and raw-query results at runtime (for example with zod).
20. Test against real PostgreSQL (Testcontainers) with the same major version and the same migrations as production; use PGlite or pg-mem only for fast, limited tests.
21. Set `application_name` per service, and tag queries (sqlcommenter) so database statistics can be linked to code.
22. On shutdown, stop taking work, wait for in-flight queries, then call `pool.end()` / `prisma.$disconnect()`.

## 1. Choosing a data-access layer

### 1.1 The options

| Kind | Examples | What you write | Strengths | Weaknesses |
|---|---|---|---|---|
| Raw driver | `pg` (node-postgres), `postgres` (postgres.js) | SQL strings with parameters | Full SQL power, no magic, fastest to debug | Results are untyped unless you add types; repetitive CRUD |
| Query builder | Kysely | Type-safe SQL-shaped TypeScript | SQL-like, very good types, no runtime schema; values in its `sql` template are parameters [42] | Types must be generated or written; complex SQL sometimes needs `sql` fragments |
| ORM | Prisma ORM, Drizzle ORM, TypeORM, MikroORM | Model operations (`findMany`, `create`) | Fast CRUD, relations, migrations included | Hides SQL; hard queries need raw SQL; each ORM has its own pitfalls |
| Typed SQL | Prisma TypedSQL (preview), PgTyped, sqlc (TypeScript plugin) | `.sql` files; types generated from the database | Real SQL with checked types | Needs a database at code-generation time; dynamic SQL is limited |
| Schema → types | Kanel, kysely-codegen | Nothing; types generated from a live database | Keeps TypeScript types in sync with the schema | Only types; you still choose how to query |

Status notes (October 2026):

- **Prisma ORM 7** is the current stable major (7.10.0). **Prisma ORM 8** is a release candidate, with general availability "expected in October 2026" [40]. It is a deep redesign (a "contract" instead of `schema.prisma`, `db.transaction()` instead of `$transaction`, SQLSTATE-style error codes, PostgreSQL only at first) [41]. "Prisma ORM 7 keeps receiving bug fixes and security updates for 18 months from the day Prisma ORM 8 reaches general availability" [40]. This page covers Prisma 7.
- **Drizzle ORM**: 0.45.x is the npm `latest`; 1.0 is in release candidate [66]. It describes itself as "a headless TypeScript ORM" with "both relational and SQL-like query APIs" and "exactly 0 dependencies" [45]; its `sql` template turns values into `$1` parameters [44].
- **TypeORM** reached 1.0 in May 2026, **MikroORM** 7.0 in March 2026 [66].
- **PgTyped**'s last npm release is from March 2025 (2.4.3), although its repository is still active; **sqlc**'s TypeScript plugin (`sqlc-gen-typescript`) has had no commits since November 2024 [66]. Check activity before adopting either.

### 1.2 How to choose

- **CRUD-heavy app, team prefers models** → an ORM (Prisma or Drizzle), plus raw SQL for the 10% of hard queries (reports, window functions, recursive CTEs, bulk upserts, full-text/vector search).
- **SQL-first team** → Kysely or `pg` + generated types (Kanel or PgTyped).
- **Libraries, scripts, migrations tooling** → the raw driver.

Mixing is normal and healthy. The important rule is to share **one connection pool** between the ORM and raw SQL, so connection limits stay predictable. With Prisma 7 this is easy: give `PrismaPg` your own `pg.Pool` (section 3.2).

## 2. node-postgres (`pg`) essentials

### 2.1 Pool vs Client

- A `Client` is one connection. Opening one "requires a handshake which can take 20-30 milliseconds" [1], and each connection uses server memory.
- A `Pool` keeps connections open and lends them out. "You generally want a limited number of these in your application and usually just 1" [1].
- `pool.query(text, values)` borrows a client, runs **one** statement, and returns the client. Use it for single statements.
- `pool.connect()` gives you a client for several statements in a row: transactions, cursors, `COPY`, session settings. You **must** release it [2].

```ts
import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: 'api',             // visible in pg_stat_activity and logs
  max: 10,                             // default 10
  idleTimeoutMillis: 30_000,           // default 10_000
  connectionTimeoutMillis: 5_000,      // default 0 = wait forever
  statement_timeout: 5_000,            // server-side limit per statement (ms)
  idle_in_transaction_session_timeout: 30_000,
});

// Without this listener, an error on an idle client (network drop, server restart)
// is an unhandled 'error' event and crashes the process.
pool.on('error', (err) => {
  console.error('idle pg client error', err);
});
```

The pool "will emit an error on behalf of any idle clients it contains if a backend error or network partition happens" [1]. Clients you hold for a long time (for example for `LISTEN`) need their own `client.on('error', ...)` listener.

### 2.2 Pool options

| Option | Default | Meaning [2] [46] |
|---|---|---|
| `max` | 10 | Maximum clients in the pool |
| `min` (pg 8.16+) | 0 | Keep at least this many idle clients (it does not pre-create them) |
| `idleTimeoutMillis` | 10000 | Close a client idle for this long; `0` disables |
| `connectionTimeoutMillis` | 0 (no timeout) | How long `connect()` waits for a new connection or a free client |
| `maxUses` | Infinity | Recycle a client after N checkouts |
| `maxLifetimeSeconds` | 0 (disabled) | Retire a client that has existed for N seconds, "regardless of whether they are idle" |
| `allowExitOnIdle` | false | Let the process exit when all clients are idle (scripts, tests) |
| `onConnect` (pg 8.20+) | — | Async setup for each new connection; if it throws, the client is destroyed [2] [7] |
| `pipeline` (pg 8.23+) | false | Send queries without waiting for previous responses [2] [7] |

All client options (`statement_timeout`, `query_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `application_name`, `ssl`, `keepAlive`, ...) can also be given to the pool, which passes them to each client [3].

Note: `connectionTimeoutMillis: 0` means a request can wait forever for a free client when the pool is exhausted. Always set it, so overload fails fast and visibly.

### 2.3 Pool sizing

The total number of server connections is *number of processes × `max`* (plus admin tools, migrations, workers). It must stay below `max_connections` (typically 100) minus reserved slots (see [11-security.md](11-security.md) section 7.5).

The `pg` author's guidance [4]:

- With a fixed number of instances, compute the share per instance but keep headroom; e.g. with a 200-connection server and 4 instances he would "probably set the `max` to 20 or 25", not 50, so that management tools and scaling still work.
- "If your app is starved for db connections, you probably want to take a look at your queries and make them execute faster".
- With auto-scaling or serverless, put a pooler (PgBouncer, RDS Proxy, Supabase/Neon poolers, Cloudflare Hyperdrive) in front of PostgreSQL and keep each pool small.

More connections do not mean more throughput: past a point, they compete for CPU, locks and memory. See [09-operations-and-server-tuning.md](09-operations-and-server-tuning.md) for server-side pooling.

### 2.4 Always release clients

"If you forget to release the client then your application will quickly exhaust available, idle clients in the pool" [2]. Use `try/finally`. If the client may be broken (protocol error, stuck transaction), pass `true` or the error to `release()` so the pool destroys it instead of reusing it [2].

```ts
const client = await pool.connect();
let broken: Error | undefined;
try {
  await client.query("SET statement_timeout = '60s'"); // session setting for one long job
  await runLongReport(client);
  await client.query('RESET statement_timeout');        // do not leak it to the next borrower
} catch (err) {
  broken = err as Error;
  throw err;
} finally {
  client.release(broken); // truthy argument = destroy this client instead of reusing it
}
```

Session-level `SET` on a pooled client stays on that connection for the next borrower. Prefer `SET LOCAL` inside a transaction, which ends with the transaction.

`client.getTransactionStatus()` (pg 8.21+) returns `'I'` (idle), `'T'` (in a transaction) or `'E'` (failed transaction, needs `ROLLBACK`) [3] [7]. A cheap safety check before release: if it is not `'I'`, destroy the client instead of returning it with an open transaction.

### 2.5 Timeouts

| Setting | Where it acts | What happens |
|---|---|---|
| `statement_timeout` | Server | Cancels any statement running longer; error `57014` (`query_canceled`). "A value of zero (the default) disables the timeout" [67] |
| `lock_timeout` | Server | Fails a statement that waits too long for a lock (`55P03`) [67] |
| `idle_in_transaction_session_timeout` | Server | Terminates a session that stays idle inside an open transaction; an open transaction also "prevents vacuuming away recently-dead tuples" [67] |
| `transaction_timeout` (PG 17+) | Server | Terminates a session whose transaction lasts too long [67] |
| `query_timeout` (pg option, per query since pg 8.13) | Client | Rejects the promise with "Query read timeout"; the source code shows it does **not** cancel the statement on the server [8] |
| `connectionTimeoutMillis` | Client | Fails `connect()` if no connection is available in time |

Use `statement_timeout` as the main protection, set per role (`ALTER ROLE ... SET`, see [11-security.md](11-security.md)) or per pool. Override it for a single long operation inside a transaction with `SET LOCAL statement_timeout = '60s'`. Use `query_timeout` only as a backstop slightly above `statement_timeout`. node-postgres has no `AbortSignal` support in its client options [3].

### 2.6 Transactions

"You must use the same client instance for all statements within a transaction" and "Do not use transactions with the pool.query method" [5]. A reusable helper:

```ts
import type { Pool, PoolClient } from 'pg';

export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  isolation: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' = 'READ COMMITTED',
): Promise<T> {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`); // value comes from the union type, not user input
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroy = true; // connection is unusable: do not return it to the pool
    }
    throw err;
  } finally {
    client.release(destroy);
  }
}

// Usage
const balances = await withTransaction(pool, async (tx) => {
  await tx.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [30, fromId]);
  await tx.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [30, toId]);
  return (await tx.query('SELECT id, balance FROM accounts WHERE id = ANY($1)', [[fromId, toId]])).rows;
}, 'SERIALIZABLE');
```

This follows the documented pattern (`BEGIN`, work, `COMMIT`; `ROLLBACK` in `catch`; `release()` in `finally`) [5], and also destroys a client whose rollback failed. A failed statement aborts the whole transaction: after an error, only `ROLLBACK` (or rolling back to a savepoint) works; other statements fail with `25P02`. Isolation levels, locking and deadlocks are explained in [08-transactions-concurrency-locking.md](08-transactions-concurrency-locking.md).

### 2.7 Parameters, prepared statements and protocol modes

- Parameters: `$1`, `$2`... with a values array [6]. JavaScript values are converted: `null`/`undefined` → `NULL`; `Date` → timestamp string; arrays → PostgreSQL arrays; other objects → `JSON.stringify` [6]. Add explicit casts when the type is ambiguous: `$1::uuid`, `$2::int[]`.
- Named prepared statements: give the query a `name`. The first time, the client parses it; the next times it sends only the name. The plan is cached "on a per connection basis" [6]. Use names for very hot queries only; with PgBouncer in transaction mode, protocol-level prepared statements need PgBouncer 1.21+ with `max_prepared_statements` set [13] [20].
- Without parameters, `pg` uses the simple protocol, which accepts several statements separated by `;`. With `queryMode: 'extended'` (pg 8.12+), even parameterless queries use the extended protocol, which rejects them ("cannot insert multiple commands into a prepared statement") [7]. This is useful defense in depth.
- `rowMode: 'array'` returns rows as arrays instead of objects [6].

### 2.8 Large results: cursors and streams

Loading a big result with `pool.query` keeps every row in memory. Two tools fetch rows in batches through a server-side cursor; both need a checked-out client.

`pg-cursor` [9]:

```ts
import Cursor from 'pg-cursor';

const client = await pool.connect();
try {
  const cursor = client.query(new Cursor('SELECT id, payload FROM events WHERE kind = $1 ORDER BY id', ['click']));
  for (;;) {
    const rows = await cursor.read(1_000);
    if (rows.length === 0) break;
    await handleBatch(rows);
  }
  await cursor.close();
} finally {
  client.release();
}
```

`pg-query-stream` gives a Node readable stream; it "uses a cursor on the server so it efficiently keeps only a low number of rows in memory" [10]. Streams are async-iterable:

```ts
import QueryStream from 'pg-query-stream';

const client = await pool.connect();
try {
  const stream = client.query(new QueryStream('SELECT id, payload FROM events ORDER BY id', [], { batchSize: 1_000 }));
  for await (const row of stream) {
    await handle(row); // backpressure: the stream waits for you
  }
} finally {
  client.release();
}
```

The cursor lives inside a transaction-like context on that connection for its whole life. Keep the processing fast, or export the data first. For paginated APIs, prefer keyset pagination (section 4.6).

### 2.9 COPY for bulk import and export

`COPY` is PostgreSQL's fastest path for loading or exporting many rows. `pg-copy-streams` exposes it as Node streams [11]:

```ts
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';

const client = await pool.connect();
try {
  // Import a CSV file
  const ingest = client.query(copyFrom('COPY staging_orders (id, customer_id, total) FROM STDIN WITH (FORMAT csv, HEADER true)'));
  await pipeline(fs.createReadStream('orders.csv'), ingest);

  // Export a query to a file
  const out = client.query(
    copyTo(`COPY (SELECT id, total FROM orders WHERE created_at >= now() - interval '1 day') TO STDOUT WITH (FORMAT csv)`),
  );
  await pipeline(out, fs.createWriteStream('orders-today.csv'));
} finally {
  client.release();
}
```

Notes from the README [11]: do not use `pool.query()` with COPY streams; when copying out, data arrives in chunks that can cut rows in the middle (use a CSV parser that handles this); since 6.0, destroying an unfinished `copyFrom` stream sends `CopyFail` and rolls back the copy. Load into a staging table, validate, then `INSERT ... SELECT` into the real table.

### 2.10 LISTEN/NOTIFY

`NOTIFY` sends a small message to every session that ran `LISTEN` on a channel. Use cases: wake up workers, invalidate caches. Rules:

- Notifications are delivered only after the sending transaction commits [12].
- The payload "must be shorter than 8000 bytes" in the default configuration; send an ID, not the data [12].
- `LISTEN` needs a **dedicated** session: a pooled client goes back to the pool, and transaction-mode PgBouncer does not support `LISTEN` at all [13].
- Messages sent while your listener is disconnected are lost. After a reconnect, re-check the table for pending work (for example a queue table, see [07-schema-design-and-patterns.md](07-schema-design-and-patterns.md)).

```ts
import pg from 'pg';

export async function listenForJobs(onJob: (id: string) => void): Promise<pg.Client> {
  const listener = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'job-listener' });
  listener.on('error', (err) => {
    console.error('listener error, reconnecting', err);
    listener.end().catch(() => {});                       // drop the broken connection
    setTimeout(() => void listenForJobs(onJob), 1_000);   // then re-scan pending jobs in the table
  });
  listener.on('notification', (msg) => {
    if (msg.channel === 'jobs' && msg.payload) onJob(msg.payload);
  });
  await listener.connect();
  await listener.query('LISTEN jobs'); // channel names are identifiers: use constants
  return listener;
}

// Sender: parameterized (NOTIFY itself only accepts a literal payload)
await pool.query('SELECT pg_notify($1, $2)', ['jobs', jobId]);
```

### 2.11 Errors: SQLSTATE codes and constraint names

Errors from the server are `DatabaseError` objects with fields such as `code` (the 5-character SQLSTATE), `constraint`, `table`, `schema`, `column` and `detail`. A duplicate e-mail, for example, gives `code: '23505'`, `constraint: 'users_email_key'`, `detail: 'Key (email)=(a@x) already exists.'`.

| SQLSTATE | Name [65] | Typical handling |
|---|---|---|
| `23505` | `unique_violation` | Map by constraint name to "already exists" (HTTP 409) |
| `23503` | `foreign_key_violation` | "Referenced row missing" or "still referenced" |
| `23502` | `not_null_violation` | Bug or validation gap |
| `23514` | `check_violation` | Map by constraint name to a validation error |
| `23P01` | `exclusion_violation` | Overlap (bookings, ranges) |
| `40001` | `serialization_failure` | Retry the whole transaction |
| `40P01` | `deadlock_detected` | Retry the whole transaction |
| `55P03` | `lock_not_available` | Lock timeout or `NOWAIT`; retry later or report busy |
| `57014` | `query_canceled` | `statement_timeout` or a cancel request |
| `53300` | `too_many_connections` | Back off; check pool sizing |
| `25P02` | `in_failed_sql_transaction` | A previous error in this transaction; roll back |
| `42501` | `insufficient_privilege` | Role setup problem; do not retry |
| `08006`, `57P01` | `connection_failure`, `admin_shutdown` | Reconnect; retry only idempotent work |

```ts
import { DatabaseError } from 'pg';

export function mapDbError(err: unknown): Error {
  if (err instanceof DatabaseError) {
    if (err.code === '23505' && err.constraint === 'users_email_key') return new EmailTakenError();
    if (err.code === '23514' && err.constraint === 'orders_total_positive') return new ValidationError('total');
  }
  return err as Error;
}
```

Mapping by constraint name only works if constraints have stable, explicit names (see naming rules in [07-schema-design-and-patterns.md](07-schema-design-and-patterns.md)). Never send `err.message` or `err.detail` to end users: they can contain data and schema names.

### 2.12 Type parsing: what you get back

By default "the PostgreSQL backend server returns everything as strings", and `pg-types` converts some types [15]. Defaults in `pg` 8 (verified on `pg` 8.23.1):

| PostgreSQL type | JavaScript value | Watch out |
|---|---|---|
| `int2`, `int4`, `float4`, `float8` | `number` | — |
| `int8` / `bigint`, `count(*)` | `string` | JavaScript numbers are exact only up to 2^53 − 1, so `pg` "just returns int8 results as strings" [15] |
| `numeric` / `decimal` | `string` | Keep it a string or use a decimal library; never `parseFloat` money |
| `numeric[]` | array of `number` | Precision loss: the array parser uses floats [16] |
| `boolean` | `boolean` | — |
| `text`, `varchar`, `uuid` | `string` | "node-postgres converts a uuid to a string" [14] |
| `json`, `jsonb` | parsed object | Not validated: see section 5.2 |
| `timestamptz` | `Date` | Correct instant; microseconds are cut to milliseconds [14] |
| `timestamp` (no time zone) | `Date` | Interpreted in the Node process's **local** time zone [14] |
| `date` | `Date` at local midnight | "Force YYYY-MM-DD dates to be parsed as local time" [17]; `2026-10-05` printed as `2026-10-04T22:00:00Z` in Paris |
| `interval` | object (`{ days: 1, hours: 2 }`) | — |
| `bytea` | `Buffer` | — |
| `'infinity'` timestamps | `Infinity` (a number) | Check before calling `Date` methods |

Override parsers once, at startup, with `pg.types.setTypeParser(oid, fn)` [15]:

```ts
import pg from 'pg';

// int8 -> bigint (exact). Do it only if your code and JSON layer handle BigInt.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => BigInt(value));

// date -> keep 'YYYY-MM-DD' strings (no time zone shift)
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

// numeric stays a string by default: convert with a decimal library where you compute
```

`JSON.stringify` throws on `BigInt` values; convert them at the API boundary (for example to strings). A per-query `types` option exists for local overrides [6]. Prefer `timestamptz` for all instants (see [03-postgresql-features-and-types.md](03-postgresql-features-and-types.md)), and run Node with `TZ=UTC` in servers to avoid surprises with `timestamp` and `date`.

### 2.13 TLS settings

- Pass `ssl: { ca, rejectUnauthorized: true }` or use `sslmode=verify-full` in the URL; never `rejectUnauthorized: false` in production. Details and the pg 8 / pg 9 `sslmode` change are in [11-security.md](11-security.md) section 8.1 [18].
- Do not mix a URL `sslmode` with an `ssl` object: fields parsed from `connectionString` override the same fields of the config object (`Object.assign({}, config, parse(config.connectionString))`) [19].
- `sslnegotiation=direct` (PostgreSQL 17+, pg 8.22+) saves one round trip on connect [7].

### 2.14 postgres.js in short

postgres.js (`postgres` package) is the other popular driver [20]:

- Queries are tagged templates; `${value}` becomes a parameter, `${sql(name)}` an escaped identifier, `sql.unsafe()` raw text.
- Transactions: `await sql.begin(async (sql) => { ... })` reserves one connection and rolls back on error.
- Pool: lazy connections, `max` 10 by default; connections get a random maximum lifetime between 45 and 90 minutes because the driver prepares statements automatically.
- Prepared statements are automatic; use `prepare: false` with old PgBouncer transaction mode (1.21+ can support them).
- `bigint` and `numeric` come back as strings unless you configure types.
- Cancel a running query with `query.cancel()` ("no guarantee that the query will be canceled").
- Shutdown: `await sql.end({ timeout: 5 })`.

## 3. Prisma ORM 7 essentials

### 3.1 What changed in Prisma 7

Prisma 7 changed the architecture [21]:

- **Driver adapters are required.** Prisma no longer opens connections itself; for PostgreSQL you pass `@prisma/adapter-pg`, which uses node-postgres.
- The new **`prisma-client` generator** produces a "Rust-free client" ("faster queries, smaller bundle size"), and its `output` path is required. `prisma-client-js` is deprecated.
- **ESM only**; Node.js 20.19+ and TypeScript 5.4+.
- Connection settings for the CLI live in **`prisma.config.ts`**, not in the `datasource` block; environment variables are **not loaded automatically** (use `dotenv` or your platform).
- **Pool defaults now come from `pg`** and differ from Prisma 6 (table below): "the pg driver has no connection timeout by default (0), while Prisma ORM v6 used a 5-second timeout" [21].
- **TLS certificates are validated by default**; a bad setup shows up as `P1010` errors [21].
- `prisma migrate dev` no longer runs `prisma generate` or `prisma db seed` for you [21].
- The `$use` middleware API and the metrics preview are removed (use client extensions and OpenTelemetry) [21].

| Prisma 6 URL parameter | v6 default | Prisma 7 / `pg` option | v7 default [22] |
|---|---|---|---|
| `connection_limit` | `num_cpus * 2 + 1` | `max` | 10 |
| `pool_timeout` | 10 s | `connectionTimeoutMillis` | 0 (no timeout) |
| `connect_timeout` | 5 s | `connectionTimeoutMillis` | 0 (no timeout) |
| `max_idle_connection_lifetime` | 300 s | `idleTimeoutMillis` | 10 s |
| `max_connection_lifetime` | 0 | `maxLifetimeSeconds` | 0 |

### 3.2 Creating the client (and sharing the pool)

`PrismaPg` accepts a `pg.Pool`, a `pg.PoolConfig`, or a connection string, plus options: `schema`, `disposeExternalPool` (default `false`), `onPoolError`, `onConnectionError`, `userDefinedTypeParser`, and `statementNameGenerator` ("If not provided, prepared statements are not cached") [35].

```ts
// db.ts: one pool and one PrismaClient per process
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client'; // path = your generator "output"

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: 'api',
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 5_000,
});
pool.on('error', (err) => console.error('idle pg client error', err));

export const prisma = new PrismaClient({
  adapter: new PrismaPg(pool), // the same pool serves raw pg code: COPY, cursors, LISTEN clients
});
```

Why share the pool: one place to set limits and timeouts, one number to compare with `max_connections`, and raw `pg` features (COPY, cursors, streaming) next to the ORM. Two cautions:

- With an external pool, `disposeExternalPool` is `false` by default, so **you** call `pool.end()` at shutdown [35].
- The adapter checks `poolOrConfig instanceof pg.Pool` [35]. If two copies of `pg` are installed, the check fails and your pool is treated as a config object. Keep a single `pg` version in the lockfile.

"Creating multiple instances of `PrismaClient` can exhaust your database connection pool" [27]: export one instance. In development with hot reload, store it on `globalThis` so reloads do not create new pools.

### 3.3 Interactive transactions

```ts
import { Prisma } from './generated/prisma/client';

const order = await prisma.$transaction(
  async (tx) => {
    // Every query inside must use `tx`, not `prisma`
    const product = await tx.product.update({
      where: { id: productId },
      data: { stock: { decrement: quantity } },
    });
    if (product.stock < 0) throw new Error('Out of stock'); // any throw rolls back
    return tx.order.create({ data: { productId, quantity, customerId } });
  },
  {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 2_000, // time to get a connection; default 2000 ms
    timeout: 5_000, // max duration of the transaction; default 5000 ms
  },
);
```

- Defaults: `maxWait` 2000 ms, `timeout` 5000 ms; PostgreSQL supports `ReadUncommitted`, `ReadCommitted` (default), `RepeatableRead`, `Serializable` [23]. Defaults for all transactions can be set with `transactionOptions` in the `PrismaClient` constructor [28].
- "Keep transactions short... Try to avoid performing network requests and executing slow queries inside your transaction functions" [23].
- A query that uses `prisma` instead of `tx` inside the callback runs **outside** the transaction, on another connection. With RLS context set by `set_config(..., true)`, such a query also runs without the context (see [11-security.md](11-security.md) section 6.4).
- The array form `prisma.$transaction([queryA, queryB])` runs independent queries in one transaction [23].
- For the stock example, a `CHECK (stock >= 0)` constraint is a stronger guard than the `if`: the database enforces it for every code path.

Retries: with `@prisma/adapter-pg`, SQLSTATE `40001` and `40P01` are mapped to the error kind `TransactionWriteConflict` [34], surfaced as `P2034` "Transaction failed due to a write conflict or a deadlock. Please retry your transaction" [33]. The docs show a retry loop on `P2034` [23]; section 4.2 has a reusable version.

### 3.4 Raw SQL in Prisma

```ts
import { Prisma } from './generated/prisma/client';
import { z } from 'zod';

const RecentOrderRowsSchema = z.array(
  z.object({ id: z.bigint(), total: z.instanceof(Prisma.Decimal) }),
);

// Tagged template: values become parameters. The result is parsed, not typed with a cast.
const recent = RecentOrderRowsSchema.parse(
  await prisma.$queryRaw`
    SELECT id, total FROM orders
    WHERE customer_id = ${customerId}::uuid AND created_at > now() - interval '30 days'
    ORDER BY created_at DESC
    LIMIT ${limit}`,
);

// Lists and optional fragments
const statusFilter = status ? Prisma.sql`AND status = ${status}` : Prisma.empty;
const rows = z
  .array(z.object({ id: z.bigint() }))
  .parse(
    await prisma.$queryRaw`SELECT id FROM orders WHERE id IN (${Prisma.join(ids)}) ${statusFilter}`,
  );
```

- Parse every raw result with a zod row schema (`z.array(Row).parse(...)`), and let a failed parse
  throw: it means the SQL and the schema disagree, which is a bug, not input to recover from. The
  type argument (`$queryRaw<T>`) is an unchecked cast — nothing checks the rows against `T` — so
  repository code does not use it. Without one, `$queryRaw` returns `unknown`, which forces the
  parse.
- `$queryRaw`/`$executeRaw` run one statement per call [24].
- Result types: 64-bit integers → `BigInt`, `numeric` → `Decimal`, bytes → `Uint8Array`, JSON → object, dates → `Date` [24].
- "Prisma sends JavaScript integers to PostgreSQL as `INT8`"; cast (`${n}::int4`) when a function expects `int4` [24].
- Never build the SQL text from input: `$queryRawUnsafe` with concatenation and `Prisma.raw(input)` are injection holes [24] (details in [11-security.md](11-security.md) section 2).
- `Prisma.join(ids)` creates one parameter per element; very long lists approach the 65,535-parameter limit of a statement (the Bind message counts parameters in a 16-bit field [53]). For large lists, use the `pg` pool with one array parameter (`= ANY($1::bigint[])`, section 4.5).

**TypedSQL** (preview feature `typedSql`) generates typed functions from `.sql` files [25]:

```sql
-- prisma/sql/getRecentOrders.sql
-- @param {String} $1:customerId
-- @param {Int} $2:limit
SELECT id, total, created_at
FROM orders
WHERE customer_id = $1::uuid
ORDER BY created_at DESC
LIMIT $2;
```

```ts
// after `prisma generate --sql` (needs a reachable database)
import { getRecentOrders } from './generated/prisma/sql';

const orders = await prisma.$queryRawTyped(getRecentOrders(customerId, 20));
```

Limits: no dynamic column or table names, and generation requires a running database [25].

### 3.5 Avoiding N+1 queries and over-fetching

The *N+1 problem* is one query for a list plus one more query per item. With 50 items it is 51 round trips.

```ts
// Bad: N+1 (one query per user)
const users = await prisma.user.findMany({ take: 50 });
const postsByUser = new Map<string, unknown[]>();
for (const u of users) {
  postsByUser.set(u.id, await prisma.post.findMany({ where: { authorId: u.id } }));
}

// Good: 2 queries in total, and only the needed columns
const usersWithPosts = await prisma.user.findMany({
  take: 50,
  select: { id: true, name: true, posts: { select: { id: true, title: true } } },
});
```

Options [27] [26]:

- `include`/`select` on relations: "only results in **two** SQL queries" [27].
- `relationLoadStrategy: 'join'` (preview feature `relationJoins`): one query; on PostgreSQL it uses `LATERAL` joins and JSON aggregation; with the preview enabled, `join` is the default [26].
- `where: { authorId: { in: userIds } }` to batch by hand [27].
- `findUnique` calls in the same tick are batched automatically (useful in GraphQL resolvers); `findMany` is not [27].
- Select only the columns you need (`select`, or `omit` for large fields such as embeddings or HTML) [28]. Big columns cost network, memory and JSON parsing.

### 3.6 Batch writes

- `createMany({ data, skipDuplicates })`: one statement; `skipDuplicates` ignores rows that hit a unique constraint; nested relation writes are not allowed [28].
- `createManyAndReturn` and `updateManyAndReturn` (PostgreSQL, CockroachDB, SQLite) return the rows; "the order of elements returned by `createManyAndReturn` is not guaranteed" [28].
- Chunk large batches (for example 1,000 rows per call) to keep statements and transactions small. For tens of thousands of rows, use `COPY` or `unnest` through the shared `pg` pool (section 4.4).

### 3.7 Upserts and race conditions

Prisma uses a real `INSERT ... ON CONFLICT` ("database upsert") on PostgreSQL only when the query has no nested writes or reads, touches one model, has one unique field in `where`, and uses the same value in `create` [28]. Otherwise it emulates the upsert in two steps, and "if two or more upsert operations happen at the same time and the record doesn't already exist", one of them can fail with a unique constraint error; the docs say to catch it and retry [28].

```ts
import { Prisma } from './generated/prisma/client';

export async function ensureTag(name: string) {
  try {
    // Qualifies for a database upsert: one unique field, same value in create
    return await prisma.tag.upsert({ where: { name }, create: { name }, update: {} });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return prisma.tag.findUniqueOrThrow({ where: { name } }); // someone else created it first
    }
    throw err;
  }
}
```

For bulk or complex upserts, write `INSERT ... ON CONFLICT ... DO UPDATE` in SQL (see [04-query-patterns-and-antipatterns.md](04-query-patterns-and-antipatterns.md), which owns the upsert patterns).

### 3.8 BigInt and Decimal

- `BigInt` fields are JavaScript `bigint`. `JSON.stringify` fails with "Do not know how to serialize a BigInt"; convert at the boundary, for example with a replacer `(key, value) => typeof value === 'bigint' ? value.toString() : value` [32].
- `Decimal` fields use Decimal.js (`Prisma.Decimal`), with exact arithmetic (`.plus()`, `.times()`) [32]. Send them to clients as strings (`amount.toFixed(2)`), never through `Number` for money.
- `Bytes` are `Uint8Array` [32].
- Choose `bigint` IDs only if you need them; `uuid` (for example UUIDv7, see [03-postgresql-features-and-types.md](03-postgresql-features-and-types.md)) avoids the BigInt serialization issue in APIs.

### 3.9 What the Prisma schema cannot express

"Some features, like SQL views, cannot be represented in the Prisma schema"; such features go into migration SQL created with `prisma migrate dev --create-only` and edited by hand [29].

| Feature | How to handle it with Prisma 7 |
|---|---|
| Partial indexes | Preview feature `partialIndexes` (Prisma 7.4+): `@@index([email], where: raw("\"deletedAt\" IS NULL"))` [30]; or plain migration SQL |
| GIN/GiST/BRIN/Hash indexes, operator classes | Supported: `@@index([data(ops: JsonbPathOps)], type: Gin)` [30] |
| `CHECK` constraints, exclusion constraints | Migration SQL |
| Triggers, functions, row-level security policies, views | Migration SQL; query views with raw SQL |
| Extensions (`pg_trgm`, `pgvector`, ...) | `CREATE EXTENSION` in a migration [31] |
| Types Prisma does not know (`vector(1536)`, `tsvector`, ranges) | `Unsupported("vector(1536)")` field; "the field will not be available in the generated Prisma Client" [29], so read and write it with raw SQL |
| Database defaults | `@default(dbgenerated("gen_random_uuid()"))` [29] |

```prisma
model Chunk {
  id         String                       @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  documentId String                       @db.Uuid
  content    String
  embedding  Unsupported("vector(1536)")?
}
```

After adding objects by hand, check that the next `prisma migrate dev` does not try to drop or recreate them, and write down which migration owns each hand-written object. Keep the hand-written SQL apart: below a banner in `migration.sql` such as `-- Everything above was generated; hand-written SQL below`, which also says how the generated part was produced. Prisma ignores CHECKs, partial and expression indexes, triggers and extensions when it diffs, so they are never recreated or dropped. Migration workflow, locking and zero-downtime rules are in [10-safe-schema-migrations.md](10-safe-schema-migrations.md). Production deploys use `prisma migrate deploy` (no shadow database), run by the owner/migration role, not by the application role ([11-security.md](11-security.md) section 3.3).

### 3.10 Prisma errors

| Code | Meaning [33] | With `@prisma/adapter-pg` [34] |
|---|---|---|
| `P2002` | Unique constraint failed | SQLSTATE `23505` |
| `P2003` | Foreign key constraint failed | `23503` (and `23001`) |
| `P2011` | Null constraint violation | `23502` |
| `P2025` | Required record not found (for example `update` on a missing row) | — |
| `P2034` | Write conflict or deadlock: retry | `40001`, `40P01` |
| `P2037` | Too many database connections | `53300` |
| `P2010` | Raw query failed; the message includes the database code | any error in `$queryRaw`/`$executeRaw` |
| `P1001` | Cannot reach the database server | — |

Other PostgreSQL errors (for example a `CHECK` violation, `23514`) have no dedicated Prisma code. In the 7.10 runtime they carry the original error in `err.meta.driverAdapterError` (with the SQLSTATE in `cause.originalCode`); this is not yet described in the error reference, so log `err.meta` once and test your mapping.

### 3.11 Logging queries in Prisma

```ts
const prisma = new PrismaClient({
  adapter: new PrismaPg(pool),
  log: [{ emit: 'event', level: 'query' }],
});

prisma.$on('query', (e) => {
  if (e.duration > 200) logger.warn({ ms: e.duration, query: e.query }, 'slow prisma query');
  // e.params contains the values: do not log it for tables with personal data
});
```

The `query` event exposes `query`, `params` and `duration` [36].

## 4. Patterns

### 4.1 Transaction scope

A transaction holds a connection and, often, row locks. While it is open, other requests wait and `VACUUM` cannot clean rows that the transaction might still see [67].

- Do the slow work **before** or **after** the transaction: HTTP calls, file uploads, LLM/embedding calls, sending e-mails.
- Never wait for user input inside a transaction.
- To publish an event reliably with a database change, write the event to an *outbox* table in the same transaction and let a worker publish it later (see [07-schema-design-and-patterns.md](07-schema-design-and-patterns.md)).
- Set `idle_in_transaction_session_timeout` as a safety net (2.5).

```ts
// Bad: network call while holding a transaction (and locks)
await withTransaction(pool, async (tx) => {
  await tx.query('UPDATE orders SET status = $1 WHERE id = $2', ['paid', orderId]);
  await paymentProvider.capture(orderId); // seconds of waiting, locks held, may fail after commit logic
});

// Good: external call first (idempotent, so it can be retried or reconciled),
// then a short transaction with an outbox row
const capture = await paymentProvider.capture(orderId, { idempotencyKey: `capture-${orderId}` });
await withTransaction(pool, async (tx) => {
  await tx.query('UPDATE orders SET status = $1, payment_ref = $2 WHERE id = $3', ['paid', capture.ref, orderId]);
  await tx.query('INSERT INTO outbox (topic, payload) VALUES ($1, $2)', ['order.paid', { orderId }]);
});
```

### 4.2 Retrying serialization failures and deadlocks

"Applications using these levels must be prepared to retry transactions that fail due to serialization errors" (SQLSTATE `40001`); "it may also be advisable to retry deadlock failures" (`40P01`). Retry "the complete transaction, including all logic that decides which SQL to issue and/or which values to use" [50]. Unique violations (`23505`) can also be worth a retry in some cases, but "more care is needed" because they may be permanent [50].

```ts
import { DatabaseError } from 'pg';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, retries = 5, baseMs = 20): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(); // fn must start a NEW transaction each time
    } catch (err) {
      const code = err instanceof DatabaseError ? err.code : undefined;
      const retryable = code === '40001' || code === '40P01';
      if (!retryable || attempt >= retries) throw err;
      await sleep(baseMs * 2 ** attempt * (0.5 + Math.random())); // exponential backoff + jitter
    }
  }
}

const result = await withRetry(() =>
  withTransaction(pool, (tx) => transferFunds(tx, fromId, toId, amount), 'SERIALIZABLE'),
);
```

For Prisma, test `err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034'` instead. Keep side effects (e-mails, events) out of the retried function, or make them idempotent.

### 4.3 Idempotency keys

Clients retry requests after timeouts. An *idempotency key* (a unique ID sent by the client with a write request) lets the server recognize the repeat and return the first result instead of charging twice. Brandur Leach's design stores the key with a unique constraint on `(user_id, idempotency_key)`, the request parameters, and the stored response [51]. A minimal version:

```sql
CREATE TABLE idempotency_keys (
  user_id      uuid        NOT NULL,
  key          text        NOT NULL CHECK (char_length(key) <= 100),
  request_hash text        NOT NULL,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- Claim the key. One row back = first time; zero rows = already seen.
INSERT INTO idempotency_keys (user_id, key, request_hash)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, key) DO NOTHING
RETURNING key;
```

Flow: claim the key and do the work in the **same** transaction, then store `response` before commit. On a repeat: if `request_hash` differs, reject (same key, different request is a client bug [51]); if `response` is set, return it; if not, the first request is still running (return 409 and let the client retry). Delete old keys with a scheduled job.

### 4.4 Bulk inserts: unnest or COPY

Sending 1,000 rows as `VALUES ($1, $2, $3), ($4, $5, $6), ...` needs 3,000 parameters and a long statement to parse and plan. Passing one array per column is simpler and faster: Tiger Data measured, at the database layer, `INSERT ... UNNEST` 2.13× faster than `INSERT ... VALUES` at batch size 1,000, and 5.02× faster with a wider schema of 10 float columns; the savings come mainly from query planning [52].

```ts
// node-postgres converts JS arrays to PostgreSQL arrays [6]
const ids = items.map((i) => i.id);
const names = items.map((i) => i.name);
const prices = items.map((i) => i.price); // strings for numeric, e.g. '19.90'

await pool.query(
  `INSERT INTO products (id, name, price)
   SELECT * FROM unnest($1::bigint[], $2::text[], $3::numeric[])
   ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name, price = EXCLUDED.price, updated_at = now()`,
  [ids, names, prices],
);
```

- All arrays must have the same length; `unnest` with several arguments pads shorter arrays with `NULL`.
- One statement carries at most 65,535 parameters [53]; arrays avoid that limit because each column is one parameter.
- For very large loads (hundreds of thousands of rows or files), use `COPY` into a staging table (2.9), then `INSERT ... SELECT`.
- Work in chunks (for example 1,000–10,000 rows per statement) so each transaction stays short.

### 4.5 Batching reads with `= ANY($1)`

Instead of building `IN ($1, $2, ..., $500)` or running one query per ID, pass one array:

```ts
const { rows } = await pool.query(
  'SELECT id, title FROM documents WHERE id = ANY($1::bigint[])',
  [documentIds],
);
```

To return rows in the same order as the input array:

```ts
const { rows } = await pool.query(
  `SELECT d.id, d.title
   FROM unnest($1::bigint[]) WITH ORDINALITY AS wanted(id, ord)
   JOIN documents d ON d.id = wanted.id
   ORDER BY wanted.ord`,
  [documentIds],
);
```

This is also how a DataLoader-style batch function should query: collect the IDs requested in one tick, run one `= ANY` query, and map results back by ID.

### 4.6 Keyset pagination from TypeScript

`OFFSET` pagination gets slower as the offset grows and can skip or repeat rows when data changes. *Keyset pagination* continues from the last row seen. The SQL side (indexes, ties, both directions) is in [04-query-patterns-and-antipatterns.md](04-query-patterns-and-antipatterns.md); the TypeScript side:

```ts
type Cursor = { createdAt: string; id: string }; // createdAt kept as text: exact microseconds

const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
const decode = (s: string): Cursor => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor;

export async function listPosts(limit: number, after?: string) {
  const c = after ? decode(after) : undefined;
  const { rows } = await pool.query<{ id: string; title: string; cursor_ts: string }>(
    `SELECT id, title, created_at::text AS cursor_ts
     FROM posts
     WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::bigint))
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [c?.createdAt ?? null, c?.id ?? null, limit],
  );
  const last = rows.at(-1);
  return { rows, next: last && rows.length === limit ? encode({ createdAt: last.cursor_ts, id: last.id }) : null };
}
```

Do not round-trip the timestamp through a JavaScript `Date` for the cursor: `Date` keeps milliseconds only, PostgreSQL stores microseconds, and the truncated value can skip rows. Validate decoded cursors (for example with zod) because they come from the client. An index on `(created_at DESC, id DESC)` serves this query.

### 4.7 Streaming large results to clients

For exports and reports, stream rows from a cursor (2.8) to the HTTP response (for example as CSV or newline-delimited JSON), and let backpressure pace the database reads. Remember that the cursor keeps a snapshot and a connection open for the whole export: run big exports on a replica or off-peak, and use `COPY ... TO STDOUT` (2.9) when the format allows it.

### 4.8 Cancellation and timeouts per request

- Give each kind of work a budget: short for API reads (`statement_timeout` a few seconds), longer for reports (`SET LOCAL statement_timeout = '60s'` inside their transaction).
- When the HTTP client disconnects, `pg` has no way to abort through an `AbortSignal` [3]; the server keeps working until the statement ends or `statement_timeout` fires. If you must stop a long query, run `SELECT pg_cancel_backend($1)` with the session's process ID from another connection (allowed for the same role or members of `pg_signal_backend`).
- postgres.js offers `query.cancel()`, which sends a protocol cancel request, without a guarantee [20].
- A `57014` error (`query_canceled`) after a timeout is normal: map it to HTTP 503/504, not 500, and look at the query plan (see [06-query-optimization-and-explain.md](06-query-optimization-and-explain.md)).

### 4.9 Graceful shutdown

Orchestrators (Kubernetes, ECS, systemd) send `SIGTERM`, wait, then kill the process. Use the delay to finish cleanly:

```ts
import { prisma, pool } from './db';

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal}: shutting down`);
  await new Promise<void>((resolve) => server.close(() => resolve())); // stop accepting requests, finish in-flight ones
  await stopWorkers();      // let running jobs finish or hand them back (with a deadline)
  await prisma.$disconnect();
  await pool.end();         // waits for checked-out clients, then closes all connections
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
```

`pool.end()` "will wait for all checked-out clients to be returned and then shut down all the clients and the pool timers" [1]. A client that is never released blocks it forever, so add an overall deadline (for example `setTimeout(() => process.exit(1), 10_000).unref()`).

### 4.10 Serverless and connection limits

- Each function instance has its **own** pool. A burst of 200 instances × `max: 10` can mean 2,000 connection attempts.
- Instantiate the pool / `PrismaClient` **outside** the handler so warm invocations reuse it [39].
- Put a pooler between functions and PostgreSQL (PgBouncer, RDS Proxy, Supabase/Neon poolers, Cloudflare Hyperdrive) and keep each instance's pool small [4] [39].
- Transaction-mode poolers break session features: session `SET`, `LISTEN`, `WITH HOLD` cursors, SQL-level `PREPARE`, session advisory locks and temporary tables that outlive a transaction [13]. Use `SET LOCAL`/`set_config(..., true)` inside transactions and transaction-level advisory locks. Protocol-level prepared statements work with PgBouncer 1.21+ when `max_prepared_statements` is set [13].
- On platforms that end the execution environment after each request (Cloudflare Workers), close the pool at the end of the handler (`pool.end()` [4]; Prisma recommends `$disconnect()` there [39]).

## 5. Type safety

### 5.1 Generate types from the database or schema

| Tool | Source of truth | Output |
|---|---|---|
| Prisma Client | `schema.prisma` | Model types and query API |
| Prisma TypedSQL (preview) | `.sql` files + live database | Typed functions for each query [25] |
| Kanel | Live database | TypeScript types for tables, views, enums; "for people who don't like ORM's but who do like intellisense" [47] |
| kysely-codegen / prisma-kysely | Live database / Prisma schema | Kysely `Database` interface [43] |
| PgTyped | `.sql` files or SQL in TS + live database | Parameter and result types per query [48] |
| Drizzle | TypeScript schema files | Types and migrations (drizzle-kit) |

Kysely recommends generating the `Database` interface "by introspecting your production database or Prisma schemas" [43]. Run the generator in CI and fail the build if the generated files change: it catches drift between migrations and code.

### 5.2 Validate data at runtime

TypeScript types disappear at run time. A `jsonb` column typed as `Metadata` in your code can still contain anything that another service, an old version, or a manual fix wrote. Validate at the boundaries: before writing JSON, after reading JSON, and on raw-query results you cast to a type.

```ts
import { z } from 'zod';

const DocumentMetadata = z.object({
  source: z.enum(['upload', 'crawler']),
  pages: z.number().int().nonnegative(),
  language: z.string().length(2).optional(),
});
type DocumentMetadata = z.infer<typeof DocumentMetadata>;

// Write: validate before INSERT
const metadata: DocumentMetadata = DocumentMetadata.parse(input.metadata);
await pool.query('INSERT INTO documents (title, metadata) VALUES ($1, $2)', [input.title, metadata]);

// Read: validate after SELECT (safeParse returns a result instead of throwing [49])
const { rows } = await pool.query('SELECT metadata FROM documents WHERE id = $1', [id]);
const parsed = DocumentMetadata.safeParse(rows[0]?.metadata);
if (!parsed.success) throw new Error(`Invalid metadata for document ${id}`);
```

Prisma `Json` fields are typed as generic JSON values; the same rule applies. For constraints the database can enforce (ranges, required keys), also add `CHECK` constraints so bad data cannot be written by any client.

## 6. Testing

### 6.1 Real PostgreSQL with Testcontainers

Unit tests with mocks do not catch wrong SQL, missing indexes, constraint behavior, RLS policies or migration errors. Run integration tests against a real PostgreSQL in a container, with the **same major version** and the **same migrations** as production.

```ts
// test/db.ts
import { execFileSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

export async function startTestDatabase() {
  const container = await new PostgreSqlContainer('postgres:18-alpine') // pin the major (and minor in CI)
    .withDatabase('app_test')
    .start();
  const url = container.getConnectionUri();

  // Apply migrations exactly as production does
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });

  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return {
    url,
    pool,
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}
```

- Start one container per test run (or per worker), not per test: startup takes seconds.
- `.withReuse()` keeps a container alive between runs on a developer machine; note that "Ryuk does not clean reused containers" [55].
- Use the same extensions as production (for example an image with pgvector) and the same roles: create the application role in setup and connect the code under test **as that role**, so privileges and RLS are tested (see [11-security.md](11-security.md) section 6.8).

### 6.2 Keeping tests independent

| Strategy | How | Pros | Cons |
|---|---|---|---|
| Truncate between tests | `TRUNCATE` all app tables `RESTART IDENTITY CASCADE` | Simple; works with any code | Tests in one database cannot run in parallel |
| Rollback per test | Open a transaction in `beforeEach`, roll back in `afterEach` | Very fast | The code under test must use that same connection; cannot test commits, concurrency or `COMMIT`-time errors; awkward with Prisma interactive transactions |
| Database per worker from a template | Migrate once into `app_template`, then `CREATE DATABASE app_test_<n> TEMPLATE app_template` | Parallel and isolated; fast copies | "no other sessions can be connected to the source database while it is being copied" [57] |
| Testcontainers snapshot | `await container.snapshot()` after seeding, `await container.restoreSnapshot()` to reset | Easy reset to a known state | Close connections first; never use the `postgres` database as the container database [54] [56] |

### 6.3 PGlite: fast in-process PostgreSQL

PGlite is "a WASM Postgres build packaged into a TypeScript/JavaScript client library" that runs in Node.js, Bun or the browser, in memory or on disk, with extensions such as pgvector [58]. Version 0.5.8 reports PostgreSQL 18.3. It is excellent for fast tests of SQL logic, but it is not a server:

- "PGlite is single user/connection" [59]. A socket server (`pglite-socket`) can multiplex several clients over that single connection, and "not all use cases are guaranteed to work" [60].
- So you cannot test real concurrency: row locks between sessions, `SKIP LOCKED` queues, deadlocks, serialization failures, `LISTEN`/`NOTIFY` between connections.
- No `pg_hba.conf`, TLS or login-time behavior. Roles, `SET ROLE` and RLS policies do work in a single session.
- In quick checks while writing this page (PGlite 0.5.8, pglite-socket 0.2.11): `statement_timeout` did not cancel a `pg_sleep()`, and `COPY ... FROM STDIN` through the socket broke the connection. Test timeouts and COPY on real PostgreSQL.
- Prisma can use it through the community adapter `pglite-prisma-adapter` [66]; check that it supports your Prisma version.

### 6.4 pg-mem: use with care

pg-mem is "an experimental in-memory emulation of a postgres database" [61], not PostgreSQL itself. Its README lists limits: materialized views behave like plain views, indexes are basic, there is no time zone support, and all number-like types are JavaScript numbers, so `numeric(x,y)` "could not behave as expected" [61]. Prefer PGlite or Testcontainers; use pg-mem only for very simple queries.

### 6.5 Seeding and factories

- Keep a small, deterministic seed for development (Prisma 7: run `prisma db seed` explicitly [21]).
- In tests, create the data each test needs with *factories*: functions that build valid rows with defaults and accept overrides. Use a counter for unique values.

```ts
let seq = 0;

export async function createUser(pool: pg.Pool, overrides: Partial<{ email: string; name: string }> = {}) {
  seq += 1;
  const user = { email: `user${seq}@test.local`, name: `User ${seq}`, ...overrides };
  const { rows } = await pool.query(
    'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id, email, name',
    [user.email, user.name],
  );
  return rows[0];
}
```

### 6.6 Testing migrations

- In CI, apply all migrations to an empty database (the Testcontainers setup above does this on every run).
- Check that the schema and the migrations agree (`prisma migrate status`, `prisma migrate diff`; some `migrate diff` flags changed in Prisma 7 [21]).
- For risky migrations (large tables, new constraints), rehearse on a masked copy of production data and measure lock times. See [10-safe-schema-migrations.md](10-safe-schema-migrations.md).

## 7. Observability from the application

### 7.1 Query logging with durations

```ts
import pg from 'pg';

export async function timedQuery<R extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  const start = performance.now();
  try {
    return await pool.query<R>(text, values);
  } finally {
    const ms = performance.now() - start;
    if (ms > 200) logger.warn({ ms: Math.round(ms), query: text }, 'slow query'); // the text, not the values
  }
}
```

Log the SQL text and the duration; do not log parameter values by default (personal data, secrets). Watch pool health too: `pool.totalCount`, `pool.idleCount` and `pool.waitingCount` [2]. A growing `waitingCount` means the pool is too small or queries/transactions are too slow.

### 7.2 OpenTelemetry

- `@opentelemetry/instrumentation-pg` traces `pg` and `pg-pool` (supported versions `pg >=8.0.3 <9`). It creates `pg.query:<OPERATION> <database>` spans, `pg-pool.connect` spans that measure the wait for a connection, and metrics such as `db.client.operation.duration` and `db.client.connection.count` [62].
- Its `enhancedDatabaseReporting` option attaches "information about query parameters and results" to spans [62]: keep it off where data is sensitive.
- Prisma 7: `@prisma/instrumentation` (`PrismaInstrumentation`) produces `prisma:client:operation` spans with `prisma:engine:db_query` children; "register tracing and instrumentation before you import any instrumented dependencies" [37]. Because Prisma 7 executes SQL through `pg`, the `pg` instrumentation can record the same queries too; check for duplicate spans.

### 7.3 Linking application traces to database statistics

- Set `application_name` per service; it appears in `pg_stat_activity` [64] and in server logs through `%a` in `log_line_prefix` (see [11-security.md](11-security.md) section 9.1).
- `pg_stat_statements` keeps "one row for each distinct combination of database ID, user ID, query ID" [63]. It has no `application_name` column, so separate login roles per service also separate their statistics.
- *sqlcommenter* comments add context to the SQL text, for example `/*traceparent='00-...'*/`. Prisma 7.1+ supports them with the `comments` option and the `@prisma/sqlcommenter-query-tags` and `@prisma/sqlcommenter-trace-context` plugins [38]; the OpenTelemetry `pg` instrumentation has `addSqlCommenterCommentToQueries` (it skips queries that already contain `--` or `/*`) [62].
- Comments do not split `pg_stat_statements` entries: queries are grouped when they "have identical query structures", and the stored text is only "a representative statement" [63]. The comments are most useful in logs (`log_min_duration_statement`, `auto_explain`) and in `pg_stat_activity`, where you see the exact statement with its trace ID.

The diagnosis workflow (from slow query to plan to fix) is in [06-query-optimization-and-explain.md](06-query-optimization-and-explain.md).

## 8. Checklist for TypeScript code that touches the database

**Connections**

- [ ] One pool (or one `PrismaClient`) per process; `pool.on('error')` handler installed.
- [ ] `max`, `connectionTimeoutMillis`, `idleTimeoutMillis` set explicitly; total connections fit `max_connections`.
- [ ] `application_name` set per service.
- [ ] TLS verified (`verify-full` or `ssl.ca`); no `rejectUnauthorized: false`.
- [ ] Graceful shutdown calls `prisma.$disconnect()` / `pool.end()` with a deadline.

**Queries**

- [ ] Parameters everywhere; identifiers from allow-lists; no unsafe raw APIs with input.
- [ ] No N+1 loops; relations loaded with `include`/`select` or `= ANY($1)`.
- [ ] Only needed columns selected (no large `jsonb`/vector/text columns by accident).
- [ ] Large results streamed or paginated with keyset pagination.
- [ ] Bulk writes use `unnest` arrays, `createMany`, or `COPY`, in chunks.

**Transactions**

- [ ] All statements of a transaction use the same client (`tx` in Prisma).
- [ ] No network calls or slow work inside transactions.
- [ ] Clients always released (`finally`); broken ones destroyed.
- [ ] Retries on `40001`/`40P01` (`P2034`) for the whole transaction, with backoff and a limit.
- [ ] `statement_timeout` and `idle_in_transaction_session_timeout` configured.

**Types and errors**

- [ ] `bigint`, `numeric`, `date` and `timestamp` handling decided (parsers, `Decimal`, `TZ=UTC`).
- [ ] JSON columns and raw results validated at runtime.
- [ ] Errors mapped by SQLSTATE and constraint name; raw database messages never sent to clients.

**Tests and operations**

- [ ] Integration tests run on real PostgreSQL (same major version, same migrations, app role).
- [ ] Query logs contain durations and SQL text, not parameter values.
- [ ] Traces include database spans; queries can be linked to code (application name, sqlcommenter).

## Sources

1. [Pooling](https://node-postgres.com/features/pooling) — node-postgres: why pools, one pool per app, release, error event, shutdown with `pool.end()` (docs source `pooling.mdx`).
2. [pg.Pool](https://node-postgres.com/apis/pool) — node-postgres: options and defaults (docs source `pool.mdx`), `release(destroy)`, `onConnect`, `pipeline`, pool counters.
3. [pg.Client](https://node-postgres.com/apis/client) — node-postgres: client config (timeouts, `application_name`), `QueryConfig`, `getTransactionStatus()`.
4. [Pool Sizing](https://node-postgres.com/guides/pool-sizing) — node-postgres (Brian Carlson): sizing across instances, serverless, poolers.
5. [Transactions](https://node-postgres.com/features/transactions) — node-postgres: same client for the whole transaction; no `pool.query`.
6. [Queries](https://node-postgres.com/features/queries) — node-postgres: parameters, value conversion, prepared statements, `rowMode`, custom types.
7. [CHANGELOG](https://github.com/brianc/node-postgres/blob/master/CHANGELOG.md) — node-postgres: `queryMode` 8.12, per-query timeout 8.13, ESM 8.15, `min` 8.16, `onConnect` 8.20, `getTransactionStatus` 8.21, `sslnegotiation` 8.22, pipelining 8.23.
8. [client.js](https://github.com/brianc/node-postgres/blob/master/packages/pg/lib/client.js) — node-postgres source: `query_timeout` only rejects the client promise.
9. [pg.Cursor](https://node-postgres.com/apis/cursor) — node-postgres: cursor API.
10. [pg-query-stream](https://github.com/brianc/node-postgres/tree/master/packages/pg-query-stream) — node-postgres: server-side cursor stream.
11. [pg-copy-streams](https://github.com/brianc/node-pg-copy-streams) — README: COPY FROM/TO streams, chunking, `CopyFail`, no `pool.query`.
12. [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html) — PostgreSQL docs: delivery on commit, payload size, queue.
13. [PgBouncer features](https://www.pgbouncer.org/features.html) — PgBouncer: session features unsupported in transaction mode; protocol-level prepared statements.
14. [Data Types](https://node-postgres.com/features/types) — node-postgres: uuid, JSON, date/timestamp parsing, millisecond precision.
15. [pg-types](https://github.com/brianc/node-pg-types) — README: everything arrives as text; int8 as string; `setTypeParser`.
16. [pg-types 2.2.0 textParsers.js](https://unpkg.com/pg-types@2.2.0/lib/textParsers.js) — source: registered parsers (numeric not parsed, `_numeric` parsed as floats, dates).
17. [postgres-date 1.0.7](https://unpkg.com/postgres-date@1.0.7/index.js) — source: `YYYY-MM-DD` parsed as local time.
18. [pg-connection-string](https://github.com/brianc/node-postgres/tree/master/packages/pg-connection-string) — node-postgres: `sslmode` handling and pg v9 change.
19. [connection-parameters.js](https://github.com/brianc/node-postgres/blob/master/packages/pg/lib/connection-parameters.js) — node-postgres source: connection string fields override config fields.
20. [Postgres.js README](https://github.com/porsager/postgres) — postgres.js: tagged templates, transactions, pool, prepared statements, BigInt, cancel, teardown.
21. [Upgrade to Prisma ORM 7](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7) — Prisma: breaking changes (adapters, generator, ESM, config, TLS, migrate/seed).
22. [Connection pool (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/connection-pool) — Prisma: v6 → v7 pool parameter mapping and defaults.
23. [Transactions and batch queries (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions) — Prisma: interactive transaction options/defaults, isolation levels, P2034 retry.
24. [Raw queries (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-client/using-raw-sql/raw-queries) — Prisma: `$queryRaw`, helpers, type mapping, INT8 parameters, injection warnings.
25. [TypedSQL (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-client/using-raw-sql/typedsql) — Prisma: preview `typedSql`, `@param` comments, limits.
26. [Relation queries (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-client/queries/relation-queries) — Prisma: `relationLoadStrategy`, preview `relationJoins`.
27. [Query optimization (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-client/queries/advanced/query-optimization-performance) — Prisma: N+1 solutions, bulk operations, single client instance.
28. [Prisma Client API (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/reference/prisma-client-reference) — Prisma: database upserts, `createMany(AndReturn)`, `transactionOptions`, `omit`, `comments`.
29. [Unsupported database features (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/unsupported-database-features) — Prisma: migration SQL, `Unsupported`, `dbgenerated`.
30. [Indexes (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/indexes) — Prisma: preview `partialIndexes`, index types and operator classes.
31. [PostgreSQL extensions (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-schema/postgresql-extensions) — Prisma: install extensions through migrations.
32. [Fields and types (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-client/special-fields-and-types) — Prisma: Decimal, BigInt serialization, Bytes.
33. [Error message reference (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/reference/error-reference) — Prisma: P2002, P2003, P2010, P2011, P2025, P2034, P2037, P1001.
34. [adapter-pg errors.ts (v7 branch)](https://github.com/prisma/orm/blob/v7/packages/adapter-pg/src/errors.ts) — Prisma source: SQLSTATE → error kind mapping (40001/40P01 → TransactionWriteConflict).
35. [adapter-pg pg.ts (v7 branch)](https://github.com/prisma/orm/blob/v7/packages/adapter-pg/src/pg.ts) — Prisma source: `PrismaPg(pool | config | string, options)`, `disposeExternalPool`, `statementNameGenerator`.
36. [Logging (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-client/observability-and-logging/logging) — Prisma: query events with duration.
37. [OpenTelemetry tracing (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-client/observability-and-logging/opentelemetry-tracing) — Prisma: `@prisma/instrumentation`, span names, registration order.
38. [Prisma ORM v7.1.0: SQL comments](https://www.prisma.io/changelog/2025-12-03) — Prisma changelog: `comments` option, query-tags and trace-context plugins.
39. [Database connections (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections) — Prisma: long-running vs serverless, `$disconnect`, PgBouncer.
40. [Prisma ORM release status](https://www.prisma.io/docs/orm/release-status) — Prisma: ORM 8 release candidate, GA expected October 2026, ORM 7 support window.
41. [Coming from Prisma ORM 7](https://www.prisma.io/docs/orm/coming-from-prisma-orm-7) — Prisma: main differences between ORM 7 and ORM 8.
42. [Interface Sql](https://kysely-org.github.io/kysely-apidoc/interfaces/Sql.html) — Kysely API docs: parameterized `sql` template and unsafe helpers.
43. [Getting started](https://kysely.dev/docs/getting-started) — Kysely: `PostgresDialect` with `pg`, generated `Database` types.
44. [Magic sql operator](https://orm.drizzle.team/docs/sql) — Drizzle ORM: `sql` template, `sql.raw`.
45. [Drizzle ORM overview](https://orm.drizzle.team/docs/overview) — Drizzle: positioning and design.
46. [pg.Pool docs source](https://github.com/brianc/node-postgres/blob/master/docs/pages/apis/pool.mdx) — node-postgres: option comments with defaults.
47. [Kanel](https://github.com/kristiandupont/kanel) — README: generate TypeScript types from a live database.
48. [PgTyped](https://github.com/adelsz/pgtyped) — README: typed SQL from a running database.
49. [Basic usage](https://zod.dev/basics) — Zod 4 docs: `parse`, `safeParse`, `z.infer`.
50. [Serialization Failure Handling](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html) — PostgreSQL docs: retry 40001, maybe 40P01/23505/23P01, whole transaction.
51. [Implementing Stripe-like Idempotency Keys in Postgres](https://brandur.org/idempotency-keys) — Brandur Leach: idempotency key table design.
52. [Boosting Postgres INSERT Performance by 2x With UNNEST](https://www.tigerdata.com/blog/boosting-postgres-insert-performance) — Tiger Data: VALUES vs UNNEST measurements.
53. [Message Formats](https://www.postgresql.org/docs/current/protocol-message-formats.html) — PostgreSQL docs: Bind parameter count is an Int16.
54. [PostgreSQL module](https://node.testcontainers.org/modules/postgresql/) — Testcontainers for Node.js: container API, snapshots and their caveats.
55. [Containers](https://node.testcontainers.org/features/containers/) — Testcontainers for Node.js: `withReuse()`, Ryuk.
56. [postgresql-container-snapshot.test.ts](https://github.com/testcontainers/testcontainers-node/blob/main/packages/modules/postgresql/src/postgresql-container-snapshot.test.ts) — Testcontainers source: `snapshot()`/`restoreSnapshot()` usage.
57. [Template Databases](https://www.postgresql.org/docs/current/manage-ag-templatedbs.html) — PostgreSQL docs: copying a database; no other sessions on the source.
58. [What is PGlite](https://pglite.dev/docs/about) — PGlite docs: WASM Postgres, persistence, pgvector, testing use.
59. [PGlite README](https://github.com/electric-sql/pglite) — ElectricSQL: single-user/single-connection limitation.
60. [pglite-socket](https://github.com/electric-sql/pglite/blob/main/docs/docs/pglite-socket.md) — PGlite docs: multiplexed connections, limits.
61. [pg-mem](https://github.com/oguimbal/pg-mem) — README: experimental emulation and current limitations.
62. [instrumentation-pg](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/packages/instrumentation-pg) — OpenTelemetry JS contrib: spans, metrics, options.
63. [pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html) — PostgreSQL docs: grouping key, representative query text.
64. [The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html) — PostgreSQL docs: `pg_stat_activity.application_name`.
65. [PostgreSQL Error Codes](https://www.postgresql.org/docs/current/errcodes-appendix.html) — PostgreSQL docs: SQLSTATE names.
66. [npm registry](https://registry.npmjs.org/) — package metadata queried 2026-10-05: latest versions and release dates (pg, postgres, kysely, drizzle-orm, @prisma/client, typeorm, @mikro-orm/core, @pgtyped/cli, kanel, pglite, pg-mem, testcontainers, pglite-prisma-adapter); GitHub API for repository activity.
67. [Client Connection Defaults](https://www.postgresql.org/docs/current/runtime-config-client.html) — PostgreSQL docs: `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `transaction_timeout`.
