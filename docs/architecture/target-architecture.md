# Target architecture

**Date:** 2026-10-10 · **Status:** accepted · **Inputs:** [legacy analysis](../analysis/legacy-analysis.md),
[contract](../specs/2026-10-10-ops-pulse-contract.md) · **Details:** [detailed design](detailed-design.md)

Ops Pulse replaces SupervIT v1 with four parts, each with one job: a **React SPA** for
supervision dashboards, a **REST API** that owns access to operational data, **Dataiku** that owns
statistics, and **PostgreSQL** as the shared store. They meet at two contracts: the REST API
(`/api/v1`, OpenAPI) and the table `ops.daily_service_kpis`.

## 1. System context

```mermaid
flowchart TB
    sup([Supervisor N1/N2<br/>viewer])
    ana([Service manager / analyst<br/>analyst])
    adm([Platform admin<br/>admin])
    subgraph OP[Ops Pulse]
      direction TB
      core[Ops Pulse platform]
    end
    sn[(ServiceNow<br/>incident, change_request)]
    dss[Dataiku DSS<br/>Data ecosystem]
    idp[Corporate IdP<br/>SAML 2.0]
    sup -- "dashboards, incident lists" --> core
    ana -- "declares / updates incidents" --> core
    adm -- "users, operations" --> core
    sn -- "Table API, incremental" --> core
    dss <-- "reads incidents/changes,<br/>writes daily KPIs" --> core
    idp -. "SSO (behind SAML_ENABLED)" .-> core
```

## 2. Containers

```mermaid
flowchart LR
    browser[Browser<br/>React 19 SPA]
    subgraph host[RHEL 9 host — Docker Compose]
      nginx[web<br/>Nginx 1.26 UBI 9<br/>:8080]
      api[api<br/>Node 22 + Express 5<br/>:3000]
      pg[(postgres 16<br/>schema ops)]
      job[kpi-job<br/>Dataiku flow runner<br/>systemd timer 06:00]
      mig[migrate<br/>one-shot]
    end
    dss[Dataiku DSS<br/>scenario 06:00]
    sn[(ServiceNow)]
    browser -- "HTTPS, static files" --> nginx
    browser -- "HTTPS /api/v1, Bearer JWT" --> nginx
    nginx -- "proxy /api/" --> api
    api -- "SQL (pg), parameterised" --> pg
    mig -- "db/migrations" --> pg
    job -- "read incidents/changes,<br/>upsert daily_service_kpis" --> pg
    dss -- "same flow in DSS<br/>(SQL connection)" --> pg
    sn -- "sync job (Table API)" --> pg
```

| Container   | Responsibility                                                                                         | Must not                                         |
| ----------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `web`       | Serve the SPA, TLS termination (or behind the corporate LB), security headers, `/api/` reverse proxy   | Hold state or secrets                            |
| SPA         | Dashboards (ECharts), lists with server-side filtering/paging, forms with client validation, French UI | Compute KPIs; trust its own validation           |
| `api`       | AuthN/AuthZ, validation (zod), business rules (SLA, roles), SQL access, OpenAPI, structured logs        | Compute daily statistics (Dataiku owns them)     |
| `postgres`  | Source of truth for incidents, changes, users; the KPI contract table                                   | Be reachable from outside the host               |
| Dataiku     | Data preparation and statistics: SQL recipe (aggregates) + Python recipe (rates, p90, z-score), scenario, API endpoint | Write any table but `ops.daily_service_kpis` |
| `kpi-job`   | Run the same Dataiku flow outside DSS (local runner) on hosts or CI without DSS                         | Diverge from the DSS recipes (same code)         |
| `migrate`   | Apply versioned SQL migrations before the API starts; optional demo seed                               | Run in parallel with another migrate             |

## 3. Data flow: ServiceNow → dashboard

```mermaid
sequenceDiagram
    autonumber
    participant SN as ServiceNow
    participant SY as Sync (Table API)
    participant PG as PostgreSQL (ops)
    participant DK as Dataiku flow
    participant API as Express API
    participant UI as React + ECharts
    SN->>SY: GET /api/now/table/incident?sysparm_query=sys_updated_on>last_run
    SY->>PG: upsert ops.incidents / ops.changes (by number)
    Note over DK: 06:00 scenario (DSS) or systemd timer (kpi-job)
    DK->>PG: SQL recipe compute_daily_service_base (counts, MTTR, p90, breaches per day × service)
    DK->>DK: Python recipe compute_daily_service_kpis: rates, rolling z-score, anomalies
    DK->>PG: upsert ops.daily_service_kpis (day, service)
    UI->>API: GET /api/v1/kpis/daily?from&to&service (JWT)
    API->>PG: SELECT … FROM ops.daily_service_kpis WHERE day BETWEEN …
    API-->>UI: { items: DailyKpi[] } (zod-validated)
    UI->>UI: ECharts line + anomaly markers
    UI->>API: GET /api/v1/kpis/by-priority, /heatmap (live SQL on ops.incidents)
```

Two freshness levels by design: KPI cards and trends are **daily** (Dataiku, D+1 06:00); incident
and change lists, priority breakdown and heatmap are **live** SQL on the operational tables.

## 4. Responsibilities by layer

