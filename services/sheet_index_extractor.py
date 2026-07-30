from __future__ import annotations

import re

from services.schemas import SheetEntry, normalize_sheet_number
from services.title_block_extractor import SHEET_NUMBER_RE, clean_title_candidate

INDEX_HEADER_RE = re.compile(r"\b(?:SHEET\s+INDEX|DRAWING\s+INDEX|INDEX\s+OF\s+SHEETS|INDEX\s+OF\s+DRAWINGS|SHEET\s+LIST)\b", re.IGNORECASE)
NAMED_COVER_SHEET_RE = re.compile(r"\bCS[- ]+[A-Z][A-Z0-9-]{1,20}\b", re.IGNORECASE)
INFERRED_SHEET_SOURCES = {
    "page_label_index_match",
    "page_label_visual_match",
    "sheet_index_position",
    "sheet_index_visual_match",
    "title_clue_visual_match",
}


def extract_sheet_index(pages: list[dict]) -> dict:
    candidate_pages = [
        page for page in pages[:5] if INDEX_HEADER_RE.search(page.get("text", ""))
    ]
    if not candidate_pages:
        candidate_pages = [
            page for page in pages if INDEX_HEADER_RE.search(page.get("text", ""))
        ][:3]

    entries: list[SheetEntry] = []
    for page in candidate_pages:
        entries.extend(_extract_entries_from_text(page.get("text", ""), source_page=page.get("page_number")))

    deduped: list[SheetEntry] = []
    seen: set[str] = set()
    for entry in entries:
        normalized = entry.normalized_number()
        if normalized and normalized not in seen:
            entry.index_position = len(deduped) + 1
            seen.add(normalized)
            deduped.append(entry)

    return {
        "source_pages": [page.get("page_number") for page in candidate_pages],
        "confidence": 90 if deduped and candidate_pages else (55 if deduped else 0),
        "entries": [entry.to_dict() for entry in deduped],
        "needs_review": not deduped,
    }


def compare_index_to_physical(
    index_entries: list[dict],
    physical_entries: list[dict],
    pages: list[dict] | None = None,
) -> dict:
    indexed = [_entry_from_dict(item, "index") for item in index_entries if normalize_sheet_number(item.get("sheet_number"))]
    raw_physical = [_entry_from_dict(item, "physical") for item in physical_entries]
    physical = [entry for entry in raw_physical if entry.normalized_number()]
    missing_sheet_number_pages = [
        _missing_sheet_number_row(entry)
        for entry in raw_physical
        if entry.missing_sheet_number or not entry.normalized_number()
    ]
    physical_numbers = [entry.normalized_number() for entry in physical]
    indexed, ignored_secondary_covers = _exclude_secondary_cover_index_entries(indexed, physical_numbers, pages or [])
    indexed_numbers = [entry.normalized_number() for entry in indexed]
    indexed_set = set(indexed_numbers)
    physical_set = set(physical_numbers)
    duplicate_physical = _duplicate_physical_entries(physical)

    missing = [entry for entry in indexed if entry.normalized_number() not in physical_set]
    extra = [entry for entry in physical if entry.normalized_number() not in indexed_set]
    common_physical = _unique_in_order(number for number in physical_numbers if number in indexed_set)
    common_index = [number for number in indexed_numbers if number in physical_set]

    out_of_sequence = []
    expected_order = {number: position for position, number in enumerate(indexed_numbers)}
    last_position = -1
    for physical_position, number in enumerate(common_physical, start=1):
        index_position = expected_order[number]
        if index_position < last_position:
            out_of_sequence.append(
                {
                    "sheet_number": number,
                    "index_position": index_position + 1,
                    "physical_page_number": physical_position,
                    "sheet_name": _name_for(number, indexed, physical),
                }
            )
        last_position = max(last_position, index_position)

    sequence_pass = common_physical == common_index and not out_of_sequence
    presence_pass = not missing and not extra and not missing_sheet_number_pages and not duplicate_physical
    return {
        "sequence_compliance": {
            "status": "Pass" if sequence_pass else "Fail",
            "out_of_sequence": out_of_sequence,
        },
        "presence_compliance": {
            "status": "Pass" if presence_pass else "Fail",
            "missing_from_pdf": [_missing_row(entry) for entry in missing],
            "extra_in_pdf": [_extra_row(entry) for entry in extra],
            "duplicate_in_pdf": [_duplicate_row(entry) for entry in duplicate_physical],
            "missing_sheet_number_pages": missing_sheet_number_pages,
        },
        "missing_page_identification": {
            "missing_from_pdf": [_missing_row(entry) for entry in missing],
            "extra_in_pdf": [_extra_row(entry) for entry in extra],
            "duplicate_in_pdf": [_duplicate_row(entry) for entry in duplicate_physical],
            "missing_sheet_number_pages": missing_sheet_number_pages,
        },
        "ignored_secondary_cover_entries": [_ignored_secondary_cover_row(entry) for entry in ignored_secondary_covers],
    }


