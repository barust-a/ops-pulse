# Changelog

All notable changes to Ops Pulse. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/). A release is a `vX.Y.Z` tag on `main`;
its notes live in `docs/release-notes/`.

## Unreleased

## 0.1.0 — 2026-10-10

Bootstrapped from the **ai-project-base** template (agent contract, guard hooks, agent harness,
engineering guides); the template's React Native stack was removed. Release notes:
[docs/release-notes/v0.1.0.md](docs/release-notes/v0.1.0.md).

### Added

- Web SPA `apps/web`: React 19, TypeScript strict, Vite, ECharts dashboards (overview, incidents,
  changes) with a French UI.
- REST API `apps/api`: Express 5, zod validation, JWT auth with roles, OpenAPI 3.1, PostgreSQL 16
  via `pg`; versioned SQL migrations in `db/migrations` and a deterministic demo seed.
- Dataiku project `dataiku/`: Python and SQL recipes computing daily service KPIs (MTTR, p90,
  SLA breach rate, change failure rate, z-score anomalies) into `ops.daily_service_kpis`, with a
  local runner and tests.
- Delivery: Red Hat UBI 9 images, Docker Compose (dev and production override), Nginx and Apache
  virtual hosts, systemd units and timers for RHEL 9, deploy / rollback / backup scripts.
- CI/CD: GitLab pipeline (lint → test → build → package → deploy) with JUnit and coverage reports,
  image scanning and manual staging/production deployments; GitHub Actions mirror of the gates.
- Documentation: legacy analysis, target architecture and detailed design, ADRs 0001–0005,
  migration plan, installation / operations / security / maintenance guides, developer and user
  guides, ServiceNow integration, way of working, knowledge-transfer plan, test strategy.
