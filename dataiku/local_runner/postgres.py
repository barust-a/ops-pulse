"""PostgreSQL access for the local runner and the `dataiku` shim (psycopg 3)."""

from collections.abc import Mapping, Sequence
from typing import Final, TypeAlias

import pandas as pd
import psycopg
from psycopg import sql
from psycopg.rows import TupleRow
from psycopg.types.numeric import FloatLoader

from local_runner.errors import FlowError

CONNECT_TIMEOUT_SECONDS: Final = 10

PgConnection: TypeAlias = psycopg.Connection[TupleRow]


def open_connection(database_url: str) -> PgConnection:
    """Connect with a timeout; numeric columns load as float, as DSS hands them to pandas."""
    connection = psycopg.connect(
        database_url,
        connect_timeout=CONNECT_TIMEOUT_SECONDS,
        application_name="ops-pulse-dataiku-runner",
    )
    connection.adapters.register_loader("numeric", FloatLoader)
    return connection


def read_frame(
    connection: PgConnection,
    query: sql.SQL | sql.Composed,
    params: Mapping[str, object] | None = None,
) -> pd.DataFrame:
    with connection.cursor() as cursor:
        cursor.execute(query, params)
        if cursor.description is None:
            message = "read_frame needs a query that returns rows"
            raise FlowError(message)
        columns = [column.name for column in cursor.description]
        return pd.DataFrame.from_records(cursor.fetchall(), columns=columns)


def primary_key_columns(connection: PgConnection, table: sql.Identifier) -> tuple[str, ...]:
    """Primary-key columns of `table`, in key order (empty when it has none)."""
    query = sql.SQL(
        """
        SELECT a.attname
        FROM pg_index AS i
        JOIN pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        WHERE i.indrelid = to_regclass(%(table)s) AND i.indisprimary
        ORDER BY array_position(i.indkey::smallint[], a.attnum)
        """
    )
    rows = connection.execute(query, {"table": table.as_string(connection)}).fetchall()
    return tuple(str(row[0]) for row in rows)


def upsert_rows(
    connection: PgConnection,
    *,
    table: sql.Identifier,
    columns: Sequence[str],
    key_columns: Sequence[str],
    rows: Sequence[Sequence[object]],
) -> None:
    """INSERT ... ON CONFLICT (key) DO UPDATE: re-running a window replaces exactly its rows."""
    updated = [column for column in columns if column not in key_columns]
    if not key_columns or not updated:
        message = f"upsert into {table.as_string(connection)} needs key and non-key columns"
        raise FlowError(message)
    statement = sql.SQL(
        "INSERT INTO {table} ({columns}) VALUES ({values}) "
        "ON CONFLICT ({keys}) DO UPDATE SET {assignments}"
    ).format(
        table=table,
        columns=sql.SQL(", ").join(map(sql.Identifier, columns)),
        values=sql.SQL(", ").join(sql.Placeholder() * len(columns)),
        keys=sql.SQL(", ").join(map(sql.Identifier, key_columns)),
        assignments=sql.SQL(", ").join(
            sql.SQL("{column} = EXCLUDED.{column}").format(column=sql.Identifier(column))
            for column in updated
        ),
    )
    with connection.cursor() as cursor:
        cursor.executemany(statement, rows)


def table_identifier(db_schema: str | None, table: str) -> sql.Identifier:
    """`schema.table`, or a bare `table` resolved by search_path (temp tables come first)."""
    return sql.Identifier(db_schema, table) if db_schema else sql.Identifier(table)
