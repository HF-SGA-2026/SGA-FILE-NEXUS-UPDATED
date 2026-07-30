from __future__ import annotations

import re
from collections import Counter
from typing import Any

from services.schemas import Detection
from services.sheet_index_extractor import INDEX_HEADER_RE

OFFICIAL_RE = re.compile(
    r"\b(?:100%\s+)?(?:PERMIT(?:\s+(?:SET|PDF|PACKAGE|DOCUMENTS?|DRAWINGS?))?|CONSTRUCTION\s+(?:SET|DOCUMENTS?|DRAWINGS?|PACKAGE)|BID\s+SET|SIGNED\s+AND\s+SEALED)\b",
    re.IGNORECASE,
)
NON_OFFICIAL_RE = re.compile(
    r"\b(?:SD|DD|DESIGN\s+DEVELOPMENT|SCHEMATIC\s+DESIGN|PROGRESS\s+DRAWING|PROGRESS\s+SET|N\.?F\.?C\.?|NOT\s+FOR\s+CONSTRUCTION)\b",
    re.IGNORECASE,
)
DATE_RE = re.compile(r"\b(?:\d{1,2}[./-]\d{1,2}[./-](?:\d{2}|20\d{2})|20\d{2}[./-]\d{1,2}[./-]\d{1,2}|(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s+\d{1,2},?\s+20\d{2})\b", re.IGNORECASE)
SEAL_RE = re.compile(r"\b(?:SEAL|SIGNED|SIGNATURE|REGISTERED\s+ARCHITECT|ARCHITECT|TBAE|LICENSE|LIC\.?|AIA)\b", re.IGNORECASE)


def classify_set_type(text: str) -> dict:
    official = OFFICIAL_RE.search(text)
    non_official = NON_OFFICIAL_RE.search(text)
    if non_official:
        return {"set_type": "Non-Official", "confidence": 86, "evidence": non_official.group(0)}
    if official:
        return {"set_type": "Official", "confidence": 90, "evidence": official.group(0)}
    return {"set_type": "Unknown", "confidence": 0, "evidence": ""}


def analyze_cover_sheet(pages: list[dict], index_result: dict | None = None, document_name: str = "") -> dict:
    cover_pages = classify_cover_sheets(pages)
    cover = detect_cover_sheet(pages)
    cover_text = cover.get("text", "") if cover else ""
    all_front_text = "\n".join(page.get("text", "") for page in pages[:5])
    set_info = classify_set_type(f"{document_name}\n{all_front_text}")
    has_seal = bool(SEAL_RE.search(all_front_text)) or any(
        bool((page.get("seal_check") or {}).get("present"))
        for page in pages
    )
    has_nfc = bool(NON_OFFICIAL_RE.search(all_front_text))
    has_index = bool(INDEX_HEADER_RE.search(all_front_text) or (index_result and index_result.get("entries")))
    owner_section_check, owner_populated_check = _owner_information_checks(cover)
    visuals = cover.get("cover_visuals") or {}

    checks = [
        _visual_check(
            visuals,
            "large_project_title_present",
            "Large project title",
            "A large project title was not detected across the upper cover area.",
            fallback=lambda: _keyword_check("Project title present at top center", cover_text, [r"\bPROJECT\s+TITLE\b"], 45),
            missing_status="Fail",
        ),
        _keyword_check("Matching project title/project identifier present in title block", cover.get("title_block_text", ""), [r"\bPROJECT\b", r"\bJOB\s+NO\.?\b", r"\b20\d{2}-\d{3,5}\b"], 70),
        _visual_check(
            visuals,
            "central_project_image_present",
            "Central project image",
            "A large project image, rendering, or isometric was not confidently detected.",
            fallback=lambda: _keyword_check("Central project image/render/isometric present", cover_text, [r"\b(?:RENDER|RENDERING|ISOMETRIC|PERSPECTIVE|IMAGE)\b"], 45),
        ),
        _keyword_check("TDLR registration present", cover_text, [r"\bTABS\b\s*#?\s*\d+", r"\bTDLR\b"], 80),
        _keyword_check("Design consultant team section present", cover_text, [r"\bDESIGN\s+CONSULTANT\s+TEAM\b", r"\bCONSULTANTS?\b"], 75),
        _consultant_entries_check(cover),
        owner_section_check,
        owner_populated_check,
        _visual_check(
            visuals,
            "vicinity_map_present",
            "Vicinity map",
            "A vicinity or site-location map was not confidently detected.",
            fallback=lambda: _keyword_check("Vicinity map present", cover_text, [r"\bVICINITY\s+MAP\b", r"\bLOCATION\s+MAP\b"], 80),
        ),
        Detection("Pass" if has_index else "Fail", 90 if has_index else 60, "Index detected" if has_index else "", "Sheet index must be on cover or dedicated index sheet."),
        _issue_label_check(cover_text),
        _set_type_marker_check(set_info["set_type"], has_seal, has_nfc),
    ]
    labels = [
        "Project title present at top center",
        "Matching project title/project identifier present in title block",
        "Central project image/render/isometric present",
        "TDLR registration present, typically beginning with TABS",
        "Design consultant team section present",
        "Consultant entries populated",
        "Owner information section present",
        "Owner information populated",
        "Vicinity map present",
        "Sheet index present on cover sheet or dedicated index sheet",
        "Submission delta/issue label present and populated with date",
        "Set-type compliance marker present",
    ]
    return {
        "cover_page_number": cover.get("page_number") if cover else None,
        "cover_pages": cover_pages,
        "set_type": set_info["set_type"],
        "set_type_confidence": set_info["confidence"],
        "set_type_evidence": set_info["evidence"],
        "issue_label": _detect_issue_label(cover_text),
        "checklist": [
            {"item": label, **check.to_dict()}
            for label, check in zip(labels, checks)
        ],
    }


