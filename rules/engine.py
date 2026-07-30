from __future__ import annotations

import re
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from typing import Iterable

from database.models import DocumentMetadata, QAIssue


SHEET_ID_RE = re.compile(r"\b(?:CS|[A-Z]{1,4}-?\d+(?:\.\d+)?)\b")
CALLOUT_RE = re.compile(r"\b(?:DETAIL|SECTION|ELEVATION)?\s*([A-Z0-9.-]{1,6})\s*/\s*([A-Z]{1,4}-?\d+(?:\.\d+)?)\b", re.IGNORECASE)
COMMON_WORDS = {
    "ACCESSIBLE", "ARCHITECT", "ARCHITECTURE", "BUILDING", "CHECKED", "CLIENT", "CODE", "CONSTRUCTION",
    "CONSULTANT", "DETAIL", "DRAWING", "ELEVATION", "FLOOR", "GENERAL", "ISSUE", "KEYNOTE", "LEGEND",
    "MECHANICAL", "NOTES", "OWNER", "PLAN", "PROJECT", "REVISION", "SCHEDULE", "SECTION", "SHEET",
    "STRUCTURAL", "TITLE",
}
KNOWN_TECHNICAL_TERMS = {
    "AIA", "ADA", "AHU", "CFM", "DBR", "EIFS", "GFCI", "HVAC", "MEP", "NTS", "TABS", "TBAE", "UL",
}


def _issue(category: str, severity: str, page_label: str, filename: str, message: str, rule: str, correction: str) -> QAIssue:
    return QAIssue(
        category=category,
        severity=severity,
        sheet_id=page_label,
        filename=filename,
        message=message,
        explanation="Presence-only production check. Checkit verifies whether the item is detectable, not whether the content is correct.",
        rule=rule,
        suggested_correction=correction,
        reference_standard="Requested Production Error Checklist",
    )


def _keyword_pages(record: DocumentMetadata, key: str) -> set[int]:
    return {int(page) for page in (record.keyword_pages or {}).get(key, [])}


def _has(record: DocumentMetadata, key: str) -> bool:
    return bool(_keyword_pages(record, key))


def _page_text(record: DocumentMetadata, page: int) -> str:
    for sheet in record.sheet_records or []:
        if int(sheet.get("page") or 0) == page:
            return str(sheet.get("text_excerpt") or "").upper()
    return ""


def _full_text(record: DocumentMetadata) -> str:
    return record.extracted_text.upper()


def _page_label(record: DocumentMetadata, page: int) -> str:
    return (record.page_labels or {}).get(str(page), f"Page {page}")


def _sheet_number_for_page(record: DocumentMetadata, page: int) -> str:
    block = (record.title_blocks or {}).get(str(page), {})
    sheet_id = str(block.get("sheet_id") or "").upper()
    if sheet_id:
        return sheet_id
    match = SHEET_ID_RE.search(_page_text(record, page))
    return match.group(0).upper() if match else ""


def _sheet_numbers(record: DocumentMetadata) -> dict[int, str]:
    return {page: value for page in range(1, record.page_count + 1) if (value := _sheet_number_for_page(record, page))}


def _sheet_title_for_page(record: DocumentMetadata, page: int) -> str:
    block = (record.title_blocks or {}).get(str(page), {})
    return str(block.get("sheet_title") or "").strip().upper()


def _is_blank_page(record: DocumentMetadata, page: int) -> bool:
    text = _page_text(record, page)
    return len(text.strip()) < 80 or page in _keyword_pages(record, "blank_marker")


def _prefix(sheet_number: str) -> str:
    match = re.match(r"([A-Z]+)", sheet_number.upper())
    return match.group(1) if match else ""


def _number_value(sheet_number: str) -> float | None:
    match = re.search(r"(\d+(?:\.\d+)?)", sheet_number)
    return float(match.group(1)) if match else None


def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a.upper(), b.upper()).ratio()


