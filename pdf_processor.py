from __future__ import annotations

from pathlib import Path
import re

import fitz

from metadata import FileMetadata, file_type_from_path, sheet_number_from_filename, sheet_title_from_filename
from qa_rules import detect_drawing_type, detect_keywords


MAX_METADATA_PAGES = 5


def process_pdf(path: Path) -> FileMetadata:
    file_size = path.stat().st_size
    sheet_number = sheet_number_from_filename(path)
    sheet_title = sheet_title_from_filename(path, sheet_number)
    detected_keywords: set[str] = set()
    drawing_type = "Unknown"
    first_text_lines: list[str] = []

    # PyMuPDF opens the PDF from disk. We iterate page-by-page so large drawing
    # sets do not get copied into one giant string in memory. For indexing, we
    # only sample the first few pages because the scanner stores lightweight
    # metadata, not a complete searchable text corpus.
    with fitz.open(path) as document:
        pages_to_scan = min(document.page_count, MAX_METADATA_PAGES)
        for page_number in range(pages_to_scan):
            page = document.load_page(page_number)
            page_text = page.get_text("text")
            detected_keywords.update(detect_keywords(page_text))

            if drawing_type == "Unknown":
                drawing_type = detect_drawing_type(page_text, path.name)

            if len(first_text_lines) < 12:
                first_text_lines.extend(clean_text_lines(page_text)[:12])

            if not sheet_number:
                sheet_number = find_sheet_number(page_text)

            if not sheet_title:
                sheet_title = find_sheet_title(first_text_lines, sheet_number)

    if not sheet_title:
        sheet_title = sheet_title_from_filename(path, sheet_number)

    return FileMetadata(
        path=str(path),
        filename=path.name,
        file_size=file_size,
        file_type=file_type_from_path(path),
        sheet_number=sheet_number,
        sheet_title=sheet_title,
        detected_keywords=sorted(detected_keywords),
        drawing_type=drawing_type,
    )


def clean_text_lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]


def find_sheet_number(text: str) -> str:
    match = re.search(r"\b([A-Z]{0,3}\d{2,4}(?:\.\d+)?)\b", text.upper())
    return match.group(1) if match else ""


def find_sheet_title(lines: list[str], sheet_number: str) -> str:
    for index, line in enumerate(lines):
        if sheet_number and sheet_number.upper() in line.upper() and index + 1 < len(lines):
            return lines[index + 1]

    return lines[0] if lines else ""
