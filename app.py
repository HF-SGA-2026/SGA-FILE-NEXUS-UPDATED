from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

import fitz
import pandas as pd
import streamlit as st


APP_DIR = Path(__file__).resolve().parent
DATA_DIR = APP_DIR / "data"
DB_PATH = DATA_DIR / "qaqc_scan_cache.sqlite3"
HASH_CHUNK_SIZE = 1024 * 1024

PresenceStatus = Literal["Present", "Missing", "Not Detected"]

SCANNER_VERSION = "presence-check-qaqc-v2"

SHEET_NUMBER_RE = re.compile(
    r"\b(?:CS|G|A|AD|I|LS|C|S|M|P|E|EP|FP|FA|T|MEP|FS|SP)[- ]?\d{1,4}(?:\.\d+)?[A-Z]?\b",
    re.IGNORECASE,
)
LOOSE_SHEET_NUMBER_RE = re.compile(r"\b[A-Z]{1,4}[- ]?\d{2,4}(?:\.\d+)?[A-Z]?\b", re.IGNORECASE)
DATE_RE = re.compile(
    r"\b(?:"
    r"\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|"
    r"\d{4}[/-]\d{1,2}[/-]\d{1,2}|"
    r"(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)[A-Z]*\.?\s+\d{1,2},?\s+\d{4}|"
    r"\d{1,2}\s+(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)[A-Z]*\.?\s+\d{4}"
    r")\b",
    re.IGNORECASE,
)
SEAL_RE = re.compile(
    r"\b(?:PROFESSIONAL\s+SEAL|SEAL|STAMP|SIGNED|SIGNATURE|ARCHITECT|ENGINEER|"
    r"REGISTERED|REGISTRATION|LICENSE|LIC\.?|TBAE|NCARB|AIA|P\.?\s*E\.?|R\.?\s*A\.?)\b"
    r"|\b(?:REG\.?|LICENSE|LIC\.?|NO\.|#)\s*[A-Z-]*\d{3,}\b",
    re.IGNORECASE,
)
SHEET_INDEX_RE = re.compile(
    r"\b(?:SHEET\s+INDEX|DRAWING\s+INDEX|INDEX\s+OF\s+DRAWINGS|SHEET\s+LIST|LIST\s+OF\s+DRAWINGS|DRAWING\s+LIST)\b",
    re.IGNORECASE,
)
PROJECT_NAME_RE = re.compile(
    r"\b(?:PROJECT\s+NAME|PROJECT\s+TITLE|PROJECT\s*:|OWNER\s*:|CLIENT\s*:|JOB\s+NAME)\b",
    re.IGNORECASE,
)
TITLE_LABEL_RE = re.compile(r"\b(?:SHEET\s+TITLE|DRAWING\s+TITLE|SHEET\s+NAME|DRAWING\s+NAME)\b", re.IGNORECASE)
DATE_LABEL_RE = re.compile(r"\b(?:DATE|ISSUE\s+DATE|REVISION\s+DATE|PERMIT\s+DATE|ISSUED)\b", re.IGNORECASE)

TITLE_STOPWORDS = re.compile(
    r"\b(?:PROJECT|OWNER|CLIENT|ARCHITECT|ENGINEER|CONSULTANT|DRAWN|CHECKED|DATE|SCALE|"
    r"REVISION|SHEET|NUMBER|NO\.?|TITLE|ISSUE|ISSUED|SEAL|STAMP|LICENSE|COPYRIGHT)\b",
    re.IGNORECASE,
)


st.set_page_config(page_title="Construction Document QA/QC", page_icon="QC", layout="wide")


def initialize_database() -> None:
    """Create the local SQLite cache used to skip unchanged PDFs."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS pdf_scans (
                path TEXT PRIMARY KEY,
                file_name TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                modified_ns INTEGER NOT NULL,
                modified_date TEXT NOT NULL,
                file_hash TEXT NOT NULL,
                page_count INTEGER NOT NULL,
                status TEXT NOT NULL,
                error TEXT NOT NULL,
                page_text_json TEXT NOT NULL,
                scanner_version TEXT NOT NULL,
                scanned_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_pdf_scans_changed
            ON pdf_scans(path, file_size, modified_ns, scanner_version);
            """
        )


def format_bytes(size: int) -> str:
    value = float(size)
    for unit in ["B", "KB", "MB", "GB"]:
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{size} B"


