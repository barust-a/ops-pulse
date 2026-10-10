# Developer guide

Start here when you join the project. Rules for agents and humans: [`AGENTS.md`](../../AGENTS.md)
and the nested `AGENTS.md` of each app; the cross-app contract:
[`docs/specs/2026-10-10-ops-pulse-contract.md`](../specs/2026-10-10-ops-pulse-contract.md).

## 1. Prerequisites

| Tool             | Version        | Check                     |
| ---------------- | -------------- | ------------------------- |
| Node.js + npm    | 22 LTS         | `node -v`                 |
| Python + uv      | 3.11, uv ≥ 0.5 | `uv --version`            |
| Docker + Compose | Compose ≥ 2.24 | `docker compose version`  |
| PostgreSQL client (optional) | 16 | `psql --version`         |

After cloning: `npm run prepare` at the root wires the git hooks (`core.hooksPath = .husky`).

## 2. Run locally

**Database only** (fastest loop):

```sh
cp deploy/compose/.env.example deploy/compose/.env
docker compose -f deploy/compose/docker-compose.yml up -d postgres
export DATABASE_URL=postgres://ops_pulse:dev-only-not-a-secret@localhost:5432/ops_pulse
```

**API** (`apps/api`, port 3000):

```sh
cd apps/api
cp .env.example .env          # dev-only values
npm ci
npm run db:migrate            # applies ../../db/migrations
npm run db:seed               # demo users + 6 services of incidents and changes
npm run dev                   # tsx watch; Swagger UI on http://localhost:3000/api/v1/docs
```

**KPIs** (`dataiku`, writes `ops.daily_service_kpis`):

```sh
cd dataiku
uv sync
uv run python -m local_runner.run_flow     # uses DATABASE_URL
```

**Web** (`apps/web`, port 5173, proxies `/api` to 3000):

```sh
cd apps/web
npm ci
npm run dev                   # http://localhost:5173
```

**Everything in containers:** `docker compose -f deploy/compose/docker-compose.yml up --build`
→ <http://localhost:8080>.

## 3. Gates (what CI and the pre-commit hook run)

| Where        | Commands                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------ |
| `apps/web`   | `npm run lint` · `npm run typecheck` · `npm test` · `npm run hygiene` · `npm run build`    |
| `apps/api`   | the same, plus `npm run test:integration` (needs `DATABASE_URL` to a disposable database)  |
| `dataiku`    | `uv run ruff check .` · `uv run ruff format --check .` · `uv run mypy` · `uv run pytest`   |
| root         | `node --test "tools/agent-harness/*.test.mjs"`                                             |
| `deploy`     | `shellcheck -x deploy/scripts/*.sh` · `docker compose … config --quiet`                    |

ESLint runs with `--max-warnings=0`; TypeScript and mypy are strict; knip (dead code) and jscpd
(duplication) run in `hygiene`. Details: [test strategy](../testing/test-strategy.md).

## 4. Architecture in one page

- **API** layers: `domain` (pure rules) ← `ports` (interfaces) ← `adapters` (pg, bcrypt, JWT) ←
  `http` (routers, middlewares). The composition root wires adapters into routers; tests swap
  adapters for fakes (`src/testing/`). Domain code imports no Express, no `pg`.
- **Web**: `api/` (client + zod schemas) → `state/` (contexts, reducers, `useApiQuery`) →
  `features/` (screens' building blocks) → `pages/` → `app/` (router). ECharts options are built by
  pure functions in `features/overview/*Option.ts`.
- **Dataiku**: SQL recipe for set-based aggregation, Python recipe for statistics; all logic in
  `python-lib/ops_kpis` (importable and unit-tested outside DSS).
- Why it is like this: [target architecture](../architecture/target-architecture.md),
  [detailed design](../architecture/detailed-design.md), [ADRs](../adr/README.md).

## 5. Typical tasks

**Add an API endpoint.** Contract first (spec + OpenAPI) → zod schema for query/body →
failing test in `src/http/*.test.ts` (supertest) → domain rule with its unit test → repository
method (+ integration test if SQL) → router wiring → docs.

**Add a column.** New migration `db/migrations/NNNN_<what>.sql` (never edit an applied one) →
expand → migrate → contract ([rules](../migration/migration-plan.md#4-schema-migration-rules)) →
repository + schema + types → `EXPLAIN` new queries.

**Add a chart.** Option builder `features/<area>/<name>Option.ts` + test on the returned option →
mount it with the shared chart component → text summary for screen readers → French labels in
`i18n/fr.ts`.

**Change a KPI.** Test in `dataiku/tests/` first → `ops_kpis` → if a column changes, it is a
contract change (spec, migration, flow schema, API, SPA together).

## 6. Branches, commits, reviews

- Branch from `main`: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`. Conventional commits
  (`feat(api): …`, `fix(web): …`), small and single-purpose.
- Open a merge request early (draft); the [MR template](../../.gitlab/merge_request_templates/Default.md)
  checklist must be complete; one approval minimum, two for auth/SQL/deploy changes.
- `main` is protected (no direct push, pipeline must pass). Releases are tags `vX.Y.Z` on `main`
  with notes in `docs/release-notes/` and a `CHANGELOG.md` entry.
- Never `--no-verify`; never commit secrets (the `.env` files are git-ignored).

## 7. Troubleshooting

| Symptom                                   | Fix                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `ECONNREFUSED 127.0.0.1:5432`             | `docker compose -f deploy/compose/docker-compose.yml up -d postgres` |
| Dashboard shows "Aucune donnée KPI — lancez le flow Dataiku" | run the KPI flow (§2)                               |
| `401` everywhere after restarting the API | the token expired or `JWT_SECRET` changed: sign in again            |
| Compose error "required variable … is missing" | create `deploy/compose/.env` from `.env.example`              |
| Port 8080 already used                    | set `WEB_PORT=8081` in `deploy/compose/.env`                        |
