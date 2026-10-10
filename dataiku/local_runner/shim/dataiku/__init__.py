"""Local stand-in for the `dataiku` package that DSS provides to recipes.

It implements the subset this project's recipes use, with the same names and shapes:
`dataiku.Dataset(name).get_dataframe()`, `.write_with_schema(df)` and
`dataiku.get_custom_variables()`. Datasets resolve through `project/datasets/<name>.json` to
PostgreSQL tables of the connection the runner opened.

Writes into a table with a primary key are upserts on that key. DSS would rebuild the written
partitions of a dataset partitioned by day; upserting (day, service) rows has the same effect and
keeps the history outside the rebuilt window, which a plain overwrite would drop.
"""

import math
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

import pandas as pd
from psycopg import sql

from local_runner.errors import FlowError
from local_runner.postgres import (
    PgConnection,
    primary_key_columns,
    read_frame,
    table_identifier,
    upsert_rows,
)
from local_runner.project import DatasetDefinition, DssColumn, DssProject

__all__ = ["Dataset", "RecipeContext", "get_custom_variables", "recipe_context"]

_DATE_TYPES = frozenset({"date", "dateonly"})


@dataclass(frozen=True)
class RecipeContext:
    """What DSS injects into a running recipe: its project, connection and variables."""

    connection: PgConnection
    project: DssProject
    variables: Mapping[str, str]


# DSS sets the running recipe's context in the process; a ContextVar scopes it to one run.
_CONTEXT: ContextVar[RecipeContext] = ContextVar("dataiku_recipe_context")


@contextmanager
def recipe_context(context: RecipeContext) -> Iterator[None]:
    token = _CONTEXT.set(context)
    try:
        yield
    finally:
        _CONTEXT.reset(token)


def get_custom_variables() -> dict[str, str]:
    """Project variables, as strings, as in DSS."""
    return dict(_current_context().variables)


class Dataset:
    """A dataset of the current project, looked up by name."""

    def __init__(self, name: str) -> None:
        self.name = name
        self._definition: DatasetDefinition = _current_context().project.dataset(name)

    def get_dataframe(self) -> pd.DataFrame:
        """All rows, with the dataset's schema columns; dates as datetime64, doubles as float64."""
        columns = self._definition.dss_schema.columns
        query = sql.SQL("SELECT {columns} FROM {table}").format(
            columns=sql.SQL(", ").join(sql.Identifier(column.name) for column in columns),
            table=self._table(),
        )
        frame = read_frame(_current_context().connection, query)
        for column in columns:
            if column.type in _DATE_TYPES:
                frame[column.name] = pd.to_datetime(frame[column.name])
            elif column.type == "double":
                # An all-NULL column would otherwise come back as object dtype full of None.
                frame[column.name] = frame[column.name].astype("float64")
        return frame

    def write_with_schema(self, df: pd.DataFrame) -> None:
        """Upsert `df` into the dataset's table; its columns must equal the declared schema."""
        expected = self._definition.column_names()
        if list(df.columns) != expected:
            message = (
                f"dataset {self.name}: frame columns {list(df.columns)} differ from the "
                f"declared schema {expected}; update project/datasets/{self.name}.json first"
            )
            raise FlowError(message)
        connection = _current_context().connection
        table = self._table()
        key_columns = primary_key_columns(connection, table)
        if not key_columns:
            message = f"dataset {self.name}: table {table.as_string(connection)} has no primary key"
            raise FlowError(message)
        upsert_rows(
            connection,
            table=table,
            columns=expected,
            key_columns=key_columns,
            rows=_database_rows(df, self._definition.dss_schema.columns),
        )

    def _table(self) -> sql.Identifier:
        return table_identifier(self._definition.params.db_schema, self._definition.params.table)


def _current_context() -> RecipeContext:
    try:
        return _CONTEXT.get()
    except LookupError as error:
        message = "the dataiku shim is used outside local_runner's recipe_context()"
        raise FlowError(message) from error


def _database_rows(frame: pd.DataFrame, columns: tuple[DssColumn, ...]) -> list[tuple[object, ...]]:
    """Plain Python values for psycopg: NA -> None, numpy scalars -> int/float/bool, dates."""
    values = [
        [_database_value(value, column) for value in frame[column.name].tolist()]
        for column in columns
    ]
    return list(zip(*values, strict=True))


def _database_value(value: object, column: DssColumn) -> object:
    if value is None or value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if column.type == "dateonly" and isinstance(value, pd.Timestamp):
        return value.date()
    return value
