# AGENTS.md — apps/api (REST API) and db/migrations

Node 22, Express 5, TypeScript strict (ESM, NodeNext), PostgreSQL 16 via `pg`, zod, pino.
Loaded on top of the root `AGENTS.md`. The binding contract (schema, endpoints, error shape, env,
security baseline) is `docs/specs/2026-10-10-ops-pulse-contract.md`: change it first, then code.

## Gates (run from `apps/api`, all must pass before "done")

```sh
npm run lint          # eslint . --max-warnings=0 (shared base + architecture layers)
npm run typecheck     # tsc --noEmit, tests included
npm test              # Vitest unit + HTTP tests (in-memory fakes, no database)
npm run build         # tsc -p tsconfig.build.json -> dist/
npm run hygiene       # knip (dead code) + jscpd (new clones vs .jscpd-baseline.json)
npm run test:integration   # needs DATABASE_URL to a DISPOSABLE PostgreSQL (see below)
```

`test:integration` runs `src/**/*.int.test.ts` one file at a time. Without `DATABASE_URL` the
suites skip with a warning; that is "not run", never "passed". The suites migrate, **truncate and
reseed**: never point them at a database holding data you want to keep. Local disposable DB:

```sh
docker run -d --rm --name ops-pulse-api-test -e POSTGRES_USER=ops_pulse \
  -e POSTGRES_PASSWORD=ops_pulse -e POSTGRES_DB=ops_pulse -p 55432:5432 postgres:16-alpine
DATABASE_URL=postgres://ops_pulse:ops_pulse@localhost:55432/ops_pulse npm run test:integration
docker stop ops-pulse-api-test
```

## Other scripts

| Script | What |
| --- | --- |
| `npm run dev` | `tsx watch`, loads `.env` if present (copy `.env.example`) |
| `npm start` | `node dist/server.js` (after `build`) |
| `npm run db:migrate` / `node dist/scripts/migrate.js` | applies `db/migrations` (`MIGRATIONS_DIR` overrides the folder) |
| `npm run db:seed` / `node dist/scripts/seed.js` | truncates and reseeds the demo data (`SEED_NOW` anchors "now") |
| `npm run hygiene:dup:update` | re-records the jscpd baseline: by hand only (`docs/guides/base/code-hygiene.md`) |

## Owner-launched runs

None are gates. Seeding or migrating a shared or deployed database (compose stack, staging) is
done by the owner, never by an agent setting `DATABASE_URL` to it.

## Layers (enforced by `no-restricted-imports` in `eslint.config.mjs`)

```
src/domain   pure rules and zod schemas: SLA, KPI aggregation, roles, date ranges
src/ports    repository / security interfaces over the domain
src/adapters postgres/* (parameterised SQL only), security/* (bcrypt, JWT)
src/http     routers, middlewares, request schemas, OpenAPI document; talks to ports only
src/app.ts   createApp(deps): the Express app, no listen
src/server.ts composition root: config, pool, adapters, listen, graceful shutdown
src/scripts  migrate / seed entry points;  src/seed  pure, deterministic demo-data generator
src/testing  fakes and helpers for tests (never shipped: excluded from the build)
```

- Domain imports no framework, database, HTTP or outer layer; the seed generator imports no
  adapter. HTTP never imports `pg`, `bcrypt`, `jsonwebtoken` or an adapter: `app.ts` receives them.
- Every request input goes through `validBody` / `validQuery` / `validParams` (`src/http/validate.ts`)
  with a zod schema from `src/http/schemas.ts`; query objects are strict (unknown keys → 400).
- Every failure response uses the contract shape through `HttpError` and `errorHandler`; anything
  unexpected becomes `INTERNAL` without message or stack. Never `res.status(4xx).json(...)` by hand.
- Database rows are parsed with the domain zod schemas: a drifted row fails loudly (500), it is
  never coerced into a default. Cast `count(*)`/`numeric` to `::int`/`::float8` in SQL.
- SQL text never contains a value: use `SqlWhere` placeholders or fixed allow-lists (sort columns).
- "Now" is injected (`Clock`); dates are UTC calendar days (`from`/`to` inclusive).

## Database and migrations

- Plain SQL in `db/migrations/NNNN_name.sql`, applied in order in one transaction and recorded in
  `ops.schema_migrations(version, checksum, applied_at)`. An applied file is immutable: the
  migrator refuses a changed checksum. Add a new file instead.
- `ops.daily_service_kpis` is written by the Dataiku flow; the API only reads it. The seed never
  touches it.
- Comment each new index with the query it serves.

## Testing

- Domain: plain unit tests. HTTP: supertest against `createApp` with the fakes of
  `src/testing/fakes.ts`; parse bodies with `src/testing/http.ts` so responses are checked against
  the contract schemas. SQL semantics: `*.int.test.ts` against PostgreSQL only.
- bcrypt hashes in tests use cost 4; production hashes use 12 (`hashPassword`).

## Known exceptions (each one commented in place)

- `src/http/middlewares/error-handler.ts`: one `eslint-disable-next-line no-restricted-syntax`,
  because Express recognises an error handler only by its four parameters.
- `src/seed/demo-users.ts`: one `eslint-disable-next-line sonarjs/no-hardcoded-passwords` for the
  contract's public, test-only demo password.
