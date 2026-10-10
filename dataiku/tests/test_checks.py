"""Local evaluation of the DSS checks declared in project/metrics_checks.json."""

from datetime import date

import pandas as pd

from local_runner.checks import (
    CheckResult,
    FreshnessMaxAgeDays,
    NullRateMax,
    RowCountMin,
    evaluate_checks,
)

AS_OF = date(2026, 4, 1)


def kpis(days: list[str], zscores: list[float | None]) -> pd.DataFrame:
    return pd.DataFrame(
        {"day": pd.to_datetime(days), "incident_zscore": pd.array(zscores, dtype="Float64")}
    )


def test_an_empty_output_fails_the_row_count_check() -> None:
    check = RowCountMin(id="rows", type="row_count_min", min=1, severity="ERROR")

    results = evaluate_checks(kpis([], []), [check], as_of=AS_OF)

    assert results == [CheckResult(check_id="rows", outcome="ERROR", value=0.0)]


def test_a_null_rate_above_the_limit_reports_the_check_severity() -> None:
    check = NullRateMax(
        id="z", type="null_rate_max", column="incident_zscore", max=0.25, severity="WARNING"
    )

    results = evaluate_checks(kpis(["2026-03-30", "2026-03-31"], [None, 1.5]), [check], as_of=AS_OF)

    assert results == [CheckResult(check_id="z", outcome="WARNING", value=0.5)]


def test_a_null_rate_within_the_limit_is_ok() -> None:
    check = NullRateMax(
        id="z", type="null_rate_max", column="incident_zscore", max=0.5, severity="ERROR"
    )

    results = evaluate_checks(kpis(["2026-03-30", "2026-03-31"], [None, 1.5]), [check], as_of=AS_OF)

    assert results == [CheckResult(check_id="z", outcome="OK", value=0.5)]


def test_freshness_measures_days_between_the_latest_day_and_as_of() -> None:
    check = FreshnessMaxAgeDays(
        id="fresh", type="freshness_max_age_days", column="day", max_age_days=1, severity="ERROR"
    )

    fresh = evaluate_checks(kpis(["2026-03-31"], [1.0]), [check], as_of=AS_OF)
    stale = evaluate_checks(kpis(["2026-03-29"], [1.0]), [check], as_of=AS_OF)

    assert fresh == [CheckResult(check_id="fresh", outcome="OK", value=1.0)]
    assert stale == [CheckResult(check_id="fresh", outcome="ERROR", value=3.0)]


def test_freshness_of_an_empty_output_fails() -> None:
    check = FreshnessMaxAgeDays(
        id="fresh", type="freshness_max_age_days", column="day", max_age_days=1, severity="WARNING"
    )

    results = evaluate_checks(kpis([], []), [check], as_of=AS_OF)

    assert results == [CheckResult(check_id="fresh", outcome="WARNING", value=None)]
