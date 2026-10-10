"""DSS Python recipe: daily_service_base -> daily_service_kpis.

All logic lives in the project library (python-lib/ops_kpis), unit-tested outside DSS; the recipe
only reads, delegates and writes, so it runs unchanged in DSS and in the local runner.
"""

from datetime import UTC, date, datetime

import dataiku
from ops_kpis import build_daily_kpis

variables = dataiku.get_custom_variables()
base = dataiku.Dataset("daily_service_base").get_dataframe()

kpis = build_daily_kpis(
    base,
    first_day=date.fromisoformat(variables["kpi_from_date"]),
    computed_at=datetime.now(tz=UTC),
)

dataiku.Dataset("daily_service_kpis").write_with_schema(kpis)
