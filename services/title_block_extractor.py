from __future__ import annotations

import re
from typing import Any

SHEET_NUMBER_RE = re.compile(
    r"\b(?:ADA|CS(?:[- .]?\d{1,4})?|(?:G|A|AD|ADA|AS|B|D|I|ID|IR|LS|L|C|S|SD|M|MD|MG|MP|MS|P|PD|PP|E|ED|EG|EL|EP|ES|FP|FA|T|MEP|MEPD|FS|SP)[- .]?\d{1,4}(?:\.\d+)?(?:[-.]\d+)?[A-Z]?)\b",
    re.IGNORECASE,
)
LOOSE_SHEET_NUMBER_RE = re.compile(r"\b[A-Z]{1,5}[- ]?\d{1,4}(?:\.\d+)?(?:[-.]\d+)?[A-Z]?\b", re.IGNORECASE)
SPACED_SHEET_NUMBER_RE = re.compile(
    r"\b([A-Z]{1,4})\s*[-–—]?\s*(\d{1,4})\s*(?:[.]\s*(\d{1,3}))?\s*([A-Z]?)\b",
    re.IGNORECASE,
)
SHEET_NUMBER_LABEL_RE = re.compile(
    r"\b(?:SHEET\s*(?:NO\.?|NUMBER|#)|SHEET\s+ID|DRAWING\s*(?:NO\.?|NUMBER|#))\b",
    re.IGNORECASE,
)
GENERIC_PREFIX_DENYLIST = {
    "TAS", "IBC", "ANSI", "NFPA", "UL", "ASTM",
    "R", "FT", "TOP", "OF", "PVB", "SH", "LOT", "BLK",
}
TITLE_LABEL_RE = re.compile(r"\b(?:SHEET\s+TITLE|DRAWING\s+TITLE|SHEET\s+NAME|DRAWING\s+NAME)\b", re.IGNORECASE)
TITLE_STOPWORDS_RE = re.compile(
    r"\b(?:PROJECT|OWNER|CLIENT|ARCHITECT|ENGINEER|CONSULTANT|DRAWN|CHECKED|DATE|SCALE|"
    r"REVISION|SHEET|NUMBER|NO\.?|TITLE|ISSUE|ISSUED|SEAL|STAMP|LICENSE|COPYRIGHT)\b",
    re.IGNORECASE,
)
TITLE_METADATA_RE = re.compile(
    r"(?:"
    r"\b\d{3,6}\s+[A-Z0-9 .'-]+(?:AVE|AVENUE|BLVD|BOULEVARD|ST|STREET|RD|ROAD|DR|DRIVE|LN|LANE|HWY|HIGHWAY)\b|"
    r"\b[A-Z .'-]+,?\s+(?:TX|TEXAS)\s+\d{5}(?:-\d{4})?\b|"
    r"\b(?:SUITE|STE\.?|P\.?O\.?\s*BOX)\s+\w+\b|"
    r"\b(?:PROJECT|JOB)\s*(?:NO\.?|NUMBER|#)?\s*\d{2,5}[-.]\d{2,5}\b|"
    r"\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|"
    r"\b\d{4}[-.]\d{3,5}\b|"
    r"\b(?:TBPELS|FIRM\s+REGISTRATION)\b|"
    r"\b(?:KNOW\s+WHAT'?S\s+BELOW|BEFORE\s+YOU\s+DIG|PRIOR\s+TO\s+DIGGING)\b|"
    r"@|"
    r"\b(?:COPYRIGHT|DO NOT REPRODUCE|SAM GARCIA ARCHITECT|INFO@)\b"
    r")",
    re.IGNORECASE,
)


