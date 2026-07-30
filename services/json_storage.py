from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any


_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()


def read_json(path: Path) -> Any:
    with _lock_for(path):
        return json.loads(path.read_text(encoding="utf-8"))


def write_json_atomic(path: Path, value: Any) -> None:
    with _lock_for(path):
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=path.parent,
                prefix=f".{path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temp_file:
                json.dump(value, temp_file, indent=2)
                temp_file.flush()
                os.fsync(temp_file.fileno())
                temp_path = Path(temp_file.name)

            for attempt in range(50):
                try:
                    os.replace(temp_path, path)
                    temp_path = None
                    return
                except PermissionError:
                    if attempt == 49:
                        raise
                    time.sleep(0.01 * min(attempt + 1, 5))
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)


def _lock_for(path: Path) -> threading.RLock:
    key = str(path.resolve())
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.RLock())