def detect_cover_sheet(pages: list[dict]) -> dict:
    if not pages:
        return {}
    classified = classify_cover_sheets(pages)
    primary_page_number = next(
        (item["page_number"] for item in classified if item["cover_type"] == "primary"),
        None,
    )
    if primary_page_number is not None:
        return next(page for page in pages if page.get("page_number") == primary_page_number)
    return pages[0]


def classify_cover_sheets(pages: list[dict]) -> list[dict]:
    candidates: list[tuple[int, dict]] = []
    for page in pages:
        score, evidence = _cover_sheet_score(page)
        page["is_cover_sheet"] = score > 0
        page["cover_type"] = ""
        page["cover_evidence"] = evidence
        if score > 0:
            candidates.append((score, page))

    if not candidates:
        return []

    primary = max(candidates, key=lambda item: _primary_cover_sort_key(item[0], item[1]))[1]
    result: list[dict] = []
    for _, page in sorted(candidates, key=lambda item: int(item[1].get("page_number") or 0)):
        cover_type = "primary" if page is primary else "secondary"
        page["cover_type"] = cover_type
        result.append(
            {
                "page_number": page.get("page_number"),
                "sheet_number": page.get("sheet_number", ""),
                "cover_type": cover_type,
                "evidence": page.get("cover_evidence", []),
            }
        )
    return result


def _primary_cover_sort_key(score: int, page: dict) -> tuple[int, int, int]:
    evidence = {str(item).upper() for item in page.get("cover_evidence", [])}
    text = str(page.get("text") or "").upper()
    has_design_team = "DESIGN CONSULTANT TEAM" in evidence or bool(re.search(r"\bDESIGN\s+CONSULTANT\s+TEAM\b", text))
    has_owner = bool(re.search(r"\bOWNER\b", text))
    page_number = int(page.get("page_number") or 0)
    return (1 if has_design_team and has_owner else 0, score, -page_number)


def _cover_sheet_score(page: dict) -> tuple[int, list[str]]:
    text = str(page.get("text") or "").upper()
    sheet = re.sub(r"[^A-Z0-9]", "", str(page.get("sheet_number") or "").upper())
    evidence: list[str] = []
    score = 0

    if _looks_like_civil_cover_sheet(text):
        return 0, []

    if sheet in {"CS", "CS1", "CS001", "G000", "G001", "A000"}:
        score += 100
        evidence.append(f"cover sheet number {page.get('sheet_number')}")

    if re.search(r"\bCOVER\s+SHEET\b", text):
        score += 45
        evidence.append("COVER SHEET")
    for label, pattern, weight in [
        ("SHEET INDEX", r"\bSHEET\s+INDEX\b", 20),
        ("LOCATION MAP", r"\b(?:LOCATION|VICINITY)\s+MAP\b", 15),
        ("DESIGN CONSULTANT TEAM", r"\bDESIGN\s+CONSULTANT\s+TEAM\b", 15),
        ("CONSTRUCTION PLANS", r"\bCONSTRUCTION\s+PLANS\b", 15),
    ]:
        if re.search(pattern, text):
            score += weight
            evidence.append(label)

    if score < 65:
        return 0, []
    return score, evidence