def extract_title_block_text(page: Any) -> str:
    import fitz

    rect = page.rect
    clips = [
        fitz.Rect(rect.x0 + rect.width * 0.55, rect.y0 + rect.height * 0.55, rect.x1, rect.y1),
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


def detect_sheet_number(text: str) -> tuple[str, float]:
    labeled = detect_sheet_number_near_label(text)
    if labeled[0]:
        return labeled

    return "", 0


def detect_sheet_number_from_title_block_geometry(page: Any) -> tuple[str, float]:
    try:
        words = page.get_text("words") or []
    except Exception:
        return "", 0
    return _sheet_number_from_words(words, page.rect)


def detect_visual_title_sheet_number(page: Any) -> dict[str, Any]:
    """Detect large raster/vector sheet-number glyphs in the title block.

    Some consultant sheets print the title block number as outlines that are not
    exposed in the PDF text layer. This does not read the number; it only
    confirms that the title-number box contains large dark glyphs.
    """
    try:
        import fitz
        import numpy as np

        rect = page.rect
        clip = fitz.Rect(rect.width * 0.72, rect.height * 0.88, rect.width * 0.98, rect.height * 0.98)
        pixmap = page.get_pixmap(matrix=fitz.Matrix(1, 1), clip=clip, alpha=False)
        pixels = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, 3)
    except Exception:
        return {"present": False, "source": "visual_title_number"}

    gray = pixels.mean(axis=2)
    dark_pixels = int((gray < 80).sum())
    ink_pixels = int((gray < 120).sum())
    present = dark_pixels >= 5500 and ink_pixels >= 6500
    return {
        "present": bool(present),
        "source": "visual_title_number",
        "confidence": 82 if present else 0,
        "evidence": "Large dark glyphs in lower-right sheet-number box." if present else "",
        "dark_pixel_count": dark_pixels,
        "ink_pixel_count": ink_pixels,
    }


def detect_sheet_number_from_page_label(page: Any) -> tuple[str, float]:
    label = _page_label_text(page)
    label = label.replace("\x00", " ").strip()
    if re.fullmatch(r"cover(?:\s+sheet)?", label, re.IGNORECASE):
        return "COVER", 97
    named_cover = re.match(r"\b(CS-[A-Z][A-Z0-9-]{2,})\b", label, re.IGNORECASE)
    if named_cover:
        return _normalize_sheet_candidate(named_cover.group(1)), 97
    alpha_label = re.match(r"\b(SI)\b\s*[-:]", label, re.IGNORECASE)
    if alpha_label:
        return alpha_label.group(1).upper(), 97
    candidates = _sheet_number_candidates(label, allow_loose=True, allow_spaced=True, reject_generic_noise=False)
    if candidates:
        return candidates[0], 97
    normalized = _normalize_sheet_candidate(label)
    if _valid_title_block_sheet_candidate(normalized):
        return normalized, 97
    return "", 0


def detect_sheet_number_near_label(text: str) -> tuple[str, float]:
    for label in SHEET_NUMBER_LABEL_RE.finditer(text):
        nearby = text[label.end() : label.end() + 180]
        candidates = _sheet_number_candidates(nearby, allow_loose=True, allow_spaced=True, reject_generic_noise=False)
        if candidates:
            return candidates[0], 96
    lines = clean_lines(text)
    for index, line in enumerate(lines):
        if SHEET_NUMBER_LABEL_RE.search(line):
            nearby = " ".join(lines[index + 1 : index + 5])
            candidates = _sheet_number_candidates(nearby, allow_loose=True, allow_spaced=True, reject_generic_noise=False)
            if candidates:
                return candidates[0], 96
    return "", 0


