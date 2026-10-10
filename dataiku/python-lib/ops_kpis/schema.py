"""Shape of ops.daily_service_kpis, the table this project writes (see the Ops Pulse contract).

Column order, pandas dtypes and rounding follow the PostgreSQL definition:
numeric(10,2) durations, numeric(5,4) rates, numeric(6,3) z-score, int4 counts.
"""

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

import pandas as pd

OUTPUT_DTYPES: Final[Mapping[str, str]] = MappingProxyType(
    {
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
)
OUTPUT_COLUMNS: Final[tuple[str, ...]] = tuple(OUTPUT_DTYPES)

NUMERIC_SCALES: Final[Mapping[str, int]] = MappingProxyType(
    {
        "mttr_minutes": 2,
        "p90_resolution_minutes": 2,
        "sla_breach_rate": 4,
        "change_failure_rate": 4,
        "incident_zscore": 3,
    }
)
# numeric(6,3) holds at most 999.999; a near-zero baseline std can produce larger scores.
ZSCORE_LIMIT: Final = 999.999


def conform_to_output_schema(frame: pd.DataFrame) -> pd.DataFrame:
    """Select, clip, round and cast `frame` to exactly the ops.daily_service_kpis columns."""
    # Cast first: an all-NULL column read without schema typing is object dtype, which cannot round.
    conformed = frame.loc[:, list(OUTPUT_COLUMNS)].astype(dict(OUTPUT_DTYPES))
    conformed["incident_zscore"] = conformed["incident_zscore"].clip(-ZSCORE_LIMIT, ZSCORE_LIMIT)
    for column, scale in NUMERIC_SCALES.items():
        conformed[column] = conformed[column].round(scale)
    return conformed
