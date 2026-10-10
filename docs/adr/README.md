# Architecture Decision Records

One numbered file per significant decision: `NNNN-<kebab-title>.md`, started from
[`docs/templates/adr-template.md`](../templates/adr-template.md). Write one when a choice shapes the
code for a long time and a newcomer would ask why: a language or runtime, a vendor or engine, a
storage or contract format, a layout or layering rule, a tuned value that was measured. Never
rewrite an accepted ADR: supersede it with a new one and update both rows below
(`docs/guides/base/collaboration.md`).

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](0001-react-19-vite-echarts.md) | React 19, TypeScript and Vite for the SPA, ECharts for visualisations | accepted | 2026-10-10 |
| [0002](0002-express-5-zod-rest-api.md) | Express 5 with zod validation and a layered TypeScript REST API | accepted | 2026-10-10 |
| [0003](0003-dataiku-writes-kpi-contract-table.md) | Dataiku computes the KPIs and writes a contract table that the API reads | accepted | 2026-10-10 |
| [0004](0004-jwt-now-saml-behind-flag.md) | JWT authentication now, SAML 2.0 single sign-on behind a feature flag | accepted | 2026-10-10 |
| [0005](0005-ubi9-compose-systemd-rhel.md) | Red Hat UBI 9 images, Docker Compose and systemd on RHEL 9 | accepted | 2026-10-10 |