def apply_index_position_fallback_to_pages(pages: list[dict], sheet_index: dict) -> list[dict]:
    entries = sheet_index.get("entries", []) if isinstance(sheet_index, dict) else []
    if not pages or not entries:
        return pages

    entries_by_position = {
        int(entry.get("index_position") or position): entry
        for position, entry in enumerate(entries, start=1)
        if normalize_sheet_number(entry.get("sheet_number"))
    }
    entries_by_number = {
        normalize_sheet_number(entry.get("sheet_number")): entry
        for entry in entries
        if normalize_sheet_number(entry.get("sheet_number"))
    }
    physical_position_by_page = _physical_position_by_page_number(pages)
    physical_positions = set(physical_position_by_page.values())
    reliable_position_alignment = bool(
        physical_positions
        and physical_positions.issubset(set(entries_by_position))
        and max(physical_positions) <= max(entries_by_position)
    )
    updated_pages: list[dict] = []
    for page in pages:
        updated = dict(page)
        page_number = int(page.get("page_number") or 0)
        physical_position = physical_position_by_page.get(page_number, page_number)
        updated["_physical_index_position"] = physical_position
        position_expected = entries_by_position.get(physical_position)
        title_expected = _title_clue_expected_entry(page, entries)
        if title_expected is None and position_expected and _position_fallback_blocked_by_title_context(page, position_expected):
            position_expected = None
        label_expected = entries_by_number.get(normalize_sheet_number(page.get("page_label_sheet_number")))
        blocked_position_expected = (
            title_expected is None
            and label_expected is None
            and position_expected is not None
            and _page_label_conflicts_with_expected_sheet(page, position_expected)
        )
        expected = title_expected or (None if blocked_position_expected else position_expected)
        if (
            label_expected
            and _page_label_matches_expected_sheet(page, label_expected.get("sheet_number", ""))
            and _page_has_visual_title_sheet_number(page, label_expected.get("sheet_number", ""))
        ):
            expected = label_expected
        if _is_ignorable_secondary_cover_page(page):
            if expected and _is_index_cover_entry(expected):
                expected_number = expected.get("sheet_number", "")
                updated["sheet_number"] = expected_number
                if expected.get("sheet_name"):
                    updated["sheet_name"] = expected.get("sheet_name", "")
                updated["title_block_confidence"] = max(
                    float(updated.get("title_block_confidence") or 0),
                    float(expected.get("confidence") or 0),
                )
                updated["needs_review"] = False
                updated["sheet_source"] = "sheet_index_position"
                updated["sheet_number_decision"] = _sheet_number_decision(
                    page,
                    expected,
                    position_expected=position_expected,
                    label_expected=label_expected,
                    source="sheet_index_position",
                    physical_missing=False,
                    reason="Secondary cover matched a cover entry at the same sheet-index position.",
                )
                updated.pop("ignored_for_sheet_index", None)
                updated.pop("_physical_index_position", None)
                updated_pages.append(updated)
                continue
            updated["ignored_for_sheet_index"] = True
            updated["sheet_number_decision"] = _ignored_sheet_number_decision(page)
            updated.pop("_physical_index_position", None)
            updated_pages.append(updated)
            continue
        updated.pop("ignored_for_sheet_index", None)
        if expected:
            expected_number = expected.get("sheet_number", "")
            expected_normalized = normalize_sheet_number(expected_number)
            inferred_source = page.get("sheet_source") in INFERRED_SHEET_SOURCES
            current_normalized = "" if inferred_source else normalize_sheet_number(page.get("sheet_number"))
            low_confidence = bool(page.get("needs_review")) or not current_normalized or float(page.get("title_block_confidence") or 0) < 60
            disagrees_with_aligned_index = reliable_position_alignment and current_normalized != expected_normalized
            if low_confidence or disagrees_with_aligned_index:
                label_matches_expected = _page_label_matches_expected_sheet(page, expected_number)
                if not current_normalized and label_matches_expected:
                    if _page_has_visual_title_sheet_number(page, expected_number):
                        updated.pop("physical_sheet_number_missing", None)
                        updated.pop("inferred_sheet_number", None)
                        updated["sheet_source"] = "page_label_visual_match"
                        decision = _sheet_number_decision(
                            page,
                            expected,
                            position_expected=position_expected,
                            label_expected=label_expected,
                            source="page_label_visual_match",
                            physical_missing=False,
                            reason="PDF page label matched the sheet index and visual sheet-number glyphs were detected in the title block.",
                        )
                    else:
                        updated["physical_sheet_number_missing"] = True
                        updated["inferred_sheet_number"] = expected_number
                        updated["sheet_source"] = "page_label_index_match"
                        decision = _sheet_number_decision(
                            page,
                            expected,
                            position_expected=position_expected,
                            label_expected=label_expected,
                            source="page_label_index_match",
                            physical_missing=True,
                            reason="Sheet number was inferred from the PDF page label/index, but no physical title-block number was confirmed.",
                        )
                elif not current_normalized:
                    updated["physical_sheet_number_missing"] = True
                    updated["inferred_sheet_number"] = expected_number
                    title_visual_match = title_expected is not None and _page_has_visual_title_sheet_number(page, expected_number)
                    position_visual_match = _sheet_index_position_visual_match(
                        updated,
                        expected,
                        reliable_position_alignment=reliable_position_alignment,
                    )
                    standalone_ada_match = _standalone_ada_visual_position_match(page, expected_number)
                    visual_match = title_visual_match or position_visual_match or standalone_ada_match
                    if title_visual_match or standalone_ada_match:
                        source = "title_clue_visual_match"
                    elif position_visual_match:
                        source = "sheet_index_visual_match"
                    else:
                        source = "sheet_index_position"
                    updated["sheet_source"] = source
                    decision = _sheet_number_decision(
                        page,
                        expected,
                        position_expected=position_expected,
                        label_expected=label_expected,
                        source=source,
                        physical_missing=not visual_match,
                        reason=(
                            "Sheet number was matched from strong title text clues and nearby sheet-index entry with visual title-block glyphs."
                            if title_visual_match or standalone_ada_match
                            else "Sheet number matched the same sheet-index position and visual sheet-number glyphs were detected in the title block."
                            if position_visual_match
                            else "Sheet number was inferred from sheet-index position only."
                        ),
                    )
                    if visual_match:
                        updated.pop("physical_sheet_number_missing", None)
                        updated.pop("inferred_sheet_number", None)
                else:
                    updated.pop("physical_sheet_number_missing", None)
                    updated.pop("inferred_sheet_number", None)
                    updated["sheet_source"] = "title_clue_visual_match" if title_expected is not None else "sheet_index_position"
                    decision = _sheet_number_decision(
                        page,
                        expected,
                        position_expected=position_expected,
                        label_expected=label_expected,
                        source=updated["sheet_source"],
                        physical_missing=False,
                        reason=(
                            "Detected title-block context was reconciled to a nearby sheet-index entry using strong title text clues."
                            if title_expected is not None
                            else "Detected title-block number was reconciled to the sheet index position."
                        ),
                    )
                updated["sheet_number"] = expected_number
                if expected.get("sheet_name"):
                    updated["sheet_name"] = expected.get("sheet_name", "")
                updated["title_block_confidence"] = max(float(updated.get("title_block_confidence") or 0), float(expected.get("confidence") or 0))
                updated["needs_review"] = False
                updated["sheet_number_decision"] = decision
                updated.pop("ignored_for_sheet_index", None)
            else:
                updated["sheet_number_decision"] = _sheet_number_decision(
                    page,
                    {"sheet_number": page.get("sheet_number", ""), "sheet_name": page.get("sheet_name", "")},
                    position_expected=expected,
                    label_expected=label_expected,
                    source=page.get("sheet_source") or "title_block",
                    physical_missing=False,
                    reason="Physical title-block sheet number was detected with sufficient confidence.",
                )
        else:
            if page.get("sheet_source") in INFERRED_SHEET_SOURCES:
                updated["sheet_number"] = ""
                updated["sheet_name"] = ""
                updated["title_block_confidence"] = 0
                updated["needs_review"] = True
                updated["physical_sheet_number_missing"] = True
                updated.pop("inferred_sheet_number", None)
            elif not normalize_sheet_number(updated.get("sheet_number")):
                updated["physical_sheet_number_missing"] = True
            updated["sheet_number_decision"] = _sheet_number_decision(
                updated,
                {"sheet_number": updated.get("sheet_number", ""), "sheet_name": updated.get("sheet_name", "")},
                position_expected=None,
                label_expected=label_expected,
                source=updated.get("sheet_source") or "title_block",
                physical_missing=not bool(normalize_sheet_number(updated.get("sheet_number"))),
                reason="No matching sheet-index position was available for this page.",
            )
        updated.pop("_physical_index_position", None)
        updated_pages.append(updated)
    return updated_pages


