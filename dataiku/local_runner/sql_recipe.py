"""SQL query recipes: DSS variable binding and in-database materialisation."""

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

from psycopg import ClientCursor, sql

from local_runner.errors import FlowError
from local_runner.postgres import PgConnection

# DSS expands ${name} as text; a quoted '${name}' is a string literal in the recipe.
_DSS_VARIABLE: Final = re.compile(
    r"'\$\{(?P<quoted>[A-Za-z_][A-Za-z0-9_]*)\}'|\$\{(?P<bare>[A-Za-z_][A-Za-z0-9_]*)\}"
)


@dataclass(frozen=True)
class BoundQuery:
    text: str
    params: dict[str, object]


def bind_dss_variables(sql_text: str, variables: Mapping[str, object]) -> BoundQuery:
    """Replace `${name}` and `'${name}'` with psycopg `%(name)s` placeholders bound to values.

    Values are bound, never pasted into the text, so a variable cannot inject SQL.
    """
    params: dict[str, object] = {}

    def placeholder(match: re.Match[str]) -> str:
        name = match["quoted"] or match["bare"]
        if name not in variables:
            message = f"SQL recipe uses ${{{name}}}, which is not a defined project variable"
            raise FlowError(message)
        params[name] = variables[name]
        return f"%({name})s"

    text = _DSS_VARIABLE.sub(placeholder, sql_text.replace("%", "%%"))
    return BoundQuery(text=text, params=params)


def run_sql_query_recipe(
    connection: PgConnection,
    *,
    code: str,
    output_table: sql.Identifier,
    variables: Mapping[str, object],
) -> int:
    """Materialise the recipe's SELECT into a temp table named like its output dataset.

    Returns the number of rows written. A client-side cursor inlines the bound values, which
    PostgreSQL requires in utility statements (CREATE TABLE AS) and window frame offsets.
    """
    bound = bind_dss_variables(code, variables)
    statement = sql.SQL("CREATE TEMP TABLE {table} ON COMMIT DROP AS {query}").format(
        table=output_table, query=sql.SQL(bound.text)
    )
    with ClientCursor(connection) as cursor:
        cursor.execute(statement, bound.params)
        return cursor.rowcount
