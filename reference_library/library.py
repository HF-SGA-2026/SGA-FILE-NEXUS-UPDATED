from __future__ import annotations

import json
import shutil
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from ai.semantic import cosine_similarity, local_embedding
from backend.pdf_processor import extract_pdf_metadata, infer_discipline
from database.models import DocumentMetadata
from database.store import APPROVED_STANDARDS_DIR, DB_PATH, initialize_database, list_reference_documents, save_reference_document, save_standards_version


REFERENCE_DIR = Path(__file__).resolve().parent
RULES_PATH = REFERENCE_DIR / "checkit_rules.json"
CACHE_PATH = REFERENCE_DIR / "checkit_cache.json"

DEFAULT_RULES: dict[str, Any] = {
    "name": "Checkit Focused Production Error Checklist",
    "version": "3.0",
    "scope": "Check only for the listed document-production errors. The scan verifies detectable presence/absence and simple consistency signals, not design correctness.",
    "reference_baseline": "reference_library/normal_document_baseline.json",
    "allowed_errors": [
        "Missing title block",
        "Missing or incorrect project information",
        "Missing or incorrect issue date",
        "Missing drawing index",
        "Missing consultant information",
        "Missing north arrow or scale",
        "Missing revision block",
        "Missing professional seal or signature",
        "Incorrect or duplicate sheet numbers",
        "Missing, blank, or extra sheets",
        "Incorrect sheet titles",
        "Missing view titles or scales",
        "Missing revision history",
        "Text overlapping or cut off",
        "Text too small to read",
        "Placeholder text not removed",
        "Spelling errors",
        "Missing or broken callouts/references",
        "Unreferenced details",
        "Views cropped incorrectly or placed off sheet",
    ],
    "discipline_profiles": {
        "General": {
            "enabled": True,
            "sheet_prefixes": ["G"],
            "required_keywords": ["SCALE", "KEYNOTES"],
            "required_legends": [],
            "annotation_patterns": ["GENERAL NOTE", "KEYNOTE", "REVISION"],
            "naming_conventions": ["PLAN", "ELEVATION", "SECTION", "DETAIL"],
        },
        "Architectural": {
            "enabled": True,
            "sheet_prefixes": ["A", "AD"],
            "required_keywords": ["SCALE", "KEYNOTES"],
            "required_legends": ["LEGEND"],
            "annotation_patterns": ["KEYNOTE", "GENERAL NOTE"],
            "naming_conventions": ["PLAN", "ELEVATION", "SECTION", "DETAIL"],
            "requires_scale": True,
        },
        "Structural": {
            "enabled": True,
            "sheet_prefixes": ["S"],
            "required_keywords": ["SCALE", "GENERAL NOTES"],
            "required_legends": ["LEGEND"],
            "annotation_patterns": ["STRUCTURAL NOTE"],
            "naming_conventions": ["FOUNDATION", "FRAMING", "DETAIL"],
        },
        "Life Safety": {
            "enabled": True,
            "sheet_prefixes": ["LS"],
            "required_keywords": ["SCALE", "EGRESS", "OCCUPANCY"],
            "required_legends": ["LIFE SAFETY LEGEND"],
            "annotation_patterns": ["CODE NOTE"],
            "naming_conventions": ["LIFE SAFETY", "EGRESS", "CODE"],
        },
        "Mechanical": {
            "enabled": True,
            "sheet_prefixes": ["M"],
            "required_keywords": ["SCALE", "LEGEND"],
            "required_legends": ["MECHANICAL LEGEND"],
            "annotation_patterns": ["MECHANICAL NOTE"],
            "naming_conventions": ["HVAC", "MECHANICAL", "SCHEDULE"],
        },
        "Electrical": {
            "enabled": True,
            "sheet_prefixes": ["E"],
            "required_keywords": ["SCALE", "LEGEND"],
            "required_legends": ["ELECTRICAL LEGEND"],
            "annotation_patterns": ["ELECTRICAL NOTE"],
            "naming_conventions": ["POWER", "LIGHTING", "SCHEDULE"],
        },
        "Plumbing": {
            "enabled": True,
            "sheet_prefixes": ["P"],
            "required_keywords": ["SCALE", "LEGEND"],
            "required_legends": ["PLUMBING LEGEND"],
            "annotation_patterns": ["PLUMBING NOTE"],
            "naming_conventions": ["PLUMBING", "RISER", "SCHEDULE"],
        },
    },
}


