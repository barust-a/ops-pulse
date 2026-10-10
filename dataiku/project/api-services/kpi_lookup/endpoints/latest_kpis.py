"""DSS API node Python function endpoint `latest_kpis` (service kpi_lookup).

The API node calls `latest_kpis(**query)` for each request and returns its result as JSON. It reads
PostgreSQL directly (DATABASE_URL in the API node's environment): API nodes do not see the
design node's datasets.
"""

import os
from datetime import date, datetime
from typing import Final

import psycopg
from psycopg.rows import dict_row
from psycopg.types.numeric import FloatLoader

CONNECT_TIMEOUT_SECONDS: Final = 5
# The primary key (day, service) is walked backwards from the latest day: every day holds one row
# per service, so the first match is found within a handful of index entries.
LATEST_KPIS_QUERY: Final = """
    SELECT day, service, incident_count, resolved_count, mttr_minutes, p90_resolution_minutes,
           sla_breach_rate, change_count, change_failure_rate, incident_zscore, is_anomaly,
           computed_at
    FROM ops.daily_service_kpis
    WHERE service = %(service)s
    ORDER BY day DESC
    LIMIT 1
"""

JsonScalar = str | int | float | bool | None


def latest_kpis(service: str) -> dict[str, JsonScalar]:
    """Latest KPIs of `service`, dates as ISO 8601 strings.

    Raises:
        ValueError: `service` is blank.
        LookupError: no KPI row exists for `service` (the API node answers with an error).
    """
    if not service.strip():
        message = "service must be a non-empty service name, e.g. 'payments'"
        raise ValueError(message)
    with psycopg.connect(
        os.environ["DATABASE_URL"], connect_timeout=CONNECT_TIMEOUT_SECONDS, row_factory=dict_row
    ) as connection:
        connection.adapters.register_loader("numeric", FloatLoader)
        row = connection.execute(LATEST_KPIS_QUERY, {"service": service}).fetchone()
    if row is None:
        message = f"no KPIs computed for service {service!r}"
        raise LookupError(message)
    return {name: _json_scalar(value) for name, value in row.items()}


def _json_scalar(value: object) -> JsonScalar:
    if isinstance(value, datetime | date):
        return value.isoformat()
    if value is None or isinstance(value, str | int | float | bool):
        return value
    message = f"unexpected {type(value).__name__} value in ops.daily_service_kpis"
    raise TypeError(message)
