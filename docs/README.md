# docs/

Ops Pulse documentation, versioned with the code. Start with the
[contract](specs/2026-10-10-ops-pulse-contract.md), then the
[target architecture](architecture/target-architecture.md).

## Project documentation (mission deliverables)

| Area                | Document                                                                 | For                          |
| ------------------- | ------------------------------------------------------------------------ | ---------------------------- |
| Contract            | [specs/2026-10-10-ops-pulse-contract.md](specs/2026-10-10-ops-pulse-contract.md) — layout, ports, schema, REST API (binding) | everyone |
| Analysis            | [analysis/legacy-analysis.md](analysis/legacy-analysis.md) — the existing app (fictional baseline), findings, recommendations | architects, PO |
| Architecture        | [architecture/target-architecture.md](architecture/target-architecture.md) — context, containers, data flow, security, deployment, NFRs | architects, devs |
|                     | [architecture/detailed-design.md](architecture/detailed-design.md) — API design, data model, KPI formulas, frontend state | devs, Data |
| Decisions           | [adr/](adr/README.md) — ADR 0001–0005                                     | everyone                     |
| Migration           | [migration/migration-plan.md](migration/migration-plan.md) — strangler fig, MySQL → PostgreSQL, cut-over, schema rules | devs, DBA, run |
| Operations          | [ops/installation.md](ops/installation.md) — laptop and RHEL 9 install   | run team                     |
|                     | [ops/operations.md](ops/operations.md) — runbook: health, logs, restart, KPI job, incidents | run team, on-call |
|                     | [ops/security.md](ops/security.md) — threat model, auth, OWASP, secrets, GDPR | security, devs           |
|                     | [ops/maintenance.md](ops/maintenance.md) — updates, backups/restore, PostgreSQL, secret rotation | run team, devs |
| Handbook            | [handbook/developer-guide.md](handbook/developer-guide.md)              | developers                   |
|                     | [handbook/user-guide.md](handbook/user-guide.md)                        | end users                    |
|                     | [handbook/servicenow-integration.md](handbook/servicenow-integration.md) — field mapping, Table API sync, Dataiku feed | devs, Data |
| Quality             | [testing/test-strategy.md](testing/test-strategy.md) — pyramid, what runs where, CI reports | devs, QA |
| Team                | [agile/way-of-working.md](agile/way-of-working.md) — Scrum, DoR/DoD, reviews, demo, retro | team |
|                     | [knowledge-transfer/plan.md](knowledge-transfer/plan.md) — sessions, pairing, exit criteria | client team |
| Releases            | [release-notes/](release-notes/v0.1.0.md) and [`CHANGELOG.md`](../CHANGELOG.md) | everyone            |

Delivery files: [`deploy/`](../deploy/) (Dockerfiles, Compose, Nginx/Apache, systemd, scripts),
[`.gitlab-ci.yml`](../.gitlab-ci.yml), [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Documentation workflow (see `AGENTS.md` §1)

- `specs/` — approved designs, `YYYY-MM-DD-<topic>-design.md`, written BEFORE planning.
- `plans/` — TDD implementation plans, `YYYY-MM-DD-<topic>.md`, written BEFORE coding.
- `smoke-tests/` — manual validation guides, `YYYY-MM-DD-<feature>-smoke-test.md`, written
  on request, with exact expected on-screen text.
- `adr/` — architecture decision records, `NNNN-<title>.md`, one per decision that shapes the
  code for a long time; never rewritten, only superseded (index in its README).
- `templates/` — copy these to start each document. Keep them in sync with practice changes.

Reference material agents open on demand, never load whole:

- `guides/` — engineering guides, routed by the map in `AGENTS.md` §11:
  `base/` (language-agnostic rules and the full `agents-base.md`) and one folder per language
  (`python/`).
- `reference/` — reference libraries; `sql/` is the SQL & PostgreSQL
  library (start at its README: golden rules, task map).