**Frontend (`apps/web`).** React 19 + TypeScript strict + Vite. Routing with React Router; pages
`/` ("Vue d’ensemble"), `/incidents`, `/changes`, `/login`. State: React Context for the session
(token, user, role) and the shared filters (period, service), local component state for forms;
server data through a small `useApiQuery` hook with abort on unmount. Every API response is parsed
with zod before use. Charts are ECharts components fed by pure option-builder functions, unit-tested
without a DOM. See [detailed design §5](detailed-design.md#5-frontend-design).

**Backend (`apps/api`).** Node 22, Express 5, TypeScript strict, layered `domain → ports →
adapters → http`. Domain code (SLA, roles, KPI shapes) imports no framework; adapters implement
ports (PostgreSQL repositories, bcrypt, JWT); `http/` holds routers, middlewares (request id,
pino logging, helmet, CORS allow-list, rate limit, auth, zod validation, error mapper). See
[ADR 0002](../adr/0002-express-5-zod-rest-api.md).

**Dataiku (`dataiku/`).** Flow: `incidents_raw` + `changes_raw` (SQL datasets on the `ops`
connection) → `incidents_prepared` → SQL recipe `compute_daily_service_base` → dataset
`daily_service_base` → Python recipe `compute_daily_service_kpis` (code in the project library
`python-lib/ops_kpis`) → `daily_service_kpis` (SQL dataset = `ops.daily_service_kpis`). Scenario
"Daily KPIs": time trigger 06:00 Europe/Paris, sets a rolling 120-day window, forced recursive
build of `daily_service_kpis`, dataset checks, mail to the on-call team on failure. API Designer
endpoint `kpi_lookup` exposes the latest KPIs to other Data consumers. See [ADR 0003](../adr/0003-dataiku-writes-kpi-contract-table.md).

**Database.** PostgreSQL 16, one schema `ops`, `citext` for e-mails, check constraints for every
enumeration, indexes designed from the dashboard queries, versioned plain-SQL migrations applied by
the API's migrator. See [detailed design §3](detailed-design.md#3-data-model).

## 5. Security architecture

```mermaid
flowchart LR
    U[User] -- "TLS 1.2+" --> N[Nginx<br/>CSP, HSTS, nosniff,<br/>frame-ancestors none,<br/>1 MB body limit,<br/>login rate limit]
    N --> A[API<br/>helmet, CORS allow-list,<br/>JWT HS256 iss/aud/exp,<br/>role check per route,<br/>zod on body/query/params,<br/>5 logins/min/IP]
    A -- "least-privilege DB role,<br/>parameterised SQL" --> P[(PostgreSQL<br/>not exposed)]
    I[IdP SAML 2.0] -. "assertion (flag)" .-> A
```

- **Identity:** local accounts with bcrypt (cost 12) for v0.1; SAML 2.0 SP behind `SAML_ENABLED`
  for corporate SSO (metadata at `/api/v1/auth/saml/metadata`). See [ADR 0004](../adr/0004-jwt-now-saml-behind-flag.md).
- **Authorisation:** roles `viewer` < `analyst` < `admin`, checked per route on the server.
- **Input:** zod on every body, query and path parameter; errors in one JSON shape, no stack traces.
- **Secrets:** environment only (`.env` mode 600 on the host, GitLab masked variables in CI); never
  in images or git. **Logs:** pino JSON with request id, `password`/`authorization`/`token` redacted.
- **Supply chain:** lock files, `npm ci`, pinned Python requirements, UBI base images, Trivy scan in CI.
- Details and OWASP mapping: [security guide](../ops/security.md).

## 6. Deployment view

```mermaid
flowchart TB
    subgraph rhel[RHEL 9 VM — SELinux enforcing, firewalld]
      sd1[systemd: ops-pulse.service] --> dc[docker compose up<br/>postgres, api, web]
      sd2[systemd: ops-pulse-kpi.timer 06:00] --> kj[docker compose run kpi-job]
      sd3[systemd: ops-pulse-backup.timer 05:30] --> bk[backup-db.sh → /var/backups]
      dc --- vol[(volume pgdata)]
      fw[firewalld: 443/tcp only] --> dc
    end
    gl[GitLab CI] -- "ssh + rsync deploy/<br/>deploy.sh --tag" --> rhel
    reg[(GitLab registry<br/>api, web, kpi-job images)] -- "docker pull" --> rhel
```

- Images: Red Hat UBI 9 (`nodejs-22`, `nodejs-22-minimal`, `nginx-126`, `python-311`), non-root,
  read-only root filesystem in production ([ADR 0005](../adr/0005-ubi9-compose-systemd-rhel.md)).
- Environments: local (Compose, demo seed) → staging (manual deploy from `main`) → production
  (manual deploy of a `vX.Y.Z` tag). Same images everywhere; only `.env` differs.
- Alternative: Nginx or Apache **on the host** in front of the API container
  (`deploy/nginx/ops-pulse.conf`, `deploy/apache/ops-pulse.conf`) when the site standard requires it.

## 7. Non-functional requirements

| NFR             | Target                                                          | How it is met                                                       |
| --------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| Performance     | API p95 < 300 ms on 2 years of data (≈ 200 k incidents); SPA LCP < 2 s | Pre-aggregated KPIs; indexes per query; gzip; immutable hashed assets |
| Availability    | 99.5 % business hours; RTO 1 h, RPO 24 h                        | Health checks, restart policies, daily backups, scripted rollback   |
| Security        | No known critical vulnerability; OWASP ASVS L2 for auth/session | Security baseline, Trivy gate, MR security checklist                |
| Maintainability | Strict TS/mypy, lint with zero warnings, ≥ 80 % coverage on domain/KPI code | CI gates, architecture-as-lint, ADRs                      |
| Observability   | Every request traceable end to end                              | Request id from Nginx to API logs; JSON logs; journald for jobs      |
| Data quality    | KPIs reproducible for any past day                              | Deterministic recipes, idempotent upsert on `(day, service)`, tests  |
| Accessibility   | WCAG 2.1 AA on dashboards                                       | Text summaries of every chart, keyboard navigation, contrast tokens |
| Portability     | Runs on RHEL 9 with Docker or Podman                            | OCI images, Compose spec, no host dependency but the engine         |
