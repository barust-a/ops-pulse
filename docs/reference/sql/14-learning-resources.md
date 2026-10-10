# Learning Resources

> Part of the [SQL & PostgreSQL reference library](README.md) · Last researched: 2026-10-05 · Targets PostgreSQL 14–18 (19 beta noted where relevant)

**What this covers.** The best books, free online references, practice sites, courses, podcasts, blogs, newsletters and communities for learning SQL and PostgreSQL, checked in October 2026 (edition, year, level, free or paid, still active or not). It ends with three learning paths — beginner, intermediate, advanced — that map each resource to the documents of this library (01–15). Tools (clients, monitoring, extensions) are in [tools by use case](13-tools-by-use-case.md).

**Levels used below.** B = beginner (you are learning `SELECT`, joins, keys). I = intermediate (you write production SQL and want it fast and safe). A = advanced (internals, operations, performance at scale). "Unverified" means I could not confirm the resource's 2026 status.

## Key rules (TL;DR)

1. Start with the official PostgreSQL tutorial and docs: free, exact, and current (the "current" docs are PostgreSQL 18).
2. Learn indexing from *Use The Index, Luke!* (free) before you try to tune anything.
3. Practice on real PostgreSQL: pgexercises.com, the Crunchy Data Postgres Playground, or your local Docker database.
4. For SQL basics with PostgreSQL, read *Practical SQL* (2nd ed.); for general SQL, *Learning SQL* (3rd ed.).
5. As an application developer, read *The Art of PostgreSQL* and *SQL Antipatterns, Volume 1*.
6. Before your first production launch, read *PostgreSQL Mistakes and How to Avoid Them* and the wiki page "Don't Do This".
7. For query performance, read *PostgreSQL Query Optimization* (2nd ed., 2024) and *SQL Performance Explained*.
8. For internals, read Egor Rogov's *PostgreSQL 14 Internals* (free PDF) and Hironobu Suzuki's *The Internals of PostgreSQL* (free online).
9. For data-system design, read *Designing Data-Intensive Applications*, 2nd edition (March 2026).
10. For database theory and engines, watch CMU 15-445 (Andy Pavlo, Fall 2025) — free on YouTube.
11. Subscribe to Postgres Weekly and skim Planet PostgreSQL; listen to Postgres FM.
12. Follow depesz's "Waiting for PostgreSQL N" posts to learn new features before they ship.
13. Ask questions on the `pgsql-general` mailing list, DBA Stack Exchange, or the PostgreSQL Slack — always include your version, table definitions and `EXPLAIN (ANALYZE, BUFFERS)` output.
14. Check the publication year: advice written for PostgreSQL 9.x–11 can be outdated (for example `serial` vs identity columns).
15. If you prefer French, use the French translation of the docs (docs.postgresql.fr) and Dalibo's free training manuals.
16. Practice on a realistic sample database (Pagila or the Postgres Pro airlines demo), not only on toy tables.
17. Trust sources in this order: official docs for your version, release notes, the PostgreSQL wiki, core developers and long-time experts, vendor blogs, then Q&A answers — and verify AI-generated pages.
18. Follow one learning path from section 12 and read the matching library document after each step.

## Quick picks

| Your situation | Pick this | Why |
|---|---|---|
| Free resources only | Official tutorial + *Use The Index, Luke!* + pgexercises.com + Rogov's *PostgreSQL 14 Internals* (PDF) | Covers basics, indexing, practice and internals at zero cost |
| One book only (app developer) | *The Art of PostgreSQL* | SQL for developers, written by a PostgreSQL major contributor [8] |
| One book only (you run production) | *PostgreSQL Mistakes and How to Avoid Them* | Short, organized by real mistakes [4] |
| One hour per week | Postgres Weekly + one Postgres FM or Scaling Postgres episode | Stay current without effort |
| You learn best by doing | Crunchy Postgres Playground, then pgexercises.com | Real PostgreSQL, guided steps |
| You prefer French | docs.postgresql.fr + Dalibo DEV1/DEVPG manuals | Free, complete, maintained by French PostgreSQL experts (section 8) |
| You want to understand engines | CMU 15-445 videos, then *Database Internals* | Theory first, then PostgreSQL internals make sense |
| Interview preparation | DataLemur + HackerRank SQL | Interview-style problems with instant feedback |

## 1. Books

### 1.1 PostgreSQL books

