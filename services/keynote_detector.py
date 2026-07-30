from __future__ import annotations

import re
from collections import Counter
from typing import Any


KEYNOTE_SYMBOL_RE = re.compile(r"\bKEYNOTE\s*(\d{1,3})\b", re.IGNORECASE)
KEYNOTE_SECTION_LABEL = (
    r"(?:SHEET|PLAN|DEMOLITION(?:\s+PLAN)?|CONSTRUCTION(?:\s+PLAN)?|"
    r"FLOOR\s+PLAN|ROOF\s+PLAN|REFLECTED\s+CEILING\s+PLAN)\s+KEYNOTES"
)
SHEET_KEYNOTES_RE = re.compile(rf"\b{KEYNOTE_SECTION_LABEL}\b", re.IGNORECASE)
KEYNOTE_LEGEND_RE = re.compile(rf"\b(?:{KEYNOTE_SECTION_LABEL}|KEYNOTE\s+LEGEND)\b", re.IGNORECASE)
KEYNOTE_ENTRY_RE = re.compile(
    r"(?:^|\s)(?P<number>\d{1,3})\s*[\).:-]\s*(?P<text>.*?)(?=(?:\s+\d{1,3}\s*[\).:-]\s*)|$)",
    re.IGNORECASE | re.DOTALL,
)
SECTION_STOP_RE = re.compile(
    r"\b(?:GENERAL\s+NOTES|DEMOLITION\s+NOTES|PLAN\s+NOTES|CONSTRUCTION\s+NOTES|LEGEND|ABBREVIATIONS|SHEET\s+INDEX)\b",
    re.IGNORECASE,
)


def has_sheet_keynotes_section(text: str) -> bool:
    for match in SHEET_KEYNOTES_RE.finditer(text):
        before = text[max(0, match.start() - 24) : match.start()].upper()
        if re.search(r"\b(?:NO|WITHOUT|LACKS?)\s+$", before):
            continue
        return True
    return False


def has_placeholder_only_keynote_section(text: str) -> bool:
    start = KEYNOTE_LEGEND_RE.search(text or "")
    if not start:
        return False
    tail = (text or "")[start.end() : start.end() + 500]
    if KEYNOTE_LEGEND_RE.search(tail[:80]):
        return False

    lines = [re.sub(r"\s+", " ", raw_line).strip() for raw_line in tail.splitlines()[:10]]
    placeholder_count = 0
    index = 0
    while index < len(lines):
        line = lines[index]
        index += 1
        if not line:
            continue
        match = re.fullmatch(r"\d{1,3}\s*[\).:-]\s*(SAMPLE|PLACEHOLDER|TBD|N/?A|NONE)", line, re.IGNORECASE)
        if match:
            placeholder_count += 1
            continue
        if re.fullmatch(r"\d{1,3}\s*[\).:-]", line) and index < len(lines):
            next_line = lines[index]
            if re.fullmatch(r"SAMPLE|PLACEHOLDER|TBD|N/?A|NONE", next_line, re.IGNORECASE):
                placeholder_count += 1
                index += 1
                continue
        if placeholder_count:
            return True
        return False
    return placeholder_count > 0


def detect_keynote_legend(text: str) -> dict:
    if not KEYNOTE_LEGEND_RE.search(text):
        return {"present": False, "numbers": [], "confidence": 0}
    legend_window = text[KEYNOTE_LEGEND_RE.search(text).start() : KEYNOTE_LEGEND_RE.search(text).start() + 1200]
    numbers = sorted(set(re.findall(r"\b\d{1,3}\b", legend_window)))
    return {"present": True, "numbers": numbers, "confidence": 75 if numbers else 55}


def detect_duplicate_keynote_contents(page: dict) -> list[dict[str, Any]]:
    entries = extract_keynote_entries(page.get("text", ""))
    by_content: dict[str, list[dict[str, str]]] = {}
    for entry in entries:
        normalized = _normalize_keynote_content(entry["text"])
        if not normalized:
            continue
        if _is_allowed_repeated_keynote_content(entry["text"], normalized):
            continue
        by_content.setdefault(normalized, []).append(entry)

    findings: list[dict[str, Any]] = []
    for normalized, duplicates in by_content.items():
        numbers = sorted({item["number"] for item in duplicates}, key=lambda value: int(value))
        if len(numbers) < 2:
            continue
        findings.append(
            {
                "pageNumber": page.get("page_number"),
                "sheetNumber": page.get("sheet_number") or f"Page {page.get('page_number')}",
                "keynoteNumbers": numbers,
                "keynoteText": duplicates[0]["text"],
                "normalizedText": normalized,
                "status": "Fail",
                "comment": f"Duplicate keynote text appears under keynote numbers {', '.join(numbers)}: {duplicates[0]['text']}",
            }
        )
    return findings


