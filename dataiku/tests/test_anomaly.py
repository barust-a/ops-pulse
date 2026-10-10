"""Rolling z-score anomaly detection on daily incident counts."""

# pandas-stubs makes Series generic, but at runtime Series is not subscriptable.
from __future__ import annotations

import math

import pandas as pd
import pytest

from ops_kpis import flag_anomalies, robust_rolling_zscore, rolling_zscore

# 28 days alternating 1 and 3 incidents: mean 2, sample std sqrt(28/27) = 1.0183501544.
ALTERNATING_28 = [1.0, 3.0] * 14
SPIKE_ZSCORE = 10 / math.sqrt(28 / 27)  # (12 - 2) / 1.0183501544 = 9.8198
ROBUST_SPIKE_ZSCORE = 10 / 1.4826  # median 2, MAD 1 -> (12 - 2) / (1.4826 * 1) = 6.7449


def daily(values: list[float]) -> pd.Series[float]:
    return pd.Series(values, index=pd.date_range("2026-01-01", periods=len(values), freq="D"))


def test_spike_after_a_stable_month_gets_a_high_zscore() -> None:
    counts = daily([*ALTERNATING_28, 12.0])

    zscores = rolling_zscore(counts)

    assert zscores.iloc[-1] == pytest.approx(SPIKE_ZSCORE, rel=1e-6)


def test_baseline_is_the_trailing_28_days_excluding_the_current_day() -> None:
    # The 100 on day 0 is 29 days before the spike, so it must not enter the baseline.
    counts = daily([100.0, *ALTERNATING_28, 12.0])

    zscores = rolling_zscore(counts)

    assert zscores.iloc[-1] == pytest.approx(SPIKE_ZSCORE, rel=1e-6)


def test_zscore_needs_seven_days_of_history() -> None:
    counts = daily([1.0, 3.0, 1.0, 3.0, 1.0, 3.0, 20.0, 20.0])

    zscores = rolling_zscore(counts)

    assert zscores.iloc[:7].isna().all()
    assert not math.isnan(zscores.iloc[7])


def test_zero_variance_history_gives_no_zscore() -> None:
    counts = daily([4.0] * 10 + [9.0])

    zscores = rolling_zscore(counts)

    assert zscores.isna().all()


def test_zero_variance_history_is_never_flagged() -> None:
    counts = daily([4.0] * 10 + [9.0])

    flags = flag_anomalies(rolling_zscore(counts), counts)

    assert not flags.any()


def test_spike_with_at_least_five_incidents_is_flagged() -> None:
    counts = daily([*ALTERNATING_28, 12.0])

    flags = flag_anomalies(rolling_zscore(counts), counts)

    assert flags.tolist() == [False] * 28 + [True]


@pytest.mark.parametrize(
    ("last_count", "expected_flag"),
    [
        pytest.param(4.0, False, id="four-incidents-below-volume-floor"),
        pytest.param(5.0, True, id="five-incidents"),
    ],
)
def test_flag_needs_five_incidents_even_with_a_high_zscore(
    *, last_count: float, expected_flag: bool
) -> None:
    # History alternating 0 and 1: mean 0.5, std 0.509; a 4 already scores z = 6.87.
    counts = daily([0.0, 1.0] * 14 + [last_count])

    flags = flag_anomalies(rolling_zscore(counts), counts)

    assert bool(flags.iloc[-1]) is expected_flag


def test_robust_zscore_uses_median_and_scaled_mad() -> None:
    counts = daily([*ALTERNATING_28, 12.0])

    zscores = robust_rolling_zscore(counts)

    assert zscores.iloc[-1] == pytest.approx(ROBUST_SPIKE_ZSCORE, rel=1e-6)


def test_robust_zscore_still_flags_a_spike_when_history_holds_an_outlier() -> None:
    # 27 alternating days then a 60: median stays 2 and MAD 1, while the mean/std baseline
    # inflates to 4.04 +/- 11.0 and hides the spike (z = 0.72).
    counts = daily([*ALTERNATING_28[:27], 60.0, 12.0])

    standard = rolling_zscore(counts)
    robust = robust_rolling_zscore(counts)

    assert abs(standard.iloc[-1]) < 3
    assert robust.iloc[-1] == pytest.approx(ROBUST_SPIKE_ZSCORE, rel=1e-6)


def test_robust_zscore_with_zero_mad_is_undefined() -> None:
    counts = daily([4.0] * 10 + [9.0])

    zscores = robust_rolling_zscore(counts)

    assert zscores.isna().all()
