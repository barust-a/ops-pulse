"""Run the Ops Pulse DSS flow locally against PostgreSQL.

    cd dataiku && DATABASE_URL=postgres://... python -m local_runner.run_flow [--from D] [--to D]

Recipes run in flow order (sync -> SQL -> Python) inside ONE transaction: intermediate datasets
are temp tables, the Python recipe upserts ops.daily_service_kpis, then the declared checks run on
the rebuilt window. Any ERROR check, or any failure, rolls everything back, so the API never reads
a half-built or failing window. Re-running a window is idempotent.

Exit codes: 0 success (warnings allowed), 1 failed run or ERROR check, 2 usage error.
"""

import argparse
import logging
import os
import runpy
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Final, assert_never
from zoneinfo import ZoneInfo

import pandas as pd
import psycopg
from psycopg import sql

import dataiku
from local_runner import PROJECT_DIR
from local_runner.checks import CheckResult, evaluate_checks, load_checks
from local_runner.errors import LocalRunnerError
from local_runner.postgres import PgConnection, open_connection, read_frame, table_identifier
from local_runner.project import DatasetDefinition, DssProject, Recipe
from local_runner.sql_recipe import run_sql_query_recipe
from local_runner.sync_recipe import run_sync_recipe
from ops_kpis import BASELINE_MIN_DAYS, BASELINE_WINDOW_DAYS

logger = logging.getLogger(__name__)

DEFAULT_WINDOW_DAYS: Final = 120
SCHEDULE_TIMEZONE: Final = ZoneInfo("Europe/Paris")


@dataclass(frozen=True)
class FlowWindow:
    """Inclusive range of days whose KPIs are (re)built."""

    first_day: date
    last_day: date


@dataclass(frozen=True)
class FlowReport:
    rows_written: int
    anomalies: int
    checks: list[CheckResult]

    def failed(self) -> bool:
        return any(check.outcome == "ERROR" for check in self.checks)


def parse_window(argv: Sequence[str], *, today: date) -> FlowWindow:
    """--from / --to (YYYY-MM-DD); by default the 120 days ending today."""
    parser = _argument_parser()
    arguments = parser.parse_args(argv)
    last_day: date = arguments.to_day or today
    first_day: date = arguments.from_day or last_day - timedelta(days=DEFAULT_WINDOW_DAYS - 1)
    if first_day > last_day:
        parser.error(f"--from {first_day} is after --to {last_day}")
    return FlowWindow(first_day=first_day, last_day=last_day)


def run_flow(
    connection: PgConnection, *, project: DssProject, window: FlowWindow, today: date
) -> FlowReport:
    """Run every recipe in flow order, then the output checks; the caller commits or rolls back."""
    variables: dict[str, object] = {
        "kpi_from_date": window.first_day,
        "kpi_to_date": window.last_day,
        "kpi_baseline_days": BASELINE_WINDOW_DAYS,
        "kpi_baseline_min_days": BASELINE_MIN_DAYS,
    }
    for recipe in project.flow_order():
        _run_recipe(connection, project=project, recipe=recipe, variables=variables)

    checks = load_checks(project)
    built = _read_window(connection, project.dataset(checks.dataset), window)
    report = FlowReport(
        rows_written=len(built),
        anomalies=int(built["is_anomaly"].sum()),
        checks=evaluate_checks(built, checks.checks, as_of=today),
    )
    for result in report.checks:
        log = logger.info if result.outcome == "OK" else logger.warning
        log("check %s: %s (value=%s)", result.check_id, result.outcome, result.value)
    return report


def main(argv: Sequence[str] | None = None, *, clock: Callable[[], datetime] | None = None) -> int:
    """CLI entry point; `clock` (tz-aware now) is injectable for tests."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    now = clock() if clock else datetime.now(tz=SCHEDULE_TIMEZONE)
    window = parse_window(sys.argv[1:] if argv is None else argv, today=now.date())
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        _argument_parser().error("DATABASE_URL is not set (postgres://user:password@host/db)")
    logger.info("building KPIs from %s to %s", window.first_day, window.last_day)
    try:
        with open_connection(database_url) as connection:
            report = run_flow(
                connection, project=DssProject(PROJECT_DIR), window=window, today=now.date()
            )
            if report.failed():
                connection.rollback()
                logger.error("an ERROR check failed: rolled back, nothing was published")
                return 1
    except (psycopg.Error, LocalRunnerError):
        logger.exception("flow run failed: rolled back, nothing was published")
        return 1
    logger.info("published %s rows, %s anomalies", report.rows_written, report.anomalies)
    return 0


def _run_recipe(
    connection: PgConnection,
    *,
    project: DssProject,
    recipe: Recipe,
    variables: Mapping[str, object],
) -> None:
    kind = recipe.definition.type
    match kind:
        case "sync":
            rows = run_sync_recipe(
                connection,
                source=project.dataset(recipe.single_input()),
                target=project.dataset(recipe.single_output()),
            )
            logger.info("recipe %s (sync): %s rows copied", recipe.name, rows)
        case "sql_query":
            output = project.dataset(recipe.single_output())
            rows = run_sql_query_recipe(
                connection,
                code=recipe.code(),
                output_table=table_identifier(output.params.db_schema, output.params.table),
                variables=variables,
            )
            logger.info("recipe %s (sql_query): %s rows materialised", recipe.name, rows)
        case "python":
            context = dataiku.RecipeContext(
                connection=connection,
                project=project,
                variables={name: _dss_text(value) for name, value in variables.items()},
            )
            with dataiku.recipe_context(context):
                runpy.run_path(str(recipe.code_path()), run_name="__main__")
            logger.info("recipe %s (python) done", recipe.name)
        case _:
            assert_never(kind)


def _read_window(
    connection: PgConnection, dataset: DatasetDefinition, window: FlowWindow
) -> pd.DataFrame:
    """The rows of `dataset` for the days just rebuilt, as written (uncommitted) by this run."""
    query = sql.SQL(
        "SELECT {columns} FROM {table} WHERE day BETWEEN %(first)s AND %(last)s"
    ).format(
        columns=sql.SQL(", ").join(map(sql.Identifier, dataset.column_names())),
        table=table_identifier(dataset.params.db_schema, dataset.params.table),
    )
    return read_frame(connection, query, {"first": window.first_day, "last": window.last_day})


def _dss_text(value: object) -> str:
    """DSS variables are strings: dates as YYYY-MM-DD."""
    return value.isoformat() if isinstance(value, date) else str(value)


def _argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m local_runner.run_flow",
        description="Run the Ops Pulse Dataiku flow locally and upsert ops.daily_service_kpis.",
    )
    parser.add_argument("--from", dest="from_day", type=date.fromisoformat, metavar="YYYY-MM-DD")
    parser.add_argument("--to", dest="to_day", type=date.fromisoformat, metavar="YYYY-MM-DD")
    return parser


if __name__ == "__main__":
    sys.exit(main())
