# Ops Pulse — shared contract (spec)

**Date:** 2026-10-10 · **Status:** accepted · **Owner:** Alexandre Barusta

Ops Pulse is a showcase for the Visian mission "Développeur Fullstack React/Node.js": the
**modernisation of a legacy operations-supervision app** into a secure, industrialised platform that
plugs into the Data ecosystem (Dataiku). Domain: IT operations — **incidents and changes**
(ServiceNow-shaped records), **statistics** (MTTR, p90, SLA breach rate, change failure rate,
z-score anomaly detection) and **operational supervision** dashboards (ECharts).

This file is the single source of truth every part of the repo builds against. Change it first,
then the code.

## Repository layout

| Path               | What                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `apps/web/`        | React 19 + TypeScript strict + Vite + ECharts SPA                    |
| `apps/api/`        | Node 22 + Express 5 + TypeScript REST API (PostgreSQL via `pg`)      |
| `db/migrations/`   | Versioned plain-SQL migrations (`NNNN_name.sql`), applied by the API's migrator |
| `apps/api/src/seed/` | Deterministic seed (run with `npm run db:seed`)                    |
| `dataiku/`         | Dataiku project: Python + SQL recipes, scenario, local runner, tests |
| `deploy/`          | Dockerfiles (Red Hat UBI 9), Docker Compose, Nginx, systemd          |
| `.gitlab-ci.yml`   | Primary CI/CD (GitLab); `.github/workflows/ci.yml` mirrors it        |
| `docs/`            | Analysis, target architecture, ADRs, ops/security/user guides        |

Every Node app exposes the same npm scripts: `dev`, `build`, `test`, `lint`, `typecheck`, `hygiene`.
Node 22 LTS. npm (one `package-lock.json` per app, no workspaces).

## Ports and environment

| Service  | Port | Notes                                         |
| -------- | ---- | --------------------------------------------- |
| postgres | 5432 | db `ops_pulse`, user `ops_pulse`              |
| api      | 3000 | `/api/v1/*`                                   |
| web dev  | 5173 | Vite proxies `/api` → `http://localhost:3000` |
| nginx    | 8080 | serves the built SPA, proxies `/api` → api    |

API env vars: `DATABASE_URL`, `JWT_SECRET` (≥ 32 chars), `JWT_TTL_SECONDS` (default 3600),
`CORS_ORIGIN`, `PORT`, `LOG_LEVEL`, `SAML_ENABLED` (default `false`), `SAML_ENTRY_POINT`,
`SAML_ISSUER`, `SAML_IDP_CERT`.

Demo users (seed, password for all: `OpsPulse!2026`, test-only): `admin@ops-pulse.test` (admin),
`analyst@ops-pulse.test` (analyst), `viewer@ops-pulse.test` (viewer).

## Database (PostgreSQL 16, schema `ops`)

```sql
ops.users            (id bigserial pk, email citext unique, password_hash text, role text check in ('viewer','analyst','admin'), created_at timestamptz default now())
ops.assignment_groups(id serial pk, name text unique not null)
ops.incidents        (id bigserial pk, number text unique not null  -- 'INC0010001'
                      , short_description text not null, priority smallint check 1..4  -- 1=critical
                      , state text check in ('new','in_progress','on_hold','resolved','closed')
                      , category text not null, service text not null
                      , assignment_group_id int fk, opened_at timestamptz not null
                      , resolved_at timestamptz null, sla_due_at timestamptz not null
                      , caused_by_change text null)   -- change number, ServiceNow 'caused_by'
ops.changes          (id bigserial pk, number text unique not null   -- 'CHG0030001'
                      , short_description text not null
                      , type text check in ('standard','normal','emergency')
                      , risk text check in ('low','moderate','high')
                      , state text check in ('scheduled','implement','review','closed','cancelled')
                      , close_code text null check in ('successful','unsuccessful','backed_out')
                      , service text not null, planned_start timestamptz, planned_end timestamptz
                      , closed_at timestamptz null)
ops.daily_service_kpis  -- WRITTEN BY DATAIKU, read by the API
                     (day date, service text, incident_count int, resolved_count int
                      , mttr_minutes numeric(10,2), p90_resolution_minutes numeric(10,2)
                      , sla_breach_rate numeric(5,4), change_count int, change_failure_rate numeric(5,4)
                      , incident_zscore numeric(6,3), is_anomaly boolean
                      , computed_at timestamptz default now(), primary key (day, service))
```

Indexes worth showing: `incidents(service, opened_at)`, partial `incidents(opened_at) where
resolved_at is null`, `changes(service, closed_at)`. Services: `payments`, `crm`, `data-platform`,
`identity`, `network`, `reporting`.

## REST API (`/api/v1`, JSON camelCase, Bearer JWT)