def detect_sheet_name(text: str, sheet_number: str = "") -> tuple[str, float]:
    lines = clean_lines(text)
    if TITLE_LABEL_RE.search(text):
        label_match = TITLE_LABEL_RE.search(text)
        after_label = text[label_match.end() : label_match.end() + 180] if label_match else ""
        for line in clean_lines(after_label):
            candidate = clean_title_candidate(line, sheet_number)
            if candidate:
                return candidate, 82

    for index, line in enumerate(lines):
        compact_line = re.sub(r"[^A-Za-z0-9.]", "", line).upper()
        compact_sheet = re.sub(r"[^A-Za-z0-9.]", "", sheet_number).upper()
        if compact_sheet and compact_sheet in compact_line:
            for offset, nearby in enumerate(lines[index + 1 : index + 8], start=1):
                candidate = clean_title_candidate(nearby, sheet_number)
                if not candidate:
                    continue
                next_line = lines[index + offset + 1] if index + offset + 1 < len(lines) else ""
                combined = clean_title_candidate(f"{nearby} {next_line}", sheet_number)
                if combined and _looks_like_split_sheet_title(candidate, clean_title_candidate(next_line, sheet_number)):
                    return combined, 72
                return candidate, 68

    candidates = [clean_title_candidate(line, sheet_number) for line in lines]
    candidates = [candidate for candidate in candidates if candidate]
    if not candidates:
        return "", 0
    return max(candidates, key=len), 48


def extract_title_block(page: Any, page_text: str) -> dict[str, Any]:
    title_block_text = extract_title_block_text(page)
    sheet_number, number_confidence = detect_sheet_number(title_block_text)
    geometry_number, geometry_confidence = detect_sheet_number_from_title_block_geometry(page)
    visual_title_number = detect_visual_title_sheet_number(page)
    label_number, label_confidence = detect_sheet_number_from_page_label(page)
    label_text = _page_label_text(page)
    label_sheet_name = _sheet_name_from_page_label(label_text, label_number)
    if _label_si_is_structural_s1(label_text, title_block_text, page_text):
        label_number = "S1"
        label_text = "S1 - GENERAL NOTES"
        label_sheet_name = _sheet_name_from_page_label("S1 - GENERAL NOTES", label_number)
    if geometry_number and geometry_confidence >= number_confidence:
        sheet_number, number_confidence = geometry_number, geometry_confidence
    if sheet_number == "COVER" and label_number and label_number != "COVER":
        sheet_number, number_confidence = label_number, min(label_confidence, 92)
    if sheet_number and label_number and _sheet_numbers_equivalent(sheet_number, label_number):
        number_confidence = max(number_confidence, min(label_confidence, 97))
    if not sheet_number:
        sheet_number, number_confidence = detect_sheet_number(page_text[:3000])
    sheet_name, title_confidence = detect_sheet_name(title_block_text, sheet_number)
    if not sheet_number:
        sheet_name, title_confidence = "", 0
    elif not sheet_name:
        sheet_name, title_confidence = detect_sheet_name(f"{title_block_text}\n{page_text[:3000]}", sheet_number)
    if label_sheet_name and sheet_number and label_number and _sheet_numbers_equivalent(sheet_number, label_number):
        sheet_name, title_confidence = label_sheet_name, max(title_confidence, 82)
    elif (
        sheet_number
        and label_number
        and _sheet_numbers_equivalent(sheet_number, label_number)
        and _clean_civil_page_label_in_stamp_context(label_text, title_block_text, page_text)
    ):
        sheet_name, title_confidence = "", 0
    cover_label_name = _named_cover_sheet_name(sheet_number, title_block_text, page_text)
    if cover_label_name:
        sheet_name, title_confidence = cover_label_name, max(title_confidence, 80)
    if sheet_number == "COVER":
        sheet_name, title_confidence = "COVER", max(title_confidence, 97)
    confidence = max(number_confidence, 0) * 0.65 + max(title_confidence, 0) * 0.35
    return {
        "title_block_text": title_block_text,
        "sheet_number": sheet_number,
        "sheet_name": sheet_name,
        "page_label_text": label_text,
        "page_label_sheet_number": label_number,
        "page_label_confidence": label_confidence,
        "visual_title_sheet_number": visual_title_number,
        "confidence": round(confidence, 1),
        "needs_review": confidence < 60 or not sheet_number,
    }


