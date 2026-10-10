"""Run the Ops Pulse DSS flow outside Dataiku DSS, against PostgreSQL.

DSS puts the project library (`python-lib/`) on every recipe's import path and provides the
`dataiku` package; importing this package does the same with `python-lib/` and the local `dataiku`
shim (`local_runner/shim/`), so recipes run unchanged.
"""

import sys
from pathlib import Path
from typing import Final

DATAIKU_DIR: Final = Path(__file__).resolve().parent.parent
PROJECT_DIR: Final = DATAIKU_DIR / "project"


def _put_dss_paths_on_sys_path() -> None:
    for path in (DATAIKU_DIR / "python-lib", DATAIKU_DIR / "local_runner" / "shim"):
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))


_put_dss_paths_on_sys_path()
