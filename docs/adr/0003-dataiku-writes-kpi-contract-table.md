# ADR-0003: Dataiku computes the KPIs and writes a contract table that the API reads

**Date**: 2026-10-10
**Status**: accepted
**Deciders**: Alexandre Barusta (lead developer), Data team (Dataiku owners), operations product owner

## Context

SupervIT v1 computes statistics in PHP at page load, over all rows, and the capacity team computes
its own in Excel: two MTTR figures circulate. The client's Data ecosystem runs on Dataiku DSS, and
the mission asks to integrate with it (Python and SQL recipes, datasets, scenarios, APIs). The
dashboards need daily KPIs per service (MTTR, p90, SLA breach rate, change failure rate, anomaly
detection) that must be identical wherever they are shown.

## Decision

The Dataiku flow owns the statistics: a SQL recipe aggregates incidents and changes per day and
service, a Python recipe (code in the project library `ops_kpis`) derives the KPIs, and the flow
writes them to `ops.daily_service_kpis`, a table whose columns are part of the shared contract.
The API only reads that table for `/kpis/summary` and `/kpis/daily`; a local runner executes the
same recipes outside DSS (CI, hosts without DSS, the `kpi-job` container).

## Alternatives Considered

### Alternative 1: Compute KPIs in the API (SQL views or on-the-fly queries)
- **Pros**: one less moving part; always fresh.
- **Cons**: statistics logic (percentiles, rolling z-score) in two places as soon as the Data
  team needs it; heavy queries on every dashboard load.
- **Why not**: the Data team must own and reuse the definitions; dashboards need speed, not
  second-level freshness, for daily KPIs.

### Alternative 2: The API calls a Dataiku API endpoint at request time
- **Pros**: no shared table.
- **Cons**: couples dashboard availability to DSS availability and latency; harder to test.
- **Why not**: a table decouples the two runtimes; the Dataiku API endpoint (`kpi_lookup`) is
  still published for other consumers.

### Alternative 3: Materialised views refreshed by cron
- **Pros**: pure PostgreSQL.
- **Cons**: z-score and robust statistics are awkward in SQL; no Data-team ownership or lineage.
- **Why not**: Dataiku provides scheduling, lineage, checks and the team's skills.

## Consequences

### Positive
- One definition of each KPI, versioned and unit-tested in `dataiku/python-lib/ops_kpis`.
- Dashboard queries are primary-key range scans on a small table.
- The flow is idempotent (upsert on `(day, service)`): any day can be recomputed.

### Negative
- KPIs are D+1 (06:00); live views (lists, heatmap) use direct SQL instead.
- The table's columns are a contract: changing one is a coordinated change (contract spec,
  migration, flow, API, SPA) using expand → migrate → contract.

### Risks
- A failed scenario leaves yesterday's KPIs missing: the scenario alerts on failure, the SPA shows
  "Aucune donnée KPI — lancez le flow Dataiku", and the runbook covers the re-run.
