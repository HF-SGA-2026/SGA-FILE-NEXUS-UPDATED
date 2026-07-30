from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import threading

from scanner import index_project_folder
from storage import DB_PATH


@dataclass
class ScanProgress:
    root: str
    total_files: int = 0
    scanned_files: int = 0
    indexed_files: int = 0
    skipped_files: int = 0
    stale_files_removed: int = 0
    current_file: str = ""
    status: str = "queued"
    error: str = ""
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "root": self.root,
                "total_files": self.total_files,
                "scanned_files": self.scanned_files,
                "indexed_files": self.indexed_files,
                "skipped_files": self.skipped_files,
                "stale_files_removed": self.stale_files_removed,
                "current_file": self.current_file,
                "status": self.status,
                "error": self.error,
            }

    def update(self, **values: object) -> None:
        with self.lock:
            for key, value in values.items():
                setattr(self, key, value)


def start_background_scan(root: Path, db_path: Path = DB_PATH) -> ScanProgress:
    progress = ScanProgress(root=str(root))
    thread = threading.Thread(
        target=run_scan,
        args=(root, progress, db_path),
        daemon=True,
    )
    thread.start()
    return progress


def run_scan(root: Path, progress: ScanProgress, db_path: Path) -> None:
    try:
        progress.update(status="running")
        index_project_folder(root, progress.update, db_path)
        progress.update(status="complete", current_file="")
    except Exception as error:
        progress.update(status="failed", error=str(error), current_file="")
