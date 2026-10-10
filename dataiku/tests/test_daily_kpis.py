"""build_daily_kpis turns the SQL base dataset into rows of ops.daily_service_kpis."""

from datetime import UTC, date, datetime

import pandas as pd
import pytest

from ops_kpis import BaseFrameError, OpsKpisError, build_daily_kpis

COMPUTED_AT = datetime(2026, 4, 1, 6, 0, tzinfo=UTC)


def base_frame(
    counts: list[int], *, service: str = "payments", start: str = "2026-03-01"
) -> pd.DataFrame:
    """One service's contiguous base rows: no resolution, no change unless a test sets them."""
    return pd.DataFrame(
        {
            "day": pd.date_range(start, periods=len(counts), freq="D"),
            "service": service,
            "incident_count": counts,
            "resolved_count": 0,
            "mttr_minutes": float("nan"),
            "p90_resolution_minutes": float("nan"),
            "sla_breach_count": 0,
            "change_count": 0,
            "failed_change_count": 0,
        }
    )


def test_output_has_the_columns_and_dtypes_of_ops_daily_service_kpis() -> None:
    kpis = build_daily_kpis(base_frame([1, 2]), first_day=date(2026, 3, 1), computed_at=COMPUTED_AT)

    assert kpis.dtypes.astype(str).to_dict() == {
        "day": "datetime64[ns]",
        "service": "string",
        "incident_count": "int32",
        "resolved_count": "int32",
        "mttr_minutes": "Float64",
        "p90_resolution_minutes": "Float64",
        "sla_breach_rate": "float64",
        "change_count": "int32",
        "change_failure_rate": "float64",
        "incident_zscore": "Float64",
        "is_anomaly": "bool",
        "computed_at": "datetime64[ns, UTC]",
    }


def test_rows_before_first_day_are_history_only() -> None:
    base = base_frame([1, 2, 3, 4], start="2026-02-27")

    kpis = build_daily_kpis(base, first_day=date(2026, 3, 1), computed_at=COMPUTED_AT)

    assert kpis["day"].dt.date.tolist() == [date(2026, 3, 1), date(2026, 3, 2)]
    assert kpis["incident_count"].tolist() == [3, 4]


def test_rates_and_durations_are_rounded_to_the_numeric_scales() -> None:
    base = base_frame([3])
    base["resolved_count"] = 3
    base["sla_breach_count"] = 1
    base["mttr_minutes"] = 12.3456
    base["p90_resolution_minutes"] = 20.0049
    base["change_count"] = 3
    base["failed_change_count"] = 2

    row = build_daily_kpis(base, first_day=date(2026, 3, 1), computed_at=COMPUTED_AT).iloc[0]

    assert row["mttr_minutes"] == 12.35
    assert row["p90_resolution_minutes"] == 20.0
    assert row["sla_breach_rate"] == 0.3333
    assert row["change_failure_rate"] == 0.6667


def test_days_without_resolution_or_change_have_zero_rates_and_null_durations() -> None:
    kpis = build_daily_kpis(base_frame([0]), first_day=date(2026, 3, 1), computed_at=COMPUTED_AT)

    row = kpis.iloc[0]
    assert row["sla_breach_rate"] == 0.0
    assert row["change_failure_rate"] == 0.0
    assert pd.isna(row["mttr_minutes"])
    assert pd.isna(row["p90_resolution_minutes"])


def test_spike_is_scored_and_flagged_per_service() -> None:
    payments = base_frame([1, 3] * 14 + [12], start="2026-02-01")
    crm = base_frame([2] * 29, service="crm", start="2026-02-01")

    kpis = build_daily_kpis(
        pd.concat([crm, payments], ignore_index=True),
        first_day=date(2026, 3, 1),
        computed_at=COMPUTED_AT,
    )

    by_service = kpis.set_index("service")
    assert by_service.loc["payments", "incident_zscore"] == 9.82
    assert bool(by_service.loc["payments", "is_anomaly"]) is True
    assert pd.isna(by_service.loc["crm", "incident_zscore"])
    assert bool(by_service.loc["crm", "is_anomaly"]) is False


def test_extreme_zscores_are_clipped_to_numeric_6_3() -> None:
    kpis = build_daily_kpis(
        base_frame([10] * 27 + [11, 1000], start="2026-02-01"),
        first_day=date(2026, 3, 1),
        computed_at=COMPUTED_AT,
    )

    assert kpis["incident_zscore"].tolist() == [999.999]


def test_computed_at_is_stamped_on_every_row() -> None:
    kpis = build_daily_kpis(base_frame([1, 2]), first_day=date(2026, 3, 1), computed_at=COMPUTED_AT)

    assert kpis["computed_at"].tolist() == [pd.Timestamp(COMPUTED_AT)] * 2


def test_a_missing_day_in_the_calendar_is_refused() -> None:
    base = base_frame([1, 2, 3]).drop(index=1)

    with pytest.raises(BaseFrameError, match="payments"):
        build_daily_kpis(base, first_day=date(2026, 3, 1), computed_at=COMPUTED_AT)


def test_a_missing_input_column_is_refused() -> None:
    base = base_frame([1]).drop(columns=["failed_change_count"])

    with pytest.raises(BaseFrameError, match="failed_change_count"):
        build_daily_kpis(base, first_day=date(2026, 3, 1), computed_at=COMPUTED_AT)


def test_errors_keep_their_builtin_base() -> None:
    assert issubclass(BaseFrameError, OpsKpisError)
    assert issubclass(BaseFrameError, ValueError)


def test_a_window_without_any_resolution_still_conforms() -> None:
    # A reader without schema typing hands all-NULL columns over as object dtype full of None.
    base = base_frame([0, 0])
    base["mttr_minutes"] = pd.Series([None, None], dtype=object)
    base["p90_resolution_minutes"] = pd.Series([None, None], dtype=object)

    kpis = build_daily_kpis(base, first_day=date(2026, 3, 1), computed_at=COMPUTED_AT)

    assert kpis["mttr_minutes"].isna().all()
    assert str(kpis["mttr_minutes"].dtype) == "Float64"
