"""Rate guards and resolution-time statistics (MTTR, p90).

The SQL recipe keeps numerators and denominators (breached / resolved, failed / closed changes)
and the rates are derived here: a ratio of sums re-aggregates correctly over a week or a service
group, a mean of daily ratios does not.
"""

# pandas-stubs makes Series generic, but at runtime Series is not subscriptable.
from __future__ import annotations

from collections.abc import Sequence
from statistics import fmean

import pandas as pd

P90 = 0.9


def guarded_rate(numerators: pd.Series[int], denominators: pd.Series[int]) -> pd.Series[float]:
    """numerator / denominator, and 0.0 where nothing could breach or fail (denominator 0).

    0.0 rather than null because the contract types both rates as non-null numbers.
    """
    return (numerators / denominators.where(denominators > 0)).fillna(0.0)


def percentile_cont(values: Sequence[float], fraction: float) -> float:
    """Continuous percentile with linear interpolation, as PostgreSQL's percentile_cont."""
    if not 0.0 <= fraction <= 1.0:
        message = f"fraction={fraction} must be within [0, 1]"
        raise ValueError(message)
    if not values:
        message = "percentile_cont of an empty sequence is undefined"
        raise ValueError(message)
    ordered = sorted(values)
    position = fraction * (len(ordered) - 1)
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (position - lower) * (ordered[upper] - ordered[lower])


def mean_resolution_minutes(resolution_minutes: Sequence[float]) -> float | None:
    """MTTR in minutes; None when nothing was resolved (the column is nullable)."""
    return fmean(resolution_minutes) if resolution_minutes else None


def p90_resolution_minutes(resolution_minutes: Sequence[float]) -> float | None:
    """90th percentile of resolution minutes; None when nothing was resolved."""
    return percentile_cont(resolution_minutes, P90) if resolution_minutes else None
