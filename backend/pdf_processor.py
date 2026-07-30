from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from database.models import DocumentMetadata, SheetMetadata
from database.store import THUMBNAILS_DIR
from ocr.extractor import extract_page_text


SHEET_ID_RE = re.compile(r"\b(?:CS|[A-Z]{1,4}-?\d+(?:\.\d+)?)\b")
SCALE_RE = re.compile(r"\b(?:\d+/\d+|\d+(?:\.\d+)?)\s*\"\s*=\s*(?:\d+|\d+/\d+)\s*'-?\s*\d*\"?|\bNTS\b", re.IGNORECASE)
DATE_RE = re.compile(r"\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})\b")
REVISION_RE = re.compile(r"\b(?:REV(?:ISION)?|ADDENDUM|ASI|BULLETIN)\s*[A-Z0-9.-]*\b", re.IGNORECASE)
DETAIL_REF_RE = re.compile(r"\b(?:SEE\s+)?(?:DETAIL|SECTION|ELEVATION)?\s*(\d{1,3})\s*/\s*([A-Z]{1,3}\d{2,4})\b", re.IGNORECASE)
DOOR_TAG_RE = re.compile(r"\b(?:DOOR\s*)?[A-Z]?\d{3}[A-Z]?\b")
ROOM_TAG_RE = re.compile(r"\b(?:ROOM\s*)?\d{3,4}\b")
TITLE_BLOCK_RE = re.compile(
    r"\b(?:PROJECT|OWNER|ARCHITECT|CONSULTANT|DRAWN|CHECKED|DATE|SCALE|REVISION|SHEET\s+TITLE|TITLE\s+BLOCK|ISSUE)\b",
    re.IGNORECASE,
)
KEYWORD_PATTERNS = {
    "sheet_index": re.compile(r"\b(?:SHEET|DRAWING)\s+INDEX\b|\bINDEX\s+PH\d*\b", re.IGNORECASE),
    "project_name": re.compile(r"\bPROJECT\s+NAME\b|\bPROJECT\b", re.IGNORECASE),
    "project_address": re.compile(r"\b(?:ADDRESS|LOCATION)\b|\b\d{2,6}\s+[A-Z0-9 .'-]+(?:ST|STREET|AVE|AVENUE|BLVD|ROAD|RD|DR|DRIVE|EXPRESSWAY|HIGHWAY|HWY)\b", re.IGNORECASE),
    "owner_client": re.compile(r"\b(?:OWNER|CLIENT)\b", re.IGNORECASE),
    "issue_description": re.compile(r"\b(?:ISSUED?\s+FOR|ISSUE\s+DESCRIPTION|PERMIT|BID|CONSTRUCTION|ISSUE)\b", re.IGNORECASE),
    "vicinity_map": re.compile(r"\b(?:VICINITY|LOCATION)\s+MAP\b|\bSITE\s+LOCATION\b", re.IGNORECASE),
    "code_summary": re.compile(r"\b(?:CODE\s+SUMMARY|CODE\s+ANALYSIS|BUILDING\s+CODE)\b", re.IGNORECASE),
    "occupancy_load": re.compile(r"\b(?:OCCUPANCY|OCCUPANT\s+LOAD|LOAD\s+DATA)\b", re.IGNORECASE),
    "project_number": re.compile(r"\b(?:PROJECT\s+NO\.?|PROJECT\s+NUMBER|JOB\s+NO\.?)\b|\b20\d{2}-\d{3,5}\b", re.IGNORECASE),
    "legend": re.compile(r"\bLEGEND\b", re.IGNORECASE),
    "north_arrow": re.compile(r"\bNORTH\b|\bN\.?\s*ARROW\b", re.IGNORECASE),
    "general_notes": re.compile(r"\bGENERAL\s+NOTES?\b", re.IGNORECASE),
    "construction_notes": re.compile(r"\bCONSTRUCTION\s+NOTES?\b", re.IGNORECASE),
    "keynotes": re.compile(r"\bKEYNOTES?\b", re.IGNORECASE),
    "revision": re.compile(r"\bREV(?:ISION)?\b|REVISION\s+CLOUD", re.IGNORECASE),
    "revision_block": re.compile(r"\b(?:REVISION\s+BLOCK|REVISION\s+HISTORY|REVISIONS?)\b", re.IGNORECASE),
    "issue_date": DATE_RE,
    "scale": re.compile(r"\bSCALE\b", re.IGNORECASE),
    "graphic_scale": re.compile(r"\bGRAPHIC\s+SCALE\b", re.IGNORECASE),
    "professional_seal": re.compile(r"\b(?:P\.?E\.?|AIA|REGISTERED|LICENSE|TBAE|TABS|SEAL|SIGNATURE)\b", re.IGNORECASE),
    "signature": re.compile(r"\b(?:SIGNATURE|SIGNED|DIGITAL\s+SIGNATURE|DIGITALLY\s+SIGNED)\b", re.IGNORECASE),
    "registration_number": re.compile(r"\b(?:REGISTRATION|LICENSE|NO\.|#)\s*[A-Z-]*\d{3,}\b|\bF-\d{3,}\b", re.IGNORECASE),
    "firm_information": re.compile(r"\b(?:ARCHITECT|ENGINEERING|ARCHITECTURE|LLC|INC\.?|FIRM)\b", re.IGNORECASE),
    "firm_logo_name": re.compile(r"\b(?:ARCHITECT|ARCHITECTURE|ENGINEERING|SAM\s+GARCIA|SOTEX|DBR|GREEN,\s*RUBIANO)\b", re.IGNORECASE),
    "drawn_checked": re.compile(r"\b(?:DRAWN|CHECKED|CHK|DRN|DRAWN\s+BY|CHECKED\s+BY)\b", re.IGNORECASE),
    "copyright": re.compile(r"\b(?:COPYRIGHT|DO\s+NOT\s+REPRODUCE|ALL\s+RIGHTS\s+RESERVED)\b", re.IGNORECASE),
    "seal_placeholder": re.compile(r"\b(?:SEAL|PROFESSIONAL\s+SEAL|STAMP)\b", re.IGNORECASE),
    "consultant_team": re.compile(r"\b(?:CIVIL|STRUCTUR(?:E|AL)|MEP|MECHANICAL|ELECTRICAL|PLUMBING|LANDSCAPE|DESIGN\s+CONSULTANT\s+TEAM)\b", re.IGNORECASE),
    "placeholder": re.compile(r"\b(?:PLACEHOLDER|TBD|TO\s+BE\s+DETERMINED|DUMMY|NOT\s+FOR\s+ISSUE)\b", re.IGNORECASE),
    "blank_marker": re.compile(r"\b(?:INTENTIONALLY\s+BLANK|THIS\s+PAGE\s+INTENTIONALLY\s+LEFT\s+BLANK)\b", re.IGNORECASE),
    "door_schedule": re.compile(r"\bDOOR\s+SCHEDULE\b", re.IGNORECASE),
    "room_finish_schedule": re.compile(r"\bROOM\s+FINISH\s+SCHEDULE\b", re.IGNORECASE),
    "code_analysis": re.compile(r"\bCODE\s+ANALYSIS\b", re.IGNORECASE),
    "life_safety": re.compile(r"\bLIFE\s+SAFETY\b", re.IGNORECASE),
    "accessibility": re.compile(r"\bACCESSIBILITY\b|\bACCESSIBLE\b", re.IGNORECASE),
}
DISCIPLINE_PREFIXES = {
    "G": "General",
    "A": "Architectural",
    "AD": "Architectural",
    "I": "Interiors",
    "LS": "Life Safety",
    "C": "Civil",
    "S": "Structural",
    "M": "Mechanical",
    "P": "Plumbing",
    "E": "Electrical",
    "FP": "Fire Protection",
}