def ensure_rules_file() -> None:
    REFERENCE_DIR.mkdir(parents=True, exist_ok=True)
    if not RULES_PATH.exists():
        RULES_PATH.write_text(json.dumps(DEFAULT_RULES, indent=2, sort_keys=True), encoding="utf-8")


def load_standards() -> dict[str, Any]:
    initialize_database(DB_PATH)
    ensure_rules_file()
    rules = json.loads(RULES_PATH.read_text(encoding="utf-8"))
    rules["cache"] = load_standards_cache()
    return rules


def save_rules(rules: dict[str, Any]) -> None:
    ensure_rules_file()
    clean_rules = {key: value for key, value in rules.items() if key != "cache"}
    RULES_PATH.write_text(json.dumps(clean_rules, indent=2, sort_keys=True), encoding="utf-8")
    save_standards_version(clean_rules.get("version", "manual update"), clean_rules)


def add_approved_standard(
    source_pdf: Path,
    *,
    project_type: str = "",
    discipline: str | None = None,
    phase: str = "",
    client: str = "",
    building_type: str = "",
    force_ocr: bool = False,
) -> Path:
    initialize_database(DB_PATH)
    APPROVED_STANDARDS_DIR.mkdir(parents=True, exist_ok=True)
    target = APPROVED_STANDARDS_DIR / source_pdf.name
    if source_pdf.resolve() != target.resolve():
        shutil.copy2(source_pdf, target)
    metadata = extract_pdf_metadata(target, project_type=project_type, phase=phase, client=client, building_type=building_type, force_ocr=force_ocr)
    metadata.drawing_type = discipline or metadata.drawing_type or infer_discipline(metadata.sheet_number, metadata.extracted_text)
    embedding = local_embedding(" ".join([metadata.filename, metadata.drawing_type or "", metadata.extracted_text[:12000]]))
    save_reference_document(target, metadata, embedding, DB_PATH)
    rebuild_standards_cache()
    return target


def load_standards_cache() -> dict[str, Any]:
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    return rebuild_standards_cache()


def rebuild_standards_cache() -> dict[str, Any]:
    initialize_database(DB_PATH)
    documents = list_reference_documents(DB_PATH, include_disabled=False)
    title_patterns: Counter[str] = Counter()
    keyword_counts: Counter[str] = Counter()
    disciplines: dict[str, dict[str, Any]] = defaultdict(lambda: {"documents": 0, "sheet_ids": []})
    title_block_count = 0

    for document in documents:
        metadata = document["metadata"]
        discipline = document["discipline"] or metadata.get("drawing_type") or "General"
        disciplines[discipline]["documents"] += 1
        title_block_count += len(metadata.get("title_blocks", {}))
        for title in metadata.get("indexed_sheets", {}).values():
            if title:
                title_patterns[title] += 1
        for block in metadata.get("title_blocks", {}).values():
            title = block.get("sheet_title")
            if title:
                title_patterns[title] += 1
        for keyword in metadata.get("detected_keywords", []):
            keyword_counts[keyword] += 1

    cache = {
        "document_count": len(documents),
        "active_documents": [
            {"id": document["id"], "filename": document["filename"], "discipline": document["discipline"], "added_at": document["added_at"]}
            for document in documents
        ],
        "title_block_count": title_block_count,
        "common_titles": [title for title, _count in title_patterns.most_common(50)],
        "observed_keywords": sorted(keyword_counts),
        "disciplines": disciplines,
    }
    CACHE_PATH.write_text(json.dumps(cache, indent=2, sort_keys=True), encoding="utf-8")
    return cache


def find_similar_references(record: DocumentMetadata, limit: int = 3) -> list[dict[str, Any]]:
    query = local_embedding(" ".join([record.filename, record.drawing_type or "", record.extracted_text[:12000]]))
    matches = []
    for document in list_reference_documents(DB_PATH, include_disabled=False):
        score = cosine_similarity(query, document.get("embedding", []))
        matches.append(
            {
                "id": document["id"],
                "filename": document["filename"],
                "discipline": document["discipline"],
                "score": round(score, 3),
                "metadata": document["metadata"],
            }
        )
    return sorted(matches, key=lambda item: item["score"], reverse=True)[:limit]


def set_discipline_enabled(discipline: str, enabled: bool) -> dict[str, Any]:
    standards = load_standards()
    profile = standards.setdefault("discipline_profiles", {}).setdefault(discipline, {})
    profile["enabled"] = enabled
    save_rules(standards)
    return load_standards()