def _sheet_number_decision(
    page: dict,
    final_entry: dict,
    *,
    position_expected: dict | None,
    label_expected: dict | None,
    source: str,
    physical_missing: bool,
    reason: str,
) -> dict:
    final_number = final_entry.get("sheet_number", "") if isinstance(final_entry, dict) else ""
    visual = page.get("visual_title_sheet_number") if isinstance(page.get("visual_title_sheet_number"), dict) else {}
    return {
        "sheet_number": final_number,
        "source": source,
        "physical_sheet_number_missing": bool(physical_missing),
        "reason": reason,
        "evidence": {
            "physical_text": {
                "sheet_number": page.get("sheet_number", ""),
                "confidence": float(page.get("title_block_confidence") or 0),
                "trusted": source not in INFERRED_SHEET_SOURCES and bool(normalize_sheet_number(page.get("sheet_number"))),
            },
            "visual_title_number": {
                "present": _page_has_visual_title_sheet_number(page, final_number),
                "raw_present": bool(visual.get("present")),
                "confidence": float(visual.get("confidence") or 0),
                "dark_pixel_count": int(visual.get("dark_pixel_count") or 0),
                "ink_pixel_count": int(visual.get("ink_pixel_count") or 0),
            },
            "page_label": {
                "sheet_number": page.get("page_label_sheet_number", ""),
                "text": page.get("page_label_text", ""),
                "confidence": float(page.get("page_label_confidence") or 0),
                "matches_final": _page_label_matches_expected_sheet(page, final_number),
            },
            "sheet_index_position": _index_evidence(position_expected),
            "sheet_index_label_match": _index_evidence(label_expected),
        },
    }