def extract_keynote_entries(text: str) -> list[dict[str, str]]:
    start = KEYNOTE_LEGEND_RE.search(text or "")
    if not start:
        return []
    legend_window = text[start.end() : start.end() + 1800]
    stop = SECTION_STOP_RE.search(legend_window)
    if stop:
        legend_window = legend_window[: stop.start()]
    legend_window = re.sub(r"\s+", " ", legend_window).strip()
    entries: list[dict[str, str]] = []
    for match in KEYNOTE_ENTRY_RE.finditer(legend_window):
        number = match.group("number")
        content = _clean_keynote_content(match.group("text"))
        if not content:
            continue
        entries.append({"number": number, "text": content})
    return entries


def detect_keynote_symbols(text: str) -> dict:
    if "KEYNOTE" not in text.upper():
        return {"present": False, "numbers": [], "confidence": 0}
    numbers = sorted(set(KEYNOTE_SYMBOL_RE.findall(text)))
    return {"present": bool(numbers), "numbers": numbers, "confidence": 58 if numbers else 0, "source": "text"}


def detect_text_keynote_callouts(text: str) -> dict:
    """Detect OCR-extracted keynote callout numbers that match the sheet legend.

    Some sheets expose the keynote bubbles as plain standalone numbers in the
    extracted text, while the vector shape itself is not available. Treat those
    as keynote callouts only when multiple numbers before the legend match the
    numbers listed in the SHEET KEYNOTES block.
    """
    legend_start = KEYNOTE_LEGEND_RE.search(text or "")
    if not legend_start:
        return {"present": False, "numbers": [], "count": 0, "confidence": 0, "source": "text-callout"}
    legend_run_numbers = _legend_number_run(text, legend_start)
    legend = detect_keynote_legend(text)
    legend_numbers = set(
        legend_run_numbers
        if len(legend_run_numbers) >= 2
        else [str(number) for number in legend.get("numbers", [])]
    )
    if not legend_numbers:
        return {"present": False, "numbers": [], "count": 0, "confidence": 0, "source": "text-callout"}

    drawing_text = _remove_scale_text(text[: legend_start.start()])
    candidates = re.findall(r"(?<![\w./-])(\d{1,3})(?![\w./-])", drawing_text)
    numbers = sorted({number for number in candidates if number in legend_numbers}, key=int)
    if len(numbers) >= 2:
        return {
            "present": True,
            "numbers": numbers,
            "count": len(numbers),
            "confidence": 62,
            "source": "text-callout",
        }

    ordered_text = _remove_scale_text(text[legend_start.start() :])
    ordered_candidates = [
        number
        for number in re.findall(r"(?<![\w./-])(\d{1,3})(?![\w./-])", ordered_text)
        if number in legend_numbers
    ]
    counts = Counter(ordered_candidates)
    repeated_numbers = sorted(
        {number for number, count in counts.items() if count >= 3},
        key=int,
    )
    if len(repeated_numbers) < 3:
        return {
            "present": False,
            "numbers": repeated_numbers or numbers,
            "count": len(repeated_numbers or numbers),
            "confidence": 0,
            "source": "text-callout",
        }
    return {
        "present": True,
        "numbers": repeated_numbers,
        "count": sum(counts[number] for number in repeated_numbers),
        "confidence": 64,
        "source": "text-callout",
    }


def detect_graphic_keynote_symbols(page: Any) -> dict:
    """Detect rounded triangular keynote callouts drawn as PDF vectors.

    SGA keynote symbols are usually a triangular callout with a leader and a
    number inside. Many PDFs expose the outline as vector paths and the number
    as ordinary page text, so this detector looks for compact path groups that
    contain one-to-three digit words.
    """
    symbols: list[dict[str, Any]] = []
    try:
        drawings = page.get_cdrawings() if hasattr(page, "get_cdrawings") else page.get_drawings()
        words = page.get_text("words")
        import fitz
    except Exception:
        return {"present": False, "numbers": [], "count": 0, "confidence": 0, "source": "graphic"}

    blue_rects: list[Any] = []
    for drawing in drawings:
        rect = _rect_from_raw(drawing.get("rect"), fitz)
        if rect is None:
            continue
        stroke = drawing.get("color")
        if _is_clusterable_blue_rect(stroke, rect):
            blue_rects.append(rect)
        if not _looks_like_keynote_callout_rect(rect):
            continue
        path_item_count = len(drawing.get("items") or [])
        if path_item_count < 2:
            continue
        numbers = _numbers_inside_rect(words, rect)
        if numbers or _is_blue_stroke(stroke):
            symbols.append(
                {
                    "numbers": numbers,
                    "bbox": [round(rect.x0, 1), round(rect.y0, 1), round(rect.x1, 1), round(rect.y1, 1)],
                    "confidence": 82 if numbers else 64,
                    "source": "vector",
                }
            )

    symbols.extend(_detect_clustered_blue_keynote_symbols(blue_rects, words))
    symbols = _dedupe_symbols(symbols)
    numbers = sorted({number for symbol in symbols for number in symbol["numbers"]})
    return {
        "present": bool(symbols),
        "numbers": numbers,
        "count": len(symbols),
        "confidence": max([symbol["confidence"] for symbol in symbols] or [0]),
        "symbols": symbols[:50],
        "source": "graphic",
    }


