# Ops Pulse — Dataiku project

The Data side of Ops Pulse: a Dataiku DSS flow that turns ServiceNow-shaped incidents and changes
(`ops.incidents`, `ops.changes`) into one row of KPIs per service and day in
`ops.daily_service_kpis`, which the Ops Pulse API serves to the supervision dashboards
(`/kpis/summary`, `/kpis/daily`). It shows SQL push-down with advanced PostgreSQL, a Python
recipe backed by a tested project library, a synchronisation, a scheduled scenario with checks
and a failure reporter, and an API node endpoint.

DSS is not needed to run it: `local_runner/` executes the same recipe files against PostgreSQL.

## Flow

```mermaid
flowchart LR
    subgraph src["PostgreSQL schema ops (owned by the API)"]
        inc[("incidents_raw<br/>ops.incidents")]
        chg[("changes_raw<br/>ops.changes")]
    end
    inc -- "sync<br/>sync_incidents_raw" --> prep[("incidents_prepared")]
    prep -- "SQL<br/>compute_daily_service_base" --> base[("daily_service_base<br/>calendar x services")]
    chg -- "SQL" --> base
    base -- "Python + ops_kpis<br/>compute_daily_service_kpis" --> kpis[("daily_service_kpis<br/>ops.daily_service_kpis")]
    kpis --> api["Ops Pulse REST API<br/>/kpis/summary, /kpis/daily"]
    kpis --> ep["API node: kpi_lookup / latest_kpis"]
    scen{{"scenario daily_kpis<br/>06:00 Europe/Paris"}} -. "set vars, build, check,<br/>mail on failure" .-> kpis
```

## Files and the DSS objects they stand for

| File                                                   | DSS object                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| `project/params.json`                                  | Project settings (key `OPS_PULSE`, code env, connection used) |
| `project/variables.json`                               | Project variables (window dates, baseline constants)          |
| `project/datasets/incidents_raw.json`, `changes_raw.json` | PostgreSQL datasets reading `ops.incidents` / `ops.changes` in place |
| `project/datasets/incidents_prepared.json`             | Managed PostgreSQL dataset, output of the sync recipe         |
| `project/datasets/daily_service_base.json`             | Managed PostgreSQL dataset, output of the SQL recipe          |
| `project/datasets/daily_service_kpis.json`             | PostgreSQL dataset on `ops.daily_service_kpis` (flow output)  |
| `project/recipes/sync_incidents_raw.json`              | Sync recipe `incidents_raw -> incidents_prepared`             |
| `project/recipes/compute_daily_service_base.{json,sql}` | SQL query recipe (in-database)                               |
| `project/recipes/compute_daily_service_kpis.{json,py}` | Python recipe                                                 |
| `python-lib/ops_kpis/`                                 | Project library (Libraries > `python/`), on every recipe's path |
| `project/scenarios/daily_kpis.json`                    | Step-based scenario: time trigger, steps, mail reporter       |
| `project/metrics_checks.json`                          | Metrics probes and checks of `daily_service_kpis` (Status tab) |
| `project/api-services/kpi_lookup/`                     | API Designer service with a Python function endpoint          |

What each recipe does:

1. **`sync_incidents_raw`** copies the columns the flow needs from `ops.incidents` into a
   managed table, in the database (no rows through Python), so the SQL recipe reads a stable
   snapshot while ServiceNow keeps writing.
2. **`compute_daily_service_base.sql`** (PostgreSQL 16) builds the gap-free calendar
   (`generate_series`) x services grid, opened and resolved volumes, MTTR, p90
   (`percentile_cont(0.9) WITHIN GROUP`), SLA breaches and failed changes
   (`count(*) FILTER (WHERE ...)`), and a trailing 28-day baseline with window functions
   (`avg/stddev_samp OVER (... ROWS BETWEEN 28 PRECEDING AND 1 PRECEDING)`). Its header records
   the `EXPLAIN` reasoning and which contract index each part relies on.
3. **`compute_daily_service_kpis.py`** reads `daily_service_base` with
   `dataiku.Dataset(...).get_dataframe()`, calls `ops_kpis.build_daily_kpis` (rates with
   zero-denominator guards, rolling z-score, anomaly flag, rounding to the column scales) and
   writes with `write_with_schema`.

## Run it locally

```sh
cd dataiku
uv sync --locked
DATABASE_URL=postgres://ops_pulse:ops_pulse@localhost:5432/ops_pulse \
  uv run python -m local_runner.run_flow --from 2026-06-13 --to 2026-10-10
```

Without `--from/--to` the window is the 120 days ending today (Europe/Paris). The container image
runs the same command with `pip install -r requirements.txt` on Python 3.11. One run is one
transaction: sync and SQL outputs are temp tables, the Python recipe upserts
`ops.daily_service_kpis` on `(day, service)`, then the checks of `metrics_checks.json` run on the
rebuilt window. An ERROR check or any failure rolls everything back; re-running a window is
idempotent. Exit codes: 0 ok, 1 failed, 2 usage error.

The `dataiku` package recipes import is `local_runner/shim/dataiku/`: `Dataset(name)` resolves
`project/datasets/<name>.json` to a table of the runner's connection, and `get_custom_variables()`
returns the window as DSS would after the scenario's "set variables" step.

## Importing into a real DSS instance

These files are a hand-maintained, reviewable subset of a DSS project export (the keys the flow
needs), not a byte-for-byte export archive. To stand the project up in DSS 12+:

1. Create a PostgreSQL connection `ops_postgres` to the Ops Pulse database (read on `ops.incidents`
   and `ops.changes`, write on `ops.daily_service_kpis` and on a managed schema such as
   `dku_ops_pulse` for the intermediate datasets).