def _ignored_sheet_number_decision(page: dict) -> dict:
    return {
        "sheet_number": page.get("sheet_number", ""),
        "source": "ignored_secondary_cover",
        "physical_sheet_number_missing": False,
        "reason": "Secondary cover page is excluded from sheet-index sheet-number checks.",
        "evidence": {
            "physical_text": {
                "sheet_number": page.get("sheet_number", ""),
                "confidence": float(page.get("title_block_confidence") or 0),
                "trusted": bool(normalize_sheet_number(page.get("sheet_number"))),
            },
            "visual_title_number": page.get("visual_title_sheet_number", {}),
            "page_label": {
                "sheet_number": page.get("page_label_sheet_number", ""),
                "text": page.get("page_label_text", ""),
                "confidence": float(page.get("page_label_confidence") or 0),
                "matches_final": False,
            },
            "sheet_index_position": None,
            "sheet_index_label_match": None,
        },
    }


def _index_evidence(entry: dict | None) -> dict | None:
    if not isinstance(entry, dict):
        return None
    return {
        "sheet_number": entry.get("sheet_number", ""),
        "sheet_name": entry.get("sheet_name", ""),
        "index_position": entry.get("index_position"),
        "confidence": float(entry.get("confidence") or 0),
    }


def _page_has_visual_title_sheet_number(page: dict, expected_number: str = "") -> bool:
    visual = page.get("visual_title_sheet_number")
    if not isinstance(visual, dict):
        return False
    if bool(visual.get("present")) and float(visual.get("confidence") or 0) >= 70:
        return True
    prefix_match = re.match(r"([A-Z]+)", normalize_sheet_number(expected_number))
    prefix = prefix_match.group(1) if prefix_match else ""
    dark_pixels = int(visual.get("dark_pixel_count") or 0)
    ink_pixels = int(visual.get("ink_pixel_count") or 0)
    if prefix in {"C", "S", "SD"}:
        return dark_pixels >= 1800 and ink_pixels >= 2200
    if prefix not in {
        "AD", "AS", "D", "E", "ED", "EL", "EP", "ES", "FP", "FA", "FS",
        "I", "ID", "IR", "M", "MD", "MG", "MP", "MS", "P", "PD", "MEP", "MEPD",
    }:
        return False
    return dark_pixels >= 850 and ink_pixels >= 1200