def _text_is_sparse_title_block(text: str) -> bool:
    return sum(char.isalnum() for char in text or "") < 40


def _page_label_text(page: Any) -> str:
    try:
        return (page.get_label() or "").replace("\x00", " ").replace("\\000", " ").strip()
    except Exception:
        return ""


def _sheet_numbers_equivalent(left: str, right: str) -> bool:
    return re.sub(r"[^A-Z0-9]", "", left.upper()) == re.sub(r"[^A-Z0-9]", "", right.upper())


def _label_context_supports_sheet_number(label: str, title_block_text: str, page_text: str) -> bool:
    label = (label or "").replace("\x00", " ").strip()
    if not label:
        return False
    if re.match(r"\bCS-[A-Z][A-Z0-9-]{2,}\b", label, re.IGNORECASE):
        context = f"{title_block_text}\n{page_text[:3000]}".upper()
        return bool(re.search(r"\b(?:SHEET\s+INDEX|COVER\s+SHEET|CONSTRUCTION\s+PLAN|CIVIL)\b", context))
    clean_label = _normalize_sheet_candidate(label)
    if re.fullmatch(r"C-?\d{1,4}(?:\.\d{1,3})?(?:-\d{1,3})?[A-Z]?", clean_label):
        return _clean_civil_page_label_in_stamp_context(label, title_block_text, page_text)
    descriptive_match = re.match(r"^[A-Z]{1,5}[- ]?\d{1,4}(?:\.\d+)?(?:[-.]\d+)?[A-Z]?\s*[-:]\s*(.+)$", label, re.IGNORECASE)
    if not descriptive_match:
        return False
    description = clean_title_candidate(descriptive_match.group(1), "")
    if not description:
        return False
    context_compact = re.sub(r"[^A-Z0-9]", "", f"{title_block_text}\n{page_text[:3000]}".upper())
    description_compact = re.sub(r"[^A-Z0-9]", "", description.upper())
    return bool(description_compact and description_compact in context_compact)


def _clean_civil_page_label_in_stamp_context(label: str, title_block_text: str, page_text: str) -> bool:
    clean_label = _normalize_sheet_candidate(label)
    if not re.fullmatch(r"C-?\d{1,4}(?:\.\d{1,3})?(?:-\d{1,3})?[A-Z]?", clean_label):
        return False
    context = f"{title_block_text}\n{page_text[:3000]}".upper()
    return bool(re.search(r"\b(?:TBPELS|FIRM\s+REGISTRATION|SOTEX|KNOW\s+WHAT'?S\s+BELOW)\b", context))


def _sheet_name_from_page_label(label: str, sheet_number: str) -> str:
    if not label or not sheet_number:
        return ""
    alpha_match = re.match(r"^(SI)\s*[-:]\s*(.+)$", label, re.IGNORECASE)
    if alpha_match and sheet_number.upper() == alpha_match.group(1).upper():
        return clean_title_candidate(alpha_match.group(2), sheet_number)
    match = re.match(r"^[A-Z]{1,5}[- ]?\d{1,4}(?:\.\d+)?(?:[-.]\d+)?[A-Z]?\s*[-:]\s*(.+)$", label, re.IGNORECASE)
    if not match:
        return ""
    return clean_title_candidate(match.group(1), sheet_number)


def _label_si_is_structural_s1(label: str, title_block_text: str, page_text: str) -> bool:
    if _normalize_sheet_candidate(label).split("-")[0] != "SI":
        return False
    context = f"{label}\n{title_block_text}\n{page_text[:3000]}".upper()
    return bool(
        re.search(r"\bGENERAL\s+NOTES\b", context)
        and re.search(r"\b(?:TREVI(?:N|Ñ)O\s+ENGINEERING|STRUCTURAL|FIRM\s+NO\.\s*F-7906)\b", context)
    )