2. Create a Python 3.11 code env `py311_ops_pulse` with the pins of `requirements.txt` (pandas,
   numpy; psycopg only for the API endpoint).
3. Create project `OPS_PULSE`; copy `python-lib/ops_kpis/` into its Libraries (`python/`); add the
   variables of `variables.json`.
4. Create the five datasets with the connection, schema/table and columns of `datasets/*.json`.
   For `daily_service_kpis`, partition by the `day` column (time dimension, DAY) so a rebuild
   replaces only the days built, as the local upsert does: an unpartitioned overwrite would wipe
   the history outside the window.
5. Create the recipes with their inputs/outputs from `recipes/*.json` and paste the `.sql` / `.py`
   code; the sync recipe needs no code.
6. Add the metrics and checks of `metrics_checks.json` on `daily_service_kpis` (Status tab).
7. Create scenario `daily_kpis` as described in `scenarios/daily_kpis.json` (time trigger daily
   06:00 Europe/Paris; steps set variables, build `daily_service_kpis` recursively, run checks;
   mail reporter on failure, through a mail channel `ops_smtp`).
8. In API Designer, create service `kpi_lookup` with a Python function endpoint `latest_kpis`
   from `api-services/kpi_lookup/endpoints/latest_kpis.py`; deploy it to an API node whose
   environment provides `DATABASE_URL`.

The same steps can be scripted with the `dataikuapi` client from these JSON files.

## Statistics

For one service, `x_t` is the number of incidents opened on day `t`, and the baseline `B_t` is
the 28 days `t-28 .. t-1` (the current day is excluded, so a spike cannot dampen its own score).
A score needs at least 7 observed days in `B_t`.

- **Rolling z-score** (published as `incident_zscore`): `z_t = (x_t - mean(B_t)) / s(B_t)`, with
  `s` the sample standard deviation (n - 1). When `s = 0` (a perfectly flat history) the score is
  undefined and stored as NULL: there is no scale to measure a deviation against.
- **Anomaly** (`is_anomaly`): `|z_t| >= 3` AND `x_t >= 5`. Under normality `|z| >= 3` happens
  about 0.27 % of the time; the volume floor keeps a quiet service going from 0 to 2 incidents
  from paging anyone.
- **Robust variant** (`ops_kpis.robust_rolling_zscore`, tested, not published):
  `z_t = (x_t - median(B_t)) / (1.4826 * MAD(B_t))` with `MAD = median(|x - median(B_t)|)`;
  1.4826 makes the MAD a consistent estimator of sigma for normal data. One past incident storm
  inflates mean and std enough to hide today's spike; median and MAD ignore it (see
  `tests/test_anomaly.py`).
- **MTTR**: mean of `resolved_at - opened_at` in minutes over incidents resolved that day; NULL
  when none was resolved.
- **p90 resolution time**: `percentile_cont(0.9)`, linear interpolation between order statistics
  (`ops_kpis.percentile_cont` mirrors it; the integration test reconciles both).
- **SLA breach rate**: incidents resolved that day after `sla_due_at` / incidents resolved that
  day; 0.0 when none was resolved (the column is non-null).
- **Change failure rate**: changes closed that day with `close_code` in (`unsuccessful`,
  `backed_out`) / changes closed that day (`state = 'closed'`; cancelled ones excluded); 0.0 when
  none closed.

Days are UTC calendar days. Rates are stored with their denominators (`resolved_count`,
`change_count`), so a period rate is `sum(rate * denominator) / sum(denominator)`, a ratio of
sums, never a mean of daily rates.

## Optimisation notes

- **Push down, then pull up only what is small.** Scanning, filtering, joining and aggregating the
  raw incidents happen in PostgreSQL; pandas receives one row per service and day (6 services x
  148 days ~ 900 rows for a 120-day run). Only what is awkward or unsafe in SQL stays in Python:
  robust statistics, guarded rates, rounding to the column scales, schema conformance.
- **The SQL twin of the baseline** (`baseline_mean_28d`, `baseline_stddev_28d`) shows the
  push-down alternative and is checked against the pandas computation
  (`test_sql_baseline_matches_the_pandas_rolling_baseline`). On very long histories, compute the
  z-score from those columns and drop the pandas rolling step.
- **Indexes used** (from the contract): `changes(service, closed_at)` for the changes window and
  the distinct service list (index-only scan); `incidents(service, opened_at)` when reading
  `ops.incidents` directly. The SQL file header has the measured plan and its caveats
  (PostgreSQL 16 has no skip scan; inlined `NOT MATERIALIZED` CTEs keep predicates indexable).
- **Partition by day** when volumes grow: partition `incidents_prepared`, `daily_service_base` and
  `daily_service_kpis` on the day (DSS time partitioning, DAY), have the scenario build
  `PREVIOUS_DAY` plus a short late-arrival window each morning instead of 120 days, and keep the
  full rebuild for backfills. The SQL predicates are half-open ranges on raw columns, so they
  prune partitions as written.
- **Idempotent writes**: upsert on `(day, service)` makes reruns and overlapping windows safe and
  keeps history outside the window.
- **One transaction per run**: the API never reads a partially rebuilt window, and a failed
  ERROR check publishes nothing.

## Tests

`uv run pytest -q` runs the unit tests (statistics with hand-computed expected values, schema of
the output, project files consistency, checks, CLI window). With `DATABASE_URL` set, the
integration tests create a scratch database, load `tests/fixtures/schema.sql` (a test copy of the
contract schema) and `tests/fixtures/synthetic_data.sql` (spike, quiet day, flat service,
change-only service, late resolution, failed changes), run the flow end to end and the API
endpoint, then drop the database. See `AGENTS.md` for the gate commands.
