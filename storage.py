from __future__ import annotations

from pathlib import Path
import json
import sqlite3

from metadata import FileMetadata


DB_PATH = Path("data") / "project_index.sqlite3"


def initialize_database(db_path: Path = DB_PATH) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS files (
                path TEXT PRIMARY KEY,
                root_path TEXT NOT NULL,
                filename TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                file_type TEXT NOT NULL,
                sheet_number TEXT NOT NULL,
                sheet_title TEXT NOT NULL,
                detected_keywords TEXT NOT NULL,
                drawing_type TEXT NOT NULL,
                modified_time_ns INTEGER NOT NULL,
                indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_files_root_path ON files(root_path)")


def get_indexed_signature(path: Path, db_path: Path = DB_PATH) -> tuple[int, int] | None:
    with sqlite3.connect(db_path) as connection:
        row = connection.execute(
            "SELECT file_size, modified_time_ns FROM files WHERE path = ?",
            (str(path),),
        ).fetchone()

    return tuple(row) if row else None


def save_file_metadata(root: Path, record: FileMetadata, modified_time_ns: int, db_path: Path = DB_PATH) -> None:
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """
            INSERT INTO files (
                path, root_path, filename, file_size, file_type, sheet_number,
                sheet_title, detected_keywords, drawing_type, modified_time_ns, indexed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(path) DO UPDATE SET
                root_path = excluded.root_path,
                filename = excluded.filename,
                file_size = excluded.file_size,
                file_type = excluded.file_type,
                sheet_number = excluded.sheet_number,
                sheet_title = excluded.sheet_title,
                detected_keywords = excluded.detected_keywords,
                drawing_type = excluded.drawing_type,
                modified_time_ns = excluded.modified_time_ns,
                indexed_at = CURRENT_TIMESTAMP
            """,
            (
                record.path,
                str(root),
                record.filename,
                record.file_size,
                record.file_type,
                record.sheet_number,
                record.sheet_title,
                json.dumps(record.detected_keywords or []),
                record.drawing_type,
                modified_time_ns,
            ),
        )


def load_records(root: Path, db_path: Path = DB_PATH) -> list[FileMetadata]:
    with sqlite3.connect(db_path) as connection:
        rows = connection.execute(
            """
            SELECT path, filename, file_size, file_type, sheet_number, sheet_title,
                   detected_keywords, drawing_type
            FROM files
            WHERE root_path = ?
            ORDER BY filename
            """,
            (str(root),),
        ).fetchall()

    return [
        FileMetadata(
            path=row[0],
            filename=row[1],
            file_size=row[2],
            file_type=row[3],
            sheet_number=row[4],
            sheet_title=row[5],
            detected_keywords=json.loads(row[6]),
            drawing_type=row[7],
        )
        for row in rows
    ]


def remove_stale_records(root: Path, current_paths: set[str], db_path: Path = DB_PATH) -> int:
    with sqlite3.connect(db_path) as connection:
        rows = connection.execute(
            "SELECT path FROM files WHERE root_path = ?",
            (str(root),),
        ).fetchall()

        stale_paths = [row[0] for row in rows if row[0] not in current_paths]
        if stale_paths:
            connection.executemany("DELETE FROM files WHERE path = ?", [(path,) for path in stale_paths])

    return len(stale_paths)
