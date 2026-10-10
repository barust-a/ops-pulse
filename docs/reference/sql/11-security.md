# PostgreSQL Security

> Part of the [SQL & PostgreSQL reference library](README.md) · Last researched: 2026-10-05 · Targets PostgreSQL 14–18 (19 beta noted where relevant)

**What this covers.** How to protect an application database: SQL injection, roles and privileges, `search_path`, `SECURITY DEFINER` functions, row-level security (RLS), authentication and network access, encryption, logging and auditing, data protection, extensions, and AI agents that query the database. It ends with a hardening checklist. Client-side code (pools, transactions, testing) is in [15-postgres-from-typescript.md](15-postgres-from-typescript.md); server operations are in [09-operations-and-server-tuning.md](09-operations-and-server-tuning.md).

Unless a block needs server configuration (`pg_hba.conf`, TLS), the SQL examples were run on PostgreSQL 18.3 (in-process, through PGlite 0.5.8) while this page was written. PG 19 items come from the draft release notes; none of them is in the list of features reverted in beta 4 [69] [70].

## Key rules (TL;DR)

1. Send every value as a bind parameter (`$1`, tagged template). Never build SQL by joining strings with user input.
2. Identifiers, keywords and sort directions cannot be parameters: map user input to a fixed allow-list of SQL fragments.
3. Treat the "unsafe" APIs (`$queryRawUnsafe`, `Prisma.raw`, `sql.raw`, `sql.unsafe`, `sql.ref` with user input) as code review blockers.
4. Escape `%`, `_` and `\` in user text used with `LIKE`/`ILIKE`, then add your own wildcards.
5. In PL/pgSQL dynamic SQL, use `format('%I')` for identifiers and `EXECUTE ... USING` for values.
6. Never connect the application as a superuser or as the owner of its tables.
7. Use separate roles: an owner/migration role, an application role with DML only, a read-only role, a monitoring role.
8. Set `ALTER DEFAULT PRIVILEGES FOR ROLE <owner>` so new tables get the right grants automatically.
9. On PostgreSQL 14, and on databases upgraded from it, run `REVOKE CREATE ON SCHEMA public FROM PUBLIC` (new PG 15+ databases do this by default).
10. Every `SECURITY DEFINER` function needs `SET search_path`, schema-qualified names, and `REVOKE EXECUTE ... FROM PUBLIC` in the same transaction.
11. With RLS, enable **and** force it (`FORCE ROW LEVEL SECURITY`), and make sure the app role is not the owner and has no `BYPASSRLS`.
12. Pass tenant/user context with `set_config('app.tenant_id', $1, true)` inside a transaction. Never use session-level `SET` with a connection pool.
13. Read the setting with `NULLIF(current_setting('app.tenant_id', true), '')` and wrap it in `(SELECT ...)` so it runs once per query.
14. Index every column used in a policy, and test policies and `EXPLAIN` plans as the real application role: under RLS, non-leakproof search operators (`@@`, `jsonb @>`, `LIKE`, trigram) cannot use their indexes.
15. Create views over RLS tables with `security_invoker = true` (PG 15+).
16. In `pg_hba.conf`, use `hostssl ... scram-sha-256`; never use `trust` on a network; move away from `md5` (deprecated in PG 18).
17. Do not expose port 5432 to the internet; keep `listen_addresses` and firewalls tight.
18. Clients must use TLS with certificate checking (`sslmode=verify-full` or the driver equivalent).
19. Community PostgreSQL has no built-in encryption at rest: use disk/volume encryption and encrypted backups.
20. Hash end-user passwords in the application with Argon2id (or bcrypt for legacy). Never store them in plain text or with reversible encryption.
21. Keep secrets and personal data out of logs: set `log_parameter_max_length` to `0` or a small value, and never log `CREATE/ALTER ROLE ... PASSWORD`.
22. Use pgAudit when you need a real audit trail; plain `log_statement` is not an audit.
23. Install only extensions you need; untrusted languages and file/program roles are equal to superuser.
24. Give AI agents a dedicated read-only role on masked or curated data, with timeouts and connection limits, and never production superuser access.

## 1. Threat model for an application database

A *threat model* is a list of the ways an attacker could hurt you, and the defenses for each. For a typical web application on PostgreSQL, these are the main risks:

| Threat | Example | Main defenses | Section |
|---|---|---|---|
| SQL injection | A search box sends `' OR 1=1 --` and the app concatenates it into SQL | Bind parameters, allow-lists, least privilege | [2](#2-sql-injection) |
| Over-privileged app account | The API connects as `postgres`; one injection becomes `COPY ... TO PROGRAM` (shell access) | Separate roles, DML-only app role | [3](#3-roles-and-privileges) |
| Leaked credentials | A password in Git, in a CI log, or in a crash report | Secret manager, rotation, `pg_hba.conf` network rules, TLS client certs | [7](#7-authentication-and-network-access) |
| Data exposure through logs and backups | Bind parameters with e-mails in the server log; an unencrypted dump in a bucket | Log settings, pgAudit config, encrypted backups, retention | [9](#9-auditing-and-logging), [10](#10-data-protection) |
| Tenant data leak | A missing `WHERE tenant_id = ...` shows another customer's documents | Row-level security + app filters + tests | [6](#6-row-level-security-rls) |
| Network exposure | Port 5432 open to the internet with a weak password | Private network, firewall, `listen_addresses`, `hostssl` | [7](#7-authentication-and-network-access) |
| Privilege escalation inside the database | A malicious function in a writable schema hijacks a `SECURITY DEFINER` function | `search_path` hygiene, schema privileges | [4](#4-search_path-security), [5](#5-security-definer-functions) |
| Unsafe automation | An AI agent follows instructions hidden in data and runs harmful SQL | Read-only role on masked data, timeouts, human approval | [12](#12-ai-agents-and-other-automated-clients) |

The defenses work in layers (*defense in depth*). Parameters stop most injection. If one query is still vulnerable, a DML-only role limits the damage. If the role is abused, RLS limits which rows it can see. If the server is stolen, disk encryption protects the files. No single layer is enough.

## 2. SQL injection

### 2.1 How injection works

*SQL injection* happens when user input becomes part of the SQL **code** instead of staying **data**. The database cannot tell which part of the string came from the user.

```ts
// Bad: the e-mail is pasted into the SQL text
const email = req.query.email; // attacker sends:  x' OR '1'='1
const res = await pool.query(`SELECT id, name FROM users WHERE email = '${email}'`);
// The server receives: SELECT id, name FROM users WHERE email = 'x' OR '1'='1'
// -> every user is returned
```

Common attack shapes:

- **Tautology**: `' OR '1'='1` makes a filter always true.
- **UNION**: `' UNION SELECT id, password_hash FROM users --` appends rows from another table.
- **Blind**: the attacker learns data one bit at a time from true/false page changes or from timing (`pg_sleep(5)`).
- **Error-based**: error messages reveal table names or values. Do not send raw database errors to clients.

### 2.2 Stacked queries and the two query protocols

PostgreSQL has two ways to send a query [3]:

- The **simple query protocol** sends one string. It "could contain several queries (separated by semicolons)" [3]. If a query is sent this way, an attacker can add a second statement: `'; DROP TABLE users; --`. This is called a *stacked query*.
- The **extended query protocol** sends the SQL text (Parse) and the values (Bind) in separate messages. "The query string contained in a Parse message cannot include more than one SQL statement" [3].

node-postgres uses the extended protocol when you pass parameters, and the simple protocol when you pass none. Since pg 8.12 you can force the extended protocol with `queryMode: 'extended'` [5]. postgres.js uses the extended protocol unless you call `.simple()` [6]. Prisma raw methods "can only run one query at a time" [7].

The extended protocol blocks stacked queries, but it does **not** make concatenated SQL safe: a `UNION` or `OR` injection still works inside one statement. Only parameters fix the root cause.

### 2.3 Second-order injection

*Second-order injection* uses data that is already stored. Example: a user saves the display name `x'); DELETE FROM orders; --`. The first insert used parameters, so it was safe. Later, a nightly job reads the name and builds dynamic SQL with it. The attack runs then.

Rule: data from your own database is still untrusted input. Use parameters everywhere, including in batch jobs, triggers, and PL/pgSQL functions [2].

### 2.4 The fix: bind parameters

"Parameterized queries force the developer to define all SQL code first and pass in each parameter to the query later" [1]. The value never becomes SQL code, whatever it contains. OWASP calls escaping "fragile" and a last resort [1].

| Library | Safe API (values become parameters) | Unsafe API (review carefully) |
|---|---|---|
| node-postgres (`pg`) | `pool.query('... $1', [value])` [4] | building the text with `+` or `${}` |
| postgres.js | ``sql`... ${value}` `` [6] | `sql.unsafe(string)` [6] |
| Prisma ORM 7 | ``prisma.$queryRaw`... ${value}` ``, `Prisma.sql`, `Prisma.join` [7] | `$queryRawUnsafe`, `$executeRawUnsafe`, `Prisma.raw` [7] |
| Kysely | ``sql`... ${value}` ``, `sql.val` [8] | `sql.raw`, `sql.lit`, `sql.ref`, `sql.id`, `sql.table` with unchecked input [8] |
| Drizzle ORM | ``sql`... ${value}` `` (becomes `$1`) [9] | `sql.raw()` [9] |

node-postgres:

```ts
// Good: $1 and $2 are placeholders; values travel separately
const { rows } = await pool.query(
  'SELECT id, name FROM users WHERE email = $1 AND tenant_id = $2',
  [email, tenantId],
);
```

postgres.js (the tagged template turns `${...}` into `$1`, `$2`):

```ts
// Good
const users = await sql`SELECT id, name FROM users WHERE email = ${email}`;
// Bad: quotes around the placeholder turn it into the literal text '$1' [6]
const broken = await sql`SELECT id FROM users WHERE email = '${email}'`;
```

Prisma ORM 7:

```ts
import { Prisma } from '@prisma/client'; // or your generated client path

// Good: tagged template, values become parameters
const rows = await prisma.$queryRaw`
  SELECT id, title FROM documents WHERE tenant_id = ${tenantId}::uuid`;

// Good: build optional parts with Prisma.sql / Prisma.empty, lists with Prisma.join
const filter = status ? Prisma.sql`AND status = ${status}` : Prisma.empty;
const docs = await prisma.$queryRaw`
  SELECT id FROM documents WHERE id IN (${Prisma.join(ids)}) ${filter}`;

// Bad: string building + Unsafe method = injection
await prisma.$queryRawUnsafe(`SELECT * FROM documents WHERE title = '${title}'`);
// Bad: Prisma.raw disables escaping for its argument [7]
await prisma.$queryRaw`SELECT * FROM documents WHERE title = ${Prisma.raw(title)}`;
```

`$queryRawUnsafe` is only acceptable with `$1` placeholders and a separate values list, and only when the SQL text itself comes from constants: `prisma.$queryRawUnsafe('SELECT ... WHERE email = $1', email)` [7].

Kysely and Drizzle work the same way: values in the template are parameters, and the `raw`/identifier helpers are unchecked. The Kysely docs warn that `sql.raw`, `sql.ref`, `sql.id`, `sql.table` and `sql.lit` with unchecked input "WILL lead to SQL injection vulnerabilities" [8].

### 2.5 What cannot be a parameter: use allow-lists

Parameters can only replace **values**. "PostgreSQL does not support parameters for identifiers" [4] (table and column names), and keywords such as `ASC`/`DESC` cannot be parameters either. For these, OWASP recommends mapping the input to a fixed set of legal values, and converting a sort order to a boolean that chooses a safe constant [1].

```ts
// Good: the user picks a key; the SQL fragment comes from our own constant table
const SORT_COLUMNS = new Map([
  ['createdAt', 'created_at'],
  ['title', 'title'],
]);

function orderBy(sortKey: string, sortDir: string): string {
  const column = SORT_COLUMNS.get(sortKey);
  if (column === undefined) throw new Error(`Invalid sort key: ${sortKey}`);
  const direction = sortDir === 'desc' ? 'DESC' : 'ASC'; // map, never copy the input
  return `ORDER BY ${column} ${direction}, id ${direction}`;
}

const { rows } = await pool.query(
  `SELECT id, title, created_at FROM documents WHERE tenant_id = $1 ${orderBy(key, dir)} LIMIT $2`,
  [tenantId, 50],
);
```

Notes:

- `LIMIT $2` and `OFFSET $3` **can** be parameters. Only names and keywords cannot.
- Use a `Map` (or `Object.hasOwn`) for the lookup, not a plain object index, so keys like `__proto__` cannot match.
- `escapeIdentifier()` from `pg` [10] quotes a name correctly, but it does not decide whether the user may access that column. Use it as a second layer after the allow-list, not instead of it.
- postgres.js has `sql(name)` for identifiers [6]. It quotes the name, but again does not check permissions: keep the allow-list.

### 2.6 LIKE and ILIKE: escape the wildcards

A parameter stops injection, but inside `LIKE` the characters `%` and `_` are still wildcards, and `\` is the default escape character [11]. A user who types `%` would match every row, and a long pattern of `%_%_%` can be slow. Escape them, then add your own wildcards:

```ts
// Good: user text matches literally; only our % wildcards are special
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

await pool.query(
  "SELECT id, title FROM documents WHERE title ILIKE $1 ESCAPE '\\'",
  [`%${escapeLike(userText)}%`],
);
```

The JavaScript string `'\\'` sends the SQL text `ESCAPE '\'`, which is correct when `standard_conforming_strings` is on (the default; PG 19 forces it on [69]). For real text search, see [12-full-text-and-vector-search.md](12-full-text-and-vector-search.md).

### 2.7 Dynamic SQL inside PL/pgSQL

Functions that build SQL at run time with `EXECUTE` can be injected exactly like application code [2]. The PostgreSQL manual gives the safe tools [12]:

- `EXECUTE '... $1 ...' USING value`: values travel as parameters. This is "much less prone to SQL-injection attacks since there is no need for quoting or escaping" [12].
- `format('%I', name)` quotes an identifier; `format('%L', value)` quotes a literal. `quote_ident()`, `quote_literal()` and `quote_nullable()` do the same as functions.
- Prefer `format(... %I ...)` + `USING` over `%L`, because values keep their native type [12].

```sql
-- Bad: table name and value are concatenated into the command
CREATE OR REPLACE FUNCTION count_by_status_bad(p_table text, p_status text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  EXECUTE 'SELECT count(*) FROM ' || p_table || ' WHERE status = ''' || p_status || ''''
    INTO n;
  RETURN n;
END $$;
-- count_by_status_bad('orders', $q$x' OR '1'='1$q$) counts every row;
-- p_table can even name a table the caller should not read.

-- Good: allow-list the table, quote it with %I, pass the value with USING
CREATE OR REPLACE FUNCTION count_by_status(p_table text, p_status text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  IF p_table NOT IN ('orders', 'invoices') THEN
    RAISE EXCEPTION 'table % is not allowed', p_table;
  END IF;
  EXECUTE format('SELECT count(*) FROM %I WHERE status = $1', p_table)
    INTO n
    USING p_status;
  RETURN n;
END $$;
```

For a schema-qualified name, quote each part: `format('%I.%I', schema_name, table_name)`. `quote_literal(NULL)` returns `NULL` and silently makes the whole string `NULL`; use `quote_nullable()` or `USING`.

### 2.8 Other places where text becomes code

| Statement | Problem | Safe form |
|---|---|---|
| `SET app.tenant_id = '...'` | `SET` does not accept bind parameters | `SELECT set_config('app.tenant_id', $1, true)` [13] |
| `NOTIFY channel, 'payload'` | The payload "must be specified as a simple string literal" [14] | `SELECT pg_notify($1, $2)` |
| `CREATE ROLE x PASSWORD '...'` | DDL takes no parameters; the password may be logged [18] | Use `\password` in psql or send a pre-hashed SCRAM verifier |
| Dynamic `ORDER BY`, column lists, table names | Not parameterizable | Allow-list (2.5) |
| Text-search input (`to_tsquery`) | User syntax errors raise exceptions | `websearch_to_tsquery($1)` (see [12-full-text-and-vector-search.md](12-full-text-and-vector-search.md)) |

## 3. Roles and privileges

### 3.1 Roles, users and groups

PostgreSQL has only **roles**. A role "can be considered a 'user', a 'group', or both depending on how it is used" [17]. A role with the `LOGIN` attribute can connect, so it acts as a user; a role without `LOGIN` is usually a group.

Important role attributes [17]:

| Attribute | Meaning | Advice |
|---|---|---|
| `LOGIN` | Can open a session | Only for real clients (app, migrator, people) |
| `SUPERUSER` | Bypasses every permission check | Only for the DBA; never for an app |
| `CREATEDB`, `CREATEROLE` | Create databases / roles | Admin roles only (PG 16 restricted what `CREATEROLE` may change [23]) |
| `BYPASSRLS` | Ignores row-level security | Never for the app role |
| `REPLICATION` | Can start streaming replication | Replication/backup tools only |
| `CONNECTION LIMIT n` | Max concurrent sessions for the role | Set it for app, reporting and agent roles |
| `VALID UNTIL 'ts'` | Password expiry time | Useful for temporary access |

`LOGIN`, `SUPERUSER`, `CREATEDB` and `CREATEROLE` "are never inherited as ordinary privileges on database objects are" [16]. Membership gives a role the *privileges* of the group, not its attributes.

### 3.2 Membership and inheritance

`GRANT group_role TO member` makes `member` a member. Since PG 16, each grant has two options [16] [23]:

- `INHERIT`: the member automatically uses the group's privileges.
- `SET`: the member may `SET ROLE group_role` to act as the group (for example, so new objects are owned by the group).

```sql
GRANT app_rw TO app_api WITH INHERIT TRUE, SET FALSE;  -- PG 16+: use privileges, cannot become app_rw
```

On PG 14–15, use plain `GRANT app_rw TO app_api;` (inheritance follows the member's `INHERIT` attribute, which is on by default).

### 3.3 A least-privilege role layout

*Least privilege* means each account gets only the rights it needs. OWASP says to "start from the ground up to determine what access rights your application accounts require, rather than trying to figure out what access rights you need to take away" [1].

| Role | LOGIN | Purpose | Gets |
|---|---|---|---|
| `app_owner` | yes, used only by the migration job | Owns the schema and all objects; runs DDL | Ownership (implicit full rights) |
| `app_rw` | no (group) | Read/write data | `USAGE` on schema; `SELECT, INSERT, UPDATE, DELETE` on tables; sequence usage; `EXECUTE` on chosen functions |
| `app_ro` | no (group) | Read-only data | `USAGE` on schema; `SELECT` |
| `app_api` | yes | The web/API service | Member of `app_rw` |
| `app_worker` | yes | Background jobs | Member of `app_rw` (or a narrower group) |
| `app_reporting` | yes | BI tools, analysts, AI agents | Member of `app_ro` (better: only curated views) |
| `app_monitor` | yes | Metrics exporter | Member of `pg_monitor` |

Separate login roles per service make logs, `pg_stat_activity` and connection limits clearer, and let you revoke one service without touching the others.

The full setup, run once by an admin (superuser or a `CREATEROLE` role), is below. Passwords are set afterwards with `\password <role>` in psql or by your secret manager, so they never appear in SQL files or logs [18].

```sql
-- Roles
CREATE ROLE app_owner LOGIN;                       -- used only by migrations
CREATE ROLE app_rw NOLOGIN;
CREATE ROLE app_ro NOLOGIN;
CREATE ROLE app_api LOGIN IN ROLE app_rw;          -- IN ROLE = "make member of"
CREATE ROLE app_worker LOGIN IN ROLE app_rw;
CREATE ROLE app_reporting LOGIN IN ROLE app_ro;
CREATE ROLE app_monitor LOGIN IN ROLE pg_monitor;

-- Database: only listed roles may connect (PUBLIC has CONNECT and TEMPORARY by default [15])
REVOKE ALL ON DATABASE appdb FROM PUBLIC;
GRANT CONNECT ON DATABASE appdb TO app_owner, app_rw, app_ro, app_monitor;

-- Schema owned by app_owner; nobody else can create objects in it
CREATE SCHEMA app AUTHORIZATION app_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;        -- needed on PG 14 and older; harmless on 15+
GRANT USAGE ON SCHEMA app TO app_rw, app_ro;

-- Rights on objects that already exist
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO app_ro;

-- Rights on objects that app_owner will create later (see 3.5)
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app
  GRANT SELECT ON TABLES TO app_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;          -- functions are executable by PUBLIC by default [15]
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO app_rw;
```

Notes:

- `TRUNCATE`, `REFERENCES`, `TRIGGER` and `CREATE` are not granted to the app. `TRUNCATE` in particular ignores row-level security [30].
- If your ORM keeps tables in `public` (the Prisma default), use `public` instead of `app` in the grants. The key point is that only `app_owner` may create objects there.
- Columns defined as `GENERATED ... AS IDENTITY` do not need sequence privileges for `INSERT`; old `serial` columns do (`permission denied for sequence ...` otherwise). Prefer identity columns.
- If you want the migration login to be separate from the owner, make `app_owner` `NOLOGIN`, grant it to a `migrator` login role, and start each migration with `SET ROLE app_owner` so new objects are owned by `app_owner`.

### 3.4 GRANT and REVOKE on each object type

| Object | Useful privileges [15] | Example |
|---|---|---|
| Database | `CONNECT`, `CREATE`, `TEMPORARY` | `GRANT CONNECT ON DATABASE appdb TO app_rw;` |
| Schema | `USAGE` (look up objects), `CREATE` | `GRANT USAGE ON SCHEMA app TO app_ro;` |
| Table/view | `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, `MAINTAIN` (PG 17+) | `GRANT SELECT ON app.orders TO app_ro;` |
| Column | `SELECT`, `INSERT`, `UPDATE`, `REFERENCES` | `GRANT SELECT (id, email) ON app.users TO app_support;` |
| Sequence | `USAGE`, `SELECT`, `UPDATE` | `GRANT USAGE, SELECT ON SEQUENCE app.orders_id_seq TO app_rw;` |
| Function/procedure | `EXECUTE` | `GRANT EXECUTE ON FUNCTION app.f(uuid) TO app_rw;` |
| Server parameter | `SET`, `ALTER SYSTEM` (PG 15+) [22] | `GRANT SET ON PARAMETER log_statement TO app_admin;` |

Column privileges are a simple way to hide a sensitive column (for example `password_hash`) from a support tool: grant `SELECT` only on the other columns (plus `USAGE` on the schema). Queries using `SELECT *` will then fail for that role, which is the desired behavior.

"The right to modify or destroy an object is inherent in being the object's owner, and cannot be granted or revoked in itself" [15]. This is why the app must not own its tables: an injection running as the owner could `DROP` or `ALTER` them, and would bypass RLS (section 6).

### 3.5 ALTER DEFAULT PRIVILEGES

`GRANT ... ON ALL TABLES IN SCHEMA` affects only tables that exist now. `ALTER DEFAULT PRIVILEGES` sets the privileges "that will be applied to objects created in the future" [19].

The common mistake: default privileges belong to the **creating** role. "New object permissions are only affected by the default privileges of the current role, and are not inherited from any roles in which the current role is a member" [19]. If migrations run as `migrator` but your defaults were set `FOR ROLE app_owner`, new tables get no grants. Always write `FOR ROLE <the role that runs CREATE TABLE>`, and check after each migration:

```sql
-- Which roles can do what on tables in schema app?
SELECT grantee, table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'app'
GROUP BY grantee, table_name
ORDER BY table_name, grantee;

-- Current default privileges (psql: \ddp)
SELECT pg_get_userbyid(defaclrole) AS creator, defaclnamespace::regnamespace AS schema,
       defaclobjtype AS object_type, defaclacl
FROM pg_default_acl;
```

### 3.6 Predefined roles

PostgreSQL ships roles that bundle common rights [20]. Grant them instead of superuser.

| Role | Allows | Since |
|---|---|---|
| `pg_read_all_data` | `SELECT` on all tables, views, sequences (does **not** bypass RLS) | PG 14 [21] |
| `pg_write_all_data` | `INSERT`, `UPDATE`, `DELETE` on all of them (does not bypass RLS) | PG 14 [21] |
| `pg_database_owner` | Implicit member = the current database owner; owns `public` in PG 15+ | PG 14 [21] |
| `pg_monitor` | Read monitoring views/settings (includes `pg_read_all_settings`, `pg_read_all_stats`, `pg_stat_scan_tables`) | all supported versions |
| `pg_signal_backend` | Cancel/terminate other non-superuser sessions | all supported versions |
| `pg_checkpoint` | Run `CHECKPOINT` | PG 15 [22] |
| `pg_use_reserved_connections` | Use slots reserved by `reserved_connections` | PG 16 [23] |
| `pg_create_subscription` | `CREATE SUBSCRIPTION` (with `CREATE` on the database) | PG 16 |
| `pg_maintain` | `VACUUM`, `ANALYZE`, `CLUSTER`, `REFRESH MATERIALIZED VIEW`, `REINDEX`, `LOCK TABLE` on all relations | PG 17 [24] |
| `pg_signal_autovacuum_worker` | Signal autovacuum workers | PG 18 [25] |
| `pg_read_server_files`, `pg_write_server_files`, `pg_execute_server_program` | Read/write server files, run programs | all supported versions |

The last three "could be used to gain superuser-level access" [20]. Treat them as superuser. In PG 19 (beta — may change), `pg_read_all_data` and `pg_write_all_data` also cover large objects, so non-superusers can run `pg_dump` [69].

### 3.7 The public schema and the PG 15 change

Before PG 15, every role could create objects in the `public` schema. PG 15 removed "PUBLIC creation permission on the public schema" and made `pg_database_owner` its owner [22]. The change "applies to new database clusters and to newly-created databases" [22]: a database upgraded from PG 14 keeps the old, unsafe rights. Run this once on such databases:

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

### 3.8 Never run the application as superuser or owner

A superuser skips every check: it can read any table, bypass RLS, load extensions, and run shell commands through `COPY ... TO PROGRAM`. One SQL injection in an app connected as `postgres` gives the attacker the whole server. The table owner is less powerful but can still `DROP`/`ALTER` tables and, by default, bypasses RLS [30].

Rule: the app connects as a login role that is a member of `app_rw` only. Migrations run as `app_owner` in a separate step (see [10-safe-schema-migrations.md](10-safe-schema-migrations.md)).

### 3.9 Per-role settings and limits

You can attach default settings to a role. They apply when that role logs in.

```sql
-- Example values; tune them to your workload
ALTER ROLE app_api SET statement_timeout = '5s';
ALTER ROLE app_api SET lock_timeout = '2s';
ALTER ROLE app_api SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE app_api SET search_path = app;
ALTER ROLE app_api CONNECTION LIMIT 40;

ALTER ROLE app_reporting SET statement_timeout = '30s';
ALTER ROLE app_reporting SET default_transaction_read_only = on;
ALTER ROLE app_reporting CONNECTION LIMIT 5;
```

Two limits of this feature:

- "Role-specific variable settings take effect only at login; `SET ROLE` and `SET SESSION AUTHORIZATION` do not process role-specific variable settings" [18].
- These are **defaults**, not locks. The role can run `SET statement_timeout = 0` or `SET TRANSACTION READ WRITE`. They are guardrails against mistakes. The security boundary is the privileges (a read-only role has only `SELECT`).

`CONNECTION LIMIT` also exists per database: `ALTER DATABASE appdb CONNECTION LIMIT 200;`.

### 3.10 Inspecting privileges

- psql: `\du` (roles), `\dp app.*` (table privileges), `\ddp` (default privileges), `\dn+` (schemas).
- SQL: `has_table_privilege('app_api', 'app.orders', 'DELETE')`, `has_schema_privilege(...)`, `has_function_privilege(...)`.
- PG 18 adds `pg_get_acl()` to read an object's access control list [25].
- Tests: pgTAP has `table_privs_are()`, `function_privs_are()` and similar assertions [40].

## 4. search_path security

### 4.1 The problem

When a query uses an unqualified name such as `lower(name)` or `orders`, PostgreSQL looks for it in the schemas listed in `search_path`. The default is `"$user", public` [26]. `pg_catalog` (built-in objects) is "implicitly searched *before*" the path's schemas, unless you list it explicitly [26].

The danger: "adding a schema to `search_path` effectively trusts all users having `CREATE` privilege on that schema" [26]. A user who can create objects in such a schema can create a function or operator with the same name as one you call, and it runs with **your** privileges. This is the class of attacks behind CVE-2018-1058 [27]. The PostgreSQL wiki example: a user creates `public.lower(varchar)`; for a `varchar` column it is a "better fit" than the built-in `lower(text)`, so other users' queries silently call the attacker's function [27].

### 4.2 Defenses

1. **No untrusted `CREATE` on any schema in the path.** PG 15+ already removes `CREATE` on `public` for `PUBLIC`; on older or upgraded databases run `REVOKE CREATE ON SCHEMA public FROM PUBLIC` [26] [22].
2. **Pin the path per role**: `ALTER ROLE app_api SET search_path = app;` [27].
3. **Schema-qualify names** in shared code (functions, triggers, views, migrations): `app.orders`, `pg_catalog.lower(x)` [27].
4. **Set `search_path` on functions**, especially `SECURITY DEFINER` ones (section 5). Two common styles:
   - `SET search_path = pg_catalog, pg_temp` and qualify every non-built-in name;
   - `SET search_path = ''` and qualify every name, built-ins included.
5. **Prefer SQL-standard function bodies (PG 14+)** for `LANGUAGE sql` functions. With `RETURN ...` or `BEGIN ATOMIC ... END`, "the body is parsed immediately and stored as a parse tree", which "can have security benefits" [21]: names are resolved once, at creation time, not at each call [28].

```sql
-- Body parsed at CREATE time (PG 14+): later search_path changes do not affect it
CREATE FUNCTION app.normalize_email(p_email text) RETURNS text
  LANGUAGE sql IMMUTABLE
  RETURN lower(trim(p_email));
```

Since PG 17, maintenance operations (`ANALYZE`, `CLUSTER`, `CREATE INDEX`, `CREATE MATERIALIZED VIEW`, `REFRESH MATERIALIZED VIEW`, `REINDEX`, `VACUUM`) run functions with a safe `search_path` [24]. A function used in an index expression or a materialized view that relies on an unqualified user object can fail after an upgrade to PG 17. Qualify the names or add `SET search_path` to the function.

## 5. SECURITY DEFINER functions

### 5.1 Why they are risky

A normal function runs with the privileges of the caller (`SECURITY INVOKER`). A `SECURITY DEFINER` function "is executed with the privileges of the user that owns it" [28]. It is useful to give a small, controlled power to a weak role: for example, "check if this user belongs to this tenant" without giving `SELECT` on the whole membership table. But any bug in it becomes a privilege escalation.

Known attacks:

- **search_path hijacking**: an attacker creates an object (table, function, operator) that masks the one the function expects. The temporary schema `pg_temp` "is searched first by default, and is normally writable by anyone" [28].
- **Operator shadowing**: Cybertec shows a user creating a custom `+` operator in `public` whose function runs `ALTER ROLE ... SUPERUSER`; an unqualified `$1 + 1` inside a superuser-owned `SECURITY DEFINER` function calls it [29].
- **Open execution**: "by default, execute privilege is granted to `PUBLIC` for newly created functions" [28].

### 5.2 The safe pattern (from the PostgreSQL manual)

```sql
BEGIN;  -- create and lock down in one transaction: no window where PUBLIC can call it [28]

CREATE FUNCTION app.user_tenant_ids(p_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp   -- trusted schemas first, pg_temp LAST [28]
AS $$
  SELECT m.tenant_id FROM app.memberships AS m WHERE m.user_id = p_user_id
$$;

REVOKE ALL ON FUNCTION app.user_tenant_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.user_tenant_ids(uuid) TO app_rw;

COMMIT;
```

Checklist for every `SECURITY DEFINER` function:

1. Owned by a role with the **minimum** privileges it needs, never a superuser.
2. `SET search_path` on the function; `pg_temp` last (or `search_path = ''`) [28].
3. All names schema-qualified, including operators if you are paranoid (`OPERATOR(pg_catalog.=)`) [29].
4. `REVOKE ALL ... FROM PUBLIC`, then `GRANT EXECUTE` to the roles that need it, in the same transaction [28]. Add `ALTER DEFAULT PRIVILEGES FOR ROLE <owner> REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` so you cannot forget.
5. Validate inputs; never build dynamic SQL from arguments without `format('%I')` and `USING` (section 2.7).
6. Return only what the caller needs (a boolean or an ID list, not whole rows).
7. Consider alternatives first: a `security_invoker` view, column privileges, or an RLS policy.

## 6. Row-level security (RLS)

### 6.1 How RLS works

*Row-level security* adds a hidden filter to every query on a table, based on *policies*. It protects data even when application code forgets a `WHERE tenant_id = ...` clause.

- `ALTER TABLE t ENABLE ROW LEVEL SECURITY` turns it on. With no policy, "a default-deny policy is used, meaning that no rows are visible or can be modified" [30].
- "Superusers and roles with the `BYPASSRLS` attribute always bypass the row security system" [30].
- "Table owners normally bypass row security as well", unless you also run `ALTER TABLE t FORCE ROW LEVEL SECURITY` [30].
- `TRUNCATE` and `REFERENCES` are not subject to RLS, and referential integrity checks (unique, primary and foreign keys) "always bypass row security" [30].

So the app role must: not be a superuser, not have `BYPASSRLS`, not own the table. Add `FORCE` anyway, so a mistake in role setup fails closed. With `FORCE`, the owner role also needs a policy (or `BYPASSRLS`) if migrations must read or update rows; otherwise those data migrations see zero rows.

### 6.2 Policies: USING, WITH CHECK, commands, and combination

```sql
CREATE POLICY name ON table_name
    [ AS { PERMISSIVE | RESTRICTIVE } ]
    [ FOR { ALL | SELECT | INSERT | UPDATE | DELETE } ]
    [ TO { role_name | PUBLIC | CURRENT_ROLE | CURRENT_USER | SESSION_USER } [, ...] ]
    [ USING ( using_expression ) ]
    [ WITH CHECK ( check_expression ) ]
```

- `USING` filters **existing** rows: which rows a command can see, update or delete.
- `WITH CHECK` validates **new** rows written by `INSERT` or `UPDATE`. If a policy has only `USING`, that expression is also used as the check [30].
- `PERMISSIVE` (default) policies are combined with `OR`; `RESTRICTIVE` policies are combined with `AND` [30]. "If only restrictive policies exist, then no records will be accessible" [31]: you need at least one permissive policy.
- An `UPDATE` (or `DELETE`) that reads columns, in `WHERE`, `SET` expressions or `RETURNING`, also applies the `SELECT` policies [31]. `INSERT ... ON CONFLICT DO UPDATE` checks the `SELECT`, `INSERT` and `UPDATE` policies.
- Rows filtered out by `USING` are skipped silently (an `UPDATE` reports 0 rows). Rows rejected by `WITH CHECK` raise `new row violates row-level security policy`.

| Command | Policies applied to existing rows | Policies applied to new rows |
|---|---|---|
| `SELECT` | `SELECT`/`ALL` `USING` | — |
| `INSERT` | — | `INSERT`/`ALL` `WITH CHECK` (+ `SELECT` `USING` if `RETURNING`) |
| `UPDATE` | `UPDATE`/`ALL` `USING` (+ `SELECT` `USING` if it reads columns) | `UPDATE`/`ALL` `WITH CHECK` (+ `SELECT` `USING` if it reads columns) |
| `DELETE` | `DELETE`/`ALL` `USING` (+ `SELECT` `USING` if it reads columns) | — |

A trap that follows from these rules: a policy `FOR SELECT USING (deleted_at IS NULL)` makes the soft-delete statement `UPDATE ... SET deleted_at = now() WHERE id = $1` fail, because the `SELECT` policy is checked against the new row. Handle soft-delete visibility in views or queries, not in a `SELECT` policy (see [07-schema-design-and-patterns.md](07-schema-design-and-patterns.md)).

### 6.3 A complete multi-tenant example

Tenant isolation as a `RESTRICTIVE` policy (it must always hold), and per-user rules as permissive policies.

```sql
-- Helper functions: read the per-transaction context set by the app (see 6.4)
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  RETURN NULLIF(current_setting('app.tenant_id', true), '')::uuid;

CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  RETURN NULLIF(current_setting('app.user_id', true), '')::uuid;

CREATE TABLE app.documents (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  owner_id   uuid NOT NULL,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  title      text NOT NULL
);
CREATE INDEX documents_tenant_owner_idx ON app.documents (tenant_id, owner_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.documents TO app_rw;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_user_id() TO app_rw;

ALTER TABLE app.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.documents FORCE ROW LEVEL SECURITY;

-- Must always hold, whatever the other policies say
CREATE POLICY tenant_guard ON app.documents AS RESTRICTIVE TO app_rw
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

-- Per-command permissive rules
CREATE POLICY read_visible ON app.documents FOR SELECT TO app_rw
  USING (visibility = 'shared' OR owner_id = (SELECT app.current_user_id()));
CREATE POLICY insert_own ON app.documents FOR INSERT TO app_rw
  WITH CHECK (owner_id = (SELECT app.current_user_id()));
CREATE POLICY update_own ON app.documents FOR UPDATE TO app_rw
  USING (owner_id = (SELECT app.current_user_id()))
  WITH CHECK (owner_id = (SELECT app.current_user_id()));
CREATE POLICY delete_own ON app.documents FOR DELETE TO app_rw
  USING (owner_id = (SELECT app.current_user_id()));
```

What happens (checked while writing this page): with no context, the app role sees 0 rows; a user sees the tenant's shared documents plus their own; an `INSERT` for another tenant fails with `new row violates row-level security policy "tenant_guard"`; an `UPDATE` of another user's document updates 0 rows.

Why `NULLIF(..., '')`: `current_setting(name, true)` returns `NULL` when the setting was never defined in the session. But once a transaction-local value ends, the setting stays defined with an **empty string** for the rest of the session. On a pooled connection that served a previous request, a plain `::uuid` cast would fail on `''`. `NULLIF` turns it into `NULL`, and `tenant_id = NULL` matches no row: the policy fails closed. Crunchy Data uses the same form [35].

### 6.4 Passing tenant and user context from the application

The policies read custom settings (`app.tenant_id`, `app.user_id`). The app sets them **inside the transaction** that runs the queries:

- `set_config('app.tenant_id', $1, true)`: the third argument `true` means "only apply during the current transaction" [13]. Unlike `SET`, it is a function, so the value can be a bind parameter.
- `SET LOCAL app.tenant_id = '...'` does the same, but cannot take a parameter. Outside a transaction block it "emits a warning and otherwise has no effect" [33].

Never use session-level `SET app.tenant_id = ...` (or `set_config(..., false)`) with a connection pool: the value stays on the connection, and the next request that borrows it runs as the previous tenant. Transaction-mode poolers such as PgBouncer do not support session `SET` at all [34]; transaction-local settings work because they end with the transaction. AWS warns that "using session variables may be incompatible with server-side connection pooling such as pgBouncer" [36] (its Java example also builds the `SET` with string concatenation, which is itself an injection risk).

node-postgres:

```ts
import type { Pool, PoolClient } from 'pg';

export async function withTenant<T>(
  pool: Pool,
  ctx: { tenantId: string; userId: string },
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [ctx.tenantId, ctx.userId],
    );
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

Prisma ORM 7 (interactive transaction; every query must use `tx`, not `prisma`):

```ts
const docs = await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
  await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
  return tx.document.findMany({ where: { visibility: 'shared' } });
});
```

Prisma's public example of a client extension wraps each query in a batch transaction that first calls `set_config(..., TRUE)` [37]. Two warnings about that example: its README says it is "not intended to be used in production", and it adds a bypass policy controlled by a setting (`app.bypass_rls = 'on'`) [37]. Any code path, or any SQL injection, can set such a setting. **Do not use a user-settable setting as a bypass switch.** For admin or cross-tenant work, use a separate role with `BYPASSRLS` (or a narrow `SECURITY DEFINER` function) and a separate pool.

Other context styles:

- **One database role per end user or tenant**, switched with `SET LOCAL ROLE` inside the transaction; policies use `current_user`. Simple policies, but many roles to manage; AWS notes it "doesn't scale well" [36].
- **Signed claims**: PostgREST/Supabase put the verified JWT claims into a setting and policies read them (for example `auth.uid()` in Supabase [38]). Same rules: set per transaction, never trust a client-supplied value that your server did not verify.

Keep filtering by tenant in application queries too. RLS is the safety net; explicit filters also help the planner (Supabase measured 171 ms → 9 ms in one of its tests by adding the filter in the query [39]).

### 6.5 Performance

Policies add conditions to every query, so they can make queries slow if written carelessly:

1. **Index the columns used in policies** (`tenant_id`, `owner_id`, ...). "Postgres evaluates the policy against each candidate row, so an unindexed filter column turns a read into a sequential scan" [38].
2. **Wrap function calls in `(SELECT ...)`.** This lets the planner run the function once per statement as an *InitPlan* and reuse the result, instead of calling it for each row [38]. Supabase reports, for example, 11,000 ms → 7 ms in one of its tests on a 100K-row table [39]. In `EXPLAIN` you will see `InitPlan 1` and a filter like `tenant_id = (InitPlan 1).col1`.
3. **Avoid joins inside policies.** Prefer `tenant_id IN (SELECT ...)` or `= ANY(...)` over correlating the outer row with another table; or call a `SECURITY DEFINER` helper that returns the allowed IDs [39].
4. **Use `TO role` on policies**, so they are not evaluated for roles they do not concern [39].
5. **Run `EXPLAIN` as the app role** (`SET ROLE app_rw` plus the context settings), not as a superuser or owner: they bypass RLS, so their plans hide the policy cost (see [06-query-optimization-and-explain.md](06-query-optimization-and-explain.md)).

#### Non-leakproof operators cannot use their indexes under RLS

A function is `LEAKPROOF` when it has no side effects and reveals nothing about its arguments except through its result; a function that raises an error for some inputs is not leakproof [28]. To avoid leaking hidden rows, PostgreSQL evaluates policy conditions *before* any user condition that uses a non-leakproof function [28] [31]. The consequence for indexes is stated in the manual: "an index scan cannot be selected for queries on security barrier views (or tables with row-level security policies) if an operator used in the WHERE clause is associated with the operator family of the index, but its underlying function is not marked LEAKPROOF" [71]. In the planner, such a clause is not "securely promotable" and is rejected as an index condition [72].

Which operators are affected (PostgreSQL 18 catalog, checked while writing this page):

| Leakproof: index still usable under RLS | Not leakproof: index NOT usable under RLS |
|---|---|
| `=` on `int`, `bigint`, `text`, `uuid` (for example `texteq`) | Full-text `tsvector @@ tsquery` (`ts_match_vq`) |
| | `jsonb @>` (`jsonb_contains`), even `jsonb =` |
| | `LIKE` / `ILIKE` (`textlike`, `texticlike`) |
| | `pg_trgm` operators such as `%` (`similarity_op`) |

On a test table with GIN indexes, the same query as a superuser used `Bitmap Index Scan on docs_tsv` (full text), `docs_meta` (`jsonb @>`) and `docs_body_trgm` (`ILIKE`). As an RLS-subject role, each plan used only the `tenant_id` index and turned the search condition into a `Filter:` line; an `=` filter on an indexed `text` column still used its index. See the full-text side of this trap in [12-full-text-and-vector-search.md](12-full-text-and-vector-search.md#74-row-level-security-and-search-indexes-a-trap).

Practical consequence: search filters cost "read every row of the tenant, then filter". This is fine for small tenants and slow for large ones. To list leakproof operators, use psql's `\dAo+` [71] or query `pg_proc.proleakproof`.

Mitigations, from simplest to strongest:

1. **Keep the policy cheap and selective** (`tenant_id = (SELECT app.current_tenant_id())` on an indexed column, leakproof equality). Then the fallback scans only one tenant's rows. Very large tenants may need partitioning (see [07-schema-design-and-patterns.md](07-schema-design-and-patterns.md)).
2. **Two-step search through a reviewed `SECURITY DEFINER` function.** The function runs as its owner. When that owner is not subject to RLS, the planner may use the search index again (it still chooses by cost). The function applies the tenant filter **explicitly** and returns only IDs; the app then loads rows normally, through RLS, with `id = ANY($1)` (leakproof equality, index usable). The tenant check now lives in reviewed code: follow section 5 and test it like a policy. Because the table uses `FORCE ROW LEVEL SECURITY` (6.1), even the table owner is filtered, so give the function a dedicated `NOLOGIN` owner role with `BYPASSRLS` and only the `SELECT` rights the search needs.
3. **Mark a function `LEAKPROOF` only if it truly is.** Only a superuser can do it [28]. It is a promise that no error, notice or side effect can reveal anything about hidden rows. Do not change the flag of built-in operators: that is a change to system objects, outside your migrations, and a security decision PostgreSQL deliberately did not make.

```sql
-- A narrow owner for search functions (creating a BYPASSRLS role needs a superuser)
CREATE ROLE app_search NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA app TO app_search;
GRANT SELECT ON app.documents TO app_search;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO app_search;

-- Step 1: index-friendly search, tenant filter applied explicitly inside
BEGIN;
CREATE FUNCTION app.search_document_ids(p_query text)
RETURNS SETOF bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT d.id
  FROM app.documents AS d
  WHERE d.tenant_id = app.current_tenant_id()          -- explicit, mandatory
    AND d.search_tsv @@ websearch_to_tsquery('english', p_query)
  LIMIT 200
$$;
ALTER FUNCTION app.search_document_ids(text) OWNER TO app_search;
REVOKE ALL ON FUNCTION app.search_document_ids(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.search_document_ids(text) TO app_rw;
COMMIT;

-- Step 2: normal query as the app role; RLS still applies, the primary key index is used
SELECT id, title FROM app.documents WHERE id = ANY($1::bigint[]);
```

In a test on PostgreSQL 18.3, the app role could not use the GIN index for `search_tsv @@ ...` even with sequential scans disabled, while the `app_search` role could; the function returned only the current tenant's IDs.

(The `search_tsv` column is an example; see [12-full-text-and-vector-search.md](12-full-text-and-vector-search.md) for how to store it.)

### 6.6 Views and RLS

By default, a view accesses its tables with the permissions **of the view owner** [32]. If the owner is the table owner or a superuser, the view silently bypasses RLS for everyone who can read the view.

- `CREATE VIEW ... WITH (security_invoker = true)` (PG 15+): "the policies and permissions of the invoking user are used instead, as if the base relations had been referenced directly" [32].
- On PG 14, keep views over RLS tables in a schema the app cannot read, or replace them with functions.
- `security_barrier` is for views that are *themselves* a row filter: it makes the view's `WHERE` run before user conditions, so user functions cannot see filtered rows [32].

```sql
CREATE VIEW app.document_titles WITH (security_invoker = true) AS
  SELECT id, title FROM app.documents;
GRANT SELECT ON app.document_titles TO app_rw;
```

### 6.7 Pitfalls

| Pitfall | Effect | Fix |
|---|---|---|
| App role owns the tables | RLS ignored | Separate owner; `FORCE ROW LEVEL SECURITY` |
| App role is superuser or `BYPASSRLS` | RLS ignored | Least-privilege role (section 3) |
| Session-level `SET` with a pool | Data of tenant A served to tenant B | `set_config(..., true)` inside a transaction |
| `current_setting(...)::uuid` without `NULLIF` | Errors on reused connections | `NULLIF(current_setting(name, true), '')` |
| View owned by table owner | View bypasses RLS | `security_invoker = true` (PG 15+) |
| Unique/foreign key checks | Can reveal that a hidden row exists ("covert channel") [30] | Avoid user-chosen unique values across tenants; include `tenant_id` in unique keys |
| `TRUNCATE` | Not filtered by RLS [30] | Never grant `TRUNCATE` to app roles |
| Backups with `pg_dump` as a normal role | Rows may be silently skipped | Dump as a role that bypasses RLS; `row_security = off` makes filtering raise an error instead [30] |
| Bypass via a custom setting | Any SQL can switch it on | Separate `BYPASSRLS` role and pool |

PG 18 adds `--no-policies` to `pg_dump`, `pg_dumpall` and `pg_restore` [25], useful when restoring into a system with different policies.

### 6.8 Testing policies

Test RLS with the **real application role**, never as a superuser (a superuser bypasses everything, so tests pass while production leaks). A minimal SQL test:

```sql
BEGIN;
SET LOCAL ROLE app_rw;
SELECT set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true),
       set_config('app.user_id',   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true);

-- Expect: only rows of tenant 1 that user b may see
SELECT count(*) FROM app.documents WHERE tenant_id <> app.current_tenant_id();  -- must be 0
ROLLBACK;
```

- Cover each command (`SELECT`, `INSERT`, `UPDATE`, `DELETE`), the "no context" case (must see nothing), and cross-tenant writes (must fail).
- pgTAP provides `policies_are()`, `policy_roles_are()`, `policy_cmd_is()`, `results_eq()` and `throws_ok()` [40].
- From TypeScript, run these tests against a real PostgreSQL in a container (see [15-postgres-from-typescript.md](15-postgres-from-typescript.md)), connected as the app role.

## 7. Authentication and network access

### 7.1 pg_hba.conf: who may connect, from where, and how

`pg_hba.conf` ("host-based authentication") decides, for each connection, which authentication method to use. Rules:

- Records are read top to bottom. "The first record with a matching connection type, client address, requested database, and user name is used". There is no fall-through: if that method fails, later lines are not tried. If no line matches, access is denied [41].
- Connection types: `local` (Unix socket), `host` (TCP, with or without TLS), `hostssl` (TCP with TLS only), `hostnossl`, `hostgssenc`, `hostnogssenc` [41].
- The file is read at startup and on reload (`SELECT pg_reload_conf();`). Check it first with the `pg_hba_file_rules` view: rows with a non-null `error` show broken lines [41].
- PG 16+ accepts regular expressions (`/^db\d+$/`) for database and user names, and `include`, `include_if_exists`, `include_dir` directives [41] [23].

A strict example (specific lines first, explicit reject at the end):

```text
# TYPE    DATABASE  USER                 ADDRESS         METHOD
local     all       postgres                             peer
hostssl   appdb     app_api,app_worker   10.0.1.0/24     scram-sha-256
hostssl   appdb     app_owner            10.0.2.10/32    scram-sha-256
hostssl   appdb     app_reporting        10.0.3.0/24     scram-sha-256
host      all       all                  0.0.0.0/0       reject
host      all       all                  ::/0            reject
```

```sql
-- Before reloading: any parsing errors?
SELECT line_number, type, database, user_name, address, auth_method, error
FROM pg_hba_file_rules;
```

### 7.2 Authentication methods

| Method | Use it? | Notes |
|---|---|---|
| `scram-sha-256` | **Yes**, for passwords | Challenge-response; the server stores a salted verifier, not the password [42]. `password_encryption` defaults to `scram-sha-256` since PG 14 [21] [44] |
| `md5` | Migrate away | "Support for MD5-encrypted passwords is deprecated and will be removed in a future release" [42]. PG 18 warns when an MD5 password is set (`md5_password_warnings`) [25]; PG 19 (beta — may change) also warns after a successful MD5 login [69] |
| `password` | No | Sends the password in clear text [42] |
| `trust` | Never on a network | No password at all; even locally it is risky. The official Docker image prints a large warning when you choose it [45] |
| `peer` | Yes, for local admin | Maps the OS user to the role, Unix sockets only |
| `cert` | Yes, for services | TLS client certificate; also `clientcert=verify-full` on other methods [41] |
| `ldap`, `gss`, `sspi`, `pam` | Enterprise setups | Central identity; prefer GSSAPI (Kerberos) over LDAP simple bind |
| `radius` | No | Removed in PG 19 (beta — may change): "only supported RADIUS over UDP, which is unfixably insecure" [69] |
| `oauth` | PG 18+, see 7.3 | Bearer tokens from an identity provider [43] |
| `reject` | Yes | Explicitly deny a range |

Migrating from MD5 to SCRAM, as the manual describes [42]: make sure all client libraries support SCRAM; set `password_encryption = 'scram-sha-256'`; make every user set a new password (the old hash cannot be converted); then change `md5` to `scram-sha-256` in `pg_hba.conf`. To find roles that still have an MD5 hash (superuser only):

```sql
SELECT rolname FROM pg_authid WHERE rolpassword LIKE 'md5%';
```

Clients can also refuse weak methods: libpq has `require_auth` (PG 16+) [47], and node-postgres supports `SCRAM-SHA-256-PLUS` channel binding since pg 8.14 [5].

### 7.3 OAuth (PG 18+)

PG 18 adds the `oauth` method: the client presents a bearer token from an identity provider [25] [43]. Things to know:

- PostgreSQL does **not** ship a token validator. You must load a validator module through `oauth_validator_libraries` (usually provided by your identity provider or cloud vendor) [43].
- `pg_hba.conf` options: `issuer` and `scope` are required; `validator`, `map` and `delegate_ident_mapping` are optional [43].
- The libpq client side needs PostgreSQL built with `--with-libcurl` [25]. Node.js drivers implement the protocol themselves, so check your driver's documentation before you plan on OAuth.

### 7.4 Network exposure

- `listen_addresses` defaults to `localhost` [44]. The official Docker image changes it to `'*'` (all interfaces) [45]. In Docker Compose, publish the port on loopback only: `ports: ["127.0.0.1:5432:5432"]`, or do not publish it and let other containers use the internal network.
- Keep the database in a private network. Allow port 5432 only from the application hosts (firewall, security groups). Use a VPN or bastion for human access.
- Never rely on `pg_hba.conf` alone; network rules are the first layer.
- `authentication_timeout` (default 1 minute) limits half-open login attempts [44].

### 7.5 Connection limits

| Setting | Default | Purpose |
|---|---|---|
| `max_connections` | "typically 100" [44] | Total sessions. Each session uses server memory; use a pooler instead of raising it a lot (see [09-operations-and-server-tuning.md](09-operations-and-server-tuning.md)) |
| `superuser_reserved_connections` | 3 [44] | Emergency slots for superusers |
| `reserved_connections` (PG 16+) | 0 | Slots for members of `pg_use_reserved_connections` (for example your monitoring role) [44] [23] |
| `ALTER ROLE ... CONNECTION LIMIT n` | -1 (none) | Stops one service or one agent from taking all slots |
| `ALTER DATABASE ... CONNECTION LIMIT n` | -1 (none) | Same, per database |

### 7.6 Credentials

- Keep database passwords in a secret manager or the platform's secret store, never in Git, Docker images, or CI logs.
- Use one login role per service; rotate passwords on a schedule and after any leak. A simple zero-downtime rotation: two login roles (`app_api_a`, `app_api_b`) with the same group membership; switch the app to the other one, then change the old one's password.
- `VALID UNTIL` gives temporary access an end date [17]. PG 19 (beta — may change) adds `password_expiration_warning_threshold` (default seven days) to warn users about expiring passwords [69].
- In node-postgres, `password` can be an async function, useful for short-lived tokens such as cloud IAM authentication; since pg 8.19 it receives the connection parameters [5].
- Changing a password with `ALTER ROLE ... PASSWORD 'clear text'` sends it in clear text, and it "might also be logged in the client's command history or the server log". Use psql's `\password` instead [18].

## 8. Encryption

### 8.1 In transit (TLS)

Server side:

- Turn on TLS (`ssl = on` plus certificate and key files) and require it with `hostssl` lines in `pg_hba.conf` (7.1).
- `ssl_min_protocol_version` defaults to `TLSv1.2` [44]. PG 18 adds `ssl_tls13_ciphers` and renames `ssl_ecdh_curve` to `ssl_groups` (now including X25519 by default) [25].
- PG 19 (beta — may change) adds SNI support (`pg_hosts.conf`), so one server can present different certificates per host name [69].

Client side: the libpq `sslmode` decides what is checked [46].

| `sslmode` | Encrypted? | Protects against a fake server (MITM)? |
|---|---|---|
| `disable` | No | No |
| `allow`, `prefer` (libpq default) | Maybe | No |
| `require` | Yes | No |
| `verify-ca` | Yes | Depends on the CA |
| `verify-full` | Yes | **Yes** (checks CA and host name) |

The default `prefer` "is not recommended in secure deployments"; `verify-full` "is recommended in most security-sensitive environments" [46]. With libpq (PG 16+), `sslrootcert=system` uses the operating system's trusted CAs and changes the default `sslmode` to `verify-full`; weaker settings then cause an error [47] [23]. `sslnegotiation=direct` (PG 17+) starts TLS immediately and saves a round trip [24]; node-postgres supports it since pg 8.22 [5].

**node-postgres warning.** In pg 8.x, `sslmode=prefer`, `require` and `verify-ca` in a connection string are treated as `verify-full`, and pg prints: "In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees" [48]. Write what you mean:

```ts
import fs from 'node:fs';
import { Pool } from 'pg';

// Good: explicit CA and verification. Do NOT also put sslmode=... in the URL:
// fields parsed from connectionString override the config object.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // e.g. postgres://app_api@db.internal:5432/appdb
  ssl: {
    ca: fs.readFileSync('/etc/ssl/certs/db-ca.pem', 'utf8'),
    rejectUnauthorized: true, // never false in production
  },
});
```

Or use `?sslmode=verify-full&sslrootcert=/path/ca.pem` in the URL and no `ssl` object. Prisma 7 with `@prisma/adapter-pg` uses the same `pg` settings and validates certificates by default (see [15-postgres-from-typescript.md](15-postgres-from-typescript.md)).

### 8.2 At rest

- Community PostgreSQL has **no built-in transparent data encryption (TDE)**. The manual lists file-system or block-device encryption (for example LUKS/dm-crypt) as "data partition encryption" [49], and so do cloud providers (encrypted volumes).
- What disk encryption protects: stolen disks or snapshots. What it does not protect: "when mounted, the operating system provides an unencrypted view of the data" [49]. An attacker with database access still reads everything.
- Vendor TDE exists: EDB Postgres Advanced Server and EDB Postgres Extended Server "from version 15" [50]; Percona's open-source `pg_tde` extension, which "requires its patches" in Percona Server for PostgreSQL (17+) [51].
- Backups and WAL archives are copies of all data: encrypt them too (pgBackRest supports `repo-cipher-type=aes-256-cbc`, default `none` [60]).

### 8.3 Column-level encryption

Use it for a few very sensitive fields (national ID numbers, bank details, API secrets of customers), not for everything.

**Option A: pgcrypto (inside the database).** The manual recommends the PGP functions over raw `encrypt()`/`decrypt()` [52].

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- trusted: a role with CREATE on the database can install it [63]

-- Value and key as bind parameters, never as literals in the SQL text
INSERT INTO secrets (id, ssn_enc) VALUES ($1, pgp_sym_encrypt($2, $3));
SELECT pgp_sym_decrypt(ssn_enc, $1) AS ssn FROM secrets WHERE id = $2;
```

The limits are serious: "all the data and passwords move between `pgcrypto` and client applications in clear text", so you must use TLS and "trust both system and database administrator" [52]. The key is a bind parameter, so it can appear in the server log when statement logging is on (section 9.2).

**Option B: encrypt in the application (preferred for high-value secrets).** "If the system administrator for the server's machine cannot be trusted, it is necessary for the client to encrypt the data" [49]. Keep the key in a KMS or secret manager, store ciphertext in a `bytea` column:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// key: 32 bytes from your KMS / secret manager, never stored in the database
export function encryptField(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]); // layout: iv(12) | tag(16) | data
}

export function decryptField(blob: Buffer, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8');
}
```

Encrypted columns cannot be indexed or searched by value. If you need equality lookups, store a keyed hash (HMAC) of the normalized value in a separate indexed column. Plan key rotation from the start (store a key version next to the ciphertext).

### 8.4 End-user passwords

Hash end-user passwords **in the application**; never store them in plain text or with reversible encryption. OWASP recommends Argon2id with at least 19 MiB of memory, 2 iterations and parallelism 1; scrypt if Argon2id is not available; bcrypt only for legacy systems, with a work factor of 10 or more and its 72-byte input limit [53]. pgcrypto's `crypt()` can hash passwords in SQL [52], but then the clear password travels to the database and can end up in logs; hashing in the app avoids that.

## 9. Auditing and logging

### 9.1 A useful logging baseline

| Setting | Suggested value | Why |
|---|---|---|
| `log_connections` | PG 18+: `'authentication,authorization'` (or `all`); PG 14–17: `on` | Who connected; PG 18 turned it into a list of options [54] [25] |
| `log_disconnections` | `on` | Session duration [54] |
| `log_line_prefix` | e.g. `'%m [%p] user=%u db=%d app=%a client=%h '` | Puts user, database, application and client address on each line [54] |
| `log_min_duration_statement` | e.g. `'500ms'` | Slow queries (see [06-query-optimization-and-explain.md](06-query-optimization-and-explain.md)) |
| `log_statement` | `ddl` | Schema changes; `mod`/`all` log every write or every statement, with their data |
| `log_parameter_max_length` | `0` or a small number | See 9.2 |

Failed authentication "is always logged regardless of the value" of `log_connections` [54].

### 9.2 Keep secrets and personal data out of logs

Logs are often less protected than the database, are shipped to third-party services, and are kept for a long time. Check these settings:

- `log_parameter_max_length`: default `-1`, which "allows bind parameters to be logged in full" in statement logs (`log_statement`, `log_min_duration_statement`) [54]. Set `0` to log no parameter values, or a small byte limit.
- `log_parameter_max_length_on_error`: default `0`, so parameters are not included in error messages [54]. Keep it.
- `log_min_error_statement`: default `ERROR`, so the **text** of a failing statement is logged [54]. With parameters the text contains only `$1`; with concatenated SQL it contains the data. One more reason for bind parameters.
- `log_statement = 'all'`: logs everything, including values in SQL text. Use only briefly for debugging.
- Passwords in `CREATE/ALTER ROLE ... PASSWORD` can reach the server log [18]. Use `\password`.
- `pg_stat_activity.query` shows the current statement of every session to its own role and to members of `pg_read_all_stats` [68]. Again, parameters keep values out of it.
- Application side: Prisma's `query` log event exposes `e.params`, and the OpenTelemetry `pg` instrumentation can attach parameters to spans with `enhancedDatabaseReporting` (see [15-postgres-from-typescript.md](15-postgres-from-typescript.md)). Do not enable these in production for tables with personal data.

### 9.3 pgAudit

"Basic statement logging can be provided by the standard logging facility with `log_statement = all`... [but it] does not provide the level of detail generally required for an audit" [55]. pgAudit logs what really happened, with the object names, in a structured `AUDIT:` line.

- Install: add `pgaudit` to `shared_preload_libraries` and restart; then `CREATE EXTENSION pgaudit` (it installs event triggers for richer DDL logging) [55].
- **Session logging** (`pgaudit.log`): classes `READ`, `WRITE`, `FUNCTION`, `ROLE`, `DDL`, `MISC`, `MISC_SET`, `ALL` [55].
- **Object logging** (`pgaudit.role`): grant `SELECT`/`INSERT`/`UPDATE`/`DELETE` on specific tables to an audit role, and only statements touching those tables are logged [55].
- Useful options: `pgaudit.log_relation` (one line per table), `pgaudit.log_parameter` (off by default; it logs parameter values, which may be personal data), `pgaudit.log_rows` [55].
- Limits: "audit logging is best-effort and not transactional"; "it is not possible to reliably audit superusers with pgAudit"; logging `READ`/`WRITE` on busy tables can produce "an enormous volume of logging" [55]. Settings "may be modified only by a superuser" [55].
- Versions: pgAudit has one branch per PostgreSQL major (v14 to v19) [55].

```sql
-- Example: audit role and privilege changes, all DDL, and writes; one line per table
ALTER SYSTEM SET pgaudit.log = 'ddl, role, write';
ALTER SYSTEM SET pgaudit.log_relation = on;
SELECT pg_reload_conf();
```

### 9.4 DDL auditing with event triggers

*Event triggers* fire on database-wide events: `login` (PG 17+), `ddl_command_start`, `ddl_command_end`, `table_rewrite`, `sql_drop` [56] [24]. "Only superusers can create event triggers" [57].

```sql
CREATE SCHEMA audit;

CREATE TABLE audit.ddl_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  happened_at     timestamptz NOT NULL DEFAULT now(),
  executed_by     text NOT NULL DEFAULT session_user,
  command_tag     text NOT NULL,
  object_type     text,
  object_identity text
);

-- SECURITY DEFINER so that roles running DDL do not need INSERT on the log table
CREATE FUNCTION audit.log_ddl() RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    INSERT INTO audit.ddl_log (command_tag, object_type, object_identity)
    VALUES (r.command_tag, r.object_type, r.object_identity);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION audit.log_ddl() FROM PUBLIC;

CREATE EVENT TRIGGER log_ddl ON ddl_command_end EXECUTE FUNCTION audit.log_ddl();
```

`pg_event_trigger_ddl_commands()` returns one row per command with `command_tag`, `object_type`, `object_identity` and more [58]. A `login` event trigger (PG 17+) can record or restrict logins, but "any bug in a trigger procedure for this event may prevent successful login"; setting `event_triggers = false` (PG 17+) disables event triggers for recovery [56] [57] [24].

For row-level change history in application tables (who changed which order), see the audit-table pattern in [07-schema-design-and-patterns.md](07-schema-design-and-patterns.md).

## 10. Data protection

### 10.1 Collect less, mask the rest

The safest personal data is the data you do not store. Store only what the product needs, and keep sensitive attributes in separate tables so you can grant and protect them separately.

For analytics, support tools, test environments and AI agents, use **masked** data. PostgreSQL Anonymizer (by Dalibo) declares masking rules in the schema with security labels [59]:

```sql
SECURITY LABEL FOR anon ON COLUMN people.lastname
  IS 'MASKED WITH FUNCTION anon.dummy_last_name()';
```

It supports anonymous dumps, static masking (rewrite the data in place), dynamic masking (masked roles see fake values), masking views, and replica masking [59]. A masked copy of production is the right source for staging and for giving data to developers.

### 10.2 Backups

- Encrypt backups and WAL archives (8.2), and store keys separately from the backup files.
- Restrict who can read backup storage; a backup is a full copy of the database, outside RLS and outside your role model.
- Set a retention period and delete expired backups automatically. Test restores regularly (see [09-operations-and-server-tuning.md](09-operations-and-server-tuning.md)).

### 10.3 Retention and GDPR erasure

- Define how long each kind of data is kept, and run scheduled deletion jobs in batches (see [04-query-patterns-and-antipatterns.md](04-query-patterns-and-antipatterns.md)).
- The UK regulator's guidance: respond to an erasure request "without undue delay and at the latest within one month" [61] (the EU GDPR uses the same one-month period).
- A soft delete (`deleted_at`) is **not** erasure. Delete or anonymize the personal fields.
- Backups: you cannot easily edit old backups. The UK regulator accepts putting backup data "beyond use" until it is overwritten on the normal schedule, as long as it is not used for anything else [61]. Short backup retention makes this simpler.
- An option for strong erasure is *crypto-shredding*: encrypt one user's sensitive fields with a per-user key (8.3) and delete the key on erasure; copies in backups become unreadable.

## 11. Extensions and procedural languages

Extensions run code inside the server process, often in C. Treat each one like a dependency with full database access.

- **Trusted extensions**: "Trusted extensions can be run by any user who has CREATE privilege on the current database"; "trusted extensions are ones that cannot provide access to outside-the-database functionality" [63]. Trusted contrib modules include `btree_gin`, `btree_gist`, `citext`, `cube`, `dict_int`, `fuzzystrmatch`, `hstore`, `intarray`, `isn`, `lo`, `ltree`, `pgcrypto`, `pg_trgm`, `seg`, `tablefunc`, `tcn`, `tsm_system_rows`, `tsm_system_time`, `unaccent`, `uuid-ossp` [63].
- Everything else needs a superuser (or the cloud provider's admin role). For example, pgvector's control file does not set `trusted = true` (checked on version 0.8.7) [66].
- An extension marked `trusted` runs its install script as the bootstrap superuser; this "requires significant extra effort to write the extension's installation and update script(s) securely" [62]. Only use extensions from sources you trust, keep them updated, and install them into a dedicated schema (`CREATE EXTENSION ... SCHEMA extensions`) that app roles cannot write to.
- **Procedural languages**: a trusted language (`plpgsql`, `sql`) "does not grant access to data that the user would not otherwise have"; for untrusted ones, "only users with the PostgreSQL superuser privilege can use this language to create new functions" [64]. `plpython3u` is "only available as an 'untrusted' language" [65] and can do anything the server's operating-system user can do. Do not install untrusted languages unless you really need them.
- Server file and program access (`COPY ... FROM/TO PROGRAM`, `pg_read_server_files`, `pg_write_server_files`, `pg_execute_server_program`) is superuser-equivalent [20]. Never grant it to application roles.

## 12. AI agents and other automated clients

Coding assistants, chat-to-SQL tools and MCP servers that query your database are a new kind of client. Supabase describes the "lethal trifecta": a model that interprets natural language, can call tools on its own, and has access to private data. Text stored in your database can contain hidden instructions that make the agent leak data [67]. Their first advice: "Never connect AI agents directly to production data" [67].

Database-side controls:

1. A **dedicated login role** per agent or tool; never a superuser, never the owner, never `BYPASSRLS`.
2. **Read-only by privilege**: grant `SELECT` on curated views of masked data (10.1), not on all tables. Avoid `pg_read_all_data` on production.
3. **Guardrail settings**: `statement_timeout`, `idle_in_transaction_session_timeout`, `default_transaction_read_only = on`, `CONNECTION LIMIT`. Remember that the role can override these settings (3.9): they limit accidents; the privileges limit attacks.
4. **Row limits**: PostgreSQL cannot cap result size per role. Enforce a `LIMIT` and a maximum response size in the tool that runs the SQL, or expose only views/functions that return bounded results.
5. **RLS** on shared tables, with the agent's tenant context set like any other client (6.4).
6. **Visibility**: a distinct role name and `application_name` make the agent's queries easy to find in logs, `pg_stat_activity` and pgAudit.
7. Keep a human approval step for any tool that can write, and prefer a staging database or a masked replica [67].

```sql
CREATE ROLE ai_agent LOGIN CONNECTION LIMIT 2;
GRANT CONNECT ON DATABASE appdb TO ai_agent;
CREATE SCHEMA agent_views AUTHORIZATION app_owner;   -- curated, masked views live here
GRANT USAGE ON SCHEMA agent_views TO ai_agent;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA agent_views
  GRANT SELECT ON TABLES TO ai_agent;                -- views count as tables here
ALTER ROLE ai_agent SET default_transaction_read_only = on;
ALTER ROLE ai_agent SET statement_timeout = '10s';
ALTER ROLE ai_agent SET idle_in_transaction_session_timeout = '30s';
```

## 13. Hardening checklist

**Application code**

- [ ] All values are bind parameters; no SQL built with `+` or template strings around user input.
- [ ] Identifiers, sort keys and directions come from allow-lists.
- [ ] No `$queryRawUnsafe` / `Prisma.raw` / `sql.raw` / `sql.unsafe` with input; each use is reviewed.
- [ ] `LIKE` input is escaped.
- [ ] Database errors are logged on the server side and not returned raw to clients.
- [ ] TLS is on with certificate verification (`verify-full` or an explicit `ssl.ca`), never `rejectUnauthorized: false`.

**Roles and privileges**

- [ ] The app does not connect as a superuser or as the table owner.
- [ ] Owner/migration, read-write, read-only and monitoring roles are separate; one login role per service.
- [ ] `REVOKE ALL ON DATABASE ... FROM PUBLIC`; `CREATE` on `public` revoked (PG 14 or upgraded databases).
- [ ] `ALTER DEFAULT PRIVILEGES FOR ROLE <creator>` is set and checked after migrations.
- [ ] No `TRUNCATE`, `TRIGGER`, `REFERENCES` or `CREATE` for app roles.
- [ ] `EXECUTE` on functions is revoked from `PUBLIC` by default.
- [ ] Every `SECURITY DEFINER` function has `SET search_path` and restricted `EXECUTE`.
- [ ] Per-role `statement_timeout`, `idle_in_transaction_session_timeout`, `CONNECTION LIMIT`.
- [ ] No app role has `BYPASSRLS`, `CREATEROLE`, `CREATEDB` or a file/program predefined role.

**Row-level security** (if used)

- [ ] `ENABLE` and `FORCE ROW LEVEL SECURITY` on every tenant table.
- [ ] Context set with `set_config(..., true)` inside transactions; read with `NULLIF(current_setting(..., true), '')`.
- [ ] Policy columns indexed; function calls wrapped in `(SELECT ...)`.
- [ ] Views over RLS tables use `security_invoker = true` (PG 15+).
- [ ] Policy tests run as the app role in CI.

**Server and network**

- [ ] Port 5432 is not reachable from the internet; `listen_addresses` and the firewall are restricted.
- [ ] `pg_hba.conf` uses `hostssl` + `scram-sha-256` (or `cert`); no `trust` on TCP; ends with `reject`.
- [ ] No role has an MD5 password left.
- [ ] TLS enabled; `ssl_min_protocol_version` at least `TLSv1.2`.
- [ ] Disk/volume encryption on; backups encrypted, access-controlled, with a retention limit.
- [ ] Only needed extensions are installed; no untrusted languages unless required.
- [ ] Minor versions are kept up to date (see [09-operations-and-server-tuning.md](09-operations-and-server-tuning.md)).

**Logging and data protection**

- [ ] `log_parameter_max_length` set to `0` or a small value; no passwords in DDL logs.
- [ ] `log_connections`/`log_disconnections` on; `log_line_prefix` includes user, database, application and client.
- [ ] pgAudit configured where an audit trail is required.
- [ ] Masked data for staging, analytics and AI agents; the GDPR erasure procedure covers backups.

## Sources

1. [SQL Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html) — OWASP: primary defenses, escaping discouraged, allow-lists for identifiers/sort order, least privilege.
2. [Query Parameterization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Query_Parameterization_Cheat_Sheet.html) — OWASP: parameterized queries; dynamic SQL inside stored procedures can still be injected.
3. [Message Flow](https://www.postgresql.org/docs/current/protocol-flow.html) — PostgreSQL docs: simple protocol allows several statements; Parse accepts only one statement.
4. [Queries](https://node-postgres.com/features/queries) — node-postgres: `$1` parameters, no parameters for identifiers, prepared statements.
5. [CHANGELOG](https://github.com/brianc/node-postgres/blob/master/CHANGELOG.md) — node-postgres: `queryMode` (8.12), channel binding (8.14), password callback params (8.19), `sslnegotiation=direct` (8.22).
6. [Postgres.js README](https://github.com/porsager/postgres) — porsager/postgres: tagged-template parameters, `sql()` identifiers, `sql.unsafe`, `.simple()`.
7. [Raw queries (Prisma ORM v7)](https://www.prisma.io/docs/orm/v7/prisma-client/using-raw-sql/raw-queries) — Prisma: `$queryRaw` vs `$queryRawUnsafe`, `Prisma.sql/join/empty/raw`, one statement per call.
8. [Interface Sql](https://kysely-org.github.io/kysely-apidoc/interfaces/Sql.html) — Kysely API docs: parameters in `sql`; warnings on `sql.raw`, `sql.ref`, `sql.id`, `sql.table`, `sql.lit`.
9. [Magic sql operator](https://orm.drizzle.team/docs/sql) — Drizzle ORM docs: values become `$1`; `sql.raw()` is unescaped.
10. [Utilities](https://node-postgres.com/apis/utilities) — node-postgres: `escapeIdentifier`, `escapeLiteral` (parameters preferred).
11. [Pattern Matching](https://www.postgresql.org/docs/current/functions-matching.html) — PostgreSQL docs: `LIKE` wildcards and the backslash default escape.
12. [PL/pgSQL Basic Statements](https://www.postgresql.org/docs/current/plpgsql-statements.html) — PostgreSQL docs: `EXECUTE ... USING`, `format('%I')`, `quote_ident`/`quote_literal`.
13. [System Administration Functions](https://www.postgresql.org/docs/current/functions-admin.html) — PostgreSQL docs: `set_config(..., is_local)`, `current_setting(..., missing_ok)`.
14. [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html) — PostgreSQL docs: payload must be a string literal; size limit.
15. [Privileges](https://www.postgresql.org/docs/current/ddl-priv.html) — PostgreSQL docs: privilege types, default `PUBLIC` privileges, owner rights.
16. [Role Membership](https://www.postgresql.org/docs/current/role-membership.html) — PostgreSQL docs: `INHERIT`/`SET` options; attributes not inherited.
17. [CREATE ROLE](https://www.postgresql.org/docs/current/sql-createrole.html) — PostgreSQL docs: role attributes, `CONNECTION LIMIT` default, `VALID UNTIL`.
18. [ALTER ROLE](https://www.postgresql.org/docs/current/sql-alterrole.html) — PostgreSQL docs: per-role settings apply at login only; clear-text password caution.
19. [ALTER DEFAULT PRIVILEGES](https://www.postgresql.org/docs/current/sql-alterdefaultprivileges.html) — PostgreSQL docs: future objects only; per creating role.
20. [Predefined Roles](https://www.postgresql.org/docs/current/predefined-roles.html) — PostgreSQL 18 docs (also checked the 17, 15 and 14 versions for version tags): role list and warnings.
21. [Release 14](https://www.postgresql.org/docs/release/14.0/) — PostgreSQL: `pg_read_all_data`, `pg_write_all_data`, `pg_database_owner`, SCRAM default, SQL-standard function bodies.
22. [Release 15](https://www.postgresql.org/docs/release/15.0/) — PostgreSQL: no `CREATE` on `public` for `PUBLIC`, `GRANT ... ON PARAMETER`, `pg_checkpoint`.
23. [Release 16](https://www.postgresql.org/docs/release/16.0/) — PostgreSQL: `GRANT ... WITH INHERIT/SET`, `CREATEROLE` limits, `reserved_connections`, `require_auth`, `sslrootcert=system`, `pg_hba` regex.
24. [Release 17](https://www.postgresql.org/docs/release/17.0/) — PostgreSQL: `MAINTAIN`/`pg_maintain`, safe `search_path` in maintenance, login event triggers, `event_triggers`, `sslnegotiation=direct`.
25. [Release 18](https://www.postgresql.org/docs/release/18.0/) — PostgreSQL: OAuth, MD5 deprecation, `log_connections` options, TLS settings, `pg_get_acl()`, `--no-policies`.
26. [Schemas](https://www.postgresql.org/docs/current/ddl-schemas.html) — PostgreSQL docs: `search_path`, secure schema usage pattern, PG 15 default.
27. [A Guide to CVE-2018-1058: Protect Your Search Path](https://wiki.postgresql.org/wiki/A_Guide_to_CVE-2018-1058:_Protect_Your_Search_Path) — PostgreSQL wiki: attack and mitigations.
28. [CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html) — PostgreSQL docs: writing `SECURITY DEFINER` functions safely, `LEAKPROOF`, SQL-standard bodies.
29. [Abusing SECURITY DEFINER functions](https://www.cybertec-postgresql.com/en/abusing-security-definer-functions/) — Cybertec (Laurenz Albe): operator-shadowing attack and defenses.
30. [Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) — PostgreSQL docs: default deny, owner/BYPASSRLS, `FORCE`, covert channels, `row_security`.
31. [CREATE POLICY](https://www.postgresql.org/docs/current/sql-createpolicy.html) — PostgreSQL docs: syntax, per-command rules, restrictive policies, `LEAKPROOF` ordering.
32. [CREATE VIEW](https://www.postgresql.org/docs/current/sql-createview.html) — PostgreSQL docs: `security_invoker`, `security_barrier`.
33. [SET](https://www.postgresql.org/docs/current/sql-set.html) — PostgreSQL docs: `SET LOCAL` scope and behavior outside a transaction.
34. [PgBouncer features](https://www.pgbouncer.org/features.html) — PgBouncer: session features unsupported in transaction pooling.
35. [Row Level Security for Tenants in Postgres](https://www.crunchydata.com/blog/row-level-security-for-tenants-in-postgres) — Crunchy Data: tenant policies with `NULLIF(current_setting(...), '')`.
36. [Multi-tenant data isolation with PostgreSQL Row Level Security](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/) — AWS Database Blog: role-per-tenant vs runtime parameter, pooler caveat.
37. [Prisma Client Extension: Row Level Security](https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security) — Prisma: `set_config` per batch transaction; "not intended" for production.
38. [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) — Supabase docs: indexes, `(select auth.uid())`, `security_invoker` views.
39. [RLS Performance and Best Practices](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv) — Supabase: measured effect of indexes, `(select ...)`, explicit filters, `TO` roles.
40. [pgTAP documentation](https://pgtap.org/documentation.html) — pgTAP: policy and privilege assertion functions.
41. [The pg_hba.conf File](https://www.postgresql.org/docs/current/auth-pg-hba-conf.html) — PostgreSQL docs: first match, connection types, methods, `pg_hba_file_rules`.
42. [Password Authentication](https://www.postgresql.org/docs/current/auth-password.html) — PostgreSQL docs: SCRAM vs MD5, MD5 deprecation, migration steps.
43. [OAuth Authorization/Authentication](https://www.postgresql.org/docs/current/auth-oauth.html) — PostgreSQL 18 docs: validator modules and `pg_hba.conf` options.
44. [Connections and Authentication](https://www.postgresql.org/docs/current/runtime-config-connection.html) — PostgreSQL docs: `listen_addresses`, connection limits, `password_encryption`, `ssl_min_protocol_version`, `md5_password_warnings`.
45. [docker-library/postgres](https://github.com/docker-library/postgres) — Official image: `listen_addresses = '*'`, `trust` warning in the entrypoint.
46. [SSL Support (libpq)](https://www.postgresql.org/docs/current/libpq-ssl.html) — PostgreSQL docs: `sslmode` protection table and recommendation.
47. [Connection Strings (libpq)](https://www.postgresql.org/docs/current/libpq-connect.html) — PostgreSQL docs: `sslrootcert=system`, `sslnegotiation`, `require_auth`.
48. [pg-connection-string](https://github.com/brianc/node-postgres/tree/master/packages/pg-connection-string) — node-postgres: `sslmode` mapping, `uselibpqcompat`, deprecation warning for pg v9.
49. [Encryption Options](https://www.postgresql.org/docs/current/encryption-options.html) — PostgreSQL docs: column, partition, network and client-side encryption.
50. [Transparent Data Encryption](https://www.enterprisedb.com/docs/tde/latest/) — EDB docs: TDE in EDB Postgres Advanced/Extended Server 15+.
51. [pg_tde documentation](https://docs.percona.com/pg-tde/index.html) — Percona: TDE extension requiring Percona Server for PostgreSQL.
52. [pgcrypto](https://www.postgresql.org/docs/current/pgcrypto.html) — PostgreSQL docs: PGP functions, `crypt()`, security limitations.
53. [Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) — OWASP: Argon2id/scrypt/bcrypt parameters.
54. [Error Reporting and Logging](https://www.postgresql.org/docs/current/runtime-config-logging.html) — PostgreSQL docs: `log_parameter_max_length*`, `log_statement`, `log_connections`, `log_line_prefix`.
55. [pgAudit README](https://github.com/pgaudit/pgaudit) — pgAudit: classes, settings, caveats, version branches.
56. [Overview of Event Trigger Behavior](https://www.postgresql.org/docs/current/event-trigger-definition.html) — PostgreSQL docs: events incl. `login` and its risk.
57. [CREATE EVENT TRIGGER](https://www.postgresql.org/docs/current/sql-createeventtrigger.html) — PostgreSQL docs: superuser only; `event_triggers` recovery.
58. [Event Trigger Functions](https://www.postgresql.org/docs/current/functions-event-triggers.html) — PostgreSQL docs: `pg_event_trigger_ddl_commands()` columns.
59. [PostgreSQL Anonymizer](https://postgresql-anonymizer.readthedocs.io/en/stable/) — Dalibo: masking methods and security-label rules.
60. [pgBackRest Configuration Reference](https://pgbackrest.org/configuration.html) — pgBackRest: `repo-cipher-type` options and default.
61. [Right to erasure](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/) — UK ICO: one-month deadline, backups "beyond use".
62. [Packaging Related Objects into an Extension](https://www.postgresql.org/docs/current/extend-extensions.html) — PostgreSQL docs: the `trusted` control-file parameter.
63. [Additional Supplied Modules and Extensions](https://www.postgresql.org/docs/current/contrib.html) — PostgreSQL docs: list of trusted contrib extensions.
64. [CREATE LANGUAGE](https://www.postgresql.org/docs/current/sql-createlanguage.html) — PostgreSQL docs: trusted vs untrusted languages.
65. [PL/Python](https://www.postgresql.org/docs/current/plpython.html) — PostgreSQL docs: `plpython3u` is untrusted only.
66. [vector.control](https://github.com/pgvector/pgvector/blob/master/vector.control) — pgvector: control file without `trusted`.
67. [Defense in depth for MCP servers](https://supabase.com/blog/defense-in-depth-mcp) — Supabase: prompt injection and agent database access risks, mitigations.
68. [The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html) — PostgreSQL docs: who can see other sessions' queries.
69. [Release 19 (beta)](https://www.postgresql.org/docs/19/release-19.html) — PostgreSQL 19 draft release notes (as of 2026-09-14): MD5 login warning, RADIUS removal, SNI, password expiration warning, `standard_conforming_strings` always on.
70. [PostgreSQL 19 Beta 4 Released](https://www.postgresql.org/about/news/postgresql-19-beta-4-released-3386/) — PostgreSQL: features reverted in beta 4 (none of the security items above).
71. [Rules and Privileges](https://www.postgresql.org/docs/current/rules-privileges.html) — PostgreSQL docs: security barrier views, `LEAKPROOF`, no index scan for non-leakproof operators under RLS, `\dAo+`.
72. [indxpath.c and restrictinfo.c (REL_18_STABLE)](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/optimizer/path/indxpath.c) — PostgreSQL source: `restriction_is_securely_promotable()` rejects non-leakproof clauses as index conditions.