def _likely_spelling_errors(text: str) -> list[str]:
    words = re.findall(r"\b[A-Z]{4,}\b", text.upper())
    errors: list[str] = []
    for word in words[:2500]:
        if word in COMMON_WORDS or word in KNOWN_TECHNICAL_TERMS:
            continue
        if any(_similar(word, common) >= 0.86 and word != common for common in COMMON_WORDS):
            errors.append(word)
        if len(errors) >= 12:
            break
    return sorted(set(errors))


def _detect_overlap_or_cutoff(text: str) -> bool:
    compact = text.replace(" ", "")
    repeated_runs = re.findall(r"([A-Z]{3,})\1", compact)
    strange_fragments = re.findall(r"\b[A-Z]{18,}\b", compact)
    return bool(repeated_runs or strange_fragments)


def _view_off_sheet_signal(text: str) -> bool:
    return any(term in text for term in ["MATCHLINE", "SEE CONTINUATION", "CONTINUED", "CROP", "VIEWPORT"])


def _add_once(
    issues_by_rule: dict[str, QAIssue],
    category: str,
    severity: str,
    page_label: str,
    filename: str,
    message: str,
    rule: str,
    correction: str,
) -> None:
    issues_by_rule.setdefault(rule, _issue(category, severity, page_label, filename, message, rule, correction))


def _rank(issue: QAIssue) -> tuple[int, str]:
    severity_rank = {"High": 0, "Medium": 1, "Low": 2}
    return (severity_rank.get(issue.severity, 3), issue.category)


