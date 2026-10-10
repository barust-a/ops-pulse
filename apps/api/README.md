# Ops Pulse API

REST API of Ops Pulse: ServiceNow-shaped incidents and changes, and supervision KPIs, over
PostgreSQL. Node 22, Express 5, TypeScript, `pg`, zod, pino. Contract:
[`docs/specs/2026-10-10-ops-pulse-contract.md`](../../docs/specs/2026-10-10-ops-pulse-contract.md).

## Run it locally

```sh
cp .env.example .env            # fake dev values; point DATABASE_URL at your PostgreSQL 16
npm ci
npm run db:migrate              # applies ../../db/migrations
npm run db:seed                 # ~2,500 incidents and ~350 changes over 90 days, 3 demo users
npm run dev                     # http://localhost:3000/api/v1
```

- Swagger UI: <http://localhost:3000/api/v1/docs>, OpenAPI 3.1: `/api/v1/openapi.json`.
- Demo users (test-only password `OpsPulse!2026`): `admin@`, `analyst@`, `viewer@ops-pulse.test`.
- `POST /api/v1/auth/login` returns a JWT; send it as `Authorization: Bearer <token>`.

## Endpoints (`/api/v1`)

`GET /health` · `POST /auth/login` · `GET /auth/me` · `GET /auth/saml/metadata` (404 unless
`SAML_ENABLED=true`) · `GET|POST /incidents` · `GET|PATCH /incidents/:number` · `GET /changes` ·
`GET /kpis/summary` · `GET /kpis/daily` · `GET /kpis/by-priority` · `GET /kpis/heatmap` ·
`GET /kpis/change-outcomes` · `GET /docs`.

`/kpis/summary` and `/kpis/daily` read `ops.daily_service_kpis`, which the Dataiku flow fills:
until it has run they answer zeros and empty lists. The other KPIs are live SQL.

## Production

`npm run build`, then `node dist/scripts/migrate.js`, `node dist/server.js` (set
`MIGRATIONS_DIR` when the image does not keep the repository layout). `SIGTERM` drains requests
and closes the pool. Logs are JSON on stdout with a request id (`X-Request-Id`) and secrets
redacted.

Agent and contributor rules, gates and layers: [`AGENTS.md`](AGENTS.md).
