"""Sync recipes: in-database copy of the output dataset's columns from the input dataset."""

from psycopg import sql

from local_runner.postgres import PgConnection, table_identifier
from local_runner.project import DatasetDefinition


def run_sync_recipe(
    connection: PgConnection, *, source: DatasetDefinition, target: DatasetDefinition
) -> int:
    """Copy `source` into a temp table named like `target`; returns the rows copied.

    Like a DSS sync between two datasets of the same connection, the copy runs in the database
    (INSERT ... SELECT) and never streams rows through Python.
    """
    statement = sql.SQL(
        "CREATE TEMP TABLE {target} ON COMMIT DROP AS SELECT {columns} FROM {source}"
    )
    with connection.cursor() as cursor:
        cursor.execute(
            statement.format(
                target=table_identifier(target.params.db_schema, target.params.table),
                columns=sql.SQL(", ").join(map(sql.Identifier, target.column_names())),
                source=table_identifier(source.params.db_schema, source.params.table),
            )
        )
        return cursor.rowcount
