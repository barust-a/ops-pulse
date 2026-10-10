"""Rate guards and resolution-time statistics."""

from collections.abc import Callable, Sequence

import pandas as pd
import pytest

from ops_kpis import guarded_rate, mean_resolution_minutes, p90_resolution_minutes, percentile_cont


def test_rate_is_numerator_over_denominator() -> None:
    rates = guarded_rate(pd.Series([1, 2]), pd.Series([4, 2]))

    assert rates.tolist() == [0.25, 1.0]


def test_rate_with_zero_denominator_is_zero_not_null() -> None:
    # ops.daily_service_kpis.sla_breach_rate / change_failure_rate are non-null in the contract.
    rates = guarded_rate(pd.Series([0]), pd.Series([0]))

    assert rates.tolist() == [0.0]


def test_percentile_cont_interpolates_like_postgres() -> None:
    # position = 0.9 * (5 - 1) = 3.6 -> 40 + 0.6 * (50 - 40)
    assert percentile_cont([50.0, 10.0, 40.0, 20.0, 30.0], 0.9) == pytest.approx(46.0)


def test_percentile_cont_of_one_value_is_that_value() -> None:
    assert percentile_cont([7.0], 0.9) == 7.0


def test_percentile_cont_rejects_a_fraction_outside_zero_one() -> None:
    with pytest.raises(ValueError, match="fraction"):
        percentile_cont([1.0], 1.5)


def test_mttr_is_the_mean_resolution_time() -> None:
    assert mean_resolution_minutes([30.0, 30.0, 30.0, 115200.0]) == pytest.approx(28822.5)


def test_p90_resolution_time_matches_percentile_cont() -> None:
    assert p90_resolution_minutes([30.0, 30.0, 30.0, 115200.0]) == pytest.approx(80649.0)


@pytest.mark.parametrize("statistic", [mean_resolution_minutes, p90_resolution_minutes])
def test_resolution_statistics_of_no_resolved_incident_are_none(
    *, statistic: Callable[[Sequence[float]], float | None]
) -> None:
    assert statistic([]) is None