def _page_label_matches_expected_sheet(page: dict, expected_number: str) -> bool:
    label_normalized = normalize_sheet_number(page.get("page_label_sheet_number"))
    expected_normalized = normalize_sheet_number(expected_number)
    label_text = str(page.get("page_label_text") or "").upper()
    if expected_normalized in {"CS", "COVER"} and re.search(r"\bCIVIL\b", label_text):
        return False
    if label_normalized and label_normalized == expected_normalized:
        return True
    if label_normalized == "SI" and expected_normalized == "S1":
        context = f"{page.get('page_label_text', '')}\n{page.get('title_block_text', '')}\n{page.get('text', '')[:3000]}".upper()
        return bool(
            re.search(r"\bGENERAL\s+NOTES\b", context)
            and re.search(r"\b(?:TREVI(?:N|Ñ)O\s+ENGINEERING|STRUCTURAL|FIRM\s+NO\.\s*F-7906)\b", context)
        )
    return False


def _page_label_conflicts_with_expected_sheet(page: dict, expected: dict) -> bool:
    label_normalized = normalize_sheet_number(page.get("page_label_sheet_number"))
    expected_normalized = normalize_sheet_number(expected.get("sheet_number"))
    if not label_normalized or not expected_normalized:
        return False
    if float(page.get("page_label_confidence") or 0) < 90:
        return False
    if _page_label_matches_expected_sheet(page, expected.get("sheet_number", "")):
        return False
    label_prefix = _sheet_prefix(label_normalized)
    expected_prefix = _sheet_prefix(expected_normalized)
    return bool(label_prefix and expected_prefix and label_prefix != expected_prefix)


def _sheet_prefix(normalized_sheet_number: str) -> str:
    match = re.match(r"([A-Z]+)", normalize_sheet_number(normalized_sheet_number))
    return match.group(1) if match else ""


def _title_clue_expected_entry(page: dict, entries: list[dict]) -> dict | None:
    if page.get("is_cover_sheet") or page.get("cover_type"):
        return None
    target_prefixes = _sheet_prefixes_from_title_context(page)
    if not target_prefixes:
        return None
    page_number = int(page.get("page_number") or 0)
    candidates = []
    for entry in entries:
        sheet_number = str(entry.get("sheet_number") or "")
        normalized = normalize_sheet_number(sheet_number)
        prefix_match = re.match(r"([A-Z]+)", normalized)
        prefix = prefix_match.group(1) if prefix_match else ""
        if prefix not in target_prefixes:
            continue
        index_position = int(entry.get("index_position") or 0)
        distance = abs(index_position - page_number) if index_position else 999
        if distance > 3:
            continue
        candidates.append((distance, target_prefixes.index(prefix), index_position, entry))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], item[1], item[2]))
    return candidates[0][3]


