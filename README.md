# Ops Pulse

Modernisation of an ageing IT operations-supervision application into a secure, tested and
industrialised platform: incidents and changes (ServiceNow-shaped), daily service KPIs computed by
**Dataiku** (MTTR, p90, SLA breach rate, change failure rate, z-score anomalies) and **ECharts**
dashboards — React 19 + Node/Express + PostgreSQL, delivered on Red Hat UBI 9 with GitLab CI/CD.

Showcase for the mission *"Développeur Fullstack React/Node.js"* (Visian, Paris). The legacy app it
replaces ("SupervIT v1") is a fictional baseline described in the [analysis](docs/analysis/legacy-analysis.md).
This repository was created from the **ai-project-base** template (agent contract, guard hooks,
agent harness, engineering guides).

![Ops Pulse — vue d’ensemble (ECharts, anomalies z-score)](docs/assets/dashboard.jpg)

![Ops Pulse — incidents (filtres, pagination serveur)](docs/assets/incidents.jpg)

## Architecture

```mermaid
flowchart LR
    SN[(ServiceNow)] -- "Table API sync" --> PG
    subgraph RHEL 9 host — Docker Compose + systemd
      NG[web: Nginx UBI 9<br/>SPA + /api proxy] --> API[api: Express 5 + zod<br/>JWT, OpenAPI]
      API --> PG[(PostgreSQL 16<br/>schema ops)]
      JOB[kpi-job<br/>Dataiku flow runner] --> PG
    end
    DSS[Dataiku DSS<br/>SQL + Python recipes,<br/>scenario 06:00] -- "writes ops.daily_service_kpis" --> PG
    U([Browser: React 19 + ECharts]) -- HTTPS --> NG
```

| Part        | Path        | Stack                                                                 |
| ----------- | ----------- | --------------------------------------------------------------------- |
| Web SPA     | `apps/web`  | React 19, TypeScript strict, Vite, ECharts, Context API + reducers, Vitest + Testing Library |
| REST API    | `apps/api`  | Node 22, Express 5, TypeScript strict, zod, `pg`, JWT + bcrypt, pino, OpenAPI 3.1 |
| Database    | `db/migrations` | PostgreSQL 16, versioned plain-SQL migrations                     |
| Data        | `dataiku`   | Dataiku project (SQL + Python recipes, scenario, API endpoint), Python 3.11, pandas, local runner |
| Delivery    | `deploy`, `.gitlab-ci.yml` | UBI 9 images, Docker Compose, Nginx / Apache, systemd, GitLab CI/CD |
| Docs        | `docs`      | Analysis, architecture, ADRs, migration, ops, handbook — [index](docs/README.md) |

The binding contract between the parts (schema, API, ports): [docs/specs/2026-10-10-ops-pulse-contract.md](docs/specs/2026-10-10-ops-pulse-contract.md).

## Quick start (Docker)

```sh
cp deploy/compose/.env.example deploy/compose/.env    # fake, dev-only values
docker compose -f deploy/compose/docker-compose.yml up --build
```

Open <http://localhost:8080>. Demo accounts (**test-only**, created by the seed; never used
outside a demo): `admin@ops-pulse.test`, `analyst@ops-pulse.test`, `viewer@ops-pulse.test`, all
with the password `OpsPulse!2026`.

Compose starts PostgreSQL, applies the migrations and the demo seed, starts the API, runs the
Dataiku flow once (`kpi-job`) to fill the KPI table, and serves the SPA through Nginx. API docs:
<http://localhost:8080/api/v1/docs>.

## Local development

```sh
docker compose -f deploy/compose/docker-compose.yml up -d postgres     # database only
export DATABASE_URL=postgres://ops_pulse:dev-only-not-a-secret@localhost:5432/ops_pulse

cd apps/api && cp .env.example .env && npm ci && npm run db:migrate && npm run db:seed && npm run dev   # :3000
cd dataiku && uv sync && uv run python -m local_runner.run_flow                                      # KPIs
cd apps/web && npm ci && npm run dev                                                                  # :5173
```