def _looks_like_civil_cover_sheet(text: str) -> bool:
    if not re.search(r"\bCIVIL\s+(?:COVER|CONSTRUCTION\s+PLAN(?:S)?)\b", text):
        return False
    return not bool(re.search(r"\b(?:DESIGN\s+CONSULTANT\s+TEAM|OWNER)\b", text))


def score_cover_checklist(checklist: list[dict]) -> dict:
    failures = [item for item in checklist if item["status"] == "Fail"]
    needs_review = [item for item in checklist if item["status"] == "Needs Review"]
    return {
        "status": "Fail" if failures else ("Needs Review" if needs_review else "Pass"),
        "failed_count": len(failures),
        "needs_review_count": len(needs_review),
    }


def detect_owner_information_from_page(page: Any) -> dict:
    try:
        words = page.get_text("words") or []
    except Exception:
        return {"section_present": False, "populated": False, "evidence": "", "confidence": 0}

    headings = [word for word in words if len(word) >= 5 and str(word[4]).upper() in {"OWNER", "CLIENT"}]
    if not headings:
        return _detect_unlabelled_owner_contact(page, words)

    heading = max(headings, key=lambda word: float(word[1]))
    x0, y0, x1, y1 = map(float, heading[:4])
    region_words = [
        word
        for word in words
        if float(word[0]) >= x0 - 30
        and float(word[2]) <= x0 + 310
        and float(word[1]) >= y1 + 8
        and float(word[3]) <= y1 + 190
    ]
    values = [
        str(word[4]).strip()
        for word in sorted(region_words, key=lambda item: (round(float(item[1]), 1), float(item[0])))
        if str(word[4]).strip()
    ]
    meaningful = [
        value for value in values
        if re.search(r"[A-Za-z]", value)
        and value.upper() not in {"OWNER", "CLIENT", "SITE", "LOCATION"}
    ]
    evidence = " ".join(values)[:180]
    if len(meaningful) < 2:
        project_match = _detect_project_title_owner_match(page, words)
        if project_match.get("populated"):
            return project_match
    return {
        "section_present": True,
        "populated": len(meaningful) >= 2,
        "evidence": evidence,
        "confidence": 92 if meaningful else 88,
    }


