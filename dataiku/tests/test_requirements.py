"""requirements.txt (used by the container image) pins what pyproject.toml declares."""

import tomllib

from local_runner import DATAIKU_DIR


def test_every_runtime_dependency_is_pinned_identically_in_requirements_txt() -> None:
    pyproject = tomllib.loads((DATAIKU_DIR / "pyproject.toml").read_text(encoding="utf-8"))
    requirements = (DATAIKU_DIR / "requirements.txt").read_text(encoding="utf-8").splitlines()
    pinned = {line.split(";")[0].strip() for line in requirements}

    declared = {
        dependency.replace("[binary]", "") for dependency in pyproject["project"]["dependencies"]
    }

    assert declared <= pinned
