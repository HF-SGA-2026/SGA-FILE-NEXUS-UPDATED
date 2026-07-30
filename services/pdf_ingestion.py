from __future__ import annotations

import hashlib
import json
import os
import re
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable

from services.schemas import PageExtraction
from services.cover_sheet_analyzer import (
    detect_consultant_information_from_page,
    detect_cover_visuals_from_page,
    detect_owner_information_from_page,
)
from services.json_storage import read_json, write_json_atomic
from services.keynote_detector import detect_graphic_keynote_symbols
from services.qc_scope import is_architectural_sheet_number
from services.seal_detector import detect_professional_seal
from services.title_block_extractor import extract_title_block


APP_DIR = Path(__file__).resolve().parents[1]
RUNS_DIR = APP_DIR / "data" / "sga_qc" / "runs"
CACHE_DIR = APP_DIR / "data" / "sga_qc" / "cache"
CACHE_VERSION = "2026-07-29-scoped-a-cover-ops-v12"
THUMBNAIL_SCALE = 0.22
PREVIEW_SCALE = 1.2
MAX_PAGE_WORKERS = max(1, min((os.cpu_count() or 2), 4))


ProgressCallback = Callable[[int, int, str], None]


class CachedPdfPage:
    """Small per-page cache for repeated PyMuPDF text/image metadata calls."""

    def __init__(self, page: Any) -> None:
        self._page = page
        self._text_cache: dict[tuple[Any, ...], Any] = {}
        self._image_info_cache: dict[tuple[Any, ...], Any] = {}
        self._label_loaded = False
        self._label = ""

    def __getattr__(self, name: str) -> Any:
        return getattr(self._page, name)

    def get_text(self, *args: Any, **kwargs: Any) -> Any:
        key = _cache_key(args, kwargs)
        if key not in self._text_cache:
            self._text_cache[key] = self._page.get_text(*args, **kwargs)
        return self._text_cache[key]

    def get_image_info(self, *args: Any, **kwargs: Any) -> Any:
        key = _cache_key(args, kwargs)
        if key not in self._image_info_cache:
            self._image_info_cache[key] = self._page.get_image_info(*args, **kwargs)
        return self._image_info_cache[key]

    def get_label(self) -> str:
        if not self._label_loaded:
            self._label = self._page.get_label()
            self._label_loaded = True
        return self._label


def _cache_key(args: tuple[Any, ...], kwargs: dict[str, Any]) -> tuple[Any, ...]:
    return (
        tuple(_cache_value(arg) for arg in args),
        tuple(sorted((key, _cache_value(value)) for key, value in kwargs.items())),
    )


def _cache_value(value: Any) -> Any:
    if hasattr(value, "x0") and hasattr(value, "y0") and hasattr(value, "x1") and hasattr(value, "y1"):
        return (
            type(value).__name__,
            round(float(value.x0), 4),
            round(float(value.y0), 4),
            round(float(value.x1), 4),
            round(float(value.y1), 4),
        )
    if isinstance(value, (str, int, float, bool, type(None))):
        return value
    return repr(value)


def ingest_pdf(pdf_path: Path, run_id: str, progress_callback: ProgressCallback | None = None) -> dict[str, Any]:
    import fitz

    file_hash = hash_file(pdf_path)
    cached = load_cached_extraction(file_hash, run_id, pdf_path.name)
    if cached:
        if progress_callback:
            progress_callback(1, 1, "Loaded cached extraction")
        return cached

    cache_dir = CACHE_DIR / f"{file_hash}-{CACHE_VERSION}"
    thumbnails_dir = cache_dir / "thumbnails"
    thumbnails_dir.mkdir(parents=True, exist_ok=True)

    with fitz.open(pdf_path) as document:
        page_count = document.page_count

    page_indexes = range(1, page_count + 1)
    worker_count = min(MAX_PAGE_WORKERS, page_count or 1)
    if worker_count == 1:
        pages = []
        for page_index in page_indexes:
            pages.append(extract_page(pdf_path, thumbnails_dir, page_index))
            if progress_callback:
                progress_callback(page_index, page_count, f"Scanning page {page_index} of {page_count}")
    else:
        pages_by_index: dict[int, PageExtraction] = {}
        completed = 0
        with ProcessPoolExecutor(max_workers=worker_count) as executor:
            futures = [
                executor.submit(extract_page_worker, (str(pdf_path), str(thumbnails_dir), page_index))
                for page_index in page_indexes
            ]
            for future in as_completed(futures):
                page = future.result()
                pages_by_index[page.page_number] = page
                completed += 1
                if progress_callback:
                    progress_callback(completed, page_count, f"Scanning page {completed} of {page_count}")
        pages = [pages_by_index[index] for index in page_indexes]

    run_data = {
        "run_id": run_id,
        "filename": pdf_path.name,
        "page_count": page_count,
        "file_hash": file_hash,
        "cache_version": CACHE_VERSION,
        "pages": [page.to_dict() for page in pages],
        "physical_sheets": [page.to_sheet_entry().to_dict() for page in pages],
    }
    save_cached_extraction(file_hash, run_data)
    return run_data


