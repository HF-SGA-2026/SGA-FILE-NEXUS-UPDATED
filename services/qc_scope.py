from __future__ import annotations

import re

from services.schemas import normalize_sheet_number


_INFERRED_MISSING_SHEET_SOURCES = {
    "page_label_index_match",
    "sheet_index_position",
}


def is_architectural_or_cover_page(page: dict) -> bool:
    if page.get("is_cover_sheet") or page.get("cover_type") == "primary":
        return True
    if page.get("physical_sheet_number_missing") and page.get("sheet_source") in _INFERRED_MISSING_SHEET_SOURCES:
        return False
    return (
        is_architectural_sheet_number(page.get("sheet_number"))
        or (
            is_cover_sheet_number(page.get("page_label_sheet_number"))
            and not _page_label_looks_like_civil_cover(page)
        )
        or is_architectural_sheet_number(page.get("page_label_sheet_number"))
    )


def is_architectural_or_cover_index_entry(entry: dict, scoped_pages: list[dict]) -> bool:
    normalized_entry = normalize_sheet_number(entry.get("sheet_number"))
    scoped_numbers = {
        normalize_sheet_number(page.get("sheet_number"))
        for page in scoped_pages
        if normalize_sheet_number(page.get("sheet_number"))
    }
    if normalized_entry and normalized_entry in scoped_numbers:
        return True
    if _looks_like_cover_entry(entry):
        return True
    return is_architectural_sheet_number(entry.get("sheet_number"))


def is_architectural_sheet_number(value: object) -> bool:
    normalized = normalize_sheet_number(value)
    return bool(normalized and normalized.startswith("A"))


def is_cover_sheet_number(value: object) -> bool:
    normalized = normalize_sheet_number(value)
    return normalized in {"CS", "COVER"} or bool(re.fullmatch(r"CS\d*", normalized))


def scoped_qc_pages(pages: list[dict]) -> list[dict]:
    return [page for page in pages if is_architectural_or_cover_page(page)]


def scoped_qc_index_entries(entries: list[dict], scoped_pages: list[dict]) -> list[dict]:
    scoped_entries = [
        entry
        for entry in entries
        if is_architectural_or_cover_index_entry(entry, scoped_pages)
    ]
    return [
        {**entry, "index_position": position}
        for position, entry in enumerate(scoped_entries, start=1)
    ]


def _looks_like_cover_entry(entry: dict) -> bool:
    sheet_name = str(entry.get("sheet_name") or "").upper()
    sheet_number = normalize_sheet_number(entry.get("sheet_number"))
    if str(entry.get("sheet_number") or "").upper().startswith("CS-"):
        return False
    if re.fullmatch(r"CS\d*", sheet_number) or re.fullmatch(r"G0+\.?0*", sheet_number):
        return True
    return sheet_number in {"COVER", "TITLE"} and bool(re.search(r"\b(?:COVER|TITLE)\s+SHEET\b", sheet_name))


def _page_label_looks_like_civil_cover(page: dict) -> bool:
    label_text = str(page.get("page_label_text") or "").upper()
    page_text = " ".join(
        str(page.get(key) or "")
        for key in ("text", "title_block_text", "sheet_name")
    ).upper()
    if re.search(r"\bCIVIL\b", label_text):
        return True
    if re.search(r"\bDESIGN\s+CONSULTANT\s+TEAM\b|\bOWNER\b", page_text):
        return False
    civil_sheet_refs = len(re.findall(r"\bC\d+(?:\.\d+)?\b", page_text))
    has_civil_terms = bool(
        re.search(
            r"\b(?:CIVIL|TBPELS?|GRADING|DRAINAGE|EROSION|UTILITY|DEMOLITION|SOTEX|ENGINEERING)\b",
            page_text,
        )
    )
    return civil_sheet_refs >= 3 and has_civil_terms