def detect_keynote_symbols_for_page(page: dict) -> dict:
    text_symbols = detect_keynote_symbols(page.get("text", ""))
    text_callouts = detect_text_keynote_callouts(page.get("text", ""))
    graphic_symbols = page.get("keynote_symbols") or {}
    graphic_present = bool(graphic_symbols.get("present") or graphic_symbols.get("count"))
    graphic_numbers = sorted(set(graphic_symbols.get("numbers", [])))
    text_callout_numbers = sorted(set(text_callouts.get("numbers", [])))
    numbers = sorted(set([*graphic_numbers, *text_callout_numbers]), key=lambda value: int(value) if str(value).isdigit() else str(value))
    sources = []
    if text_symbols.get("present"):
        sources.append("text")
    if text_callouts.get("present"):
        sources.append("text-callout")
    if graphic_present:
        sources.append("graphic")
    return {
        "present": bool(text_symbols.get("present") or text_callouts.get("present") or graphic_present),
        "numbers": numbers,
        "confidence": max(text_symbols.get("confidence", 0), text_callouts.get("confidence", 0), graphic_symbols.get("confidence", 0)),
        "count": max(0, int(graphic_symbols.get("count") or 0)) + max(0, int(text_callouts.get("count") or 0)) + (1 if text_symbols.get("present") else 0),
        "source": "+".join(sources) if sources else "",
        "has_number_inside_symbol": bool((graphic_present and graphic_numbers) or text_callouts.get("present")),
        "graphic": graphic_symbols,
        "text": text_symbols,
        "text_callouts": text_callouts,
    }


def compare_symbols_to_legend(page_text: str, symbols: dict | None = None) -> dict:
    if not has_sheet_keynotes_section(page_text):
        return {
            "status": "Not Applicable",
            "reason": "No SHEET KEYNOTES section found; keynote symbols not required.",
            "legend": {"present": False, "numbers": [], "confidence": 0},
            "symbols": symbols or detect_keynote_symbols(page_text),
        }
    if has_placeholder_only_keynote_section(page_text):
        return {
            "status": "Not Applicable",
            "reason": "SHEET KEYNOTES section only contains placeholder entries; keynote symbols not required.",
            "legend": detect_keynote_legend(page_text),
            "symbols": symbols or detect_keynote_symbols(page_text),
        }
    legend = detect_keynote_legend(page_text)
    symbols = symbols or detect_keynote_symbols(page_text)
    if not symbols["present"]:
        return {"status": "Fail", "reason": "SHEET KEYNOTES section found, but no keynote symbol was detected.", "legend": legend, "symbols": symbols}
    if not symbols.get("has_number_inside_symbol"):
        return {
            "status": "Fail",
            "reason": "Keynote symbol detected, but no number was detected inside the symbol.",
            "legend": legend,
            "symbols": symbols,
        }
    return {
        "status": "Pass",
        "reason": "",
        "legend": legend,
        "symbols": symbols,
    }


def _clean_keynote_content(value: str) -> str:
    value = re.sub(r"\s+", " ", value or "").strip(" .;:-")
    return value


def _remove_scale_text(value: str) -> str:
    value = re.sub(r"\b(?:\d+/\d+|\d+(?:\.\d+)?)\s*\"\s*=\s*(?:\d+|\d+/\d+)\s*'-?\s*\d*\"?", " ", value)
    value = re.sub(r"\b\d+\s*'\s*-\s*\d+\s*\"?", " ", value)
    return value


def _legend_number_run(text: str, legend_match: re.Match) -> list[str]:
    """Return the initial numbered legend run after a keynotes heading.

    Some PDFs extract legends as all numbers first, then all descriptions. This
    isolates that opening run so later drawing callout numbers can be compared
    against a stable legend number set.
    """
    tail = (text or "")[legend_match.end() : legend_match.end() + 500]
    while True:
        repeated_heading = KEYNOTE_LEGEND_RE.match(tail.strip())
        if not repeated_heading:
            break
        stripped = tail.strip()
        tail = stripped[repeated_heading.end() :]
    matches = list(re.finditer(r"\s*(\d{1,3})\s*[\).:-]", tail))
    numbers: list[str] = []
    position = 0
    for match in matches:
        gap = tail[position : match.start()]
        if re.search(r"[A-Za-z]{2,}", gap):
            break
        numbers.append(match.group(1))
        position = match.end()
    return sorted(set(numbers), key=int)