def detect_consultant_information_from_page(page: Any) -> dict:
    try:
        words = page.get_text("words") or []
        width = float(page.rect.width)
        height = float(page.rect.height)
    except Exception:
        return {}

    aliases = {
        "ARCHITECT": "ARCHITECT",
        "CIVIL": "CIVIL",
        "LANDSCAPE": "LANDSCAPE",
        "LANSCAPE": "LANDSCAPE",
        "STRUCTURE": "STRUCTURE",
        "STRUCTURAL": "STRUCTURE",
        "MEP": "MEP",
        "MECHANICAL": "MECHANICAL",
        "ELECTRICAL": "ELECTRICAL",
        "PLUMBING": "PLUMBING",
    }
    design_team_bottom = _design_team_bottom(words)
    headings = []
    for word in words:
        if len(word) < 5:
            continue
        label = aliases.get(str(word[4]).upper())
        center_y = (float(word[1]) + float(word[3])) / 2
        center_x = (float(word[0]) + float(word[2])) / 2
        if (
            label
            and center_y >= height * 0.54
            and center_x <= width * 0.78
            and (design_team_bottom is None or center_y > design_team_bottom)
        ):
            headings.append((label, word))
    if not headings:
        return {}

    deduped = {}
    for label, word in headings:
        deduped.setdefault(label, word)
    ordered = sorted(deduped.items(), key=lambda item: float(item[1][0]))
    sections = []
    for index, (label, heading) in enumerate(ordered):
        center_x = (float(heading[0]) + float(heading[2])) / 2
        left = 0 if index == 0 else (center_x + (float(ordered[index - 1][1][0]) + float(ordered[index - 1][1][2])) / 2) / 2
        right = width * 0.80 if index == len(ordered) - 1 else (center_x + (float(ordered[index + 1][1][0]) + float(ordered[index + 1][1][2])) / 2) / 2
        y0 = float(heading[1])
        y1 = float(heading[3])
        values = []
        seen = set()
        for word in sorted(words, key=lambda item: (round(float(item[1]), 1), float(item[0]))):
            if len(word) < 5:
                continue
            word_center_x = (float(word[0]) + float(word[2])) / 2
            word_center_y = (float(word[1]) + float(word[3])) / 2
            value = str(word[4]).strip()
            identity = (round(float(word[0]), 1), round(float(word[1]), 1), value)
            above_min_y = max((design_team_bottom or 0) + 4, y0 - height * 0.18)
            in_below_block = y1 + 5 <= word_center_y <= min(y1 + height * 0.14, height * 0.94)
            in_above_block = above_min_y <= word_center_y <= y0 - 5
            if (
                left <= word_center_x <= right
                and (in_below_block or in_above_block)
                and value.upper() not in aliases
                and identity not in seen
            ):
                values.append(value)
                seen.add(identity)
        evidence = " ".join(values)
        placeholder_tokens = {"FIRM", "NAME", "TBD", "NA", "NONE", "PLACEHOLDER"}
        meaningful = [
            token for token in re.findall(r"\b[A-Za-z]{2,}\b", evidence)
            if token.upper() not in placeholder_tokens
        ]
        populated = len(meaningful) >= 2 or bool(re.search(r"\d{3}[\s).-]*\d{3}[\s.-]*\d{4}", evidence))
        sections.append({
            "discipline": label,
            "populated": populated,
            "evidence": evidence[:160] if populated else "",
        })
    return {
        "sections": sections,
        "missing_disciplines": [item["discipline"] for item in sections if not item["populated"]],
        "confidence": 88,
    }


def _design_team_bottom(words: list) -> float | None:
    for first in words:
        if len(first) < 5 or str(first[4]).upper() != "DESIGN":
            continue
        for second in words:
            if len(second) < 5 or str(second[4]).upper() not in {"TEAM", "CONSULTANT"}:
                continue
            same_line = abs(float(first[1]) - float(second[1])) <= 12
            close = 0 <= float(second[0]) - float(first[2]) <= 160
            if same_line and close:
                return max(float(first[3]), float(second[3]))
    return None


def _sheet_index_top(words: list) -> float | None:
    for first in words:
        if len(first) < 5 or str(first[4]).upper() != "SHEET":
            continue
        for second in words:
            if len(second) < 5 or str(second[4]).upper() != "INDEX":
                continue
            same_line = abs(float(first[1]) - float(second[1])) <= 8
            close = 0 <= float(second[0]) - float(first[2]) <= 80
            if same_line and close:
                return min(float(first[1]), float(second[1]))
    return None


def detect_cover_visuals_from_page(page: Any) -> dict:
    try:
        words = page.get_text("words") or []
        width = float(page.rect.width)
        height = float(page.rect.height)
    except Exception:
        return {}

    large_title_words = [
        word
        for word in words
        if len(word) >= 5
        and float(word[1]) <= height * 0.24
        and float(word[2]) <= width * 0.82
        and float(word[3]) - float(word[1]) >= height * 0.075
        and re.search(r"[A-Za-z]{2,}", str(word[4]))
    ]
    title_evidence = " ".join(str(word[4]) for word in sorted(large_title_words, key=lambda item: float(item[0])))[:160]
    title_ink_ratio = _upper_title_ink_ratio(page, width, height)
    title_present = bool(large_title_words) or title_ink_ratio >= 0.02
    if not title_evidence and title_present:
        title_evidence = "Large outlined title lettering in upper cover area"

    try:
        image_info = page.get_image_info(xrefs=True) or []
    except Exception:
        image_info = []
    xref_counts = Counter(int(item.get("xref") or 0) for item in image_info)
    repeated_background_xrefs = {xref for xref, count in xref_counts.items() if xref and count >= 8}

    central_images = [
        item for item in image_info
        if int(item.get("xref") or 0) not in repeated_background_xrefs
        and _bbox_intersects(item.get("bbox"), (0, height * 0.20, width * 0.68, height * 0.72))
    ]
    map_images = [
        item for item in image_info
        if _bbox_center_in(item.get("bbox"), (width * 0.48, height * 0.68, width * 0.80, height * 0.94))
        and _bbox_area_ratio(item.get("bbox"), width, height) >= 0.015
    ]
    text = " ".join(str(word[4]) for word in words)
    return {
        "large_project_title_present": title_present,
        "large_project_title_evidence": title_evidence,
        "central_project_image_present": len(central_images) >= 3,
        "central_project_image_evidence": f"{len(central_images)} image regions in central cover area",
        "vicinity_map_present": bool(map_images) or bool(re.search(r"\b(?:VICINITY|LOCATION|SITE\s+LOCATION)\b", text, re.IGNORECASE)),
        "vicinity_map_evidence": "Site-location map region" if map_images else "Site-location label",
        "confidence": 88,
    }