def _named_cover_sheet_name(sheet_number: str, title_block_text: str, page_text: str) -> str:
    if not re.fullmatch(r"CS-[A-Z][A-Z0-9-]{2,}", sheet_number or ""):
        return ""
    context = f"{title_block_text}\n{page_text[:3000]}".upper()
    if re.search(r"\bCIVIL\s+CONSTRUCTION\s+PLAN\b", context):
        return "CIVIL CONSTRUCTION PLAN"
    if re.search(r"\bCOVER\s+SHEET\b", context):
        return "COVER SHEET"
    return ""


def _sheet_number_candidates(
    text: str,
    *,
    allow_loose: bool,
    allow_spaced: bool = False,
    reject_generic_noise: bool = True,
) -> list[str]:
    values: list[str] = []
    patterns = [SHEET_NUMBER_RE]
    if allow_loose:
        patterns.append(LOOSE_SHEET_NUMBER_RE)
    for pattern in patterns:
        for match in pattern.finditer(text):
            normalized = _normalize_sheet_candidate(match.group(0))
            if _valid_sheet_candidate(normalized, reject_generic_noise=reject_generic_noise):
                values.append(normalized)
    if allow_spaced:
        for match in SPACED_SHEET_NUMBER_RE.finditer(text):
            prefix, number, decimal, suffix = match.groups()
            value = f"{prefix}{number}"
            if "-" in match.group(0) or prefix.upper() in {"C", "S"}:
                value = f"{prefix}-{number}"
            if decimal:
                value += f".{decimal}"
            if suffix:
                value += suffix
            normalized = _normalize_sheet_candidate(value)
            if _valid_sheet_candidate(normalized, reject_generic_noise=reject_generic_noise):
                values.append(normalized)
        for line in clean_lines(text):
            compacted = _compact_spaced_sheet_text(line)
            if compacted == line:
                continue
            values.extend(
                _sheet_number_candidates(
                    compacted,
                    allow_loose=True,
                    allow_spaced=False,
                    reject_generic_noise=reject_generic_noise,
                )
            )
    deduped: list[str] = []
    for value in values:
        if value not in deduped:
            deduped.append(value)
    return sorted(deduped, key=len, reverse=True)


def _normalize_sheet_candidate(value: str) -> str:
    cleaned = re.sub(r"\s+", "", value.upper())
    cleaned = cleaned.replace("–", "-").replace("—", "-")
    cleaned = re.sub(r"[^A-Z0-9.-]", "", cleaned)
    cleaned = cleaned.strip(".")
    return cleaned


def _valid_sheet_candidate(value: str, *, reject_generic_noise: bool) -> bool:
    if not value or len(value) > 10:
        return False
    if value in {"SI", "ADA"}:
        return True
    match = re.fullmatch(r"([A-Z]{1,5})[.-]?\d{1,4}(?:\.\d{1,3})?(?:-\d{1,3})?[A-Z]?", value)
    if not match:
        return value in {"CS", "CS1", "COVER"}
    prefix = match.group(1)
    if prefix not in _ALLOWED_SHEET_PREFIXES:
        return False
    if reject_generic_noise and prefix in GENERIC_PREFIX_DENYLIST:
        return False
    return True