def _normalize_keynote_content(value: str) -> str:
    value = re.sub(r"\([^)]*\)", " ", value or "")
    value = re.sub(r"[^A-Za-z0-9]+", " ", value).upper()
    return re.sub(r"\s+", " ", value).strip()


def _is_allowed_repeated_keynote_content(value: str, normalized: str) -> bool:
    text = re.sub(r"\s+", " ", value or "").upper().strip()
    if not text:
        return False
    if "REFER FINISHES" in text or "REFER TO FINISH" in text:
        return True
    if normalized.endswith("AS SCHEDULED") and any(
        term in normalized
        for term in ["DOOR", "WINDOW", "STOREFRONT", "WALL BASE", "GYPSUM BOARD"]
    ):
        return True
    return False


def _rect_from_drawing(drawing: dict) -> Any | None:
    try:
        import fitz

        raw = drawing.get("rect")
        if raw is None:
            return None
        return fitz.Rect(raw)
    except Exception:
        return None


def _rect_from_raw(raw: Any, fitz_module: Any) -> Any | None:
    if raw is None:
        return None
    try:
        return fitz_module.Rect(raw)
    except Exception:
        return None


def _looks_like_keynote_callout_rect(rect: Any) -> bool:
    width = float(rect.width)
    height = float(rect.height)
    if width < 10 or height < 10 or width > 420 or height > 220:
        return False
    aspect = width / max(height, 1)
    return 0.35 <= aspect <= 8.5


def _numbers_inside_rect(words: list, rect: Any) -> list[str]:
    import fitz

    numbers: list[str] = []
    expanded = rect + (-4, -4, 4, 4)
    for word in words:
        if len(word) < 5:
            continue
        text = str(word[4]).strip()
        if not re.fullmatch(r"\d{1,3}", text):
            continue
        try:
            word_rect = fitz.Rect(word[:4])
        except Exception:
            continue
        if expanded.intersects(word_rect):
            numbers.append(text)
    return sorted(set(numbers))


def _detect_clustered_blue_keynote_symbols(blue_rects: list[Any], words: list) -> list[dict[str, Any]]:
    """Detect keynote symbols split into separate PDF stroke commands."""
    import fitz

    clusters: list[list[Any]] = []
    for rect in blue_rects:
        expanded = rect + (-6, -6, 6, 6)
        matches: list[int] = []
        for index, cluster in enumerate(clusters):
            cluster_rect = _union_rects(cluster) + (-6, -6, 6, 6)
            if expanded.intersects(cluster_rect):
                matches.append(index)
        if not matches:
            clusters.append([rect])
            continue
        first = matches[0]
        clusters[first].append(rect)
        for extra in reversed(matches[1:]):
            clusters[first].extend(clusters.pop(extra))

    symbols: list[dict[str, Any]] = []
    for cluster in clusters:
        if len(cluster) < 3:
            continue
        bbox = _union_rects(cluster)
        if bbox.width < 8 or bbox.height < 8 or bbox.width > 260 or bbox.height > 180:
            continue
        numbers = _numbers_inside_rect(words, bbox + (-10, -10, 10, 10))
        if not numbers:
            continue
        symbols.append(
            {
                "numbers": numbers,
                "bbox": [round(bbox.x0, 1), round(bbox.y0, 1), round(bbox.x1, 1), round(bbox.y1, 1)],
                "confidence": 78,
                "source": "clustered-vector",
            }
        )
    return symbols


def _union_rects(rects: list[Any]) -> Any:
    import fitz

    if not rects:
        return fitz.Rect()
    bbox = fitz.Rect(rects[0])
    for rect in rects[1:]:
        bbox |= rect
    return bbox


def _dedupe_symbols(symbols: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen: set[tuple] = set()
    for symbol in symbols:
        bbox = symbol.get("bbox") or []
        key = (
            tuple(symbol.get("numbers") or []),
            round(float(bbox[0]) / 8) if len(bbox) == 4 else 0,
            round(float(bbox[1]) / 8) if len(bbox) == 4 else 0,
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(symbol)
    return deduped


def _is_blue_stroke(stroke: Any) -> bool:
    if not stroke or len(stroke) < 3:
        return False
    red, green, blue = [float(value) for value in stroke[:3]]
    return blue > 0.45 and blue > red * 1.35 and blue > green * 1.15


def _is_clusterable_blue_rect(stroke: Any, rect: Any) -> bool:
    if not _is_blue_stroke(stroke):
        return False
    if rect.width > 260 or rect.height > 180:
        return False
    if rect.width < 0.25 and rect.height < 0.25:
        return False
    return True
