"""Errors raised by the local runner."""


class LocalRunnerError(Exception):
    """Base class of every deliberate local runner error."""


class ProjectDefinitionError(LocalRunnerError, ValueError):
    """A file of the DSS project is missing or does not match its expected shape."""


class FlowError(LocalRunnerError, RuntimeError):
    """A recipe could not run: undefined variable, schema drift, missing primary key."""