def _sheet_number_from_words(words: list[Any], rect: Any) -> tuple[str, float]:
    candidates: list[tuple[str, float]] = []
    width = max(float(getattr(rect, "width", 0) or 0), 1.0)
    height = max(float(getattr(rect, "height", 0) or 0), 1.0)
    for word_index, word in enumerate(words):
        if len(word) < 5:
            continue
        x0, y0, x1, y1, text = word[:5]
        x0, y0, x1, y1 = float(x0), float(y0), float(x1), float(y1)
        center_x = ((x0 + x1) / 2) / width
        center_y = ((y0 + y1) / 2) / height
        if not _in_title_number_zone(center_x, center_y):
            continue
        normalized = _normalize_sheet_candidate(str(text))
        if not _valid_title_block_sheet_candidate(normalized):
            continue
        if _is_code_reference_context(words, word_index):
            continue
        word_height = max(y1 - y0, 0)
        if word_height < height * _minimum_sheet_number_height_ratio(center_x, center_y):
            continue
        score = 55
        score += min((word_height / height) * 500, 25)
        score += max(center_x - 0.70, 0) * 35
        score += max(center_y - 0.52, 0) * 35
        if word_height >= height * 0.045 and (center_y <= 0.20 or center_y >= 0.82):
            score += 20
        if word_height >= height * 0.045 and (center_x <= 0.16 or center_x >= 0.58):
            score += 10
        if center_x >= 0.86 and center_y >= 0.82:
            score += 12
        if word_height >= height * 0.035:
            score += 10
        candidates.append((normalized, min(score, 98)))
    candidates.extend(_sheet_number_from_word_lines(words, width, height))
    if not candidates:
        return "", 0
    candidates.sort(key=lambda item: (item[1], len(item[0])), reverse=True)
    return candidates[0][0], round(candidates[0][1], 1)


def _valid_title_block_sheet_candidate(value: str) -> bool:
    if value in {"CS", "COVER", "SI", "ADA"} or re.fullmatch(r"CS-[A-Z][A-Z0-9-]{2,}", value):
        return True
    if not _valid_sheet_candidate(value, reject_generic_noise=False):
        return False
    match = re.fullmatch(r"([A-Z]{1,5})[.-]?\d{1,4}(?:\.\d{1,3})?(?:-\d{1,3})?[A-Z]?", value)
    if not match:
        return False
    prefix = match.group(1)
    return prefix in _ALLOWED_SHEET_PREFIXES


_ALLOWED_SHEET_PREFIXES = {
    "CS", "G", "A", "AD", "AS", "ADA", "B", "D", "I", "ID", "IR", "LS", "L", "C", "S", "SD",
    "M", "MD", "MG", "MP", "MS", "P", "PD", "PP", "E", "ED", "EG", "EL", "EP", "ES", "FP", "FA", "T", "MEP", "MEPD", "FS", "SP",
}


def _compact_spaced_sheet_text(text: str) -> str:
    compacted = re.sub(r"(?<=[A-Za-z0-9.])\s+(?=[A-Za-z0-9.])", "", text.upper())
    compacted = re.sub(r"\s*[-â€“â€”]\s*", "-", compacted)
    return compacted


def _sheet_number_from_word_lines(words: list[Any], width: float, height: float) -> list[tuple[str, float]]:
    rows: list[list[tuple[float, float, float, float, str]]] = []
    for word in words:
        if len(word) < 5:
            continue
        x0, y0, x1, y1, text = word[:5]
        x0, y0, x1, y1 = float(x0), float(y0), float(x1), float(y1)
        center_x = ((x0 + x1) / 2) / width
        center_y = ((y0 + y1) / 2) / height
        if not _in_title_number_zone(center_x, center_y):
            continue
        token = str(text).strip()
        if not re.fullmatch(r"[A-Za-z0-9.-]{1,8}", token):
            continue
        for row in rows:
            row_y = sum((item[1] + item[3]) / 2 for item in row) / len(row)
            avg_height = sum(item[3] - item[1] for item in row) / len(row)
            if abs(((y0 + y1) / 2) - row_y) <= max(avg_height, y1 - y0) * 0.65:
                row.append((x0, y0, x1, y1, token))
                break
        else:
            rows.append([(x0, y0, x1, y1, token)])

    candidates: list[tuple[str, float]] = []
    for row in rows:
        row = sorted(row, key=lambda item: item[0])
        for start in range(len(row)):
            text = ""
            x0 = row[start][0]
            y0 = row[start][1]
            x1 = row[start][2]
            y1 = row[start][3]
            previous_x1 = row[start][2]
            for item in row[start : start + 8]:
                gap = item[0] - previous_x1
                avg_height = max(item[3] - item[1], y1 - y0, 1)
                if text and gap > avg_height * 1.6:
                    break
                text += item[4]
                x1 = max(x1, item[2])
                y0 = min(y0, item[1])
                y1 = max(y1, item[3])
                previous_x1 = item[2]
                normalized = _normalize_sheet_candidate(text)
                if not _valid_title_block_sheet_candidate(normalized):
                    continue
                if _row_text_looks_like_code_reference(row):
                    continue
                center_x = ((x0 + x1) / 2) / width
                center_y = ((y0 + y1) / 2) / height
                word_height = y1 - y0
                if word_height < height * _minimum_sheet_number_height_ratio(center_x, center_y):
                    continue
                score = 58
                score += min((word_height / height) * 500, 25)
                score += max(center_x - 0.70, 0) * 35
                score += max(center_y - 0.52, 0) * 35
                if word_height >= height * 0.045 and (center_y <= 0.20 or center_y >= 0.82):
                    score += 20
                if word_height >= height * 0.045 and (center_x <= 0.16 or center_x >= 0.58):
                    score += 10
                if center_x >= 0.86 and center_y >= 0.82:
                    score += 12
                candidates.append((normalized, min(score, 96)))
    return candidates