| Title | Author(s) | Latest edition (year) | Level | Best for | Free or paid |
|---|---|---|---|---|---|
| *The Art of PostgreSQL* | Dimitri Fontaine | 2nd ed., updated 2026; covers PG 10–18 [8] | I | Application developers who want to replace code with good SQL (window functions, CTEs, aggregates, schema design) | Paid ($89 digital, $129 paperback) [8] |
| *PostgreSQL 14 Internals* | Egor Rogov | English edition covering PG 14 [1] | A | How PostgreSQL works inside: MVCC, vacuum, buffer cache, WAL, locks, planner, index types | **Free PDF**; paid print via Lulu [1] |
| *The Internals of PostgreSQL* | Hironobu Suzuki | Online; updated 2026-10-01, covers up to 19 beta [2] | A | Clear diagrams of processes, memory, MVCC, VACUUM, buffer manager, WAL, replication | Free to read online; the site sets terms for commercial reuse [2] |
| *PostgreSQL Query Optimization* | Henrietta Dombrovskaya, Boris Novikov, Anna Bailliekova | 2nd ed., 2024 (Apress) [12] | I–A | Writing efficient queries and reading plans, with a realistic schema | Paid |
| *PostgreSQL Mistakes and How to Avoid Them* | Jimmy Angelakos | 1st ed., June 2025 (Manning), 232 pages [4] | I–A | Common mistakes in configuration, SQL, data types, security, HA/backups, upgrades | Paid |
| *Just Use Postgres!* | Denis Magda | 1st ed., Nov 2025 (Manning), 400 pages [3] | I | Using PostgreSQL for JSON, full-text search, pgvector/AI, PostGIS, TimescaleDB, queues (pgmq) | Paid |
| *High Performance PostgreSQL for Rails* | Andrew Atkinson | 1st ed., June 2024 (Pragmatic) [6] | I–A | Production performance, zero-downtime migrations, pooling, partitioning; most content applies to any stack [6] | Paid |
| *Mastering PostgreSQL 17* | Hans-Jürgen Schönig | 2024 (Packt) [13] | I–A | Administration, replication, advanced features (new edition per major version) | Paid |
| *PostgreSQL: Up and Running* | Regina Obe, Leo Hsu | 3rd ed., 2017 (O'Reilly) [14] | B–I | A fast tour of PostgreSQL features; dated (written for PG 10) | Paid |
| *Practical SQL* | Anthony DeBarros | 2nd ed., Jan 2022 (No Starch), 464 pages [7] | B | Learning SQL with PostgreSQL and pgAdmin on real public datasets | Paid |

Newer PostgreSQL titles found in library catalogs but **not reviewed** for this guide [15]: *AI-Ready PostgreSQL 18* (Vibhor Kumar, Marc Linster, Ed Boyajian; Packt, 2026), *Database Design and Modeling with PostgreSQL and MySQL* (Alkin Tezuysal, Ibrar Ahmed, Peter Zaitsev; Packt, 2024), *PostgreSQL 16 Administration Cookbook* (Gianni Ciolli, Boriss Mejías, Jimmy Angelakos, Vibhor Kumar, Simon Riggs; Packt, 2023), *Learn PostgreSQL*, 2nd ed. (Packt, 2023), and *Procedural Programming with PostgreSQL PL/pgSQL* (Shaik Baji, Dinesh Kumar Chemuduru; Apress, 2023).

**Recommendation.** If you buy one PostgreSQL book as an application developer, buy *The Art of PostgreSQL*. If you run PostgreSQL in production, add *PostgreSQL Mistakes and How to Avoid Them*. When you need to understand *why* PostgreSQL behaves as it does (bloat, locks, plans), read Rogov's free *PostgreSQL 14 Internals*; most of it still applies to PG 18 because the core architecture has not changed, but check the release notes for newer details.

### 1.2 SQL books (any database)

| Title | Author(s) | Latest edition (year) | Level | Best for | Free or paid |
|---|---|---|---|---|---|
| *SQL Performance Explained* / *Use The Index, Luke!* | Markus Winand | Book first published 2012; web edition maintained [9][60] | B–I | Indexing for developers, for Oracle, MySQL, PostgreSQL, SQL Server and Db2 [60] | **Free online** at use-the-index-luke.com; PDF from €9.95 [9] |
| *SQL Antipatterns, Volume 1* | Bill Karwin | Oct 2022 (Pragmatic), 378 pages [5] | I | Recognizing bad designs and queries (EAV, polymorphic keys, NULL traps, SQL injection); examples mainly in MySQL 8.0 [5] | Paid |
| *Learning SQL* | Alan Beaulieu | 3rd ed., 2020 (O'Reilly) [16] | B | SQL fundamentals, step by step | Paid |
| *SQL Cookbook* | Anthony Molinaro, Robert de Graaf | 2nd ed., 2020 (O'Reilly) [17] | I | Ready recipes (pivoting, ranking, date math) shown for several dialects | Paid |
| *SQL for Data Analysis* | Cathy Tanimura | 2021 (O'Reilly) [18] | I | Analytics SQL: time series, cohorts, text analysis, experiments | Paid |
| *Database Design for Mere Mortals* | Michael J. Hernandez | 25th-anniversary (4th) ed., 2020 (Addison-Wesley) [19] | B | A design process and normalization explained without math | Paid |
| *Joe Celko's SQL for Smarties* | Joe Celko | 5th ed., 2014 (Morgan Kaufmann) [21] | A | Advanced, standard SQL techniques and puzzles | Paid |

### 1.3 Books for other databases (useful for comparison)

| Title | Author(s) | Latest edition (year) | Level | Best for | Free or paid |
|---|---|---|---|---|---|
| *T-SQL Fundamentals* | Itzik Ben-Gan | 4th ed., Feb 2023 (Microsoft Press), SQL Server 2022 [22] | B–I | Logical query processing, explained very clearly; SQL Server dialect | Paid |
| *Efficient MySQL Performance* | Daniel Nichter | 2021 (O'Reilly) [20] | I | MySQL performance for software engineers | Paid |

Read these only if you also work with SQL Server or MySQL; [SQL dialects compared](02-sql-dialects-compared.md) summarizes the differences.

### 1.4 Data-systems books

| Title | Author(s) | Latest edition (year) | Level | Best for | Free or paid |
|---|---|---|---|---|---|
| *Designing Data-Intensive Applications* | Martin Kleppmann, Chris Riccomini | **2nd ed., March 2026** (O'Reilly) [10] | I–A | Replication, partitioning, transactions, consistency, streams — the "why" behind data systems | Paid |
| *Database Internals* | Alex Petrov | 2019 (O'Reilly) [11] | A | Storage engines (B-trees, LSM) and distributed-systems algorithms (consensus, failure detection) [11] | Paid |

**Recommendation.** *Use The Index, Luke!* is the single most useful free resource for developers: read it before you add your first index. Read *SQL Antipatterns* early; it prevents design mistakes that are expensive to fix later. Read the 2nd edition of *Designing Data-Intensive Applications* when you design systems that use more than one database or service.

## 2. Free online references and tutorials

| Resource | What it is | Best for | Level |
|---|---|---|---|
| [PostgreSQL documentation](https://www.postgresql.org/docs/current/) | The official manual; "current" points to PostgreSQL 18 [64] | Exact syntax, defaults, and behavior; always check here first | B–A |
| [Official tutorial](https://www.postgresql.org/docs/current/tutorial.html) | Three short parts: getting started, the SQL language, advanced features (views, foreign keys, transactions, window functions) [64] | Your first day with PostgreSQL | B |
| [PostgreSQL wiki](https://wiki.postgresql.org/) | Community wiki; see especially ["Don't Do This"](https://wiki.postgresql.org/wiki/Don%27t_Do_This) [63] | Avoiding classic mistakes: `NOT IN` with NULLs, `timestamp` without time zone, `char(n)`, `serial`, `trust` authentication [63] | B–I |
| [Use The Index, Luke!](https://use-the-index-luke.com/) | Free web book on indexing by Markus Winand [60] | Index design for developers | B–I |
| [modern-sql.com](https://modern-sql.com/) | Feature pages on modern standard SQL with support charts for PostgreSQL, MySQL, SQL Server, Oracle, SQLite, DuckDB and more [27] | Knowing which SQL features exist and which databases support them | I–A |
| [The Internals of PostgreSQL](https://www.interdb.jp/pg/) | Free online book on internals (12 chapters) [2] | Architecture and internals | A |
| [PostgreSQL Tutorial (Neon)](https://neon.com/postgresql/tutorial) | The former postgresqltutorial.com, now hosted by Neon; 17 basic and 5 advanced sections [23] | Many small, practical examples by topic | B–I |
| [Crunchy Data Postgres Playground](https://www.crunchydata.com/developers/tutorials) | Guided tutorials that run PostgreSQL in your browser: psql, joins, window functions, JSON, PostGIS, partitioning, row-level security [24] | Hands-on practice without installing anything | B–I |
| [Postgres how-tos (postgres.ai)](https://postgres.ai/docs/postgres-howtos) | Dozens of practical guides by Nikolay Samokhvalov (performance, admin, monitoring, DDL) [25] | Short answers to real production problems | I–A |
| [SQL Style Guide](https://www.sqlstyle.guide/) | Simon Holywell's style guide (CC BY-SA 4.0): naming, uppercase keywords, "river" alignment [26] | Agreeing on a team style (adapt it; see [query patterns](04-query-patterns-and-antipatterns.md)) | B |
| [Release notes](https://www.postgresql.org/docs/release/) | What changed in each version | Upgrades and "is this feature available in my version?" | I–A |

**Recommendation.** Keep the official docs open while you work and always check the version selector. Use the Neon tutorial or the Crunchy Playground when the manual feels too dense. Read the wiki page "Don't Do This" once a year; it is short and prevents real bugs.

### Official documentation pages to bookmark

These pages answer most day-to-day questions. Humans and AI agents should check them before trusting any blog post. Replace `current` with your major version (for example `/docs/16/`) when you run an older server.

| Topic | Page | Use it for | Library document |
|---|---|---|---|
| All SQL commands | [SQL Commands](https://www.postgresql.org/docs/current/sql-commands.html) | Exact syntax of `CREATE INDEX`, `ALTER TABLE`, `MERGE`, `COPY`… | [doc 01](01-sql-fundamentals.md), [doc 03](03-postgresql-features-and-types.md) |
| Data types | [Data Types](https://www.postgresql.org/docs/current/datatype.html) | Choosing `timestamptz`, `numeric`, `jsonb`, `uuid`, arrays, ranges | [doc 03](03-postgresql-features-and-types.md), [doc 07](07-schema-design-and-patterns.md) |
| Functions and operators | [Functions and Operators](https://www.postgresql.org/docs/current/functions.html) | Date math, string functions, JSON operators, aggregates, window functions | [doc 01](01-sql-fundamentals.md), [doc 04](04-query-patterns-and-antipatterns.md) |
| Indexes | [Indexes](https://www.postgresql.org/docs/current/indexes.html) | Index types, multicolumn, partial and expression indexes, index-only scans | [doc 05](05-indexing.md) |
| EXPLAIN | [Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) | Reading plans | [doc 06](06-query-optimization-and-explain.md) |
| Locks | [Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) | The table of lock modes and conflicts — essential before schema changes | [doc 08](08-transactions-concurrency-locking.md), [doc 10](10-safe-schema-migrations.md) |
| Isolation | [Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html) | What Read Committed, Repeatable Read and Serializable really guarantee | [doc 08](08-transactions-concurrency-locking.md) |
| Vacuum | [Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html) | Autovacuum, bloat, transaction ID wraparound | [doc 09](09-operations-and-server-tuning.md) |
| Configuration | [Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html) | Every setting with its default value | [doc 09](09-operations-and-server-tuning.md) |
| Statistics views | [The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html) | `pg_stat_activity`, `pg_stat_user_tables`, `pg_stat_io` (PG 16+) | [doc 06](06-query-optimization-and-explain.md), [doc 09](09-operations-and-server-tuning.md) |
| Row-level security | [Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) | Writing and testing RLS policies | [doc 11](11-security.md) |
| Full-text search | [Full Text Search](https://www.postgresql.org/docs/current/textsearch.html) | `tsvector`, `tsquery`, ranking, GIN indexes | [doc 12](12-full-text-and-vector-search.md) |
| Release notes | [Release Notes](https://www.postgresql.org/docs/release/) | "In which version did this change?" | [doc 03](03-postgresql-features-and-types.md) |

### Official docs for the TypeScript stack

For the libraries your project uses, read their own documentation first; it changes faster than any book. See [Postgres from TypeScript](15-postgres-from-typescript.md) for the patterns.

| Library | Documentation |
|---|---|
| Prisma ORM | [prisma.io/docs](https://www.prisma.io/docs) (check that a page is for Prisma 7: configuration moved to `prisma.config.ts`) |
| node-postgres | [node-postgres.com](https://node-postgres.com/) |
| Testcontainers for Node.js | [node.testcontainers.org](https://node.testcontainers.org/modules/postgresql/) |
| Kysely / Drizzle (if used) | [kysely.dev](https://kysely.dev/), [orm.drizzle.team](https://orm.drizzle.team/) |

## 3. Practice sites

| Site | What you practice | Engine | Cost | Level | Status (Oct 2026) |
|---|---|---|---|---|---|
| [PostgreSQL Exercises](https://pgexercises.com/) | One small dataset; basic queries, joins and subqueries, modifying data, aggregates, dates, strings, recursive queries [28] | PostgreSQL | Free (CC BY-SA 3.0) [28] | B→A | Active |
| [SQLBolt](https://sqlbolt.com/) | 18 short interactive lessons from `SELECT` to `CREATE TABLE` [29] | In-browser | Free | B | Active |
| [Select Star SQL](https://selectstarsql.com/) | Interactive book with a real-world dataset; 5 chapters of about 30 minutes [30] | In-browser | Free, no registration | B | Active |
| [SQL Murder Mystery](https://mystery.knightlab.com/) | Solve a crime with SQL; beginner walkthrough available [31] | SQLite | Free (MIT code, CC BY-SA content) [31] | B–I | Active |
| [Crunchy Postgres Playground](https://www.crunchydata.com/developers/tutorials) | Guided exercises on real datasets [24] | PostgreSQL in the browser | Free | B–I | Active |
| [HackerRank SQL](https://www.hackerrank.com/domains/sql) | Basic Select, Advanced Select, Aggregation, Basic/Advanced Join [61] | Several (choose MySQL or other) | Free | B–I | Active |
| [DataLemur](https://datalemur.com/) | SQL and analytics interview questions; free SQL tutorial [32] | Interview-style | Free + Premium | I | Active |
| [LeetCode "SQL 50"](https://leetcode.com/studyplan/top-sql-50/) | Interview problems | Several | Freemium | I | Unverified (page blocked automated checks) |
| [Advent of SQL](https://adventofsql.com/) | December puzzle series | PostgreSQL | Free | I | Unverified (site did not respond during research) |
| [CS50 SQL problem sets](https://cs50.harvard.edu/sql/) | Weekly problem sets of the Harvard course (section 4) [37] | SQLite, then PostgreSQL/MySQL | Free | B | Active |

**Recommendation.** Do pgexercises.com from start to finish: it is free, it uses real PostgreSQL, and it covers window functions and recursive queries. Use SQLBolt or Select Star SQL if you are new to SQL. Be careful with sites that run SQLite or MySQL: syntax and behavior differ from PostgreSQL (dates, string functions, `GROUP BY` rules); see [dialects compared](02-sql-dialects-compared.md).

## 4. Courses and lectures

| Course | Who | What | Level | Cost | Status |
|---|---|---|---|---|---|
| CMU 15-445/645 *Database Systems* | Andy Pavlo (Fall 2025, with a YouTube playlist) [34]; Jignesh Patel (Fall 2026) [33] | How a database engine works: storage, buffer pool, indexes, query execution, concurrency control, recovery; C++ projects | A (needs systems programming) | Free videos | Active |
| CMU 15-721 *Advanced Database Systems* | Andy Pavlo (Spring 2024, OLAP focus, YouTube playlist) [36]; Jignesh Patel (Fall 2025) [35] | Modern analytical engines, query optimization, research papers | A | Free videos (Spring 2024) | Active |
| CS50's *Introduction to Databases with SQL* (Harvard) | Carter Zenke, David J. Malan [37] | 7 weeks: querying, relating, designing, writing, viewing, optimizing, scaling; starts with SQLite and ends with PostgreSQL and MySQL [37] | B | Free (OpenCourseWare) | Active |
| Stanford *Databases* (edX, self-paced) | Jennifer Widom | Classic course: relational algebra, SQL, design theory, constraints | B–I | Free to audit (historically) | Unverified (course page not reachable) |
| freeCodeCamp | Various authors | Free full-length SQL courses and handbooks (for example "The SQL Handbook", "Learn Databases and SQL from Harvard") [40] | B | Free | Active; specific certification status unverified |
| *Fundamentals of Database Engineering* | Hussein Nasser [38][39] | ACID, indexing, partitioning, sharding, replication, database engines | I | Paid (Udemy) | Active; Nasser also publishes free videos |

**Recommendation.** For SQL itself, CS50 SQL is the best free structured course. For understanding database engines (why B-trees, why MVCC, what a buffer pool does), watch CMU 15-445 — it is demanding, but it makes the PostgreSQL internals books much easier. Treat Udemy-style courses as optional: pick one only if you learn best from video.

## 5. Podcasts and video

| Show | Hosts / publisher | Format | Best for | Status (Oct 2026) |
|---|---|---|---|---|
| [Postgres FM](https://postgres.fm/) | Nikolay Samokhvalov (Postgres AI) and Michael Christofides (pgMustard) [41] | Weekly podcast, about 45–60 min | Deep, practical discussion of one topic per episode | Active (latest 2026-09-25) [41] |
| [Scaling Postgres](https://www.scalingpostgres.com/) | Creston Jamison (Ruby Tree Software) [42] | Weekly video show reviewing the week's best Postgres articles | Staying current when you have little time | Active (episode 437) [42] |
| [5mins of Postgres](https://pganalyze.com/blog) | pganalyze [43] | Short videos on one article or feature | Quick deep dives on performance features | Occasional (E122, April 2026) [43] |
| [Talking Postgres](https://talkingpostgres.com/) | Claire Giordano (Microsoft) [46] | Monthly podcast, recorded live | The people and history behind PostgreSQL | Active (episode 43, Sept 2026) [46] |
| Conference talks | [PGConf.dev](https://2027.pgconf.dev/) (developer conference; next in Montréal, May 2027) [45], [POSETTE](https://posetteconf.com/) (Microsoft's free virtual Postgres event; 2026 edition) [44], PGConf EU, PGDay events | Recorded talks on YouTube (availability varies by event) | Hearing core developers and large users | Active |
| CMU Database Group (YouTube) | Andy Pavlo and guests | Course lectures and database seminars [34][36] | Database systems theory | Active |

## 6. Blogs and newsletters

| Source | Best for | Notes (Oct 2026) |
|---|---|---|
| [Postgres Weekly](https://postgresweekly.com/) | One email per week with the best articles, releases and tools [47] | Cooperpress; issue 667; running since 2013 [47] |
| [Planet PostgreSQL](https://planet.postgresql.org/) | Aggregator of community blogs; the place to see everything new [48] | Linked from the official community page [59] |
| [depesz.com](https://www.depesz.com/) | "Waiting for PostgreSQL 19/20" posts explaining each new commit, with examples [49] | Notes when a feature is later reverted [49] |
| [Cybertec blog](https://www.cybertec-postgresql.com/en/blog/) | Practical deep dives by Laurenz Albe, Hans-Jürgen Schönig and others (locking, MVCC, security, tuning) [58] | Active |
| [Crunchy Data blog](https://www.crunchydata.com/blog) | Clear explanations for developers (data types, pgvector, PG 19 changes) [50] | Active in 2026 under Snowflake ownership [50] |
| [pganalyze blog](https://pganalyze.com/blog) | Performance: `pg_stat_statements`, plans, "Postgres in Production" series [43] | Active |
| [Haki Benita](https://hakibenita.com/) | PostgreSQL performance tricks, locking surprises, Django [51] | Active in 2026 [51] |
| [Brandur Leach](https://brandur.org/articles) | Classic essays on transactions, idempotency, queues (River), soft deletion [52] | Recent posts are less about Postgres [52] |
| Markus Winand ([modern-sql.com](https://modern-sql.com/), [use-the-index-luke.com](https://use-the-index-luke.com/)) | Standard SQL features and cross-database support [27] | Active |
| [Lukas Eder (jOOQ blog)](https://blog.jooq.org/) | SQL tricks and dialect differences (MERGE, anti-joins, JSON) [57] | Active in 2026 [57] |
| [Bruce Momjian](https://momjian.us/main/blogs/pgblog.html) | Release notes author; a large library of presentations (internals, security, performance) [56] | Active in 2026 [56] |
| [Robert Haas](https://rhaas.blogspot.com/) | Core-developer view: planner, `pg_plan_advice`, monthly hacking workshops [53] | Active in 2026 [53] |
| [Michael Paquier](https://paquier.xyz/) | "Postgres N highlight" feature posts [54] | Archive: latest posts are from 2023 [54] |
| [postgres.ai / Nikolay Samokhvalov](https://postgres.ai/docs/postgres-howtos) | How-tos, Postgres FM, database branching ideas [25] | Active |
| [Jonathan Katz](https://jkatz05.com/) | pgvector performance and PostgreSQL release management (PostgreSQL Core Team member) [55] | Latest post September 2024 [55] |
| Supabase blog | Postgres features through Supabase (RLS, pgvector, MCP) | Company blog |
| Neon blog | Serverless Postgres, branching; Neon also hosts the PostgreSQL Tutorial [23] | Company blog (Databricks) |
| EDB blog | Enterprise PostgreSQL, CloudNativePG | Company blog |
| Percona blog | Operations, monitoring, cross-database comparisons | Company blog |
| Citus / Azure Database for PostgreSQL blogs | Distributed Postgres, Microsoft's upstream work | Company blogs |
| Tiger Data blog | Time series, pgvectorscale, pg_textsearch | Company blog (formerly Timescale) |

**Recommendation.** Do not try to read everything. Subscribe to Postgres Weekly (one email a week), watch Scaling Postgres or listen to Postgres FM, and read depesz when a new major version approaches. Company blogs are useful but promote their products: check claims against the official docs.

### Keeping up with new PostgreSQL versions

PostgreSQL ships one major version per year (PG 18 in September 2025; PG 19 is in beta in autumn 2026) and regular minor releases with bug and security fixes. Each major version is supported for five years. To follow a new version:

1. **During development**: read depesz's "Waiting for PostgreSQL N" posts; each one explains a single commit with examples [49]. Some features are later reverted — in the PG 19 cycle, depesz marked SQL/PGQ property graph queries and `UPDATE/DELETE FOR PORTION OF` as rolled back [49], and Scaling Postgres discussed "the reasons for all the PG 19 reversions" [42].
2. **At beta**: read the official release notes of the beta; they are the only reliable list of what is in the version. Expect changes until GA.
3. **At GA**: read the release notes again, then the "what's new" posts from Crunchy Data, Cybertec, pganalyze and others; Bruce Momjian, who writes the release notes, also blogs about them [56].
4. **Before upgrading**: check the "Migration to Version N" section of the release notes (incompatible changes) and test your application against the new version locally (see [operations](09-operations-and-server-tuning.md) for upgrade methods).

In this library, a feature is tagged "(PG 19, beta — may change)" only if the PG 19 release notes still list it.

## 7. Communities

| Community | Where | Best for |
|---|---|---|
| Mailing lists | [lists.postgresql.org](https://lists.postgresql.org/) — `pgsql-general` (support), `pgsql-hackers` (development), `pgsql-announce` (releases), and more [59] | Official help from experienced users and core developers |
| IRC | Listed on the official community page [59] | Real-time chat (official) |
| PostgreSQL Slack | Workspace `postgresteam`; invite link at pgtreats.info/slack-invite [62] | Real-time help and many topic channels |
| Reddit r/PostgreSQL | reddit.com/r/PostgreSQL | News and discussions |
| DBA Stack Exchange | dba.stackexchange.com (tag `postgresql`) | Searchable, well-answered Q&A on design and performance |
| User groups and events | [postgresql.org/community/user-groups](https://www.postgresql.org/community/user-groups/) and [events](https://www.postgresql.org/about/events/) [59] | Meeting people, local talks |
| Discord | Community and vendor servers exist (Talking Postgres is recorded on Discord [46]) | Unofficial; not listed on the official community page [59] |

**How to ask a good question.** People can only help if they can see what you see. Include the exact version, the table definition, and the real plan of the slow query. In `psql` (the `\d+` line is a psql meta-command, not SQL):

```text
-- Run in psql, then paste the output into your question
SELECT version();
\d+ orders
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, total_cents FROM orders WHERE customer_id = 42;
```

Also say what you expected, what happened, and what you already tried. Remove secrets and personal data first.

## 8. Resources in French (ressources en français)

Reading in your first language is faster when a topic is hard. These resources are reliable and free or low-cost.

| Resource | What it is | Best for | Cost |
|---|---|---|---|
| [docs.postgresql.fr](https://docs.postgresql.fr/) | The French translation of the official documentation, for PostgreSQL 14 to 18 (HTML, PDF, man pages); translation issues go to Guillaume Lelarge [65] | Reading the manual in French; switch to the English original when the translation lags | Free |
| [Dalibo training manuals](https://www.dalibo.com/formations) | Dalibo's PostgreSQL course manuals, downloadable for free, in French: administration (DBA1, DBA2, DBA3), high availability (HAPAT, CNPG1), performance (PERF1, PERF2), development (DEV1, DEVPG), PostGIS (SIG1, SIG2) [66] | Complete, structured courses written by a major PostgreSQL company (the authors of PEV2, pg_activity and PostgreSQL Anonymizer) | Free manuals; paid live training |
| [PostgreSQL.fr](https://www.postgresql.fr/) | The French-speaking community: forums, a French mailing list, news, meetups in Paris, Lyon, Toulouse, Lille and Belgium [67] | Asking questions in French; finding local meetups | Free |
| PG Day France | Annual French-speaking conference; 2026 edition in Toulouse, June 3–4 [67] | Talks in French, meeting French users | Paid ticket |
| [pgDay Paris](https://2026.pgday.paris/) | Annual one-day conference organized by PostgreSQL Europe; 10th edition on 2026-03-26 [68] | International speakers in Paris | Paid ticket |

**Recommendation.** For a French speaker learning PostgreSQL, Dalibo's DEV1 and DEVPG manuals (development) and PERF1 (performance) are an excellent free complement to this library. Keep the English documentation as the reference: it is always the most up to date, and AI agents read English sources.

## 9. Sample databases for practice

Toy tables with ten rows hide real problems (plans, index choice, bloat). Load a realistic dataset into your local PostgreSQL.

| Dataset | What it contains | Size | License | Notes |
|---|---|---|---|---|
| [pgexercises dataset](https://pgexercises.com/) | A small country-club schema (members, facilities, bookings) [28] | Small | CC BY-SA 3.0 [28] | Load it locally to repeat the exercises |
| [Pagila](https://github.com/devrimgunduz/pagila) | DVD-rental schema (PostgreSQL port of MySQL's Sakila) with data from 2022–2026; shows partitioning, JSONB, vector embeddings and UUID functions [69] | About 51,800 rentals [69] | PostgreSQL License [69] | Tested against PostgreSQL 18 and above [69] |
| [Postgres Pro demo database](https://postgrespro.com/community/demodb) | Airline flights, bookings, passengers and airports; designed for learning SQL and for teaching material [70] | 4 sizes: 3 months (~1.3 GB) to 2 years (~11 GB) uncompressed [70] | MIT [70] | Needs PostgreSQL 15 or later [70]; great for practicing `EXPLAIN` on real volumes |
| Crunchy Playground datasets | Datasets loaded inside each browser tutorial [24] | Small to medium | Free to use online | No installation |

```bash
# Load the Postgres Pro airlines demo (3-month version) into a local PostgreSQL 18 container
docker run -d --name pg18 -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:18
gunzip -c demo-20250901-3m.sql.gz | psql -h localhost -U postgres
```

The file name comes from the download page [70]; check the page for the current file.

## 10. Which resource for which library document

Use this table when a library document is not enough and you want to go deeper.

| Library document | Best external resources |
|---|---|
| [01 SQL fundamentals](01-sql-fundamentals.md) | Official tutorial [64]; *Practical SQL* [7]; *Learning SQL* [16]; CS50 SQL [37]; SQLBolt [29] |
| [02 SQL dialects compared](02-sql-dialects-compared.md) | modern-sql.com compatibility charts [27]; *SQL Cookbook* (multi-dialect recipes) [17]; *T-SQL Fundamentals* [22]; *Efficient MySQL Performance* [20] |
| [03 PostgreSQL features and types](03-postgresql-features-and-types.md) | Official docs and release notes [64]; *The Art of PostgreSQL* [8]; depesz "Waiting for PostgreSQL N" [49]; *Just Use Postgres!* [3] |
| [04 Query patterns and anti-patterns](04-query-patterns-and-antipatterns.md) | *SQL Antipatterns, Volume 1* [5]; wiki "Don't Do This" [63]; pgexercises.com [28]; Haki Benita [51]; jOOQ blog [57] |
| [05 Indexing](05-indexing.md) | *Use The Index, Luke!* [60]; *PostgreSQL 14 Internals* (index chapters) [1] |
| [06 Query optimization and EXPLAIN](06-query-optimization-and-explain.md) | *PostgreSQL Query Optimization* [12]; pganalyze blog [43]; postgres.ai how-tos [25]; Postgres FM [41] |
| [07 Schema design and patterns](07-schema-design-and-patterns.md) | *Database Design for Mere Mortals* [19]; *SQL Antipatterns* [5]; Brandur's essays [52] |
| [08 Transactions, concurrency, locking](08-transactions-concurrency-locking.md) | *PostgreSQL 14 Internals* (MVCC and locks) [1]; interdb.jp chapter 5 [2]; Cybertec blog [58]; *Designing Data-Intensive Applications* [10] |
| [09 Operations and server tuning](09-operations-and-server-tuning.md) | *PostgreSQL Mistakes and How to Avoid Them* [4]; *Mastering PostgreSQL 17* [13]; interdb.jp chapters 6, 9–11 [2]; Dalibo DBA/PERF manuals [66] |
| [10 Safe schema migrations](10-safe-schema-migrations.md) | *High Performance PostgreSQL for Rails* [6]; *PostgreSQL Mistakes* [4]; postgres.ai how-tos [25] |
| [11 Security](11-security.md) | Official docs (roles, RLS); wiki "Don't Do This" (authentication) [63]; Bruce Momjian's security presentations [56] |
| [12 Full-text and vector search](12-full-text-and-vector-search.md) | *Just Use Postgres!* [3]; Crunchy blog on hybrid search [50]; Jonathan Katz's pgvector posts [55] |
| [13 Tools by use case](13-tools-by-use-case.md) | Postgres Weekly [47]; Scaling Postgres [42] (to hear about new tools) |
| [15 Postgres from TypeScript](15-postgres-from-typescript.md) | Library documentation (Prisma, node-postgres); *The Art of PostgreSQL* (SQL in application code) [8] |

## 11. How to judge a resource (for humans and AI agents)

Many pages about PostgreSQL are old, vendor marketing, or generated by AI for search engines. Use this order of trust:

1. **The official documentation for your exact major version** (use the version switcher) and the **release notes**.
2. **The PostgreSQL wiki** and the **mailing-list archives** (answers from core developers).
3. **Long-time experts and core developers**: depesz, Cybertec (Laurenz Albe), Bruce Momjian, Robert Haas, Markus Winand, Haki Benita, pganalyze, postgres.ai, Crunchy Data.
4. **Vendor blogs and docs**: useful, but they show their own product in the best light.
5. **Q&A answers** (Stack Exchange, Reddit): check the date and the PostgreSQL version of the answer.
6. **Unknown sites and AI-generated pages**: verify every claim on a source above.

Checklist before you trust a tip:

- Which PostgreSQL version does it target? Is the feature available in yours (PG 14–18)?
- Is there evidence: an `EXPLAIN (ANALYZE, BUFFERS)` output, a benchmark with its method, or a link to the docs?
- Does it change a server setting? Check the default value in the docs of your version.
- Can you reproduce it on your local database with realistic data (section 9)?

## 12. Learning paths

Each path is an ordered list. Each step gives a resource, then the library document to read next. Steps take from a few hours to a few weeks.

### Path A — Beginner: from zero to correct SQL

1. Install PostgreSQL locally (Docker `postgres:18` or Postgres.app) and learn basic `psql` → [tools: local development](13-tools-by-use-case.md#14-local-development).
2. Read the official tutorial, parts I–III [64] (in French: docs.postgresql.fr [65]) → [SQL fundamentals](01-sql-fundamentals.md).
3. Do SQLBolt or Select Star SQL to build intuition → [SQL fundamentals](01-sql-fundamentals.md).
4. Read *Practical SQL* (2nd ed.), or follow CS50 SQL weeks 0–4 → [SQL fundamentals](01-sql-fundamentals.md), [PostgreSQL features and types](03-postgresql-features-and-types.md).
5. Practice pgexercises.com: Basic, Joins and Subqueries, Aggregates → [query patterns](04-query-patterns-and-antipatterns.md).
6. Learn data modeling with *Database Design for Mere Mortals* → [schema design](07-schema-design-and-patterns.md).
7. Read the wiki page "Don't Do This" [63] → [query patterns and anti-patterns](04-query-patterns-and-antipatterns.md).
8. Read *Use The Index, Luke!* chapters 1–2 (anatomy of an index, the WHERE clause) → [indexing](05-indexing.md).
9. Learn why you must pass values as parameters → [security](11-security.md).
10. Connect from TypeScript with Prisma and node-postgres → [Postgres from TypeScript](15-postgres-from-typescript.md).
11. Load Pagila into your local database and rewrite your exercises against it (section 9) → [query patterns](04-query-patterns-and-antipatterns.md).

### Path B — Intermediate: from working SQL to production-quality SQL

1. Read *The Art of PostgreSQL* → [query patterns](04-query-patterns-and-antipatterns.md), [PostgreSQL features](03-postgresql-features-and-types.md).
2. Read *SQL Antipatterns, Volume 1* → [schema design](07-schema-design-and-patterns.md).
3. Finish *Use The Index, Luke!* and browse modern-sql.com → [indexing](05-indexing.md), [SQL fundamentals](01-sql-fundamentals.md).
4. Finish pgexercises.com (window functions, recursive queries) → [query patterns](04-query-patterns-and-antipatterns.md).
5. Read *PostgreSQL Query Optimization* (2nd ed.) and practice with explain.dalibo.com → [query optimization and EXPLAIN](06-query-optimization-and-explain.md).
6. Learn MVCC and locking from the Cybertec and Haki Benita posts → [transactions, concurrency, locking](08-transactions-concurrency-locking.md).
7. Do the Crunchy Playground tutorials on JSON, partitioning and row-level security → [PostgreSQL features](03-postgresql-features-and-types.md), [schema design](07-schema-design-and-patterns.md), [security](11-security.md).
8. Read *PostgreSQL Mistakes and How to Avoid Them* → [operations](09-operations-and-server-tuning.md), [safe schema migrations](10-safe-schema-migrations.md).
9. Read the migration and pooling chapters of *High Performance PostgreSQL for Rails* (they apply to any stack) → [safe schema migrations](10-safe-schema-migrations.md), [Postgres from TypeScript](15-postgres-from-typescript.md).
10. Read *Just Use Postgres!* chapters on search, vectors and queues → [full-text and vector search](12-full-text-and-vector-search.md), [schema design patterns](07-schema-design-and-patterns.md).
11. Optional, in French: Dalibo's DEV1 and DEVPG manuals as a structured review of everything above [66].
12. From now on: Postgres Weekly + Postgres FM or Scaling Postgres every week.

### Path C — Advanced: internals, performance at scale, operations

1. Read Rogov's *PostgreSQL 14 Internals* (free PDF) → [transactions and locking](08-transactions-concurrency-locking.md), [indexing](05-indexing.md), [operations](09-operations-and-server-tuning.md).
2. Read *The Internals of PostgreSQL* (interdb.jp) chapters on WAL, backup and replication → [operations](09-operations-and-server-tuning.md).
3. Watch CMU 15-445 (Fall 2025) → background for [query optimization](06-query-optimization-and-explain.md) and [indexing](05-indexing.md).
4. Watch CMU 15-721 (Spring 2024) for analytical engines → background for [tools: analytics extensions](13-tools-by-use-case.md#13-extensions-by-use-case).
5. Read *Designing Data-Intensive Applications* (2nd ed.) → [dialects compared](02-sql-dialects-compared.md), [operations](09-operations-and-server-tuning.md).
6. Read *Database Internals* (Petrov) for storage engines and consensus → background.
7. Work through the postgres.ai how-tos and pganalyze's "Postgres in Production" series → [query optimization](06-query-optimization-and-explain.md), [operations](09-operations-and-server-tuning.md).
8. Track the next version: release notes, depesz's "Waiting for PostgreSQL 19/20", Robert Haas's posts on `pg_plan_advice` → [PostgreSQL features (what's new)](03-postgresql-features-and-types.md).
9. Read *Mastering PostgreSQL 17*, or Dalibo's PERF1/PERF2 and DBA2/DBA3 manuals in French [66], for administration breadth → [operations](09-operations-and-server-tuning.md), [security](11-security.md).
10. Practice plan reading on the 1-year or 2-year Postgres Pro demo database (section 9) → [query optimization](06-query-optimization-and-explain.md).
11. Follow `pgsql-hackers`, watch PGConf.dev talks, and consider attending a hacking workshop → contributor level.

## Sources

1. [PostgreSQL 14 Internals](https://postgrespro.com/community/books/internals) — Postgres Professional: free PDF and Lulu print editions of Egor Rogov's book.
2. [The Internals of PostgreSQL](https://www.interdb.jp/pg/) — Hironobu Suzuki: coverage up to 19 beta, update of 2026-10-01, usage terms, chapter list.
3. [Just Use Postgres!](https://www.manning.com/books/just-use-postgres) — Manning: author, Nov 2025, 400 pages, topics.
4. [PostgreSQL Mistakes and How to Avoid Them](https://www.manning.com/books/postgresql-mistakes-and-how-to-avoid-them) — Manning: author, June 2025, 232 pages, topics.
5. [SQL Antipatterns, Volume 1](https://pragprog.com/titles/bksap1/sql-antipatterns-volume-1/) — Pragmatic Bookshelf: Oct 2022, 378 pages, MySQL 8.0 examples.
6. [High Performance PostgreSQL for Rails](https://pragprog.com/titles/aapsql/high-performance-postgresql-for-rails/) — Pragmatic Bookshelf: June 2024, 454 pages, topics.
7. [Practical SQL, 2nd Edition](https://nostarch.com/practical-sql-2nd-edition) — No Starch Press: Jan 2022, PostgreSQL and pgAdmin, beginner level.
8. [The Art of PostgreSQL](https://theartofpostgresql.com/) — Dimitri Fontaine: 2nd edition updated 2026, PG 10–18, prices.
9. [SQL Performance Explained](https://sql-performance-explained.com/) — Markus Winand: formats, prices, free web edition.
10. [Martin Kleppmann](https://martin.kleppmann.com/) — Martin Kleppmann: DDIA 2nd edition with Chris Riccomini, O'Reilly, March 2026.
11. [Database Internals](https://www.databass.dev/) — Alex Petrov: O'Reilly 2019, contents.
12. [Open Library: PostgreSQL Query Optimization](https://openlibrary.org/search.json?title=PostgreSQL+Query+Optimization) — Open Library: editions 2021 and 2024 (Apress), authors.
13. [Open Library: Mastering PostgreSQL](https://openlibrary.org/search.json?q=Mastering+PostgreSQL+Schonig) — Open Library: *Mastering PostgreSQL 17* (2024).
14. [Open Library: PostgreSQL: Up and Running](https://openlibrary.org/search.json?title=PostgreSQL+Up+and+Running) — Open Library: latest edition 2017.
15. [Open Library: recent PostgreSQL titles](https://openlibrary.org/search.json?q=title%3Apostgresql&sort=new) — Open Library: 2023–2026 PostgreSQL books.
16. [Open Library: Learning SQL](https://openlibrary.org/search.json?q=Learning+SQL+Beaulieu) — Open Library: 2020 edition.
17. [Open Library: SQL Cookbook](https://openlibrary.org/search.json?q=SQL+Cookbook+Molinaro) — Open Library: 2020 edition.
18. [Open Library: SQL for Data Analysis](https://openlibrary.org/search.json?q=SQL+for+Data+Analysis+Tanimura) — Open Library: 2021.
19. [Open Library: Database Design for Mere Mortals](https://openlibrary.org/search.json?q=Database+Design+for+Mere+Mortals+Hernandez) — Open Library: 2020 edition.
20. [Open Library: Efficient MySQL Performance](https://openlibrary.org/search.json?q=Efficient+MySQL+Performance+Nichter) — Open Library: 2021.
21. [Open Library: Joe Celko's SQL for Smarties](https://openlibrary.org/search.json?q=Joe+Celko+SQL+for+Smarties) — Open Library: editions up to 2014.
22. [T-SQL Fundamentals, 4th Edition](https://www.microsoftpressstore.com/store/t-sql-fundamentals-9780138102104) — Microsoft Press Store: Feb 2023, SQL Server 2022.
23. [PostgreSQL Tutorial](https://neon.com/postgresql/tutorial) — Neon: former PostgreSQLTutorial.com, sections.
24. [Postgres tutorials / Playground](https://www.crunchydata.com/developers/tutorials) — Crunchy Data: in-browser guided tutorials and topics.
25. [Postgres how-tos](https://postgres.ai/docs/postgres-howtos) — Postgres AI: author, categories, free.
26. [SQL Style Guide](https://www.sqlstyle.guide/) — Simon Holywell: license and rules.
27. [modern-sql.com](https://modern-sql.com/) — Markus Winand: feature pages and compatibility charts.
28. [PostgreSQL Exercises](https://pgexercises.com/) — pgexercises: categories, CC BY-SA 3.0.
29. [SQLBolt](https://sqlbolt.com/) — SQLBolt: 18 interactive lessons, free.
30. [Select Star SQL](https://selectstarsql.com/) — Select Star SQL: free interactive book.
31. [SQL Murder Mystery](https://github.com/NUKnightLab/sql-mysteries) — Northwestern Knight Lab (GitHub): game, SQLite, licenses.
32. [DataLemur](https://datalemur.com/) — DataLemur: interview platform, free tutorial, premium tier.
33. [CMU 15-445/645](https://15445.courses.cs.cmu.edu/) — Carnegie Mellon: Fall 2026 offering and instructor.
34. [CMU 15-445/645 Fall 2025](https://15445.courses.cs.cmu.edu/fall2025/) — Carnegie Mellon: Andy Pavlo, YouTube playlist.
35. [CMU 15-721 Fall 2025](https://www.cs.cmu.edu/~15721-f25/) — Carnegie Mellon: Jignesh Patel, topics.
36. [CMU 15-721 Spring 2024](https://15721.courses.cs.cmu.edu/spring2024/) — Carnegie Mellon: Andy Pavlo, YouTube playlist, OLAP focus.
37. [CS50's Introduction to Databases with SQL](https://cs50.harvard.edu/sql/) — Harvard: free, 7 weeks, SQLite to PostgreSQL/MySQL, instructors.
38. [Hussein Nasser courses](https://husseinnasser.com/courses) — Hussein Nasser: course list.
39. [Fundamentals of Database Engineering](https://database.husseinnasser.com/) — Hussein Nasser: course redirect to Udemy.
40. [freeCodeCamp SQL articles](https://www.freecodecamp.org/news/tag/sql/) — freeCodeCamp: free SQL courses and handbooks.
41. [Postgres FM](https://postgres.fm/) — Postgres FM: hosts, weekly cadence, latest episode.
42. [Scaling Postgres](https://www.scalingpostgres.com/) — Ruby Tree Software: weekly show, episode 437.
43. [pganalyze blog](https://pganalyze.com/blog) — pganalyze: "Postgres in Production" series, 5mins of Postgres E122 (April 2026).
44. [POSETTE](https://posetteconf.com/) — POSETTE: 2026 edition.
45. [PGConf.dev 2027](https://2027.pgconf.dev/) — PGConf.dev: purpose, May 2027 Montréal.
46. [Talking Postgres](https://talkingpostgres.com/) — Microsoft: host, monthly, episode 43, recorded on Discord.
47. [Postgres Weekly](https://postgresweekly.com/) — Cooperpress: issue 667, weekly since 2013.
48. [Planet PostgreSQL](https://planet.postgresql.org/) — PostgreSQL community: blog aggregator, recent posts.
49. [depesz](https://www.depesz.com/) — Hubert Lubaczewski: "Waiting for PostgreSQL 19/20" posts, reverted-feature notes.
50. [Crunchy Data blog](https://www.crunchydata.com/blog) — Crunchy Data: 2026 posts.
51. [Haki Benita](https://hakibenita.com/) — Haki Benita: 2026 PostgreSQL posts.
52. [Brandur articles](https://brandur.org/articles) — Brandur Leach: article list and dates.
53. [Robert Haas](https://rhaas.blogspot.com/) — Robert Haas: 2026 posts, pg_plan_advice, workshops.
54. [Michael Paquier](https://paquier.xyz/) — Michael Paquier: latest posts (2023).
55. [Jonathan Katz](https://jkatz05.com/) — Jonathan Katz: pgvector posts, latest Sept 2024.
56. [Bruce Momjian's blog](https://momjian.us/main/blogs/pgblog.html) — Bruce Momjian: 2026 posts, presentations.
57. [jOOQ blog](https://blog.jooq.org/) — Lukas Eder: 2025–2026 posts.
58. [Cybertec blog](https://www.cybertec-postgresql.com/en/blog/) — Cybertec: 2026 posts and authors.
59. [PostgreSQL Community](https://www.postgresql.org/community/) — postgresql.org: mailing lists, IRC, user groups, events, Planet, wiki.
60. [Use The Index, Luke!](https://use-the-index-luke.com/) — Markus Winand: free web book, databases, chapters.
61. [HackerRank SQL](https://www.hackerrank.com/domains/sql) — HackerRank: SQL subdomains and levels.
62. [PostgreSQL Slack invite](https://pgtreats.info/slack-invite) — pgtreats.info: redirects to the `postgresteam` Slack invite.
63. [Don't Do This](https://wiki.postgresql.org/wiki/Don%27t_Do_This) — PostgreSQL wiki: common mistakes.
64. [PostgreSQL Tutorial (official)](https://www.postgresql.org/docs/current/tutorial.html) — postgresql.org: tutorial parts; current docs are PostgreSQL 18.
65. [Documentation PostgreSQL en français](https://docs.postgresql.fr/) — docs.postgresql.fr: French translation for PG 14–18, maintainer contact.
66. [Formations Dalibo](https://www.dalibo.com/formations) — Dalibo: free downloadable French training manuals and course codes.
67. [PostgreSQL.fr](https://www.postgresql.fr/) — French-speaking community: forums, mailing list, meetups, PG Day France 2026 (Toulouse, June 3–4).
68. [pgDay Paris 2026](https://2026.pgday.paris/) — PostgreSQL Europe: 10th edition, 2026-03-26.
69. [Pagila](https://github.com/devrimgunduz/pagila) — Devrim Gündüz (GitHub): sample database, PostgreSQL License, tested on PG 18+.
70. [Postgres Pro demo database](https://postgrespro.com/community/demodb) — Postgres Professional: airline dataset, sizes, MIT license, PG 15+.
