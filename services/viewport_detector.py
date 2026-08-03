from __future__ import annotations

import re

from services.keynote_detector import (
    compare_symbols_to_legend,
    detect_duplicate_keynote_contents,
    detect_keynote_symbols_for_page,
    has_placeholder_only_keynote_section,
    has_sheet_keynotes_section,
)
from services.schemas import ViewportFinding

VIEW_TITLE_RE = re.compile(
    r"\b(?P<detail>[A-Z0-9.-]{1,6})\s+(?P<label>REFLECTED\s+CEILING\s+PLAN|FLOOR\s+PLAN|INT\.?\s+ELEVATION|ELEVATION|SECTION|DETAIL|PERSPECTIVE|PLAN)\s+(?P<scale>(?:\d+/\d+|\d+(?:\.\d+)?)\s*\"\s*=\s*(?:\d+|\d+/\d+)\s*'-?\s*\d*\"?|NTS)\b",
    re.IGNORECASE,
)
VIEW_LABEL_RE = re.compile(
    r"\b(?P<label>"
    r"(?:ENLARGED\s+)?(?:FLOOR|ROOF|SITE|UTILITY|LIGHTING|POWER|PLUMBING|MECHANICAL|ELECTRICAL|"
    r"LANDSCAPE|FOUNDATION|FRAMING|DEMO(?:LITION)?|DRAINAGE(?:\s*&\s*GRADING)?|DIMENSION(?:AL)?\s+CONTROL)\s+PLAN|"
    r"REFLECTED\s+CEILING\s+PLAN|RCP|"
    r"(?:[A-Z][A-Z0-9/&'.-]*\s+){1,5}DETAIL|"
    r"(?:(?:BUILDING|WALL|INTERIOR|EXTERIOR|INT\.?|ENLARGED)\s+)(?:SECTION|ELEVATION|DETAIL)|"
    r"PERSPECTIVE"
    r")\b",
    re.IGNORECASE,
)
VIEW_SCALE_RE = re.compile(
    r"\bN\.?T\.?S\.?\b|\bNOT\s+TO\s+SCALE\b|\bNO\s+SCALE\b|"
    r"(?:\d+/\d+|\d+(?:\.\d+)?)\s*\"\s*=\s*"
    r"(?:"
    r"\d+\s*'\s*(?:-\s*(?:\d+(?:\s+\d+/\d+)?)\s*\"?)?|"
    r"\d+(?:\s+\d+/\d+)?\s*\""
    r")",
    re.IGNORECASE,
)
DETAIL_NUMBER_RE = re.compile(r"^[A-Z]?\d{1,3}(?:\.\d+)?[A-Z]?$", re.IGNORECASE)


def keynote_review_for_page(page: dict, is_cover: bool = False) -> dict | None:
    sheet_number = page.get("sheet_number") or f"Page {page.get('page_number')}"
    if is_cover:
        return None
    text = page.get("text", "")
    has_keynotes = has_sheet_keynotes_section(text)
    if not has_keynotes:
        return None
    if has_placeholder_only_keynote_section(text):
        return None
    comparison = compare_symbols_to_legend(text, detect_keynote_symbols_for_page(page))
    duplicate_findings = detect_duplicate_keynote_contents(page)
    status = comparison["status"]
    comment = comparison.get("reason", "")
    if duplicate_findings:
        status = "Fail"
        duplicate_comment = " ".join(item["comment"] for item in duplicate_findings)
        comment = f"{comment} {duplicate_comment}".strip()
    return {
        "sheetNumber": sheet_number,
        "pageNumber": page.get("page_number"),
        "hasSheetKeynotes": True,
        "keynoteCheckStatus": status,
        "comment": comment,
        "duplicateKeynoteContents": duplicate_findings,
    }