def _sheet_prefixes_from_title_context(page: dict) -> list[str]:
    context = _title_context_text(page)
    if not context:
        return []
    has_demolition = bool(re.search(r"\bDEMOLITION\b|\bDEMO\b", context))
    if has_demolition and re.search(r"\bELECTRICAL\b", context):
        return ["ED"]
    if has_demolition and re.search(r"\bPLUMBING\b", context):
        return ["PD"]
    if has_demolition and re.search(r"\bMECHANICAL\b", context):
        return ["MD"]
    if has_demolition and re.search(r"\bARCHITECTURAL\b", context):
        return ["AD"]
    if _has_accessibility_title_context(page):
        return ["ADA"]
    return []


def _position_fallback_blocked_by_title_context(page: dict, expected: dict) -> bool:
    if not _has_accessibility_title_context(page):
        return False
    normalized = normalize_sheet_number(expected.get("sheet_number"))
    prefix_match = re.match(r"([A-Z]+)", normalized)
    return bool(prefix_match and prefix_match.group(1) == "AD")


def _standalone_ada_visual_position_match(page: dict, expected_number: str) -> bool:
    if normalize_sheet_number(expected_number) != "ADA":
        return False
    visual = page.get("visual_title_sheet_number")
    if not isinstance(visual, dict):
        return False
    if not bool(visual.get("present")) or float(visual.get("confidence") or 0) < 70:
        return False
    page_number = int(page.get("page_number") or 0)
    return page_number > 1 and not (page.get("is_cover_sheet") or page.get("cover_type"))


def _sheet_index_position_visual_match(
    page: dict,
    expected: dict,
    *,
    reliable_position_alignment: bool,
) -> bool:
    if not reliable_position_alignment:
        return False
    if not isinstance(expected, dict):
        return False
    if not _page_has_visual_title_sheet_number(page, expected.get("sheet_number", "")):
        return False
    page_number = int(page.get("_physical_index_position") or page.get("page_number") or 0)
    index_position = int(expected.get("index_position") or 0)
    return bool(page_number and index_position and page_number == index_position)


def _has_accessibility_title_context(page: dict) -> bool:
    context = _title_context_text(page)
    return bool(re.search(r"\bACCESSIBILITY\b|\bADA\b", context))


def _title_context_text(page: dict) -> str:
    parts = [str(page.get("title_block_text") or "")]
    if page.get("sheet_source") not in INFERRED_SHEET_SOURCES:
        parts.append(str(page.get("sheet_name") or ""))
    context = " ".join(parts).upper()
    return re.sub(r"\s+", " ", context)


def physical_sheets_from_pages(pages: list[dict]) -> list[dict]:
    return [
        {
            "sheet_number": page.get("sheet_number", ""),
            "sheet_name": page.get("sheet_name", ""),
            "page_number": page.get("page_number"),
            "index_position": None,
            "confidence": page.get("title_block_confidence", 0),
            "source": page.get("sheet_source") or ("manual" if page.get("manually_corrected") else "title_block"),
            "missing_sheet_number": bool(page.get("physical_sheet_number_missing"))
            or not bool(normalize_sheet_number(page.get("sheet_number"))),
        }
        for page in pages
        if not _is_ignorable_secondary_cover_page(page)
    ]


def _physical_position_by_page_number(pages: list[dict]) -> dict[int, int]:
    ignored_numbers = sorted(
        int(page.get("page_number") or 0)
        for page in pages
        if page.get("page_number") is not None and _is_ignorable_secondary_cover_page(page)
    )
    positions: dict[int, int] = {}
    for page in pages:
        page_number = int(page.get("page_number") or 0)
        if not page_number:
            continue
        ignored_before = sum(1 for ignored in ignored_numbers if ignored < page_number)
        positions[page_number] = page_number - ignored_before
    return positions


