"""Ops Pulse DSS project library: pure, typed KPI and anomaly logic used by the recipes.

DSS puts `python-lib/` on the path of every recipe of the project; the local runner does the same.
"""

from ops_kpis.anomaly import (
    BASELINE_MIN_DAYS,
    BASELINE_WINDOW_DAYS,
    flag_anomalies,
    robust_rolling_zscore,
    rolling_zscore,
)
from ops_kpis.daily_kpis import BASE_COLUMNS, build_daily_kpis
from ops_kpis.errors import BaseFrameError, OpsKpisError
from ops_kpis.rates import (
    guarded_rate,
    mean_resolution_minutes,
    p90_resolution_minutes,
    percentile_cont,
)
from ops_kpis.schema import OUTPUT_COLUMNS, OUTPUT_DTYPES, conform_to_output_schema

__all__ = [
    "BASELINE_MIN_DAYS",
    "BASELINE_WINDOW_DAYS",
    "BASE_COLUMNS",
    "OUTPUT_COLUMNS",
    "OUTPUT_DTYPES",
    "BaseFrameError",
    "OpsKpisError",
    "build_daily_kpis",
    "conform_to_output_schema",
    "flag_anomalies",
    "guarded_rate",
    "mean_resolution_minutes",
    "p90_resolution_minutes",
    "percentile_cont",
    "robust_rolling_zscore",
    "rolling_zscore",
]