def detect_viewports_for_page(page: dict, is_cover: bool = False) -> list[dict]:
    if is_cover:
        return []
    text = page.get("text", "")
    sheet_number = page.get("sheet_number") or f"Page {page.get('page_number')}"
    if not has_sheet_keynotes_section(text) or has_placeholder_only_keynote_section(text):
        return []
    matches = list(VIEW_TITLE_RE.finditer(text))
    symbols = detect_keynote_symbols_for_page(page)
    keynote_page_status = compare_symbols_to_legend(text, symbols)
    if not matches and any(word in text.upper() for word in ["PLAN", "SECTION", "ELEVATION", "DETAIL"]):
        if symbols["present"] and symbols.get("has_number_inside_symbol") and keynote_page_status["status"] == "Pass":
            return []
        matches = []
        fallback = ViewportFinding(
            sheet_number=sheet_number,
            view_label="Possible viewport",
            status="Needs Review",
            failure_reason="Viewport-like sheet text found, but detail number/title/scale was not confidently parsed.",
            confidence=35,
        )
        return [fallback.to_dict()]

    findings: list[ViewportFinding] = []
    for match in matches:
        if symbols["present"] and symbols.get("has_number_inside_symbol") and keynote_page_status["status"] == "Pass":
            status = "Pass"
            reason = ""
            confidence = 72
        else:
            status = "Fail"
            reason = keynote_page_status.get("reason") or "Viewport lacks a keynote symbol with a number inside it."
            confidence = 70
        findings.append(
            ViewportFinding(
                sheet_number=sheet_number,
                detail_number=match.group("detail").upper(),
                view_label=re.sub(r"\s+", " ", match.group("label").upper()),
                scale=re.sub(r"\s+", " ", match.group("scale").upper()),
                status=status,
                failure_reason=reason,
                confidence=confidence,
            )
        )
    return [finding.to_dict() for finding in findings]


def evaluate_viewport_compliance(pages: list[dict], cover_page_number: int | None = None) -> list[dict]:
    findings: list[dict] = []
    for page in pages:
        findings.extend(detect_viewports_for_page(page, is_cover=page.get("page_number") == cover_page_number))
    return findings


def evaluate_missing_scale_checks(pages: list[dict]) -> list[dict]:
    findings: list[dict] = []
    for page in pages:
        if page.get("is_cover_sheet"):
            continue
        findings.extend(detect_missing_scales_for_page(page))
    return findings


def detect_missing_scales_for_page(page: dict) -> list[dict]:
    if _is_scale_optional_sheet(page):
        return []
    lines = _view_text_lines(str(page.get("text") or ""))
    sheet_number = page.get("sheet_number") or f"Page {page.get('page_number')}"
    findings_by_view: dict[tuple[str, str], dict] = {}
    normalized_sheet = re.sub(r"[^A-Z0-9.]", "", str(page.get("sheet_number") or "").upper())

    for index, line in enumerate(lines):
        if re.search(r"\b(?:KEY)?NOTES?\b", line, re.IGNORECASE):
            continue
        for title_match in VIEW_LABEL_RE.finditer(line):
            if (
                _is_reference_to_plan(line, title_match.start(), title_match.end())
                or _is_reference_to_plan_context(lines, index, title_match.start())
                or _is_sheet_index_context(lines, index)
            ):
                continue
            detail_number = _nearby_detail_number(lines, index, title_match.start(), title_match.end())
            if not detail_number:
                continue
            normalized_detail = re.sub(r"[^A-Z0-9.]", "", str(detail_number).upper())
            if normalized_sheet and normalized_detail == normalized_sheet:
                continue
            label = re.sub(r"\s+", " ", title_match.group("label").upper()).strip()
            if _is_optional_scale_view(label, line):
                continue
            if re.search(r"\bSEE\s+DETAILS?$", label, re.IGNORECASE):
                continue
            nearby = " ".join(lines[max(0, index - 4) : min(len(lines), index + 3)])
            nearby = _normalize_scale_glyphs(nearby)
            scale_match = VIEW_SCALE_RE.search(nearby)
            scale = _normalize_view_scale(scale_match.group(0)) if scale_match else ""
            if not scale and label == "SITE PLAN" and (page.get("visual_scale_marker") or {}).get("present"):
                scale = "Visual scale marker"
            key = (str(detail_number).upper(), label)
            finding = {
                "sheet_number": sheet_number,
                "page_number": page.get("page_number"),
                "detail_number": str(detail_number).upper(),
                "view_label": label,
                "scale": scale,
                "status": "Pass" if scale else "Warning",
                "comment": "" if scale else "Missing scale or NTS designation.",
            }
            existing = findings_by_view.get(key)
            if existing is None or (scale and not existing.get("scale")):
                findings_by_view[key] = finding
    return list(findings_by_view.values())


