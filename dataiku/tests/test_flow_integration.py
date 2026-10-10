"""End to end on PostgreSQL: fixture schema + synthetic data, the whole flow, the API endpoint.

Each test gets its own scratch database (created from DATABASE_URL, dropped afterwards), so the
database DATABASE_URL points at is never modified. Expected values come from
fixtures/synthetic_data.sql, whose header lists them.
"""

from __future__ import annotations

import importlib.util
import os
import runpy
import secrets
import sys
from collections.abc import Callable, Iterator
from datetime import UTC, date, datetime
from pathlib import Path

import pandas as pd
import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg.types.numeric import FloatLoader

import dataiku
from local_runner import PROJECT_DIR
from local_runner.errors import FlowError
from local_runner.postgres import open_connection, read_frame
from local_runner.project import DssProject
from local_runner.run_flow import FlowWindow, main, run_flow
from ops_kpis import mean_resolution_minutes, p90_resolution_minutes, rolling_zscore

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.environ.get("DATABASE_URL"),
        reason="needs PostgreSQL 16: set DATABASE_URL=postgres://user:password@host:port/db "
        "(a role allowed to CREATE DATABASE; see dataiku/AGENTS.md)",
    ),
]

FIXTURES = Path(__file__).parent / "fixtures"
ENDPOINT_FILE = PROJECT_DIR / "api-services" / "kpi_lookup" / "endpoints" / "latest_kpis.py"
WINDOW_ARGS = ["--from", "2026-03-01", "--to", "2026-03-31"]
WINDOW = FlowWindow(first_day=date(2026, 3, 1), last_day=date(2026, 3, 31))
RUN_AT = datetime(2026, 4, 1, 6, 0, tzinfo=UTC)