def format_modified(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d %H:%M:%S")


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(HASH_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cached_scan(path: Path, stat: Any) -> dict[str, Any] | None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            """
            SELECT *
            FROM pdf_scans
            WHERE path = ?
              AND file_size = ?
              AND modified_ns = ?
              AND scanner_version = ?
            """,
            (str(path), stat.st_size, stat.st_mtime_ns, SCANNER_VERSION),
        ).fetchone()

    if row is None:
        return None

    return row_to_record(row, cached=True)


def row_to_record(row: sqlite3.Row, cached: bool = False) -> dict[str, Any]:
    return {
        "file_name": row["file_name"],
        "path": row["path"],
        "page_count": row["page_count"],
        "file_size": row["file_size"],
        "file_size_display": format_bytes(row["file_size"]),
        "modified_date": row["modified_date"],
        "file_hash": row["file_hash"],
        "status": "Cached" if cached else row["status"],
        "error": row["error"],
        "page_text": json.loads(row["page_text_json"]),
    }


def save_scan(record: dict[str, Any], stat: Any) -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO pdf_scans (
                path, file_name, file_size, modified_ns, modified_date, file_hash,
                page_count, status, error, page_text_json, scanner_version, scanned_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                file_name = excluded.file_name,
                file_size = excluded.file_size,
                modified_ns = excluded.modified_ns,
                modified_date = excluded.modified_date,
                file_hash = excluded.file_hash,
                page_count = excluded.page_count,
                status = excluded.status,
                error = excluded.error,
                page_text_json = excluded.page_text_json,
                scanner_version = excluded.scanner_version,
                scanned_at = excluded.scanned_at
            """,
            (
                record["path"],
                record["file_name"],
                record["file_size"],
                stat.st_mtime_ns,
                record["modified_date"],
                record["file_hash"],
                record["page_count"],
                record["status"],
                record["error"],
                json.dumps(record["page_text"]),
                SCANNER_VERSION,
                datetime.now().isoformat(timespec="seconds"),
            ),
        )


def scan_pdf(path: Path) -> dict[str, Any]:
    stat = path.stat()
    cached = cached_scan(path, stat)
    if cached is not None:
        return cached

    record = {
        "file_name": path.name,
        "path": str(path),
        "page_count": 0,
        "file_size": stat.st_size,
        "file_size_display": format_bytes(stat.st_size),
        "modified_date": format_modified(stat.st_mtime),
        "file_hash": hash_file(path),
        "status": "Scanned",
        "error": "",
        "page_text": [],
    }

    try:
        with fitz.open(path) as document:
            record["page_count"] = document.page_count
            for index, page in enumerate(document, start=1):
                try:
                    text = page.get_text("text") or ""
                except Exception as exc:  # PDF text extraction can fail on damaged pages.
                    text = ""
                    record["error"] = f"Page {index} text extraction issue: {exc}"
                title_block_text = extract_title_block_text(page)
                record["page_text"].append(
                    {
                        "page": index,
                        "text": text[:20000],
                        "title_block_text": title_block_text[:8000],
                        "visual_seal_signal": has_visual_seal_signal(page),
                    }
                )
    except Exception as exc:
        record["status"] = "Error"
        record["error"] = str(exc)

    save_scan(record, stat)
    return record


def find_pdfs(folder: Path) -> list[Path]:
    return sorted(path for path in folder.rglob("*.pdf") if path.is_file())


def has_pattern(text: str, patterns: list[str]) -> bool:
    return any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns)


def extract_title_block_text(page: fitz.Page) -> str:
    """Sample common title-block areas only; this stays fast and avoids OCR."""
    rect = page.rect
    clips = [
        fitz.Rect(rect.x0 + rect.width * 0.52, rect.y0 + rect.height * 0.58, rect.x1, rect.y1),
        fitz.Rect(rect.x0, rect.y0 + rect.height * 0.72, rect.x1, rect.y1),
        fitz.Rect(rect.x0 + rect.width * 0.68, rect.y0, rect.x1, rect.y1),
    ]
    parts: list[str] = []
    for clip in clips:
        try:
            parts.append(page.get_text("text", clip=clip) or "")
        except Exception:
            continue
    return "\n".join(parts)


def has_visual_seal_signal(page: fitz.Page) -> bool:
    """Cheap visual hint for stamp/seal areas; it is intentionally not validation."""
    rect = page.rect
    seal_area = fitz.Rect(rect.x0 + rect.width * 0.58, rect.y0 + rect.height * 0.52, rect.x1, rect.y1)
    try:
        drawings = [drawing for drawing in page.get_drawings() if fitz.Rect(drawing["rect"]).intersects(seal_area)]
    except Exception:
        drawings = []
    try:
        image_count = len(page.get_images(full=False))
    except Exception:
        image_count = 0
    return len(drawings) >= 18 or image_count >= 2


def normalized_text(*parts: str) -> str:
    return re.sub(r"\s+", " ", "\n".join(part for part in parts if part)).strip()


def status_from_match(text_available: bool, present: bool) -> PresenceStatus:
    if present:
        return "Present"
    return "Missing" if text_available else "Not Detected"


def detect_sheet_number(text: str) -> str:
    match = SHEET_NUMBER_RE.search(text) or LOOSE_SHEET_NUMBER_RE.search(text)
    return re.sub(r"\s+", "", match.group(0).upper()) if match else ""


def detect_sheet_title(text: str, sheet_number: str) -> str:
    if TITLE_LABEL_RE.search(text):
        label_match = TITLE_LABEL_RE.search(text)
        if label_match:
            after_label = text[label_match.end() : label_match.end() + 120]
            for line in clean_lines(after_label):
                candidate = clean_title_candidate(line, sheet_number)
                if candidate:
                    return candidate

    lines = clean_lines(text)
    for index, line in enumerate(lines):
        if sheet_number and sheet_number.replace("-", "") in re.sub(r"[^A-Za-z0-9.]", "", line).upper():
            for nearby in lines[index + 1 : index + 4]:
                candidate = clean_title_candidate(nearby, sheet_number)
                if candidate:
                    return candidate

    candidates = [clean_title_candidate(line, sheet_number) for line in lines]
    candidates = [candidate for candidate in candidates if candidate]
    return max(candidates, key=len) if candidates else ""


def clean_lines(text: str) -> list[str]:
    return [re.sub(r"\s+", " ", line).strip(" :-\t") for line in text.splitlines() if line.strip()]


def clean_title_candidate(line: str, sheet_number: str) -> str:
    candidate = line
    if sheet_number:
        candidate = re.sub(rf"\b{re.escape(sheet_number)}\b", "", candidate, flags=re.IGNORECASE)
    candidate = candidate.strip(" :-\t")
    if len(candidate) < 4 or len(candidate) > 90:
        return ""
    if TITLE_STOPWORDS.fullmatch(candidate) or DATE_RE.fullmatch(candidate) or LOOSE_SHEET_NUMBER_RE.fullmatch(candidate):
        return ""
    if sum(char.isalpha() for char in candidate) < 4:
        return ""
    return candidate.upper()


def detect_project_name(text: str) -> str:
    if PROJECT_NAME_RE.search(text):
        match = PROJECT_NAME_RE.search(text)
        after_label = text[match.end() : match.end() + 160] if match else ""
        for line in clean_lines(after_label):
            candidate = clean_title_candidate(line, "")
            if candidate and "PROJECT" not in candidate:
                return candidate
        return "Project label found"

    for line in clean_lines(text)[:24]:
        candidate = clean_title_candidate(line, "")
        if candidate and any(word in candidate for word in ["BUILDING", "CENTER", "OFFICE", "SCHOOL", "BANK", "RENOVATION"]):
            return candidate
    return ""


def run_presence_checks(records: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    document_rows: list[dict[str, Any]] = []
    sheet_rows: list[dict[str, Any]] = []

    for record in records:
        pages = record["page_text"]
        raw_front_matter_text = "\n".join(page.get("text", "") for page in pages[:5])
        combined_text = normalized_text(*(page.get("text", "") for page in pages))
        front_matter_text = normalized_text(raw_front_matter_text)
        text_available = bool(combined_text)
        seal_present = bool(SEAL_RE.search(combined_text)) or any(page.get("visual_seal_signal") for page in pages)
        sheet_index_present = bool(SHEET_INDEX_RE.search(front_matter_text or combined_text))
        project_name = detect_project_name(raw_front_matter_text or combined_text)

        document_rows.append(
            {
                "pdf": record["file_name"],
                "scope": "PDF",
                "sheet": "",
                "seal/stamp": status_from_match(text_available, seal_present),
                "sheet index": status_from_match(text_available, sheet_index_present),
                "project name": status_from_match(text_available, bool(project_name)),
                "detected value/note": project_name,
            }
        )

        for page in pages:
            title_block_text = page.get("title_block_text") or page.get("text", "")
            page_text = normalized_text(title_block_text, page.get("text", "")[:4000])
            page_has_text = bool(page_text)
            sheet_number = detect_sheet_number(title_block_text) or detect_sheet_number(page_text)
            sheet_title = detect_sheet_title(title_block_text, sheet_number) or detect_sheet_title(page_text, sheet_number)
            date_present = bool(DATE_RE.search(title_block_text) or (DATE_LABEL_RE.search(title_block_text) and DATE_RE.search(page_text)))

            sheet_rows.append(
                {
                    "pdf": record["file_name"],
                    "scope": "Sheet",
                    "sheet": sheet_number or f"PDF page {page['page']}",
                    "pdf page": page["page"],
                    "sheet title/name": status_from_match(page_has_text, bool(sheet_title)),
                    "sheet number": status_from_match(page_has_text, bool(sheet_number)),
                    "date": status_from_match(page_has_text, date_present),
                    "detected sheet title": sheet_title,
                    "detected sheet number": sheet_number,
                }
            )

    return document_rows, sheet_rows


def records_table(records: list[dict[str, Any]]) -> pd.DataFrame:
    rows = []
    for record in records:
        rows.append(
            {
                "file name": record["file_name"],
                "path": record["path"],
                "page count": record["page_count"],
                "file size": record["file_size_display"],
                "modified date": record["modified_date"],
                "status": record["status"],
                "error": record["error"],
            }
        )
    return pd.DataFrame(rows)


def main() -> None:
    initialize_database()

    st.title("Construction Document QA/QC Presence Check")
    st.caption(
        "Fast local PDF checks for commonly overlooked required items. "
        "This reports whether items appear present; it does not validate correctness or compliance."
    )

    folder_text = st.text_input("Project folder path", value=str(APP_DIR))
    scan_clicked = st.button("Scan Project", type="primary")

    if scan_clicked:
        folder = Path(folder_text).expanduser()
        if not folder.exists() or not folder.is_dir():
            st.error("Please enter a valid folder path.")
            return

        pdf_paths = find_pdfs(folder)
        progress = st.progress(0)
        status = st.empty()
        records: list[dict[str, Any]] = []

        for index, pdf_path in enumerate(pdf_paths, start=1):
            status.write(f"Scanning {index} of {len(pdf_paths)}: {pdf_path.name}")
            records.append(scan_pdf(pdf_path))
            progress.progress(index / max(len(pdf_paths), 1))

        status.write("Scan complete.")
        st.session_state["records"] = records
        document_rows, sheet_rows = run_presence_checks(records)
        st.session_state["document_rows"] = document_rows
        st.session_state["sheet_rows"] = sheet_rows
        st.session_state["last_folder"] = str(folder)

    records = st.session_state.get("records", [])
    document_rows = st.session_state.get("document_rows", [])
    sheet_rows = st.session_state.get("sheet_rows", [])

    pdf_count = len(records)
    total_pages = sum(record["page_count"] for record in records)
    missing_count = sum(
        1
        for row in [*document_rows, *sheet_rows]
        for value in row.values()
        if value == "Missing"
    )

    col1, col2, col3 = st.columns(3)
    col1.metric("PDFs found", pdf_count)
    col2.metric("Total sheets/pages", total_pages)
    col3.metric("Missing presence checks", missing_count)

    st.subheader("PDF Files")
    if records:
        st.dataframe(records_table(records), use_container_width=True, hide_index=True)
    else:
        st.info("Enter a project folder path and click Scan Project.")

    st.subheader("PDF-Level Presence Checks")
    if document_rows:
        document_df = pd.DataFrame(document_rows)
        st.dataframe(document_df, use_container_width=True, hide_index=True)
        st.download_button(
            "Export PDF-level checks to CSV",
            data=document_df.to_csv(index=False).encode("utf-8"),
            file_name="qaqc_pdf_presence_checks.csv",
            mime="text/csv",
        )
    else:
        st.info("PDF-level presence checks will appear after a scan.")

    st.subheader("Sheet-Level Presence Checks")
    if sheet_rows:
        sheet_df = pd.DataFrame(sheet_rows)
        st.dataframe(sheet_df, use_container_width=True, hide_index=True)
        combined_df = pd.concat([pd.DataFrame(document_rows), sheet_df], ignore_index=True, sort=False)
        st.download_button(
            "Export full QA/QC presence report to CSV",
            data=combined_df.to_csv(index=False).encode("utf-8"),
            file_name="qaqc_presence_report.csv",
            mime="text/csv",
        )
    else:
        st.info("Sheet-level presence checks will appear after a scan.")


if __name__ == "__main__":
    main()