def normalize_sheet_id(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = re.sub(r"[^A-Za-z0-9.]", "", value).upper()
    match = SHEET_ID_RE.search(cleaned)
    return match.group(0) if match else None


def sheet_sort_key(sheet_id: str) -> tuple[str, int, str]:
    match = re.match(r"([A-Z]+)(\d+)(.*)", sheet_id)
    if not match:
        return (sheet_id, 0, "")
    return (match.group(1), int(match.group(2)), match.group(3))


def infer_discipline(sheet_id: str | None, text: str = "") -> str:
    if sheet_id:
        prefix = re.match(r"[A-Z]+", sheet_id)
        if prefix:
            letters = prefix.group(0)
            return DISCIPLINE_PREFIXES.get(letters, DISCIPLINE_PREFIXES.get(letters[:1], "General"))
    upper = text.upper()
    for word in ["ARCHITECTURAL", "STRUCTURAL", "MECHANICAL", "ELECTRICAL", "PLUMBING", "CIVIL"]:
        if word in upper:
            return word.title()
    return "General"


def extract_title_from_line(line: str, sheet_id: str) -> str | None:
    compact = re.sub(r"\s+", " ", line).strip()
    compact = re.sub(rf"\b{re.escape(sheet_id)}\b", "", compact, flags=re.IGNORECASE).strip(" -:\t")
    compact = re.sub(r"^(SHEET|NO\.?|NUMBER)\s+", "", compact, flags=re.IGNORECASE)
    if not compact or len(compact) < 3 or len(compact) > 90:
        return None
    return compact.upper()


def extract_indexed_sheets(page_text: str) -> dict[str, str]:
    indexed: dict[str, str] = {}
    for raw_line in page_text.splitlines():
        line = re.sub(r"\s+", " ", raw_line).strip()
        if not line:
            continue
        for match in SHEET_ID_RE.finditer(line):
            sheet_id = normalize_sheet_id(match.group(0))
            if sheet_id:
                indexed.setdefault(sheet_id, extract_title_from_line(line, sheet_id) or "")
    return indexed


def _extract_sheet_index_entries(page_text: str) -> dict[str, str]:
    indexed: dict[str, str] = {}
    for raw_line in page_text.splitlines():
        line = re.sub(r"\s+", " ", raw_line).strip()
        if not line:
            continue
        for match in SHEET_ID_RE.finditer(line):
            sheet_id = normalize_sheet_id(match.group(0))
            if not sheet_id or not _looks_like_sheet_number(sheet_id):
                continue
            prefix = re.match(r"[A-Z]+", sheet_id)
            if not prefix or prefix.group(0) in {"TX", "TO", "BE", "IN", "LOT", "FD", "SH"}:
                continue
            indexed.setdefault(sheet_id, extract_title_from_line(line, sheet_id) or "")
    return indexed


def _page_regions(page: Any) -> list[tuple[str, Any]]:
    rect = page.rect
    return [
        ("top_right_index", (rect.x0 + rect.width * 0.62, rect.y0, rect.x1, rect.y0 + rect.height * 0.28)),
        ("bottom_right", (rect.x0 + rect.width * 0.55, rect.y0 + rect.height * 0.65, rect.x1, rect.y1)),
        ("bottom_band", (rect.x0, rect.y0 + rect.height * 0.72, rect.x1, rect.y1)),
        ("right_band", (rect.x0 + rect.width * 0.68, rect.y0, rect.x1, rect.y1)),
    ]


def _extract_region_text(page: Any, clip_tuple: tuple[float, float, float, float]) -> str:
    import fitz

    return page.get_text("text", clip=fitz.Rect(*clip_tuple))


def _best_sheet_id_from_text(text: str) -> str | None:
    candidates = [normalize_sheet_id(match.group(0)) for match in SHEET_ID_RE.finditer(text.upper())]
    candidates = [candidate for candidate in candidates if candidate]
    candidates = [candidate for candidate in candidates if _looks_like_sheet_number(candidate)]
    if not candidates:
        return None
    return sorted(candidates, key=lambda value: (len(value), value))[0]


def _looks_like_sheet_number(value: str) -> bool:
    cleaned = value.upper().replace("-", "")
    if cleaned == "CS":
        return True
    if cleaned.startswith(("F", "X", "ADA", "PH", "B", "TX", "STX", "SH", "LOT", "FD")):
        return False
    return bool(re.match(r"^[A-Z]{1,3}\d+(?:\.\d+)?$", cleaned))


def _title_block_from_regions(page: Any) -> dict[str, Any] | None:
    best: dict[str, Any] | None = None
    for region_name, clip in _page_regions(page):
        region_text = _extract_region_text(page, clip)
        compact = re.sub(r"\s+", " ", region_text).strip()
        if len(compact) < 20:
            continue
        keyword_hits = len(TITLE_BLOCK_RE.findall(compact))
        if keyword_hits == 0 and len(compact) < 90:
            continue
        title = _title_from_title_block_text(region_text)
        confidence = min(95, 50 + keyword_hits * 12 + (20 if region_name in {"bottom_right", "bottom_band", "right_band"} else 0))
        candidate = {
            "sheet_id": "",
            "page_label": "",
            "sheet_title": title,
            "region": region_name,
            "confidence": confidence,
            "text_excerpt": compact[:500],
        }
        if best is None or candidate["confidence"] > best["confidence"]:
            best = candidate
    return best


def _sheet_number_from_page(page: Any, page_text: str) -> str | None:
    regions = ["bottom_right", "bottom_band", "right_band"]
    for region_name, clip in _page_regions(page):
        if region_name not in regions:
            continue
        region_sheet_id = _best_sheet_id_from_text(_extract_region_text(page, clip))
        if region_sheet_id:
            return region_sheet_id
    return None


def _title_from_title_block_text(text: str) -> str:
    ignored = re.compile(
        r"\b(?:PROJECT|OWNER|ARCHITECT|CONSULTANT|DRAWN|CHECKED|DATE|SCALE|REVISION|SHEET|TITLE|NUMBER|NO\.?|ISSUE)\b",
        re.IGNORECASE,
    )
    candidates: list[str] = []
    for raw_line in text.splitlines():
        line = re.sub(r"\s+", " ", raw_line).strip(" :-\t")
        if len(line) < 4 or len(line) > 80:
            continue
        if ignored.fullmatch(line) or re.fullmatch(r"[\d/.-]+", line):
            continue
        if SHEET_ID_RE.fullmatch(line):
            continue
        candidates.append(line.upper())
    if not candidates:
        return ""
    return max(candidates, key=lambda value: (sum(char.isalpha() for char in value), len(value)))


def _thumbnail(page: Any, pdf_path: Path, page_index: int) -> str:
    import fitz

    THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(f"{pdf_path}-{page_index}-{pdf_path.stat().st_mtime}".encode("utf-8")).hexdigest()[:12]
    target = THUMBNAILS_DIR / f"{pdf_path.stem}-{page_index}-{digest}.png"
    if not target.exists():
        pix = page.get_pixmap(matrix=fitz.Matrix(0.35, 0.35), alpha=False)
        pix.save(target)
    return str(target)


def extract_pdf_metadata(
    pdf_path: Path,
    *,
    project_type: str = "",
    phase: str = "",
    client: str = "",
    building_type: str = "",
    force_ocr: bool = False,
) -> DocumentMetadata:
    import fitz

    doc = fitz.open(pdf_path)
    keyword_pages: dict[str, list[int]] = {key: [] for key in KEYWORD_PATTERNS}
    scales: list[str] = []
    scale_pages: dict[str, list[int]] = {}
    legends: list[str] = []
    annotations: list[str] = []
    page_labels: dict[str, str] = {}
    title_blocks: dict[str, dict[str, Any]] = {}
    indexed_sheets: dict[str, str] = {}
    detected_sheets: dict[str, dict[str, Any]] = {}
    sheet_records: list[dict[str, Any]] = []
    text_chunks: list[str] = []
    discipline_sample = ""
    used_ocr = False
    expected_index_order: list[str] = []

    for page_index, page in enumerate(doc, start=1):
        page_text, page_used_ocr = extract_page_text(page, force_ocr=force_ocr)
        used_ocr = used_ocr or page_used_ocr
        text_chunks.append(page_text[:8000])
        if page_index <= 3:
            discipline_sample += "\n" + page_text[:4000]
        for key, pattern in KEYWORD_PATTERNS.items():
            if pattern.search(page_text):
                keyword_pages[key].append(page_index)
        if page_index <= 3 or KEYWORD_PATTERNS["sheet_index"].search(page_text):
            indexed_sheets.update(_extract_sheet_index_entries(page_text))
        if page_index == 1:
            top_right_text = _extract_region_text(page, _page_regions(page)[0][1])
            indexed_sheets.update(_extract_sheet_index_entries(top_right_text))
            expected_index_order = list(indexed_sheets)

        for scale in SCALE_RE.findall(page_text):
            normalized = re.sub(r"\s+", " ", scale).upper()
            if normalized not in scales:
                scales.append(normalized)
            scale_pages.setdefault(normalized, []).append(page_index)

        if KEYWORD_PATTERNS["legend"].search(page_text):
            legends.append(f"Page {page_index}")
        for note in re.findall(r"\b(?:KEYNOTE|NOTE|REVISION|GENERAL NOTE|DIMENSION)\s*[A-Z0-9.-]*", page_text, flags=re.IGNORECASE):
            normalized_note = re.sub(r"\s+", " ", note).upper()
            if normalized_note not in annotations:
                annotations.append(normalized_note)

        title_block = _title_block_from_regions(page)
        sheet_number = _sheet_number_from_page(page, page_text)
        expected_label = expected_index_order[page_index - 1] if page_index <= len(expected_index_order) else ""
        if sheet_number:
            label = f"{sheet_number} (PDF page {page_index})"
        elif expected_label:
            label = f"Expected {expected_label} (PDF page {page_index})"
        else:
            label = f"Page {page_index}"
        page_labels[str(page_index)] = label
        if sheet_number:
            keyword_pages.setdefault("sheet_number", []).append(page_index)
        page_scale = next((scale for scale, pages in scale_pages.items() if page_index in pages), "")
        page_keywords = [key for key, pages in keyword_pages.items() if page_index in pages]
        page_revision = (REVISION_RE.search(page_text) or [""])[0] if REVISION_RE.search(page_text) else ""
        page_date = (DATE_RE.search(page_text) or [""])[0] if DATE_RE.search(page_text) else ""
        thumbnail_path = _thumbnail(page, pdf_path, page_index)
        discipline = infer_discipline(None, page_text)
        title = title_block.get("sheet_title", "") if title_block else ""
        if title_block:
            title_block["page_label"] = label
            title_blocks[str(page_index)] = {
                "sheet_id": sheet_number or "",
                "page_label": label,
                "sheet_title": title,
                "region": title_block["region"],
                "confidence": title_block["confidence"],
                "text_excerpt": title_block["text_excerpt"],
            }
        sheet_records.append(
            SheetMetadata(
                sheet_number=label,
                sheet_title=title,
                discipline=discipline,
                phase=phase,
                page=page_index,
                source_file=pdf_path.name,
                scale=page_scale,
                revision=page_revision,
                issue_date=page_date,
                title_block_confidence=title_blocks.get(str(page_index), {}).get("confidence", 0),
                keywords=page_keywords,
                text_excerpt=page_text[:1500],
                thumbnail_path=thumbnail_path,
            ).to_dict()
        )

    detected_keywords = [key for key, pages in keyword_pages.items() if pages]
    return DocumentMetadata(
        path=str(pdf_path),
        filename=pdf_path.name,
        file_size=pdf_path.stat().st_size,
        project_type=project_type,
        client=client,
        building_type=building_type,
        phase=phase,
        sheet_number=None,
        sheet_title=None,
        drawing_type=infer_discipline(None, discipline_sample),
        detected_keywords=detected_keywords,
        annotations=annotations,
        scales=scales,
        scale_pages=scale_pages,
        legends=legends,
        keyword_pages={key: pages for key, pages in keyword_pages.items() if pages},
        page_labels=page_labels,
        title_block=next(iter(title_blocks.values()), {}),
        title_blocks=title_blocks,
        indexed_sheets=indexed_sheets,
        detected_sheets=detected_sheets,
        sheet_records=sheet_records,
        page_count=len(doc),
        ocr_used=used_ocr,
        confidence_scores={"title_block": max([block.get("confidence", 0) for block in title_blocks.values()] or [0])},
        extracted_text="\n\n".join(text_chunks),
    )
