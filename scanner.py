from __future__ import annotations

from pathlib import Path
import os
import zipfile

from metadata import FileMetadata, file_type_from_path, sheet_number_from_filename, sheet_title_from_filename
from pdf_processor import process_pdf
from qa_rules import detect_drawing_type, detect_keywords
from storage import DB_PATH, get_indexed_signature, initialize_database, load_records, remove_stale_records, save_file_metadata


SUPPORTED_EXTENSIONS = {".pdf", ".dwg", ".ifc", ".zip"}
TEXT_CHUNK_SIZE = 1024 * 1024
MAX_TEXT_CHUNKS = 8


def scan_project_folder(root: Path) -> list[FileMetadata]:
    initialize_database(DB_PATH)
    root = root.resolve()
    index_project_folder(root, db_path=DB_PATH)
    return load_records(root, DB_PATH)


def index_project_folder(root: Path, progress_callback=None, db_path: Path = DB_PATH) -> None:
    initialize_database(db_path)
    root = root.resolve()
    total_files = count_supported_files(root)
    current_paths: set[str] = set()

    if progress_callback:
        progress_callback(total_files=total_files, scanned_files=0, indexed_files=0, skipped_files=0)

    # os.walk streams directory entries as it traverses the tree. That keeps the
    # scanner useful for large project folders without building a huge file list first.
    scanned_files = 0
    indexed_files = 0
    skipped_files = 0

    for folder, _, files in os.walk(root):
        for filename in files:
            path = Path(folder) / filename
            if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
                continue

            current_paths.add(str(path))
            scanned_files += 1

            if progress_callback:
                progress_callback(scanned_files=scanned_files, current_file=str(path))

            stat = path.stat()
            signature = (stat.st_size, stat.st_mtime_ns)
            indexed_signature = get_indexed_signature(path, db_path)

            # Incremental indexing is the main speed win for large projects:
            # unchanged files reuse their SQLite metadata instead of being parsed again.
            if indexed_signature == signature:
                skipped_files += 1
                if progress_callback:
                    progress_callback(skipped_files=skipped_files)
                continue

            record = scan_file(path)
            save_file_metadata(root, record, stat.st_mtime_ns, db_path)
            indexed_files += 1

            if progress_callback:
                progress_callback(indexed_files=indexed_files)

    stale_files_removed = remove_stale_records(root, current_paths, db_path)
    if progress_callback:
        progress_callback(stale_files_removed=stale_files_removed)


def count_supported_files(root: Path) -> int:
    total = 0

    # This first pass gives the UI a real progress denominator without keeping
    # thousands of paths in memory. The second pass performs the actual indexing.
    for _, _, files in os.walk(root):
        total += sum(1 for filename in files if Path(filename).suffix.lower() in SUPPORTED_EXTENSIONS)

    return total


def scan_file(path: Path) -> FileMetadata:
    if path.suffix.lower() == ".pdf":
        return process_pdf(path)

    if path.suffix.lower() == ".ifc":
        return process_ifc(path)

    if path.suffix.lower() == ".zip":
        return process_zip(path)

    return basic_file_metadata(path)


def basic_file_metadata(path: Path) -> FileMetadata:
    sheet_number = sheet_number_from_filename(path)
    sheet_title = sheet_title_from_filename(path, sheet_number)

    return FileMetadata(
        path=str(path),
        filename=path.name,
        file_size=path.stat().st_size,
        file_type=file_type_from_path(path),
        sheet_number=sheet_number,
        sheet_title=sheet_title,
        detected_keywords=detect_keywords(path.name),
        drawing_type=detect_drawing_type("", path.name),
    )


def process_ifc(path: Path) -> FileMetadata:
    sheet_number = sheet_number_from_filename(path)
    sheet_title = sheet_title_from_filename(path, sheet_number)
    detected_keywords: set[str] = set(detect_keywords(path.name))
    drawing_type = detect_drawing_type("", path.name)
    text_sample = []

    # IFC files are text-based and can be large. Read fixed-size chunks instead
    # of loading the whole model into RAM; the goal here is only lightweight indexing.
    with path.open("rb") as file:
        for _ in range(MAX_TEXT_CHUNKS):
            chunk = file.read(TEXT_CHUNK_SIZE)
            if not chunk:
                break

            chunk_text = chunk.decode("utf-8", errors="ignore")
            detected_keywords.update(detect_keywords(chunk_text))
            text_sample.append(chunk_text[:2000])

            if drawing_type == "Unknown":
                drawing_type = detect_drawing_type(chunk_text, path.name)

    return FileMetadata(
        path=str(path),
        filename=path.name,
        file_size=path.stat().st_size,
        file_type=file_type_from_path(path),
        sheet_number=sheet_number,
        sheet_title=sheet_title or find_ifc_name("\n".join(text_sample)),
        detected_keywords=sorted(detected_keywords),
        drawing_type=drawing_type,
    )


def process_zip(path: Path) -> FileMetadata:
    detected_keywords: set[str] = set(detect_keywords(path.name))
    drawing_type = detect_drawing_type("", path.name)

    # ZIP archives are indexed through their central directory. We inspect names
    # without extracting file contents, which keeps memory use predictable.
    try:
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                detected_keywords.update(detect_keywords(info.filename))
                if drawing_type == "Unknown":
                    drawing_type = detect_drawing_type("", info.filename)
    except zipfile.BadZipFile:
        detected_keywords.add("UNREADABLE ZIP")

    sheet_number = sheet_number_from_filename(path)

    return FileMetadata(
        path=str(path),
        filename=path.name,
        file_size=path.stat().st_size,
        file_type=file_type_from_path(path),
        sheet_number=sheet_number,
        sheet_title=sheet_title_from_filename(path, sheet_number),
        detected_keywords=sorted(detected_keywords),
        drawing_type=drawing_type,
    )


def find_ifc_name(text: str) -> str:
    for line in text.splitlines():
        if "FILE_NAME" in line.upper():
            return line.strip()[:120]

    return ""