def _upper_title_ink_ratio(page: Any, width: float, height: float) -> float:
    try:
        import fitz

        clip = fitz.Rect(width * 0.06, height * 0.02, width * 0.72, height * 0.17)
        pixmap = page.get_pixmap(
            matrix=fitz.Matrix(0.5, 0.5),
            clip=clip,
            colorspace=fitz.csGRAY,
            alpha=False,
        )
        samples = pixmap.samples
    except Exception:
        return 0
    if not samples:
        return 0
    return sum(value < 180 for value in samples) / len(samples)


def _detect_unlabelled_owner_contact(page: Any, words: list[Any]) -> dict:
    try:
        width = float(page.rect.width)
        height = float(page.rect.height)
    except Exception:
        return {"section_present": False, "populated": False, "evidence": "", "confidence": 0}

    contact_words = [
        word for word in words
        if len(word) >= 5
        and width * 0.58 <= (float(word[0]) + float(word[2])) / 2 <= width * 0.77
        and height * 0.67 <= (float(word[1]) + float(word[3])) / 2 <= height * 0.82
    ]
    values: list[str] = []
    seen: set[tuple[float, float, str]] = set()
    for word in sorted(contact_words, key=lambda item: (round(float(item[1]), 1), float(item[0]))):
        value = str(word[4]).strip()
        identity = (round(float(word[0]), 1), round(float(word[1]), 1), value)
        if value and identity not in seen:
            values.append(value)
            seen.add(identity)
    evidence = " ".join(values)
    has_phone = bool(re.search(r"(?:\(?\d{3}\)?[\s.-]*)?\d{3}[\s.-]*\d{4}", evidence))
    has_address = bool(re.search(r"\b\d{3,6}\b", evidence) and re.search(r"\b(?:STREET|ST\.?|ROAD|RD\.?|AVENUE|AVE\.?|DRIVE|DR\.?|TX|TEXAS)\b", evidence, re.IGNORECASE))
    has_identity = len(re.findall(r"\b[A-Za-z]{3,}\b", evidence)) >= 4
    populated = has_identity and (has_phone or has_address)
    if not populated:
        project_match = _detect_project_title_owner_match(page, words)
        if project_match.get("populated"):
            return project_match
    return {
        "section_present": populated,
        "populated": populated,
        "evidence": evidence[:180] if populated else "",
        "confidence": 84 if populated else 0,
    }