Details: [developer guide](docs/handbook/developer-guide.md).

## Gates

| Where      | Commands                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `apps/web` | `npm run lint` · `npm run typecheck` · `npm test` · `npm run hygiene` · `npm run build`           |
| `apps/api` | same + `npm run test:integration` (PostgreSQL via `DATABASE_URL`)                                 |
| `dataiku`  | `uv run ruff check .` · `uv run ruff format --check .` · `uv run mypy` · `uv run pytest`          |
| root       | `node --test "tools/agent-harness/*.test.mjs"` · `shellcheck -x deploy/scripts/*.sh`             |

The pre-commit hook (`.husky/pre-commit`, enabled by `npm run prepare` at the root) runs the
harness and lints/typechecks the apps whose files are staged. GitLab CI runs everything, with
JUnit and coverage reports, image builds and scans, and manual deployments.

## Mission → where it is in this repo

### Missions

| Mission (job description)                                                        | Where                                                                                     |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| « Analyser l'architecture, le code et les flux de données existants »            | [docs/analysis/legacy-analysis.md](docs/analysis/legacy-analysis.md)                      |
| « Définir l'architecture cible (frontend, backend, Dataiku, bases de données) »  | [docs/architecture/target-architecture.md](docs/architecture/target-architecture.md), [docs/adr/](docs/adr/README.md) |
| « React 19, TypeScript, Vite »                                                   | `apps/web/` (`vite.config.ts`, `tsconfig.json`, `src/`)                                   |
| « ECharts » — nouvelles visualisations                                            | `apps/web/src/features/overview/` (`volumeOption.ts`, `heatmapOption.ts`, `priorityOption.ts`, `changeFailureOption.ts`) |
| « Context API / Redux »                                                          | `apps/web/src/state/` (`auth/`, `filters/`: Context + reducers); rationale in [detailed design §5](docs/architecture/detailed-design.md#5-frontend-design) |
| « API REST Node.js / Express / TypeScript, middlewares »                         | `apps/api/src/http/` (`routers/`, `middlewares/`), `apps/api/src/app.ts`                  |
| « Dataiku : Python et SQL avancé, datasets, recettes, syncs, API, scénarios »    | `dataiku/project/` (`datasets/`, `recipes/`, `scenarios/daily_kpis.json`), `dataiku/project/api-services/`, `dataiku/python-lib/ops_kpis/` |
| « Optimisation des requêtes MySQL/PostgreSQL, indexation »                       | `db/migrations/0002_indexes.sql`, `dataiku/project/recipes/compute_daily_service_base.sql`, [detailed design §3](docs/architecture/detailed-design.md#3-data-model) |
| « Migrations de schéma »                                                         | `db/migrations/`, `apps/api/src/adapters/postgres/migrator.ts`, [migration plan §4](docs/migration/migration-plan.md#4-schema-migration-rules) |
| « JWT, bcrypt, SAML 2.0 si requis »                                              | `apps/api/src/adapters/security/`, `apps/api/src/http/saml-metadata.ts`, [ADR 0004](docs/adr/0004-jwt-now-saml-behind-flag.md) |
| « Validation des entrées, protection des données sensibles »                     | `apps/api/src/http/schemas.ts`, `apps/api/src/http/validate.ts`, [security guide](docs/ops/security.md) |
| « Tests Vitest/Jest, Testing Library »                                           | `apps/*/src/**/*.test.ts(x)`, `apps/api/src/**/*.int.test.ts`, `dataiku/tests/`, [test strategy](docs/testing/test-strategy.md) |
| « ESLint, TypeScript strict »                                                    | `apps/*/eslint.config.mjs`, `tools/eslint/base.mjs`, `apps/*/tsconfig.json`              |
| « Pipelines CI/CD GitLab, workflows de branches »                                | [.gitlab-ci.yml](.gitlab-ci.yml), [.gitlab/merge_request_templates/Default.md](.gitlab/merge_request_templates/Default.md), [way of working §2](docs/agile/way-of-working.md#2-branch-and-release-workflow) |
| « Déploiements Docker / Docker Compose sur Linux Red Hat »                       | `deploy/docker/` (UBI 9), `deploy/compose/`, `deploy/scripts/`, [installation](docs/ops/installation.md) |
| « Services systemd, Apache ou Nginx »                                            | `deploy/systemd/`, `deploy/nginx/`, `deploy/apache/`                                      |
| « Agile / Scrum : cérémonies, revues de code, démos, rétrospectives »            | [docs/agile/way-of-working.md](docs/agile/way-of-working.md)                              |
| « Documentation et transfert de compétences »                                    | [docs/README.md](docs/README.md), [docs/knowledge-transfer/plan.md](docs/knowledge-transfer/plan.md) |
| Profil : « statistiques, supervision opérationnelle »                            | KPI formulas in [detailed design §4](docs/architecture/detailed-design.md#4-kpi-definitions), `dataiku/python-lib/ops_kpis/anomaly.py` |
| Profil : « gestion des incidents et des changements, ServiceNow »                | [docs/handbook/servicenow-integration.md](docs/handbook/servicenow-integration.md), [operations §5–6](docs/ops/operations.md#5-incident-handling-ops-pulse-itself) |

### Deliverables

| Deliverable (job description)                                         | Where                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| « Analyse de l'existant et recommandations »                          | [docs/analysis/legacy-analysis.md](docs/analysis/legacy-analysis.md)                        |
| « Architecture cible et conception détaillée »                        | [target architecture](docs/architecture/target-architecture.md), [detailed design](docs/architecture/detailed-design.md), [ADRs](docs/adr/README.md) |
| « Code versionné dans GitLab »                                        | this repository; branch workflow in [way of working](docs/agile/way-of-working.md)          |
| « API REST documentées, sécurisées et testées »                       | `apps/api/` — OpenAPI at `/api/v1/docs` (`apps/api/src/http/openapi.ts`), tests `apps/api/src/http/*.test.ts` |
| « Scripts SQL, modèles de données, procédures de migration »          | `db/migrations/`, `dataiku/project/recipes/*.sql`, [ER model](docs/architecture/detailed-design.md#3-data-model), [migration plan](docs/migration/migration-plan.md) |
| « Tests automatisés et rapports d'exécution »                         | test suites above; JUnit + coverage artifacts in `.gitlab-ci.yml`, [test strategy §3](docs/testing/test-strategy.md#3-execution-reports-in-ci) |
| « Pipelines CI/CD et procédures de déploiement »                      | [.gitlab-ci.yml](.gitlab-ci.yml), [.github/workflows/ci.yml](.github/workflows/ci.yml), `deploy/scripts/deploy.sh`, `deploy/scripts/rollback.sh` |
| « Images Docker et configurations Compose »                           | `deploy/docker/*.Dockerfile`, `deploy/compose/docker-compose.yml`, `deploy/compose/docker-compose.prod.yml` |
| « Documentation d'installation, d'exploitation, de sécurité, de maintenance » | [installation](docs/ops/installation.md), [operations](docs/ops/operations.md), [security](docs/ops/security.md), [maintenance](docs/ops/maintenance.md) |
| « Guides développeur et utilisateur, notes de version, supports de transfert » | [developer guide](docs/handbook/developer-guide.md), [user guide](docs/handbook/user-guide.md), [release notes](docs/release-notes/v0.1.0.md), [`CHANGELOG.md`](CHANGELOG.md), [KT plan](docs/knowledge-transfer/plan.md) |
| « Versions déployables et testées »                                   | tags `vX.Y.Z` → images `api`, `web`, `kpi-job` in the registry, `deploy_production` job; smoke test in `deploy.sh` |

## For AI agents

Read [`AGENTS.md`](AGENTS.md) (loaded by `CLAUDE.md`) and the nested `AGENTS.md` of the app you
work in. The agent harness (`tools/agent-harness/`) and the guard hooks (`.claude/hooks/`) keep
those rules enforced.
