"""Command-line window of `python -m local_runner.run_flow`."""

from datetime import date

import pytest

from local_runner.run_flow import FlowWindow, parse_window

TODAY = date(2026, 10, 10)


def test_default_window_is_the_last_120_days_including_today() -> None:
    assert parse_window([], today=TODAY) == FlowWindow(
        first_day=date(2026, 6, 13), last_day=date(2026, 10, 10)
    )


def test_explicit_dates_are_used_as_given() -> None:
    window = parse_window(["--from", "2026-03-01", "--to", "2026-03-31"], today=TODAY)

    assert window == FlowWindow(first_day=date(2026, 3, 1), last_day=date(2026, 3, 31))


def test_from_alone_runs_until_today() -> None:
    window = parse_window(["--from", "2026-10-01"], today=TODAY)

    assert window == FlowWindow(first_day=date(2026, 10, 1), last_day=TODAY)


def test_to_alone_keeps_a_120_day_window() -> None:
    window = parse_window(["--to", "2026-03-31"], today=TODAY)

    assert window == FlowWindow(first_day=date(2025, 12, 2), last_day=date(2026, 3, 31))


def test_a_reversed_window_is_a_usage_error() -> None:
    with pytest.raises(SystemExit) as exit_info:
        parse_window(["--from", "2026-04-01", "--to", "2026-03-01"], today=TODAY)

    assert exit_info.value.code == 2


def test_a_malformed_date_is_a_usage_error() -> None:
    with pytest.raises(SystemExit) as exit_info:
        parse_window(["--from", "01/03/2026"], today=TODAY)

    assert exit_info.value.code == 2