def extract_page(pdf_path: Path, thumbnails_dir: Path, page_index: int) -> PageExtraction:
    import fitz

    with fitz.open(pdf_path) as document:
        page = CachedPdfPage(document[page_index - 1])
        try:
            text = page.get_text("text") or ""
        except Exception:
            text = ""
        title_block = extract_title_block(page, text)
        keywords = detect_page_keywords(text)
        run_page_operations = should_run_page_operations(title_block, keywords)
        keynote_symbols = detect_graphic_keynote_symbols(page) if run_page_operations else {}
        owner_information = detect_owner_information_from_page(page) if run_page_operations else {}
        cover_visuals = detect_cover_visuals_from_page(page) if run_page_operations else {}
        consultant_information = detect_consultant_information_from_page(page) if run_page_operations else {}
        seal_check = detect_professional_seal(page) if run_page_operations else {}
        visual_scale_marker = detect_visual_scale_marker(page, text) if run_page_operations else {}
        thumbnail_path = thumbnail_path_for_page(thumbnails_dir, page_index)
        return PageExtraction(
            page_number=page_index,
            text=text[:25000],
            title_block_text=title_block["title_block_text"][:8000],
            sheet_number=title_block["sheet_number"],
            sheet_name=title_block["sheet_name"],
            page_label_text=title_block.get("page_label_text", ""),
            page_label_sheet_number=title_block.get("page_label_sheet_number", ""),
            page_label_confidence=title_block.get("page_label_confidence", 0),
            thumbnail_path=str(thumbnail_path),
            title_block_confidence=title_block["confidence"],
            detected_keywords=keywords,
            keynote_symbols=keynote_symbols,
            owner_information=owner_information,
            cover_visuals=cover_visuals,
            consultant_information=consultant_information,
            seal_check=seal_check,
            visual_scale_marker=visual_scale_marker,
            visual_title_sheet_number=title_block.get("visual_title_sheet_number", {}),
            needs_review=title_block["needs_review"],
        )


def extract_page_worker(args: tuple[str, str, int]) -> PageExtraction:
    pdf_path, thumbnails_dir, page_index = args
    return extract_page(Path(pdf_path), Path(thumbnails_dir), page_index)


def should_run_page_operations(title_block: dict[str, Any], keywords: list[str]) -> bool:
    return "cover" in keywords or is_architectural_sheet_number(title_block.get("sheet_number"))


def render_thumbnail(page: Any, thumbnails_dir: Path, page_index: int) -> Path:
    import fitz

    target = thumbnails_dir / f"page-{page_index:04d}.png"
    if not target.exists():
        pix = page.get_pixmap(matrix=fitz.Matrix(THUMBNAIL_SCALE, THUMBNAIL_SCALE), alpha=False)
        pix.save(target)
    return target


def thumbnail_path_for_page(thumbnails_dir: Path, page_index: int) -> Path:
    return thumbnails_dir / f"page-{page_index:04d}.png"