def _in_title_number_zone(center_x: float, center_y: float) -> bool:
    if center_x >= 0.70 and center_y >= 0.52:
        return True
    if center_x >= 0.58 and center_y <= 0.20:
        return True
    if center_x <= 0.18 and center_y >= 0.82:
        return True
    if center_y > 1.0 and center_x <= 0.20:
        return True
    return False


def _minimum_sheet_number_height_ratio(center_x: float, center_y: float) -> float:
    if center_x >= 0.86 and center_y >= 0.82:
        return 0.016
    return 0.018


def _is_code_reference_context(words: list[Any], index: int) -> bool:
    if index < 0:
        return False
    context = " ".join(str(words[position][4]) for position in range(max(0, index - 5), min(len(words), index + 6)) if len(words[position]) >= 5)
    return _text_looks_like_code_reference(context)


def _row_text_looks_like_code_reference(row: list[tuple[float, float, float, float, str]]) -> bool:
    return _text_looks_like_code_reference(" ".join(item[4] for item in row))


def _text_looks_like_code_reference(text: str) -> bool:
    return bool(
        re.search(r"\b(?:ASME|TAS|ADA|ANSI|IBC|NFPA|ASTM|UL|SECTION|FIGURE|FIG\.?)\b", text, re.IGNORECASE)
    )


def clean_lines(text: str) -> list[str]:
    return [re.sub(r"\s+", " ", line).strip(" :-\t") for line in text.splitlines() if line.strip()]


def clean_title_candidate(line: str, sheet_number: str) -> str:
    candidate = re.sub(r"\s+", " ", line.replace("\x00", " ").replace("\\000", " ")).strip(" :-\t")
    if sheet_number:
        candidate = re.sub(rf"\b{re.escape(sheet_number)}\b", "", candidate, flags=re.IGNORECASE).strip(" :-\t")
    if len(candidate) < 4 or len(candidate) > 90:
        return ""
    if TITLE_METADATA_RE.search(candidate):
        return ""
    if TITLE_STOPWORDS_RE.fullmatch(candidate) or SHEET_NUMBER_RE.fullmatch(candidate) or LOOSE_SHEET_NUMBER_RE.fullmatch(candidate):
        return ""
    if re.search(r"\bNO\s+SHEET\s+NUMBER\b", candidate, re.IGNORECASE):
        return ""
    if sum(char.isalpha() for char in candidate) < 4:
        return ""
    return candidate.upper()


def _looks_like_split_sheet_title(first: str, second: str) -> bool:
    if not first or not second:
        return False
    if len(first.split()) > 3 or len(second.split()) > 3:
        return False
    combined = f"{first} {second}"
    return 8 <= len(combined) <= 60
