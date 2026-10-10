"""daily_service_base (SQL recipe output) -> ops.daily_service_kpis rows."""

from datetime import date, datetime
from typing import Final

import pandas as pd

from ops_kpis.anomaly import flag_anomalies, rolling_zscore
from ops_kpis.errors import BaseFrameError
from ops_kpis.rates import guarded_rate
from ops_kpis.schema import conform_to_output_schema

BASE_COLUMNS: Final = (
    "day",
    "service",
    "incident_count",
    "resolved_count",
    "mttr_minutes",
    "p90_resolution_minutes",
    "sla_breach_count",
    "change_count",
    "failed_change_count",
)


def build_daily_kpis(base: pd.DataFrame, *, first_day: date, computed_at: datetime) -> pd.DataFrame:
    """Derive rates, z-scores and anomaly flags, and return the rows from `first_day` on.

    `base` holds one row per (day, service) with no calendar gap, starting 28 days before
    `first_day`: those earlier rows only feed the anomaly baseline and are not returned.
    `computed_at` must be timezone-aware.

    Raises:
        BaseFrameError: a base column is missing, or a service skips or repeats a day.
    """
    _require_columns(base)
    ordered = base.assign(day=pd.to_datetime(base["day"])).sort_values(
        ["service", "day"], ignore_index=True
    )
    _require_contiguous_days(ordered)

    counts = ordered["incident_count"].astype(float)
    zscores = counts.groupby(ordered["service"], sort=False).transform(rolling_zscore)
    kpis = ordered.assign(
        sla_breach_rate=guarded_rate(ordered["sla_breach_count"], ordered["resolved_count"]),
        change_failure_rate=guarded_rate(ordered["failed_change_count"], ordered["change_count"]),
        incident_zscore=zscores,
        is_anomaly=flag_anomalies(zscores, counts),
        computed_at=pd.Timestamp(computed_at).tz_convert("UTC"),
    )
    in_range = kpis.loc[kpis["day"] >= pd.Timestamp(first_day)]
    return conform_to_output_schema(in_range).reset_index(drop=True)


def _require_columns(base: pd.DataFrame) -> None:
    missing = [column for column in BASE_COLUMNS if column not in base.columns]
    if missing:
        message = f"daily_service_base lacks column(s) {missing}; expected {list(BASE_COLUMNS)}"
        raise BaseFrameError(message, offenders=missing)


def _require_contiguous_days(ordered: pd.DataFrame) -> None:
    steps = ordered.groupby("service", sort=False)["day"].diff().dropna()
    broken = steps.index[steps != pd.Timedelta(days=1)]
    services = sorted({str(service) for service in ordered.loc[broken, "service"]})
    if services:
        message = (
            f"daily_service_base skips or repeats days for service(s) {services}; "
            "the SQL recipe must emit exactly one row per calendar day and service"
        )
        raise BaseFrameError(message, offenders=services)