def _extract_entries_from_text(text: str, source_page: int | None) -> list[SheetEntry]:
    entries: list[SheetEntry] = []
    header_match = INDEX_HEADER_RE.search(text)
    lines = [re.sub(r"\s+", " ", raw_line).strip() for raw_line in text.splitlines()]
    if header_match:
        index_lines = _index_table_lines_around_header(lines)
        if index_lines:
            lines = index_lines
        else:
            text = text[header_match.start():]
            lines = [re.sub(r"\s+", " ", raw_line).strip() for raw_line in text.splitlines()]
    for line_index, line in enumerate(lines):
        if not line or len(line) > 180:
            continue
        match = NAMED_COVER_SHEET_RE.search(line) or SHEET_NUMBER_RE.search(line)
        if not match:
            continue
        sheet_number = re.sub(r"\s+", "", match.group(0).upper())
        if sheet_number == "ADA" and not re.fullmatch(r"ADA", line, re.IGNORECASE):
            continue
        sheet_name = clean_title_candidate(line, sheet_number)
        if sheet_name == sheet_number:
            sheet_name = ""
        if re.fullmatch(re.escape(sheet_number), line, re.IGNORECASE) and not sheet_name:
            nearby = [
                candidate for candidate in lines[line_index + 1 : line_index + 4]
                if candidate and candidate.upper() != sheet_number
            ]
            if nearby and re.fullmatch(r"COVER\s+SHEET", nearby[0], re.IGNORECASE):
                sheet_name = nearby[0]
        entries.append(
            SheetEntry(
                sheet_number=sheet_number,
                sheet_name=sheet_name,
                page_number=source_page,
                confidence=80 if sheet_name else 62,
                source="sheet_index",
            )
        )
    return entries


def _index_table_lines_around_header(lines: list[str]) -> list[str]:
    header_indices = [index for index, line in enumerate(lines) if INDEX_HEADER_RE.search(line)]
    if not header_indices:
        return []
    sheet_number_indices = [
        index for index, line in enumerate(lines)
        if _line_is_sheet_index_number(line)
    ]
    if not sheet_number_indices:
        return []
    selected_indices: set[int] = set()
    for header_index in header_indices:
        before_runs = _consecutive_runs([index for index in sheet_number_indices if index < header_index])
        before_run = max(before_runs, key=len) if before_runs else []
        after_numbers = [
            index for index in sheet_number_indices
            if index > header_index and index <= min(len(lines) - 1, header_index + 260)
        ]
        if len(before_run) >= 3:
            selected_indices.update(before_run)
        selected_indices.update(after_numbers)
    if not selected_indices:
        return []
    start = min(selected_indices)
    end = min(len(lines) - 1, max(selected_indices) + 3)
    return lines[start : end + 1]


def _line_is_sheet_index_number(line: str) -> bool:
    if not line or len(line) > 24:
        return False
    normalized = re.sub(r"\s+", "", line.upper())
    if normalized == "ADA":
        return True
    return bool(
        re.fullmatch(NAMED_COVER_SHEET_RE, line)
        or re.fullmatch(SHEET_NUMBER_RE, line)
    )


def _consecutive_runs(values: list[int]) -> list[list[int]]:
    runs: list[list[int]] = []
    current: list[int] = []
    for value in sorted(values):
        if not current or value == current[-1] + 1:
            current.append(value)
            continue
        runs.append(current)
        current = [value]
    if current:
        runs.append(current)
    return runs


def _entry_from_dict(item: dict, source: str) -> SheetEntry:
    return SheetEntry(
        sheet_number=item.get("sheet_number", ""),
        sheet_name=item.get("sheet_name", ""),
        page_number=item.get("page_number"),
        index_position=item.get("index_position"),
        confidence=item.get("confidence", 0),
        source=item.get("source", source),
        missing_sheet_number=bool(item.get("missing_sheet_number")),
    )


def _missing_row(entry: SheetEntry) -> dict:
    return {
        "sheet_number": entry.sheet_number,
        "sheet_name": entry.sheet_name,
        "index_position": entry.index_position,
        "physical_page_number": None,
    }


def _extra_row(entry: SheetEntry) -> dict:
    return {
        "sheet_number": entry.sheet_number,
        "sheet_name": entry.sheet_name,
        "index_position": None,
        "physical_page_number": entry.page_number,
    }