def compare_records_to_standards(records: Iterable[DocumentMetadata], standards: dict | None = None) -> list[QAIssue]:
    issues: list[QAIssue] = []
    for record in records:
        filename = record.filename
        full_text = _full_text(record)
        title_blocks = record.title_blocks or {}
        sheet_numbers = _sheet_numbers(record)
        indexed = {sheet.upper(): title for sheet, title in (record.indexed_sheets or {}).items()}
        issues_by_rule: dict[str, QAIssue] = {}

        if len(title_blocks) < max(1, int(record.page_count * 0.5)):
            _add_once(issues_by_rule, "Missing title block", "High", "Project", filename, f"Title blocks are detectable on only {len(title_blocks)} of {record.page_count} pages.", "missing_title_block", "Add or verify title blocks.")

        if not (_has(record, "project_name") and _has(record, "project_address") and _has(record, "owner_client")):
            _add_once(issues_by_rule, "Missing or incorrect project information", "High", "Project", filename, "Project information fields are missing or unreadable.", "missing_project_information", "Add or verify project name, address, and owner/client fields.")

        if not _has(record, "issue_date"):
            _add_once(issues_by_rule, "Missing or incorrect issue date", "High", "Project", filename, "Issue date is missing or unreadable.", "missing_issue_date", "Add or verify issue date.")

        if not indexed and not _has(record, "sheet_index"):
            _add_once(issues_by_rule, "Missing drawing index", "High", "Project", filename, "Drawing index is missing or unreadable.", "missing_drawing_index", "Add or verify drawing index.")

        if not _has(record, "consultant_team"):
            _add_once(issues_by_rule, "Missing consultant information", "Medium", "Project", filename, "Consultant information is missing or unreadable.", "missing_consultant_information", "Add or verify consultant information.")

        if not (_has(record, "north_arrow") or _has(record, "scale") or _has(record, "graphic_scale")):
            _add_once(issues_by_rule, "Missing north arrow or scale", "Medium", "Project", filename, "North arrow or scale marker is missing or unreadable.", "missing_north_arrow_or_scale", "Add or verify north arrow and scale where required.")

        if not _has(record, "revision_block"):
            _add_once(issues_by_rule, "Missing revision block", "Medium", "Project", filename, "Revision block is missing or unreadable.", "missing_revision_block", "Add or verify revision block.")

        if not (_has(record, "professional_seal") or _has(record, "signature")):
            _add_once(issues_by_rule, "Missing professional seal or signature", "High", "Project", filename, "Professional seal or signature is missing or unreadable.", "missing_professional_seal_or_signature", "Add or verify seal/signature.")

        duplicate_numbers = {num for num, count in Counter(sheet_numbers.values()).items() if count > 1}
        invalid_numbers = [num for num in sheet_numbers.values() if not re.match(r"^(CS|[A-Z]{1,4}-?\d+(?:\.\d+)?)$", num)]
        if duplicate_numbers or invalid_numbers:
            detail = ", ".join(sorted(duplicate_numbers or set(invalid_numbers))[:12])
            _add_once(issues_by_rule, "Incorrect or duplicate sheet numbers", "High", "Project", filename, f"Sheet numbering issue detected: {detail}.", "incorrect_or_duplicate_sheet_numbers", "Verify sheet numbers are present, unique, and consistently formatted.")

        if indexed and len(sheet_numbers) >= max(5, int(record.page_count * 0.70)):
            detected_set = set(sheet_numbers.values())
            missing = sorted(set(indexed) - detected_set)
            extra = sorted(detected_set - set(indexed))
            missing_ratio = len(missing) / max(1, len(indexed))
            extra_ratio = len(extra) / max(1, len(detected_set))
            if (missing or extra) and (missing_ratio > 0.25 or extra_ratio > 0.25):
                parts = []
                if missing:
                    parts.append(f"missing from set: {', '.join(missing[:10])}")
                if extra:
                    parts.append(f"not listed in index: {', '.join(extra[:10])}")
                _add_once(issues_by_rule, "Missing, blank, or extra sheets", "High", "Project", filename, "; ".join(parts), "missing_blank_or_extra_sheets", "Verify every issued sheet is listed and every indexed sheet is included.")

        blank_pages: list[str] = []
        placeholder_pages: list[str] = []
        title_pages: list[str] = []
        view_scale_pages: list[str] = []
        revision_pages: list[str] = []
        overlap_pages: list[str] = []
        tiny_text_pages: list[str] = []
        spelling_pages: list[str] = []
        cropped_pages: list[str] = []

        for page in range(1, record.page_count + 1):
            page_label = _page_label(record, page)
            text = _page_text(record, page)
            sheet_num = _sheet_number_for_page(record, page)
            sheet_title = _sheet_title_for_page(record, page)

            if _is_blank_page(record, page):
                blank_pages.append(page_label)

            if page in _keyword_pages(record, "placeholder"):
                placeholder_pages.append(page_label)

            if sheet_num and indexed and sheet_num in indexed and indexed[sheet_num] and sheet_title and _similar(sheet_title, indexed[sheet_num]) < 0.55:
                title_pages.append(page_label)
            elif title_blocks.get(str(page)) and not sheet_title:
                title_pages.append(page_label)

            if ("PLAN" in text or "ELEVATION" in text or "SECTION" in text or "DETAIL" in text) and not (page in _keyword_pages(record, "scale")):
                view_scale_pages.append(page_label)

            if title_blocks.get(str(page)) and page not in _keyword_pages(record, "revision"):
                revision_pages.append(page_label)

            if _detect_overlap_or_cutoff(text) and len(text.strip()) < 500:
                overlap_pages.append(page_label)

            if record.ocr_used and len(text.strip()) < 120:
                tiny_text_pages.append(page_label)

            spelling = _likely_spelling_errors(text)
            if len(spelling) >= 6:
                spelling_pages.append(page_label)

            if _view_off_sheet_signal(text) and len(text.strip()) < 250:
                cropped_pages.append(page_label)

        if blank_pages:
            _add_once(issues_by_rule, "Missing, blank, or extra sheets", "Medium", "Project", filename, f"Blank/empty sheets detected on {len(blank_pages)} page(s): {', '.join(blank_pages[:8])}.", "blank_sheet", "Remove blank sheets unless intentionally issued.")
        if placeholder_pages:
            _add_once(issues_by_rule, "Placeholder text not removed", "High", "Project", filename, f"Placeholder text detected on {len(placeholder_pages)} page(s): {', '.join(placeholder_pages[:8])}.", "placeholder_text_not_removed", "Remove placeholder/TBD text.")
        if len(title_pages) >= max(2, int(record.page_count * 0.08)):
            _add_once(issues_by_rule, "Incorrect sheet titles", "Medium", "Project", filename, f"Possible sheet title issues on {len(title_pages)} page(s): {', '.join(title_pages[:8])}.", "incorrect_sheet_titles", "Verify sheet titles against drawing index.")
        if len(view_scale_pages) >= max(8, int(record.page_count * 0.30)):
            _add_once(issues_by_rule, "Missing view titles or scales", "Medium", "Project", filename, f"Possible missing view titles/scales on {len(view_scale_pages)} page(s): {', '.join(view_scale_pages[:8])}.", "missing_view_titles_or_scales", "Add or verify view titles and scales.")
        if len(revision_pages) >= max(5, int(record.page_count * 0.35)):
            _add_once(issues_by_rule, "Missing revision history", "Low", "Project", filename, f"Revision history is not detectable on {len(revision_pages)} title-block pages.", "missing_revision_history", "Add or verify revision history.")
        if len(overlap_pages) >= max(4, int(record.page_count * 0.10)):
            _add_once(issues_by_rule, "Text overlapping or cut off", "Medium", "Project", filename, f"Possible overlap/cut-off text on {len(overlap_pages)} page(s): {', '.join(overlap_pages[:8])}.", "text_overlapping_or_cut_off", "Review text placement.")
        if tiny_text_pages:
            _add_once(issues_by_rule, "Text too small to read", "Medium", "Project", filename, f"Very little readable text after OCR on {len(tiny_text_pages)} page(s): {', '.join(tiny_text_pages[:8])}.", "text_too_small_to_read", "Review text size and PDF legibility.")
        if len(spelling_pages) >= max(8, int(record.page_count * 0.25)):
            _add_once(issues_by_rule, "Spelling errors", "Low", "Project", filename, f"Possible spelling issues on {len(spelling_pages)} page(s): {', '.join(spelling_pages[:8])}.", "spelling_errors", "Review possible misspellings.")
        if len(cropped_pages) >= max(3, int(record.page_count * 0.08)):
            _add_once(issues_by_rule, "Views cropped incorrectly or placed off sheet", "Medium", "Project", filename, f"Possible cropped/off-sheet views on {len(cropped_pages)} page(s): {', '.join(cropped_pages[:8])}.", "views_cropped_or_off_sheet", "Review viewport crop and placement.")

        detected_sheets = set(sheet_numbers.values())
        referenced_sheets = {match.group(2).upper() for match in CALLOUT_RE.finditer(full_text)}
        missing_refs = sorted(referenced_sheets - detected_sheets)
        if missing_refs and len(detected_sheets) >= max(5, int(record.page_count * 0.70)):
            _add_once(issues_by_rule, "Missing or broken callouts/references", "High", "Project", filename, f"References point to missing sheets: {', '.join(missing_refs[:12])}.", "missing_or_broken_callouts_references", "Verify callout/reference sheet targets.")

        detail_labels = {match.group(1).upper() for match in CALLOUT_RE.finditer(full_text)}
        unreferenced_details = [num for num in detected_sheets if re.match(r"^[A-Z]*\d+(?:\.\d+)?$", num) and num not in referenced_sheets]
        if detail_labels and len(unreferenced_details) > max(8, len(detected_sheets) * 0.5):
            _add_once(issues_by_rule, "Unreferenced details", "Low", "Project", filename, "Many detected detail/sheet identifiers do not appear to be referenced elsewhere.", "unreferenced_details", "Review detail references.")

        issues.extend(sorted(issues_by_rule.values(), key=_rank)[:10])

    return sorted(issues, key=_rank)[:10]


def summarize_issue_counts(issues: Iterable[QAIssue]) -> dict[str, int]:
    return dict(Counter(issue.category for issue in issues))