def _is_scale_optional_sheet(page: dict) -> bool:
    text = str(page.get("text") or "").upper()
    sheet_name = str(page.get("sheet_name") or "").upper()
    page_label = str(page.get("page_label_text") or "").upper()
    if (
        re.search(r"\b(?:COVER|INDEX)\s+SHEET\b|\bSHEET\s+INDEX\b|\bINDEX\s+OF\s+SHEETS\b", sheet_name)
        or re.search(r"\b(?:COVER|INDEX)\s+SHEET\b|\bSHEET\s+INDEX\b", page_label)
        or re.search(r"\bSHEET\s+INDEX\b|\bINDEX\s+OF\s+SHEETS\b", text)
    ):
        return True
    if re.search(r"\b(?:DOOR|WINDOW|ROOM\s+FINISH)\s+SCHEDULE\b|\bGLAZING\s+TYPES?\b|\bCEILING\s+TILE\s+TYPES?\b", text):
        return True
    if (
        re.search(r"\b(?:DOOR|WINDOW)\s+(?:HEAD|JAMB|SILL)\s+DETAILS?\b", text)
        and re.search(r"\b(?:AS|PER)\s+SCHEDULED?\b", text)
        and re.search(r"\b(?:DOOR|WINDOW|LEAD-LINED|GLAZING)\b", sheet_name)
    ):
        return True
    return False


def _is_optional_scale_view(label: str, line: str) -> bool:
    if label == "ROOF PLAN" and re.search(r"\b(?:REFER|REF\.?|SEE|LEGEND|SCHEDULE|FINISH)\b", line, re.IGNORECASE):
        return True
    return False


def _view_text_lines(text: str) -> list[str]:
    return [re.sub(r"\s+", " ", line).strip() for line in text.splitlines() if line.strip()]


def _nearby_detail_number(lines: list[str], index: int, title_start: int, title_end: int) -> str:
    same_line_prefix = lines[index][:title_start].strip(" .:-")
    same_line_match = re.search(r"(?:^|\s)([A-Z]?\d{1,3}(?:\.\d+)?[A-Z]?)$", same_line_prefix, re.IGNORECASE)
    if same_line_match:
        return same_line_match.group(1)
    same_line_suffix = lines[index][title_end:].strip(" .:-")
    suffix_candidate = _detail_number_from_text_fragment(same_line_suffix)
    if suffix_candidate:
        return suffix_candidate
    for line in reversed(lines[max(0, index - 2) : index]):
        candidate = line.strip(" .:-")
        if DETAIL_NUMBER_RE.fullmatch(candidate):
            return candidate
    for line in lines[index + 1 : min(len(lines), index + 4)]:
        candidate = _detail_number_from_text_fragment(line)
        if candidate:
            return candidate
    return ""


def _detail_number_from_text_fragment(value: str) -> str:
    fragment = VIEW_SCALE_RE.sub(" ", _normalize_scale_glyphs(value)).strip(" .:-")
    if DETAIL_NUMBER_RE.fullmatch(fragment):
        return fragment
    match = re.search(r"(?:^|\s)([A-Z]?\d{1,3}(?:\.\d+)?[A-Z]?)(?:\s|$)", fragment, re.IGNORECASE)
    return match.group(1) if match else ""


