from __future__ import annotations

import shutil
import zipfile
from pathlib import Path
from typing import Iterable
from uuid import uuid4

from backend.pdf_processor import extract_pdf_metadata
from database.models import DocumentMetadata
from database.store import DB_PATH, UPLOADS_DIR, complete_scan_job, create_scan_job, save_records
from reference_library.library import find_similar_references


def scan_pdf_paths(
    pdf_paths: Iterable[Path],
    *,
    job_id: str,
    root_path: Path,
    project_type: str = "",
    phase: str = "",
    client: str = "",
    building_type: str = "",
    force_ocr: bool = False,
) -> list[DocumentMetadata]:
    records: list[DocumentMetadata] = []
    for pdf_path in sorted(pdf_paths):
        record = extract_pdf_metadata(
            pdf_path,
            project_type=project_type,
            phase=phase,
            client=client,
            building_type=building_type,
            force_ocr=force_ocr,
        )
        record.reference_matches = {record.filename: find_similar_references(record)}
        records.append(record)
    save_records(root_path, records, DB_PATH, job_id)
    complete_scan_job(job_id, DB_PATH)
    return records


def scan_project_folder_to_db(root: Path, db_path: Path = DB_PATH, job_id: str | None = None, **metadata: str) -> list[DocumentMetadata]:
    actual_job = job_id or f"scan-{uuid4().hex[:10]}"
    create_scan_job(actual_job, root, db_path)
    return scan_pdf_paths(root.rglob("*.pdf"), job_id=actual_job, root_path=root, **metadata)


def stage_uploaded_files(uploaded_files: list, run_name: str) -> Path:
    target_root = UPLOADS_DIR / run_name
    target_root.mkdir(parents=True, exist_ok=True)
    for uploaded in uploaded_files:
        safe_name = Path(uploaded.name).name
        target = target_root / safe_name
        target.write_bytes(uploaded.getbuffer())
        if target.suffix.lower() == ".zip":
            extract_dir = target_root / target.stem
            extract_dir.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(target) as archive:
                for member in archive.infolist():
                    member_path = Path(member.filename)
                    if member.is_dir() or member_path.is_absolute() or ".." in member_path.parts:
                        continue
                    archive.extract(member, extract_dir)
    return target_root


def clear_upload_run(run_name: str) -> None:
    target_root = UPLOADS_DIR / run_name
    if target_root.exists() and UPLOADS_DIR in target_root.resolve().parents:
        shutil.rmtree(target_root)