def _detect_project_title_owner_match(page: Any, words: list[Any]) -> dict:
    try:
        width = float(page.rect.width)
        height = float(page.rect.height)
    except Exception:
        return {"section_present": False, "populated": False, "evidence": "", "confidence": 0}

    top_tokens = {
        re.sub(r"[^A-Z0-9]", "", str(word[4]).upper())
        for word in words
        if len(word) >= 5
        and float(word[1]) <= height * 0.28
        and float(word[2]) <= width * 0.78
        and len(re.sub(r"[^A-Z0-9]", "", str(word[4]))) >= 3
    }
    top_tokens -= {
        "PROJECT", "CAMPUS", "BUILDING", "SERVICES", "COVER", "SHEET", "CIVIL",
        "CONSTRUCTION", "PLANS", "PHASE", "CENTER", "RENOVATION",
    }
    if not top_tokens:
        return {"section_present": False, "populated": False, "evidence": "", "confidence": 0}

    bottom_words = [
        word for word in words
        if len(word) >= 5
        and height * 0.55 <= (float(word[1]) + float(word[3])) / 2 <= height * 0.88
        and float(word[2]) <= width * 0.90
    ]
    bottom_values = [str(word[4]).strip() for word in bottom_words if str(word[4]).strip()]
    bottom_tokens = {re.sub(r"[^A-Z0-9]", "", value.upper()) for value in bottom_values}
    matches = sorted(token for token in top_tokens if token in bottom_tokens)
    strong_match = len(matches) >= 2 or any(len(token) >= 7 for token in matches)
    if not strong_match:
        return {"section_present": False, "populated": False, "evidence": "", "confidence": 0}
    return {
        "section_present": True,
        "populated": True,
        "evidence": f"Bottom project/owner block matches project title: {', '.join(matches[:4])}",
        "confidence": 86,
        "source": "project_title_match",
    }


def _bbox_values(bbox: Any) -> tuple[float, float, float, float] | None:
    try:
        return tuple(map(float, bbox[:4]))
    except (TypeError, ValueError):
        return None


def _bbox_intersects(bbox: Any, region: tuple[float, float, float, float]) -> bool:
    values = _bbox_values(bbox)
    if not values:
        return False
    x0, y0, x1, y1 = values
    rx0, ry0, rx1, ry1 = region
    return x1 > rx0 and x0 < rx1 and y1 > ry0 and y0 < ry1


def _bbox_center_in(bbox: Any, region: tuple[float, float, float, float]) -> bool:
    values = _bbox_values(bbox)
    if not values:
        return False
    x0, y0, x1, y1 = values
    rx0, ry0, rx1, ry1 = region
    center_x = (x0 + x1) / 2
    center_y = (y0 + y1) / 2
    return rx0 <= center_x <= rx1 and ry0 <= center_y <= ry1


def _bbox_area_ratio(bbox: Any, width: float, height: float) -> float:
    values = _bbox_values(bbox)
    if not values or width <= 0 or height <= 0:
        return 0
    x0, y0, x1, y1 = values
    return max(0, x1 - x0) * max(0, y1 - y0) / (width * height)


def _owner_information_checks(cover: dict) -> tuple[Detection, Detection]:
    geometry = cover.get("owner_information") or {}
    if geometry:
        section_present = bool(geometry.get("section_present"))
        populated = bool(geometry.get("populated"))
        evidence = str(geometry.get("evidence") or "")
        section = Detection(
            "Pass" if section_present else "Needs Review",
            float(geometry.get("confidence") or 75),
            "OWNER" if section_present else "",
            "" if section_present else "Owner information section was not confidently detected.",
        )
        populated_check = Detection(
            "Pass" if populated else "Fail",
            float(geometry.get("confidence") or 80),
            evidence if populated else "",
            "" if populated else "OWNER heading was found, but no owner name, address, or contact information was detected in the owner block.",
        )
        return section, populated_check

    text = str(cover.get("text") or "")
    section = _keyword_check("Owner information section present", text, [r"\bOWNER\b", r"\bCLIENT\b"], 75)
    match = re.search(r"\b(?:OWNER|CLIENT)\b[ \t]*[:.-]?[ \t]+([^\n]{3,120})", text, re.IGNORECASE)
    populated = bool(match and re.search(r"[A-Za-z]{3,}", match.group(1)))
    if section.status != "Pass":
        return section, Detection(
            "Needs Review",
            60,
            "",
            "Owner information could not be checked because the owner section was not confidently detected.",
        )
    return section, Detection(
        "Pass" if populated else "Fail",
        65 if populated else 70,
        match.group(0)[:120] if populated and match else "",
        "" if populated else "OWNER heading was found, but no owner information was detected on the same line.",
    )


