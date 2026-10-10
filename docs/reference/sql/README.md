# SQL & PostgreSQL Reference Library

> Last researched: 2026-10-05 · Targets PostgreSQL 14–18, with notes on PostgreSQL 19 (beta) · Examples use PostgreSQL syntax unless a document says otherwise

This library explains how to write good SQL and how to use PostgreSQL well. It covers SQL syntax in every major dialect, query patterns, indexing, optimization, schema design, concurrency, migrations, operations, security, search, and tools. It is built from web research: the official PostgreSQL documentation and release notes first, then recognized experts, books and engineering blogs. Each document ends with a numbered list of the pages it used.

**Who it is for:** developers who write SQL for PostgreSQL applications (code examples use TypeScript/Node.js), and AI coding agents, which must read the matching rules before they write SQL.

## How to use it

1. Read the [golden rules](#golden-rules) below. They are the short version of the whole library.
2. Find your task in the [task map](#task-map) and open that document.
3. Every document starts with **Key rules (TL;DR)**. Read them first, then the sections you need.
4. Check the version tags (for example "(PG 15+)") against the oldest PostgreSQL version you run.
5. Before you finish, run the matching checklist:
   - a query: [04 §14](04-query-patterns-and-antipatterns.md#14-query-review-checklist);
   - an index: [05 §16.4](05-indexing.md#164-review-checklist-for-a-new-index);
   - a slow query: [06 §12](06-query-optimization-and-explain.md#12-optimization-checklist);
   - a new table: [07 §10.3](07-schema-design-and-patterns.md#103-schema-review-checklist);
   - a migration: [10 §11](10-safe-schema-migrations.md#11-migration-pull-request-checklist);
   - security: [11 §13](11-security.md#13-hardening-checklist);
   - TypeScript data-access code: [15 §8](15-postgres-from-typescript.md#8-checklist-for-typescript-code-that-touches-the-database);
   - a database server: [09, operations checklist](09-operations-and-server-tuning.md#operations-checklist).

**For AI agents:** before you write or change SQL, a migration, or data-access code in a project, read the golden rules and the TL;DR of the matching document, follow the examples marked `-- Good:`, and apply the checklist above. If a document says that sources disagree, do not pick a side silently: say so in your change.

## Documents

| # | Document | Read it when you need to… |
|---|---|---|
| 01 | [SQL fundamentals](01-sql-fundamentals.md) | learn or refresh standard SQL: `SELECT`, joins, NULL logic, aggregation, subqueries, CTEs, window functions, DML, DDL |
| 02 | [SQL dialects compared](02-sql-dialects-compared.md) | translate SQL between PostgreSQL, MySQL/MariaDB, SQLite, SQL Server, Oracle, DuckDB, BigQuery, Snowflake, ClickHouse |
| 03 | [PostgreSQL features and data types](03-postgresql-features-and-types.md) | choose data types, use JSONB, `ON CONFLICT`, `MERGE`, functions, triggers, extensions, psql; see what is new in each version |
| 04 | [Writing good SQL: patterns, recipes, anti-patterns](04-query-patterns-and-antipatterns.md) | write or review a query: style guide, sargable filters, pagination, upserts, batching, 19 recipes, anti-pattern catalog |
| 05 | [Indexing](05-indexing.md) | choose, create, check or remove an index |
| 06 | [Query optimization and EXPLAIN](06-query-optimization-and-explain.md) | find slow queries, read execution plans, fix bad estimates |
| 07 | [Schema design and data modeling patterns](07-schema-design-and-patterns.md) | design tables, keys and constraints; trees, soft delete, audit, job queues, outbox, multi-tenancy, partitioning |
| 08 | [Transactions, concurrency and locking](08-transactions-concurrency-locking.md) | choose an isolation level; handle locks, deadlocks, retries and timeouts |
| 09 | [Operating and tuning PostgreSQL](09-operations-and-server-tuning.md) | configure the server; vacuum, pool connections, monitor, back up, replicate, upgrade |
| 10 | [Safe schema migrations](10-safe-schema-migrations.md) | change a schema without downtime, including with Prisma Migrate |
| 11 | [PostgreSQL security](11-security.md) | prevent SQL injection; set roles and privileges; use row-level security |
| 12 | [Full-text and vector search](12-full-text-and-vector-search.md) | build keyword, fuzzy, vector or hybrid search; design tables for RAG |
| 13 | [Tools by use case](13-tools-by-use-case.md) | pick a client, plan viewer, monitoring tool, pooler, backup tool, linter, test setup, driver/ORM, extension or host |
| 14 | [Learning resources](14-learning-resources.md) | find books (several free), courses, blogs, practice sites and learning paths |
| 15 | [Using PostgreSQL from TypeScript and Node.js](15-postgres-from-typescript.md) | write data-access code with Prisma 7 or node-postgres; transactions, pooling, types, testing |

## Task map

| Task | Read |
|---|---|
| A query is slow | [06 §9](06-query-optimization-and-explain.md#9-the-diagnosis-workflow) (find it, read the plan) → [05](05-indexing.md) (index) → [04](04-query-patterns-and-antipatterns.md) (rewrite) |
| Paginate a list | [04 §5](04-query-patterns-and-antipatterns.md#5-pagination) |
| Insert or update ("upsert", "get or create") | [04 §8.16](04-query-patterns-and-antipatterns.md#816-upsert-and-return-the-id-get-or-create), [08](08-transactions-concurrency-locking.md) |
| Choose primary keys (bigint, UUIDv4, UUIDv7) | [07 §3](07-schema-design-and-patterns.md#3-keys-and-identifiers), [03](03-postgresql-features-and-types.md) |
| Name tables and columns | [07 §6](07-schema-design-and-patterns.md#6-naming-conventions) |
| Add a column, constraint or index to a big live table | [10](10-safe-schema-migrations.md), [05](05-indexing.md) |
| Background jobs in PostgreSQL | [07 §8.9](07-schema-design-and-patterns.md#89-job-queue-tables-with-skip-locked), [08 §7.7](08-transactions-concurrency-locking.md#77-queue-consumers-with-skip-locked-locking-side) |
| Send events reliably to other systems | [07 §8.10](07-schema-design-and-patterns.md#810-transactional-outbox-idempotency-keys-inbox) |
| Keep tenants' data apart | [07 §8.12](07-schema-design-and-patterns.md#812-multi-tenancy), [11](11-security.md) |
| Deadlocks, lock waits, "idle in transaction" | [08](08-transactions-concurrency-locking.md) |
| The database grows, bloat, vacuum | [09](09-operations-and-server-tuning.md) |
| Keyword, fuzzy, semantic or hybrid search | [12](12-full-text-and-vector-search.md) |
| Raw SQL, transactions or pooling with Prisma/node-postgres | [15](15-postgres-from-typescript.md), [11](11-security.md) |
| Port a query from MySQL, SQL Server, Oracle or SQLite | [02](02-sql-dialects-compared.md) |
| Pick a tool | [13](13-tools-by-use-case.md) |
| Learn SQL from the start | [14 §12](14-learning-resources.md#12-learning-paths) → [01](01-sql-fundamentals.md) |

## Golden rules

These rules come from the TL;DR sections of the documents. Each one links to the document that explains it.

### Writing queries

1. Think in sets: one statement that handles 10,000 rows beats a loop of 10,000 statements. [01](01-sql-fundamentals.md), [04](04-query-patterns-and-antipatterns.md)
2. Never put user input into SQL text. Pass values as parameters; take identifiers (table, column, sort direction) from an allow-list. [11](11-security.md)
3. Name the columns: no `SELECT *` in application code, and always list the columns of an `INSERT`. Write explicit `JOIN … ON`, never comma joins. [04](04-query-patterns-and-antipatterns.md)
4. Keep indexed columns "naked" in `WHERE`: no function, cast or arithmetic on them. Filter time with half-open ranges (`>= start AND < end`), not `BETWEEN` or `date(col) =`. [04](04-query-patterns-and-antipatterns.md), [05](05-indexing.md)
5. Use `NOT EXISTS`, never `NOT IN (subquery)`: one NULL makes `NOT IN` return nothing. Use `EXISTS`, not `count(*) > 0`, for "has at least one". [01](01-sql-fundamentals.md), [04](04-query-patterns-and-antipatterns.md)
6. Give every `ORDER BY` used with `LIMIT` a unique tie-breaker, and paginate with keyset (seek) pagination, not a deep `OFFSET`. [04](04-query-patterns-and-antipatterns.md)
7. Pass a list as one array parameter (`= ANY($1::bigint[])`), not a generated `IN ($1, $2, …)`. [04](04-query-patterns-and-antipatterns.md), [06](06-query-optimization-and-explain.md)
8. For "create if missing", use a unique constraint plus `INSERT … ON CONFLICT`; never "SELECT, then INSERT". [04](04-query-patterns-and-antipatterns.md), [08](08-transactions-concurrency-locking.md)
9. Write in bulk (multi-row `VALUES`, `unnest` arrays, `COPY`) and change large sets in batches of a few thousand rows. Use `RETURNING` instead of a second query. [04](04-query-patterns-and-antipatterns.md)
10. Bound every query: `LIMIT` for lists, batches for jobs, a cursor or `COPY` for exports. [04](04-query-patterns-and-antipatterns.md)

### Schema

11. Use `timestamptz` for points in time, `numeric` (or integer cents) for money, `text` (plus `CHECK`) for strings, and `jsonb`, not `json`. [03](03-postgresql-features-and-types.md)
12. Use `bigint GENERATED ALWAYS AS IDENTITY` or UUIDv7 keys. Never `serial`, never `integer` for tables that grow, never random UUIDv4 as the key of a large, write-heavy table. [07](07-schema-design-and-patterns.md)
13. Make columns `NOT NULL` unless NULL has a clear meaning. Enforce rules in the database with `CHECK`, `UNIQUE`, foreign keys and `EXCLUDE`, and index the referencing columns of foreign keys. [07](07-schema-design-and-patterns.md), [05](05-indexing.md)
14. Use lowercase `snake_case` names and never quote identifiers. [01](01-sql-fundamentals.md), [07](07-schema-design-and-patterns.md)
15. Normalize first (3NF); denormalize only with measured evidence and a clear refresh path. Never store lists in a string, and never build EAV tables. [07](07-schema-design-and-patterns.md)

### Indexing and performance

16. Measure before you optimize: find queries with `pg_stat_statements`, then run `EXPLAIN (ANALYZE, BUFFERS)` on production-like data. [06](06-query-optimization-and-explain.md)
17. Compare estimated and actual rows at every plan node. Fix statistics (`ANALYZE`, `CREATE STATISTICS`) before forcing a plan, and never set `enable_*` switches in production. [06](06-query-optimization-and-explain.md)
18. Design indexes from real queries. Every index slows writes, so add one only when a frequent or critical query needs it. [05](05-indexing.md)
19. In a multicolumn B-tree, put equality columns first and the range or sort column last. [05](05-indexing.md)
20. On live tables, use `CREATE INDEX CONCURRENTLY` outside a transaction; after a failure, drop the `INVALID` index and retry. [05](05-indexing.md), [10](10-safe-schema-migrations.md)

### Transactions and migrations

21. Keep transactions short, and never call external services (HTTP, LLM, email) inside one; use an outbox table. [08](08-transactions-concurrency-locking.md), [07](07-schema-design-and-patterns.md)
22. Retry the whole transaction on SQLSTATE `40001` (serialization failure) and `40P01` (deadlock), and keep its body idempotent. [08](08-transactions-concurrency-locking.md)
23. Lock rows in a consistent order (`ORDER BY id FOR UPDATE`); use `FOR UPDATE SKIP LOCKED` only for queue workers. [08](08-transactions-concurrency-locking.md)
24. Set `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` per application role. [08](08-transactions-concurrency-locking.md), [09](09-operations-and-server-tuning.md)
25. Make breaking schema changes with expand/contract, keep every migration compatible with the running code, start DDL with a short `lock_timeout`, and add constraints as `NOT VALID`, then `VALIDATE`. [10](10-safe-schema-migrations.md)

### Operations and security

26. Never disable autovacuum; tune it per table for big tables. Never run `VACUUM FULL` on a live table. [09](09-operations-and-server-tuning.md)
27. Put a connection pooler in front of PostgreSQL and keep active connections near a small multiple of the CPU core count. [09](09-operations-and-server-tuning.md)
28. Use physical backups with point-in-time recovery, and test restores on a schedule. [09](09-operations-and-server-tuning.md)
29. Use least privilege: the application role does not own the tables and is never a superuser; AI agents get a read-only role with a `statement_timeout`. [11](11-security.md), [13](13-tools-by-use-case.md)
30. Under row-level security, check plans as the application role: filters with non-leakproof operators (`@@`, `@>`, `LIKE`, trigram) cannot use their indexes. [11](11-security.md), [12](12-full-text-and-vector-search.md)

## Reading paths

- **New to SQL:** 01 → 04 → 03 → 07, with the beginner path in [14 §12](14-learning-resources.md#12-learning-paths).
- **Application developer:** 04 → 05 → 06 → 08 → 10 → 15 → 11.
- **Performance and operations:** 06 → 05 → 09 → 08 → 10.
- **Search and RAG:** 12 → 05 → 07 → 06.
- **Moving between databases:** 02 → 01 → 03.

## How this library was made, and its limits

- **Method.** Each document was researched on its own. The research used the official documentation and release notes of each version first, then recognized experts (for example Use The Index, Luke!, Cybertec, Crunchy Data, pganalyze, depesz, pgMustard, postgres.ai), books, and engineering blogs. Facts that could be outdated (defaults, versions, tool status) were checked against primary sources. When sources disagree, the documents say so.
- **SQL examples.** All SQL blocks were parsed with PostgreSQL's own parser (pglast, PostgreSQL 18 grammar). The only blocks that do not parse are fragments written on purpose, `...` placeholders, syntax templates, and PostgreSQL 19 syntax. The examples of [11](11-security.md) and [15](15-postgres-from-typescript.md) were also run on PostgreSQL 18.3 (through PGlite) with node-postgres; the other examples were not run against a live database. The `EXPLAIN` outputs shown are illustrations, not measurements.
- **PostgreSQL 19.** It was in beta (beta 4) during the research. Items marked "(PG 19, beta — may change)" can change or be removed before the final release; several announced features were already reverted in beta 4.
- **Fast-changing facts.** Tool and extension status (maintained, archived, acquired, license) and version numbers were checked in October 2026. Re-check them before you rely on them.
- **Maintenance.** Review the version facts after each PostgreSQL major release (September or October each year). PostgreSQL 14 reaches end of life on 2026-11-12; after that, the supported range becomes 15–19.

## Applying it in a project

This library is generic. A project that uses it puts its own database rules in a nested `AGENTS.md` beside the schema and migrations (with a sibling `CLAUDE.md` containing `@AGENTS.md`), so an agent loads them exactly when it works there. Keep that file short and specific to the project:

- **Facts:** the ORM or driver and its version, the schema path, the exact migration commands (create, apply, status, reset), where raw SQL lives, and the extensions in use. Check version-sensitive chapters against them; for Prisma Migrate, [10 §9](10-safe-schema-migrations.md#9-applying-the-recipes-with-prisma-migrate) explains how the transaction behaviour changed between versions.
- **Naming and key policy, taken from the actual migration history.** Read the existing migrations and write down what they already do: table and column case, singular or plural, key type and where keys are generated. For existing objects this policy overrides golden rules 12 and 14. Never rename old tables or change old keys to match this library; apply the golden rules to new tables only, or say in the policy that new tables follow the existing style.
- **The golden rules agents most often break there,** about ten, copied as one line each with their link. Pick them from the project's real mistakes and from what its linters and tests do not catch.
- **How to read this library:** find the task in the [task map](#task-map), read the matching chapter's **Key rules (TL;DR)**, grep the chapter for the section you need and read only that section. Never read a chapter whole; most are over 1,000 lines.