def render_pdf_thumbnail(pdf_path: Path, thumbnail_path: Path, page_index: int) -> Path:
    import fitz

    if thumbnail_path.exists():
        return thumbnail_path
    thumbnail_path.parent.mkdir(parents=True, exist_ok=True)
    with fitz.open(pdf_path) as document:
        if page_index < 1 or page_index > document.page_count:
            raise IndexError(f"Page {page_index} is outside the document page range.")
        render_thumbnail(document[page_index - 1], thumbnail_path.parent, page_index)
    return thumbnail_path


def render_pdf_preview(pdf_path: Path, preview_path: Path, page_index: int) -> Path:
    import fitz

    if preview_path.exists():
        return preview_path
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    with fitz.open(pdf_path) as document:
        if page_index < 1 or page_index > document.page_count:
            raise IndexError(f"Page {page_index} is outside the document page range.")
        page = document[page_index - 1]
        pix = page.get_pixmap(matrix=fitz.Matrix(PREVIEW_SCALE, PREVIEW_SCALE), alpha=False)
        pix.save(preview_path)
    return preview_path


def detect_visual_scale_marker(page: Any, text: str) -> dict[str, Any]:
    """Detect plotted scale markers that are vector artwork, not text.

    Some civil/site sheets plot the north arrow and scale label as pale vector
    outlines. PyMuPDF does not expose that label as searchable text, so this
    only marks a page when a site-plan sheet has light vector ink in the
    typical north-arrow scale area.
    """
    upper = (text or "").upper()
    if "SITE PLAN" not in upper:
        return {"present": False, "source": "visual"}
    if "SCALE" in upper or re.search(r'\d+\s*"\s*=\s*\d+\s*\'', upper):
        return {"present": False, "source": "visual"}
    try:
        import fitz
        import numpy as np

        rect = page.rect
        clip = fitz.Rect(rect.width * 0.70, rect.height * 0.22, rect.width * 0.92, rect.height * 0.55)
        pixmap = page.get_pixmap(matrix=fitz.Matrix(1, 1), clip=clip, alpha=False)
        pixels = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, 3)
    except Exception:
        return {"present": False, "source": "visual"}

    gray = pixels.mean(axis=2)
    dark_ink = int((gray < 150).sum())
    light_vector_ink = int(((gray >= 150) & (gray < 235)).sum())
    present = 150 <= dark_ink <= 2000 and 800 <= light_vector_ink <= 8000
    return {
        "present": bool(present),
        "source": "visual",
        "evidence": "Light vector scale marker in site-plan north-arrow area." if present else "",
        "dark_pixel_count": dark_ink,
        "light_pixel_count": light_vector_ink,
    }


def load_cached_extraction(file_hash: str, run_id: str, filename: str) -> dict[str, Any] | None:
    cache_path = CACHE_DIR / f"{file_hash}-{CACHE_VERSION}" / "extraction.json"
    if not cache_path.exists():
        return None
    try:
        cached = read_json(cache_path)
    except Exception:
        return None
    if cached.get("file_hash") != file_hash or cached.get("cache_version") != CACHE_VERSION:
        return None
    run_data = dict(cached)
    run_data["run_id"] = run_id
    run_data["filename"] = filename
    return run_data


def save_cached_extraction(file_hash: str, run_data: dict[str, Any]) -> None:
    cache_path = CACHE_DIR / f"{file_hash}-{CACHE_VERSION}" / "extraction.json"
    cached = dict(run_data)
    cached["run_id"] = "cached"
    write_json_atomic(cache_path, cached)


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def detect_page_keywords(text: str) -> list[str]:
    upper = text.upper()
    terms = {
        "cover": ["COVER", "TITLE SHEET"],
        "sheet_index": ["SHEET INDEX", "DRAWING INDEX", "INDEX OF SHEETS", "SHEET LIST"],
        "keynotes": ["KEYNOTE", "KEYNOTES"],
        "legend": ["LEGEND"],
        "seal": ["SEAL", "SIGNED", "REGISTERED", "ARCHITECT"],
        "nfc": ["NOT FOR CONSTRUCTION", "N.F.C.", "PROGRESS SET", "PROGRESS DRAWING"],
        "permit": ["PERMIT SET", "CONSTRUCTION SET"],
    }
    return [key for key, needles in terms.items() if any(needle in upper for needle in needles)]