def _consultant_entries_check(cover: dict) -> Detection:
    geometry = cover.get("consultant_information") or {}
    sections = geometry.get("sections") or []
    if sections:
        missing = geometry.get("missing_disciplines") or []
        populated = [item["discipline"] for item in sections if item.get("populated")]
        if missing:
            return Detection(
                "Fail",
                float(geometry.get("confidence") or 85),
                f"Populated: {', '.join(populated)}" if populated else "",
                f"{', '.join(missing)} header(s) found with no consultant information underneath.",
            )
        return Detection(
            "Pass",
            float(geometry.get("confidence") or 85),
            f"Populated consultant sections: {', '.join(populated)}",
        )
    text = str(cover.get("text") or "")
    return _keyword_check(
        "Consultant entries populated",
        text,
        [r"\b(?:CIVIL|STRUCTURAL|MECHANICAL|ELECTRICAL|PLUMBING|LANDSCAPE)\b"],
        70,
    )


def _keyword_check(label: str, text: str, patterns: list[str], minimum_confidence: float) -> Detection:
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
        if match:
            evidence = re.sub(r"\s+", " ", match.group(0)).strip()[:120]
            return Detection("Pass", minimum_confidence, evidence)
    return Detection("Needs Review", 35, "", f"{label} was not confidently detected.")


def _visual_check(
    visuals: dict,
    key: str,
    evidence_label: str,
    comments: str,
    fallback: Any,
    missing_status: str = "Needs Review",
) -> Detection:
    if key not in visuals:
        return fallback()
    present = bool(visuals.get(key))
    evidence = str(visuals.get(key.replace("_present", "_evidence")) or evidence_label)
    return Detection(
        "Pass" if present else missing_status,
        float(visuals.get("confidence") or 80),
        evidence if present else "",
        "" if present else comments,
    )


def _issue_label_check(text: str) -> Detection:
    revision_table = re.search(
        r"\bNo\.?\s+DESCRIPTION\s+DATE\b.{0,240}\b(?:\d+\s+)?(?:\d{2,3}%\s+)?(?:BID|PERMIT|PROGRESS|CONSTRUCTION|ISSUED?|SUBMISSION|ADDENDUM)\b.{0,120}"
        r"(?:\d{1,2}[./-]\d{1,2}[./-](?:\d{2}|20\d{2})|20\d{2}[./-]\d{1,2}[./-]\d{1,2})",
        text,
        re.IGNORECASE | re.DOTALL,
    )
    if revision_table:
        evidence = re.sub(r"\s+", " ", revision_table.group(0)).strip()[:120]
        return Detection("Pass", 82, evidence)
    official_label = OFFICIAL_RE.search(text)
    any_date = DATE_RE.search(text)
    if official_label and any_date:
        return Detection("Pass", 84, f"{official_label.group(0)} {any_date.group(0)}")
    issue_words = re.search(r"\b(?:ISSUED?\s+FOR|ISSUE|DELTA|REVISION|SUBMISSION|PERMIT|PROGRESS|BID\s+SET|BID|ADDENDUM|DESCRIPTION\s+DATE)\b", text, re.IGNORECASE)
    if issue_words:
        nearby = text[issue_words.start() : issue_words.end() + 180]
        date = DATE_RE.search(nearby)
        if date:
            return Detection("Pass", 82, f"{issue_words.group(0)} {date.group(0)}")
        return Detection("Needs Review", 55, issue_words.group(0), "Issue label found without a nearby readable date.")
    return Detection("Fail", 60, "", "Submission delta or issue label with date was not detected.")


def _set_type_marker_check(set_type: str, has_seal: bool, has_nfc: bool) -> Detection:
    if set_type == "Official":
        return Detection("Pass" if has_seal else "Fail", 90 if has_seal else 80, "Professional seal signal" if has_seal else "", "Official permit/construction sets require a professional seal.")
    if set_type == "Non-Official":
        return Detection("Pass" if has_nfc else "Fail", 88 if has_nfc else 78, "NFC/progress marker" if has_nfc else "", "SD/DD/progress sets require a prominent NFC or progress marker.")
    return Detection("Needs Review", 40, "", "Set type could not be classified.")


def _detect_issue_label(text: str) -> str:
    match = re.search(r"\b(?:ISSUED?\s+FOR|ISSUE|DELTA|REVISION|SUBMISSION|PERMIT|PROGRESS|BID\s+SET|BID|ADDENDUM|DESCRIPTION\s+DATE)\b.{0,120}", text, re.IGNORECASE | re.DOTALL)
    return re.sub(r"\s+", " ", match.group(0)).strip() if match else ""