Error shape everywhere: `{ "error": { "code": "VALIDATION_FAILED", "message": "…", "details"?: [...] } }`.
Codes: `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `VALIDATION_FAILED` 400,
`RATE_LIMITED` 429, `INTERNAL` 500.

| Method | Path                        | Role     | Response                                                   |
| ------ | --------------------------- | -------- | ---------------------------------------------------------- |
| GET    | `/health`                   | public   | `{ status: 'ok', db: 'up'\|'down', version }`              |
| POST   | `/auth/login`               | public   | body `{email,password}` → `{ token, user: User }`          |
| GET    | `/auth/me`                  | any      | `User`                                                     |
| GET    | `/auth/saml/metadata`       | public   | SP metadata XML, 404 when `SAML_ENABLED=false`             |
| GET    | `/incidents`                | viewer+  | query `service,priority,state,from,to,q,page=1,pageSize=25(≤100),sort=-openedAt` → `Page<Incident>` |
| GET    | `/incidents/:number`        | viewer+  | `Incident`                                                 |
| POST   | `/incidents`                | analyst+ | body `{shortDescription,priority,category,service,assignmentGroup}` → 201 `Incident` |
| PATCH  | `/incidents/:number`        | analyst+ | body `{state?,priority?}` → `Incident`                     |
| GET    | `/changes`                  | viewer+  | query `service,state,type,from,to,page,pageSize` → `Page<Change>` |
| GET    | `/kpis/summary`             | viewer+  | query `from,to,service?` → `KpiSummary`                    |
| GET    | `/kpis/daily`               | viewer+  | query `from,to,service?` → `{ items: DailyKpi[] }`         |
| GET    | `/kpis/by-priority`         | viewer+  | query `from,to` → `{ items: {priority,count,mttrMinutes,slaBreachRate}[] }` |
| GET    | `/kpis/heatmap`             | viewer+  | query `from,to` → `{ items: {weekday 0-6 (Mon=0), hour 0-23, count}[] }` |
| GET    | `/kpis/change-outcomes`     | viewer+  | query `from,to` → `{ items: {service,closeCode,count}[] }` (closed in range, by service then closeCode) |
| GET    | `/docs`                     | public   | OpenAPI 3.1 (Swagger UI), spec at `/api/v1/openapi.json`   |

Clarifications (as implemented):

- All days are **UTC**; `to` is inclusive. The `from`/`to` default (last 30 days) also filters the
  lists: `incidents.opened_at`, `changes.planned_start`. Unknown query parameters → 400.
- `sort` on `/incidents` accepts `±number`, `±priority`, `±openedAt`, `±slaDueAt` (allow-listed).
- `/kpis/by-priority` always returns priorities 1–4; `mttrMinutes` is `null` when nothing resolved.
  `/kpis/heatmap` returns the full 7 × 24 grid (UTC hours).
- `/kpis/summary` weights `slaBreachRate` and `mttrMinutes` by `resolved_count` and
  `changeFailureRate` by `change_count`; `p90ResolutionMinutes` is computed live
  (`percentile_cont`) because daily p90s cannot be combined.
- KPI semantics (Dataiku): SLA breach rate = breached ÷ resolved that day; change failure rate =
  (unsuccessful + backed_out) ÷ changes closed that day, cancelled excluded; both `0` with no
  denominator. Anomaly = trailing 28-day z-score (current day excluded, ≥ 7 days history),
  `|z| ≥ 3` and `incident_count ≥ 5`.
- `/health` answers 200 with `db: 'down'` when Postgres is unreachable.
- `SAML_CALLBACK_URL` is required when `SAML_ENABLED=true` (SP metadata only; no IdP round trip).
- `POST /incidents` numbers come from the `ops.incident_number_seq` sequence.

```ts
type User = { id: number; email: string; role: 'viewer' | 'analyst' | 'admin' };
type Page<T> = { items: T[]; page: number; pageSize: number; total: number };
type Incident = { number: string; shortDescription: string; priority: 1|2|3|4; state: string;
  category: string; service: string; assignmentGroup: string; openedAt: string;
  resolvedAt: string | null; slaDueAt: string; slaBreached: boolean; causedByChange: string | null };
type Change = { number: string; shortDescription: string; type: string; risk: string; state: string;
  closeCode: string | null; service: string; plannedStart: string; plannedEnd: string; closedAt: string | null };
type KpiSummary = { openIncidents: number; mttrMinutes: number; p90ResolutionMinutes: number;
  slaBreachRate: number; changeFailureRate: number; anomalies: number };
type DailyKpi = { day: string; service: string; incidentCount: number; resolvedCount: number;
  mttrMinutes: number | null; p90ResolutionMinutes: number | null; slaBreachRate: number;
  changeCount: number; changeFailureRate: number; incidentZscore: number | null; isAnomaly: boolean };
```

Dates are ISO 8601 strings; `from`/`to` are `YYYY-MM-DD` (default: last 30 days).
`/kpis/summary` and `/kpis/daily` read `ops.daily_service_kpis` (Dataiku output); `by-priority`
and `heatmap` are live SQL aggregates on `ops.incidents`.

## Security baseline

helmet, CORS allow-list, rate limit on `/auth/login` (5/min/IP), bcrypt cost 12, JWT HS256 with
`iss`/`aud`/`exp`, zod validation on every body/query/param, parameterised SQL only, no stack traces
in responses, structured JSON logs (pino) with request id, sensitive fields redacted
(`password`, `authorization`, `token`).