@pytest.fixture
def database_url(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    admin_url = os.environ["DATABASE_URL"]
    name = f"ops_pulse_dku_test_{os.getpid()}_{secrets.token_hex(4)}"
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    url = make_conninfo(admin_url, dbname=name)
    try:
        with psycopg.connect(url, autocommit=True) as connection:
            connection.execute((FIXTURES / "schema.sql").read_text(encoding="utf-8"))
            connection.execute((FIXTURES / "synthetic_data.sql").read_text(encoding="utf-8"))
        monkeypatch.setenv("DATABASE_URL", url)
        yield url
    finally:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


def run_main() -> int:
    return main(WINDOW_ARGS, clock=lambda: RUN_AT)


def published(url: str) -> pd.DataFrame:
    with open_connection(url) as connection:
        frame = read_frame(
            connection, sql.SQL("SELECT * FROM ops.daily_service_kpis ORDER BY service, day")
        )
    return frame.set_index(["service", "day"])


def kpi_row(url: str, service: str, day: str) -> dict[str, object]:
    """One published row as plain Python values (NULL -> None)."""
    with psycopg.connect(url, row_factory=dict_row) as connection:
        connection.adapters.register_loader("numeric", FloatLoader)
        row = connection.execute(
            "SELECT * FROM ops.daily_service_kpis WHERE service = %(service)s AND day = %(day)s",
            {"service": service, "day": date.fromisoformat(day)},
        ).fetchone()
    assert row is not None, (service, day)
    return row


def test_flow_publishes_one_row_per_day_and_service(database_url: str) -> None:
    assert run_main() == 0

    kpis = published(database_url)
    assert len(kpis) == 93  # payments, crm, identity x 31 days of March
    assert sorted(kpis.index.get_level_values("service").unique()) == [
        "crm",
        "identity",
        "payments",
    ]


def test_spike_day_is_scored_and_flagged(database_url: str) -> None:
    run_main()

    row = kpi_row(database_url, "payments", "2026-03-20")

    assert {
        name: value for name, value in row.items() if name not in {"day", "service", "computed_at"}
    } == {
        "incident_count": 12,
        "resolved_count": 12,
        "mttr_minutes": 65.0,
        "p90_resolution_minutes": 109.0,
        "sla_breach_rate": 0.5,
        "change_count": 0,
        "change_failure_rate": 0.0,
        "incident_zscore": 9.82,
        "is_anomaly": True,
    }


def test_the_spike_is_the_only_anomaly(database_url: str) -> None:
    run_main()

    anomalies = published(database_url).query("is_anomaly").index.tolist()

    assert anomalies == [("payments", date(2026, 3, 20))]


def test_a_day_without_incident_still_has_a_row(database_url: str) -> None:
    run_main()

    row = kpi_row(database_url, "payments", "2026-03-25")

    assert row["incident_count"] == 0
    assert row["resolved_count"] == 0
    assert row["mttr_minutes"] is None
    assert row["p90_resolution_minutes"] is None
    assert row["sla_breach_rate"] == 0.0
    assert row["is_anomaly"] is False


def test_an_incident_opened_before_the_window_counts_where_it_is_resolved(
    database_url: str,
) -> None:
    run_main()

    row = kpi_row(database_url, "payments", "2026-03-05")

    assert (row["incident_count"], row["resolved_count"]) == (3, 4)
    assert (row["mttr_minutes"], row["p90_resolution_minutes"]) == (28822.5, 80649.0)
    assert row["sla_breach_rate"] == 0.25


def test_change_failure_rate_counts_only_closed_changes(database_url: str) -> None:
    run_main()

    payments = kpi_row(database_url, "payments", "2026-03-12")
    crm = kpi_row(database_url, "crm", "2026-03-12")

    assert (payments["change_count"], payments["change_failure_rate"]) == (4, 0.5)
    assert (crm["change_count"], crm["change_failure_rate"]) == (1, 0.0)


def test_unresolved_incidents_count_as_opened_only(database_url: str) -> None:
    run_main()

    row = kpi_row(database_url, "payments", "2026-03-30")

    assert (row["incident_count"], row["resolved_count"]) == (2, 1)


def test_a_flat_history_gives_no_zscore(database_url: str) -> None:
    run_main()

    crm = published(database_url).loc["crm"]

    assert crm["incident_zscore"].isna().all()
    assert not crm["is_anomaly"].any()


def test_a_window_without_any_activity_publishes_zero_rows_per_day(database_url: str) -> None:
    assert main(["--from", "2026-06-01", "--to", "2026-06-30"], clock=lambda: RUN_AT) == 0

    row = kpi_row(database_url, "payments", "2026-06-15")

    assert (row["incident_count"], row["resolved_count"], row["mttr_minutes"]) == (0, 0, None)
    assert len(published(database_url)) == 90  # 3 services x 30 days


def test_rerunning_a_window_replaces_its_rows(database_url: str) -> None:
    run_main()
    first = published(database_url)

    assert main(WINDOW_ARGS, clock=lambda: datetime(2026, 4, 2, 6, 0, tzinfo=UTC)) == 0

    second = published(database_url)
    assert len(second) == len(first)
    pd.testing.assert_frame_equal(
        second.drop(columns="computed_at"), first.drop(columns="computed_at")
    )
    assert (second["computed_at"] > first["computed_at"]).all()


def test_checks_pass_with_a_zscore_coverage_warning(database_url: str) -> None:
    with open_connection(database_url) as connection:
        report = run_flow(
            connection, project=DssProject(PROJECT_DIR), window=WINDOW, today=RUN_AT.date()
        )

    outcomes = {result.check_id: result.outcome for result in report.checks}
    assert not report.failed()
    assert (report.rows_written, report.anomalies) == (93, 1)
    assert outcomes == {
        "row_count_positive": "OK",
        "incident_count_not_null": "OK",
        "sla_breach_rate_not_null": "OK",
        "change_failure_rate_not_null": "OK",
        "zscore_coverage": "WARNING",  # crm (flat) and identity (no incident) have no z-score
        "kpis_fresh": "OK",
    }


def test_an_error_check_rolls_the_run_back(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute("TRUNCATE ops.incidents, ops.changes")

    assert run_main() == 1

    assert published(database_url).empty


def test_python_dash_m_entry_point_runs_the_flow(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "argv", ["run_flow", *WINDOW_ARGS])
    # `python -m` executes a fresh module; drop the copy this test file imported.
    monkeypatch.delitem(sys.modules, "local_runner.run_flow")

    with pytest.raises(SystemExit) as exit_info:
        runpy.run_module("local_runner.run_flow", run_name="__main__", alter_sys=True)

    assert exit_info.value.code == 0
    assert len(published(database_url)) == 93


def test_sql_baseline_matches_the_pandas_rolling_baseline(database_url: str) -> None:
    with open_connection(database_url) as connection:
        run_flow(connection, project=DssProject(PROJECT_DIR), window=WINDOW, today=RUN_AT.date())
        base = read_frame(connection, sql.SQL("SELECT * FROM daily_service_base"))

    for _, rows in base.sort_values(["service", "day"]).groupby("service"):
        counts = rows["incident_count"].astype(float)
        std = rows["baseline_stddev_28d"].where(rows["baseline_stddev_28d"] > 0)
        sql_zscores = (counts - rows["baseline_mean_28d"]) / std
        pd.testing.assert_series_equal(
            rolling_zscore(counts), sql_zscores, check_names=False, atol=1e-9
        )


def test_sql_mttr_and_p90_reconcile_with_the_python_helpers(database_url: str) -> None:
    run_main()
    with open_connection(database_url) as connection:
        resolutions = read_frame(
            connection,
            sql.SQL(
                "SELECT service, (resolved_at AT TIME ZONE 'UTC')::date AS day, "
                "EXTRACT(EPOCH FROM resolved_at - opened_at) / 60 AS minutes FROM ops.incidents "
                "WHERE resolved_at >= '2026-03-01' AND resolved_at < '2026-04-01'"
            ),
        )
    minutes = resolutions.groupby(["service", "day"])["minutes"]

    expected = pd.DataFrame(
        {
            "mttr_minutes": minutes.apply(lambda group: mean_resolution_minutes(group.tolist())),
            "p90_resolution_minutes": minutes.apply(
                lambda group: p90_resolution_minutes(group.tolist())
            ),
        }
    )
    published_stats = published(database_url).loc[expected.index, list(expected.columns)]

    pd.testing.assert_frame_equal(published_stats, expected, check_dtype=False, atol=0.005)


def load_endpoint() -> Callable[[str], dict[str, str | int | float | bool | None]]:
    spec = importlib.util.spec_from_file_location("latest_kpis_endpoint", ENDPOINT_FILE)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    endpoint: Callable[[str], dict[str, str | int | float | bool | None]] = module.latest_kpis
    return endpoint


@pytest.mark.usefixtures("database_url")
def test_api_endpoint_returns_the_latest_kpis_of_a_service() -> None:
    run_main()

    kpis = load_endpoint()("payments")

    assert kpis["day"] == "2026-03-31"
    assert (kpis["service"], kpis["incident_count"], kpis["resolved_count"]) == ("payments", 3, 3)
    assert kpis["is_anomaly"] is False


@pytest.mark.usefixtures("database_url")
def test_api_endpoint_rejects_an_unknown_service() -> None:
    run_main()

    with pytest.raises(LookupError, match="mainframe"):
        load_endpoint()("mainframe")


def test_writing_a_frame_that_drifted_from_the_dataset_schema_is_refused(database_url: str) -> None:
    drifted = pd.DataFrame({"day": [date(2026, 3, 1)], "service": ["payments"]})

    with open_connection(database_url) as connection:
        context = dataiku.RecipeContext(
            connection=connection, project=DssProject(PROJECT_DIR), variables={}
        )
        with dataiku.recipe_context(context), pytest.raises(FlowError, match="declared schema"):
            dataiku.Dataset("daily_service_kpis").write_with_schema(drifted)
