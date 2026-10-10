"""Errors raised by the ops_kpis project library."""

from collections.abc import Sequence


class OpsKpisError(Exception):
    """Base class of every deliberate ops_kpis error."""


class BaseFrameError(OpsKpisError, ValueError):
    """The daily_service_base frame breaks its contract (missing columns, calendar gaps).

    `offenders` names the missing columns or the services whose calendar has gaps.
    """

    def __init__(self, message: str, *, offenders: Sequence[str]) -> None:
        super().__init__(message)
        self.offenders = tuple(offenders)