def _duplicate_row(entry: SheetEntry) -> dict:
    return {
        "sheet_number": entry.sheet_number,
        "sheet_name": entry.sheet_name,
        "index_position": None,
        "physical_page_number": entry.page_number,
        "comment": "This sheet number appears more than once in the document.",
    }


def _inferred_row(entry: SheetEntry) -> dict:
    return {
        "sheet_number": entry.sheet_number,
        "sheet_name": entry.sheet_name,
        "index_position": entry.index_position,
        "physical_page_number": entry.page_number,
        "confidence": entry.confidence,
        "source": entry.source,
        "comment": "Physical page had no readable bottom-right sheet number; matched by index position.",
    }


def _missing_sheet_number_row(entry: SheetEntry) -> dict:
    inferred = bool(entry.normalized_number())
    return {
        "sheet_number": entry.sheet_number if inferred else "",
        "sheet_name": entry.sheet_name,
        "index_position": None,
        "physical_page_number": entry.page_number,
        "confidence": entry.confidence,
        "source": entry.source,
        "comment": (
            "Physical page has no readable sheet number; sheet identity was inferred from the index/page position."
            if inferred
            else "Physical page has no readable sheet number. Sheet index was not used to fill this value."
        ),
    }


def _duplicate_physical_entries(entries: list[SheetEntry]) -> list[SheetEntry]:
    seen: set[str] = set()
    duplicates: list[SheetEntry] = []
    for entry in entries:
        normalized = entry.normalized_number()
        if not normalized:
            continue
        if normalized in seen:
            duplicates.append(entry)
        else:
            seen.add(normalized)
    return duplicates


def _unique_in_order(numbers: object) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for number in numbers:
        if not number or number in seen:
            continue
        seen.add(str(number))
        unique.append(str(number))
    return unique


def _exclude_secondary_cover_index_entries(
    indexed: list[SheetEntry],
    physical_numbers: list[str],
    pages: list[dict],
) -> tuple[list[SheetEntry], list[SheetEntry]]:
    secondary_cover_count = sum(1 for page in pages if _is_ignorable_secondary_cover_page(page))
    if not secondary_cover_count:
        return indexed, []

    physical_set = set(physical_numbers)
    kept: list[SheetEntry] = []
    ignored: list[SheetEntry] = []
    for entry in indexed:
        is_unmatched_cover = (
            entry.normalized_number() not in physical_set
            and bool(re.search(r"\bCOVER\s+SHEET\b", entry.sheet_name, re.IGNORECASE))
        )
        if is_unmatched_cover and len(ignored) < secondary_cover_count:
            ignored.append(entry)
        else:
            kept.append(entry)
    return kept, ignored


def _is_ignorable_secondary_cover_page(page: dict) -> bool:
    if page.get("cover_type") != "secondary":
        return False
    sheet_number = str(page.get("sheet_number") or "").upper()
    if re.fullmatch(r"B[- ]?\d+(?:\.\d+)?", sheet_number):
        return False
    if re.fullmatch(r"C[- ]?0(?:\.0+)?", sheet_number):
        return False
    return True


def _is_index_cover_entry(entry: dict) -> bool:
    sheet_number = str(entry.get("sheet_number") or "").upper()
    sheet_name = str(entry.get("sheet_name") or "").upper()
    if re.fullmatch(r"C[- ]?0(?:\.0+)?", sheet_number) or sheet_number.startswith("CS-"):
        return False
    return bool(
        re.search(r"\bCOVER\s+SHEET\b", sheet_name)
    )


def _ignored_secondary_cover_row(entry: SheetEntry) -> dict:
    return {
        "sheet_number": entry.sheet_number,
        "sheet_name": entry.sheet_name,
        "index_position": entry.index_position,
        "comment": "Index entry corresponds to a secondary cover page and is excluded from missing-sheet checks.",
    }


def _name_for(number: str, indexed: list[SheetEntry], physical: list[SheetEntry]) -> str:
    for entry in [*indexed, *physical]:
        if entry.normalized_number() == number and entry.sheet_name:
            return entry.sheet_name
    return ""
