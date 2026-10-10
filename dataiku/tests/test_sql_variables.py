"""DSS ${variable} expansions become bound psycopg parameters in the local runner."""

from datetime import date

import pytest

from local_runner.errors import FlowError
from local_runner.sql_recipe import bind_dss_variables


def test_quoted_and_bare_variables_become_named_placeholders() -> None:
    bound = bind_dss_variables(
        "SELECT CAST('${kpi_from_date}' AS date) - ${kpi_baseline_days}",
        {"kpi_from_date": date(2026, 3, 1), "kpi_baseline_days": 28},
    )

    assert bound.text == "SELECT CAST(%(kpi_from_date)s AS date) - %(kpi_baseline_days)s"
    assert bound.params == {"kpi_from_date": date(2026, 3, 1), "kpi_baseline_days": 28}


def test_literal_percent_signs_are_escaped_for_psycopg() -> None:
    bound = bind_dss_variables("SELECT 'a%b' WHERE x > ${n}", {"n": 1})

    assert bound.text == "SELECT 'a%%b' WHERE x > %(n)s"


def test_only_the_variables_used_are_bound() -> None:
    bound = bind_dss_variables("SELECT ${n}", {"n": 1, "unused": 2})

    assert bound.params == {"n": 1}


def test_an_undefined_variable_is_refused() -> None:
    with pytest.raises(FlowError, match="kpi_to_date"):
        bind_dss_variables("SELECT '${kpi_to_date}'", {})
