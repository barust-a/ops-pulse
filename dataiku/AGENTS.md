# AGENTS.md — dataiku/ (Dataiku DSS project + local runner)

Loaded on top of the root `AGENTS.md`. Python 3.11, managed with `uv` (never pip/venv by hand).

## Gates (run from `dataiku/`, all must be green)

```sh
uv sync --locked                                   # .venv from uv.lock
uv run ruff format --check .                       # format
uv run ruff check .                                # lint (base: ../docs/guides/python/ruff.toml)
uv run mypy                                        # strict type-check
PYTHONPATH=python-lib:local_runner/shim:. uv run lint-imports   # "ops_kpis stays pure"
uv run pytest -q                                   # unit tests; integration tests skip without DB
```

Integration tests (`tests/test_flow_integration.py`) need PostgreSQL 16 and are skipped with a
reason when `DATABASE_URL` is unset. They create and drop their own scratch database, so the role
needs `CREATEDB`; they never touch the database `DATABASE_URL` names. Disposable server:

```sh
docker run -d --rm --name ops-pulse-dku-test -e POSTGRES_USER=ops_pulse \
  -e POSTGRES_PASSWORD=ops_pulse -e POSTGRES_DB=ops_pulse -p 55433:5432 postgres:16-alpine
DATABASE_URL=postgres://ops_pulse:ops_pulse@localhost:55433/ops_pulse uv run pytest -q
docker stop ops-pulse-dku-test
```

Run the flow (the command the container runs):

```sh
cd dataiku && DATABASE_URL=postgres://... python -m local_runner.run_flow [--from YYYY-MM-DD] [--to YYYY-MM-DD]
```

Default window: the 120 days ending today (Europe/Paris). Exit 0 ok (warnings allowed), 1 failed
run or ERROR check (rolled back), 2 usage error.

## Layout and ownership

| Path                         | What                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `project/`                   | DSS project export: params, variables, datasets, recipes, scenario, checks, API service |
| `project/recipes/*.sql/.py`  | Recipe code, runs unchanged in DSS and locally               |
| `python-lib/ops_kpis/`       | DSS project library: pure pandas logic (stats, rates, output schema) |
| `local_runner/`              | Runs the flow outside DSS: project loader, recipe executors, checks, CLI |
| `local_runner/shim/dataiku/` | Local stand-in for the `dataiku` package (`Dataset`, `get_custom_variables`) |
| `tests/`                     | pytest; `tests/fixtures/schema.sql` is a TEST COPY of the contract schema |

- The schema of `ops.*` is owned by `docs/specs/2026-10-10-ops-pulse-contract.md` and the API's
  `db/migrations/`. Change the contract first; then `fixtures/schema.sql`,
  `datasets/daily_service_kpis.json` and `ops_kpis/schema.py` together (tests compare them).
- `requirements.txt` is generated, never edited: after changing `pyproject.toml` dependencies run
  `uv lock && uv export --no-dev --no-hashes --no-header --no-annotate --format requirements-txt -o requirements.txt`
  (`tests/test_requirements.py` fails when they drift). Pins are exact (`==`).

## Rules specific to this folder

- **Logic lives in `ops_kpis`.** Recipes only read inputs, call the library, write outputs.
  `ops_kpis` imports pandas/numpy only — no psycopg, pydantic, `dataiku` or `local_runner`
  (import-linter contract). Write the library test first, with literal expected values derived
  by hand (comment the arithmetic next to the literal).
- **Push down what SQL does well** (filtering, joins, counts, `percentile_cont`, windows) into
  `compute_daily_service_base.sql`; keep numerators and denominators there and divide in Python
  with `guarded_rate`, so rates re-aggregate as ratios of sums.
- **SQL recipe:** PostgreSQL 16 dialect; DSS variables are written `'${name}'` (string) or
  `${name}` (number); the runner binds them as parameters, never pastes text. Keep predicates
  sargable (half-open ranges on raw columns). When the query shape changes, re-run `EXPLAIN` on
  the fixture and update the plan notes at the top of the file.
- **Baseline constants** (28-day window, 7-day minimum) are defined in `ops_kpis/anomaly.py`; the
  SQL twin reads them as `${kpi_baseline_days}` / `${kpi_baseline_min_days}` and
  `project/variables.json` mirrors them (tested).
- **DSS JSON files** are boundaries: `local_runner/project.py` and `checks.py` validate them with
  pydantic; add a field to the model before relying on it.
- **Python 3.11:** no `type X = ...` or `def f[T]()` syntax. Modules annotating `pd.Series[...]`
  start with `from __future__ import annotations` (Series is not subscriptable at runtime).
- **No escape hatches:** no `Any`, `cast`, `# type: ignore`, `# noqa`. pandas-stubs is strict
  about `isna(object)` and MultiIndex `.loc` tuples: narrow explicitly or restructure.
- **Errors:** library errors subclass `OpsKpisError` and a builtin (`ValueError`, ...); runner
  errors subclass `LocalRunnerError`. `run_flow.main` is the only place that catches broadly
  (`psycopg.Error`, `LocalRunnerError`) and logs once.
- The output table is written by upsert on its primary key (`(day, service)`): a rerun of a window
  replaces exactly that window. Never truncate `ops.daily_service_kpis`.

## Reference

- `README.md`: flow diagram, file-to-DSS mapping, DSS import steps, statistics, optimisation notes.
- `../docs/guides/python/README.md`: Python typing, testing and tooling rules in depth.
