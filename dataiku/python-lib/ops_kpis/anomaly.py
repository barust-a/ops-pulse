"""Rolling z-score anomaly detection on one service's daily incident counts.

Every function takes a contiguous daily series (one value per calendar day, in day order) and
compares each day with a trailing baseline that EXCLUDES the day itself, so a spike cannot dampen
its own score.

- Standard score: z_t = (x_t - mean(B_t)) / std(B_t), sample std (ddof = 1).
- Robust score:   z_t = (x_t - median(B_t)) / (1.4826 * MAD(B_t)), MAD = median(|x - median|).
  1.4826 makes the MAD a consistent estimator of sigma for normal data; median and MAD ignore up
  to half the window being outliers, so last week's incident storm does not mask today's.

B_t is the 28 days before t; fewer than 7 observed days, or a zero spread, leave z undefined (NaN):
a perfectly flat history gives no scale to measure a deviation against.
"""

# pandas-stubs makes Series generic, but at runtime Series is not subscriptable.
from __future__ import annotations

import numpy as np
import numpy.typing as npt
import pandas as pd

BASELINE_WINDOW_DAYS = 28
BASELINE_MIN_DAYS = 7
ZSCORE_THRESHOLD = 3.0
MIN_INCIDENTS_FOR_ANOMALY = 5
MAD_TO_SIGMA = 1.4826
# Rolling variance is computed incrementally: a flat window can leave ~1e-15 instead of 0.
SPREAD_EPSILON = 1e-9


def rolling_zscore(counts: pd.Series[float]) -> pd.Series[float]:
    """Standard z-score of each day against its trailing 28-day mean and std."""
    window = counts.rolling(window=BASELINE_WINDOW_DAYS, min_periods=BASELINE_MIN_DAYS)
    # The statistic at t-1 covers days t-28..t-1: shifting it excludes the current day.
    mean = window.mean().shift(1)
    std = window.std(ddof=1).shift(1)
    return (counts - mean) / std.where(std > SPREAD_EPSILON)


def robust_rolling_zscore(counts: pd.Series[float]) -> pd.Series[float]:
    """Robust z-score of each day against its trailing 28-day median and scaled MAD."""
    window = counts.rolling(window=BASELINE_WINDOW_DAYS, min_periods=BASELINE_MIN_DAYS)
    median = window.median().shift(1)
    scale = MAD_TO_SIGMA * window.apply(_median_absolute_deviation, raw=True).shift(1)
    return (counts - median) / scale.where(scale > SPREAD_EPSILON)


def flag_anomalies(zscores: pd.Series[float], counts: pd.Series[float]) -> pd.Series[bool]:
    """|z| >= 3 on a day with at least 5 incidents; an undefined z is never an anomaly.

    The volume floor keeps a quiet service going from 0 to 2 incidents from paging anyone.
    """
    return (zscores.abs() >= ZSCORE_THRESHOLD).fillna(value=False) & (
        counts >= MIN_INCIDENTS_FOR_ANOMALY
    )


def _median_absolute_deviation(window: npt.NDArray[np.float64]) -> float:
    return float(np.median(np.abs(window - np.median(window))))