def _is_reference_to_plan(line: str, label_start: int, label_end: int) -> bool:
    before = line[max(0, label_start - 12) : label_start].upper()
    after = line[label_end : label_end + 30].upper()
    line_before_label = line[:label_start].upper()
    if re.search(r"\bREFER\s+TO\b", line_before_label):
        return True
    if re.search(r"\b(?:RE|REF|REFERENCE)\.?\s*:?\s*$", before):
        return True
    if re.match(r"\s+FOR\s+(?:SIZES|LOCATION|REFERENCE|INFORMATION)\b", after):
        return True
    return False


def _is_reference_to_plan_context(lines: list[str], index: int, label_start: int) -> bool:
    context = " ".join(lines[max(0, index - 2) : index] + [lines[index][:label_start]])
    return bool(re.search(r"\bREFER\s+TO\b|\bREFERENCE\s*:?\s*$|\bREF\.?\s+NOTES?\b", context, re.IGNORECASE))


def _is_sheet_index_context(lines: list[str], index: int) -> bool:
    window = " ".join(lines[max(0, index - 10) : index + 1])
    if not re.search(r"\b(?:INDEX|LIST)\s+OF\s+SHEETS\b|\bSHEET\s+(?:INDEX|LIST)\b", window, re.IGNORECASE):
        return False
    recent = lines[max(0, index - 3) : index + 1]
    return any(re.fullmatch(r"[A-Z]{1,5}[- ]?\d{1,4}(?:\.\d+)?(?:[-.]\d+)?[A-Z]?", line, re.IGNORECASE) for line in recent)


def _normalize_view_scale(value: str) -> str:
    compact = re.sub(r"\s+", " ", _normalize_scale_glyphs(value).upper()).strip(" .")
    if re.fullmatch(r"N\.?T\.?S\.?|NOT\s+TO\s+SCALE|NO\s+SCALE", compact, re.IGNORECASE):
        return "NTS"
    return compact


def _normalize_scale_glyphs(value: str) -> str:
    return (
        value.replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("\u2032", "'")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u2033", '"')
    )


def evaluate_keynote_compliance(pages: list[dict], cover_page_number: int | None = None) -> dict:
    sheet_reviews: list[dict] = []
    viewport_findings: list[dict] = []
    for page in pages:
        is_cover = _is_keynote_exempt_cover(page, cover_page_number)
        review = keynote_review_for_page(page, is_cover=is_cover)
        page["hasSheetKeynotes"] = bool(review)
        if review:
            page["keynoteCheckStatus"] = review["keynoteCheckStatus"]
            page["keynoteComment"] = review["comment"]
            sheet_reviews.append(review)
        else:
            page.pop("keynoteCheckStatus", None)
            page.pop("keynoteComment", None)
        viewport_findings.extend(detect_viewports_for_page(page, is_cover=is_cover))
    failed_viewports_by_sheet = {item.get("sheet_number") for item in viewport_findings if item.get("status") == "Fail"}
    for review in sheet_reviews:
        if review["hasSheetKeynotes"] and review["sheetNumber"] in failed_viewports_by_sheet:
            review["keynoteCheckStatus"] = "Fail"
            if not review["comment"]:
                review["comment"] = "One or more viewports lack detected keynote symbols."
    return {"sheet_reviews": sheet_reviews, "viewport_findings": viewport_findings}


def _is_keynote_exempt_cover(page: dict, cover_page_number: int | None) -> bool:
    if page.get("page_number") != cover_page_number:
        return False
    sheet_number = re.sub(r"[^A-Z0-9]", "", str(page.get("sheet_number") or "").upper())
    if sheet_number in {"CS", "CS001", "G000", "G001", "A000"}:
        return True
    text = str(page.get("text") or "").upper()
    return bool(re.search(r"\b(?:COVER|TITLE)\s+SHEET\b", text))
