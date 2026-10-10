"""Local evaluation of the checks declared in `project/metrics_checks.json`.

In DSS the engine evaluates dataset checks after a build; locally the runner does it on the rows of
the window it just built, before committing (an ERROR rolls the whole flow run back).
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from typing import Annotated, Literal

import pandas as pd
from pydantic import Field

from local_runner.project import DssProject, FrozenModel, load_model

Severity = Literal["WARNING", "ERROR"]
Outcome = Literal["OK", "WARNING", "ERROR"]


class RowCountMin(FrozenModel):
    id: str
    type: Literal["row_count_min"]
    min: int
    severity: Severity


class NullRateMax(FrozenModel):
    id: str
    type: Literal["null_rate_max"]
    column: str
    max: float
    severity: Severity


class FreshnessMaxAgeDays(FrozenModel):
    id: str
    type: Literal["freshness_max_age_days"]
    column: str
    max_age_days: int
    severity: Severity


Check = Annotated[RowCountMin | NullRateMax | FreshnessMaxAgeDays, Field(discriminator="type")]


class ChecksDefinition(FrozenModel):
    dataset: str
    checks: tuple[Check, ...]


@dataclass(frozen=True)
class CheckResult:
    """`value` is the measured metric: rows, null rate or age in days; None if unmeasurable."""

    check_id: str
    outcome: Outcome
    value: float | None


def load_checks(project: DssProject) -> ChecksDefinition:
    return load_model(project.checks_path(), ChecksDefinition)


def evaluate_checks(
    frame: pd.DataFrame, checks: Sequence[Check], *, as_of: date
) -> list[CheckResult]:
    return [_evaluate(frame, check, as_of=as_of) for check in checks]


def _evaluate(frame: pd.DataFrame, check: Check, *, as_of: date) -> CheckResult:
    match check:
        case RowCountMin():
            rows = float(len(frame))
            return _result(check.id, check.severity, value=rows, passed=rows >= check.min)
        case NullRateMax():
            null_rate = float(frame[check.column].isna().mean()) if len(frame) else 0.0
            return _result(check.id, check.severity, value=null_rate, passed=null_rate <= check.max)
        case FreshnessMaxAgeDays():
            if frame.empty:
                return CheckResult(check_id=check.id, outcome=check.severity, value=None)
            latest = pd.Timestamp(frame[check.column].max()).date()
            age_days = float((as_of - latest).days)
            return _result(
                check.id, check.severity, value=age_days, passed=age_days <= check.max_age_days
            )


def _result(check_id: str, severity: Severity, *, value: float, passed: bool) -> CheckResult:
    return CheckResult(check_id=check_id, outcome="OK" if passed else severity, value=value)
