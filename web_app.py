from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from threading import Thread
from uuid import uuid4

from fastapi import File, HTTPException, UploadFile
from fastapi import FastAPI
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from services.cover_sheet_analyzer import (
    analyze_cover_sheet,
    classify_cover_sheets,
    detect_consultant_information_from_page,
    detect_cover_visuals_from_page,
    detect_owner_information_from_page,
)
from services.json_storage import read_json, write_json_atomic
from services.pdf_ingestion import RUNS_DIR, ingest_pdf, render_pdf_preview, render_pdf_thumbnail
from services.qc_report_generator import build_qc_result, result_to_csv, result_to_pdf
from services.qc_scope import (
    is_architectural_or_cover_page,
    is_cover_sheet_number,
    scoped_qc_index_entries,
    scoped_qc_pages,
)
from services.sheet_index_extractor import (
    apply_index_position_fallback_to_pages,
    compare_index_to_physical,
    extract_sheet_index,
    physical_sheets_from_pages,
)
from services.seal_detector import detect_professional_seal
from services.spell_check import run_spell_check
from services.title_block_extractor import detect_sheet_number_from_page_label
from services.viewport_detector import evaluate_keynote_compliance, evaluate_missing_scale_checks


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "web" / "static"
PDF_UPLOAD_EXTENSIONS = {".pdf"}
IMAGE_UPLOAD_EXTENSIONS = {".jpg", ".jpeg", ".png"}
ALLOWED_UPLOAD_EXTENSIONS = PDF_UPLOAD_EXTENSIONS | IMAGE_UPLOAD_EXTENSIONS
QC_RULES_VERSION = 27

app = FastAPI(title="Quality Assurance Check", version="0.1.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def prevent_stale_local_app_cache(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...)) -> dict:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Upload a PDF or image drawing sheet.")
    extension = Path(file.filename).suffix.lower()
    if extension not in ALLOWED_UPLOAD_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Upload a PDF, JPG, JPEG, or PNG drawing file.")
    run_id = uuid4().hex[:12]
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    safe_name = Path(file.filename).name
    upload_path = run_dir / safe_name
    with upload_path.open("wb") as target:
        shutil.copyfileobj(file.file, target)
    pdf_path = upload_path
    if extension in IMAGE_UPLOAD_EXTENSIONS:
        pdf_path = convert_image_upload_to_pdf(upload_path)

    write_run_status(run_id, "Queued", 1, "Preparing drawing scan.")
    worker = Thread(target=process_uploaded_pdf, args=(run_id, pdf_path), daemon=True)
    worker.start()
    return {"run_id": run_id, "status": "Queued", "percent": 1, "message": "Preparing drawing scan."}


def convert_image_upload_to_pdf(image_path: Path) -> Path:
    import fitz

    pdf_path = image_path.with_suffix(".pdf")
    try:
        with fitz.open(image_path) as image_document:
            pdf_bytes = image_document.convert_to_pdf()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="The uploaded image could not be converted to PDF.") from exc
    pdf_path.write_bytes(pdf_bytes)
    return pdf_path


@app.get("/api/runs/{run_id}/status")
def get_run_status(run_id: str) -> dict:
    return read_run_status(run_id)


@app.get("/api/runs")
def list_runs() -> dict:
    runs = []
    if RUNS_DIR.exists():
        for run_dir in RUNS_DIR.iterdir():
            if not run_dir.is_dir():
                continue
            run_file = run_dir / "run.json"
            if not run_file.exists():
                continue
            try:
                run_data = read_json(run_file)
            except Exception:
                continue
            status = {}
            status_file = run_dir / "status.json"
            if status_file.exists():
                try:
                    status = read_json(status_file)
                except Exception:
                    status = {}
            summary = display_needs_review_as_pass(
                run_data.get("qc_result", {}).get("executive_summary", {})
            )
            runs.append({
                "run_id": run_data.get("run_id") or run_dir.name,
                "filename": run_data.get("filename") or "Untitled PDF",
                "page_count": run_data.get("page_count") or len(run_data.get("pages", [])),
                "status": status.get("status") or ("Complete" if run_data.get("qc_result") else "Scanned"),
                "overall_status": summary.get("overall_status") if isinstance(summary, dict) else "",
                "failed_items": summary.get("failed_items") if isinstance(summary, dict) else 0,
                "modified_time": run_file.stat().st_mtime,
                "created_time": run_dir.stat().st_ctime,
                "thumbnail_url": f"/api/runs/{run_data.get('run_id') or run_dir.name}/thumbnail/1",
            })
    runs.sort(key=lambda item: item["modified_time"], reverse=True)
    return {"runs": runs[:25]}


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict:
    run_data = load_run(run_id)
    if _run_needs_qc_refresh(run_data):
        run_data = rebuild_qc_for_run(run_id, run_data)
    return public_run_payload(run_data)


@app.put("/api/runs/{run_id}/extractions")
async def update_extractions(run_id: str, payload: dict) -> dict:
    run_data = load_run(run_id)
    if "pages" in payload:
        run_data["pages"] = merge_page_private_fields(run_data.get("pages", []), payload["pages"])
        classify_cover_sheets(run_data["pages"])
        run_data["pages"] = scoped_qc_pages(run_data["pages"])
        run_data["physical_sheets"] = physical_sheets_from_pages(run_data["pages"])
    if "sheet_index" in payload:
        scoped_entries = scoped_qc_index_entries(payload["sheet_index"].get("entries", []), run_data.get("pages", []))
        run_data["sheet_index"] = {**payload["sheet_index"], "entries": scoped_entries}
    save_run(run_id, run_data)
    return public_run_payload(run_data)


def merge_page_private_fields(existing_pages: list[dict], incoming_pages: list[dict]) -> list[dict]:
    existing_by_number = {
        int(page.get("page_number") or 0): page
        for page in existing_pages
        if page.get("page_number") is not None
    }
    private_keys = ("thumbnail_path",)
    merged_pages = []
    for incoming in incoming_pages:
        merged = dict(incoming)
        existing = existing_by_number.get(int(incoming.get("page_number") or 0), {})
        for key in private_keys:
            if not merged.get(key) and existing.get(key):
                merged[key] = existing[key]
        merged_pages.append(merged)
    return merged_pages


@app.post("/api/runs/{run_id}/qc")
def run_qc(run_id: str) -> dict:
    run_data = load_run(run_id)
    run_data = rebuild_qc_for_run(run_id, run_data)
    return public_run_payload(run_data)


def rebuild_qc_for_run(run_id: str, run_data: dict) -> dict:
    run_data = restore_full_extraction_for_scope_refresh(run_id, run_data)
    classify_cover_sheets(run_data["pages"])
    refresh_cover_geometry(run_id, run_data)
    stored_index = run_data.get("sheet_index") or {}
    extracted_index = extract_sheet_index(run_data["pages"])
    has_manual_index_edits = any(
        entry.get("manually_corrected") or entry.get("source") == "manual"
        for entry in stored_index.get("entries", [])
    )
    sheet_index = stored_index if has_manual_index_edits else (extracted_index if extracted_index.get("entries") else stored_index)
    run_data["pages"] = apply_index_position_fallback_to_pages(run_data["pages"], sheet_index)
    apply_extraction_scope(run_data, sheet_index)
    cover = analyze_cover_sheet(run_data["pages"], run_data.get("sheet_index", {}), run_data.get("filename", ""))
    review_pages = run_data["pages"]
    review_sheet_index_entries = run_data.get("sheet_index", {}).get("entries", [])
    review_physical_sheets = run_data["physical_sheets"]
    index_check = compare_index_to_physical(
        review_sheet_index_entries,
        review_physical_sheets,
        review_pages,
    )
    keynote = evaluate_keynote_compliance(review_pages, cover.get("cover_page_number"))
    scale_findings = evaluate_missing_scale_checks(review_pages)
    review_run_data = {
        **run_data,
        "pages": review_pages,
        "physical_sheets": review_physical_sheets,
        "sheet_index": run_data["sheet_index"],
        "qc_review_scope": "Cover sheet and sheets whose sheet number starts with A.",
    }
    run_data["qc_result"] = build_qc_result(
        review_run_data, cover, index_check, keynote["viewport_findings"], keynote["sheet_reviews"], scale_findings
    )
    run_data["qc_result"]["review_scope"] = review_run_data["qc_review_scope"]
    run_data["qc_rules_version"] = QC_RULES_VERSION
    save_run(run_id, run_data)
    return run_data


def restore_full_extraction_for_scope_refresh(run_id: str, run_data: dict) -> dict:
    if not run_data.get("extraction_scope"):
        return run_data
    pdf_path = RUNS_DIR / run_id / str(run_data.get("filename") or "")
    if not pdf_path.exists():
        return run_data
    restored = ingest_pdf(pdf_path, run_id)
    for key in ("spell_check",):
        if key in run_data:
            restored[key] = run_data[key]
    return restored


def apply_extraction_scope(run_data: dict, sheet_index: dict) -> None:
    apply_page_label_scope_identity(run_data.get("pages", []))
    scoped_pages = scoped_qc_pages(run_data.get("pages", []))
    scoped_index_entries = scoped_qc_index_entries(sheet_index.get("entries", []), scoped_pages)
    if not scoped_index_entries:
        scoped_index_entries = sheet_index_entries_from_scoped_pages(scoped_pages)
    run_data["pages"] = scoped_pages
    run_data["sheet_index"] = {**sheet_index, "entries": scoped_index_entries}
    run_data["physical_sheets"] = physical_sheets_from_pages(scoped_pages)
    run_data["extraction_scope"] = "Cover sheet and sheets whose sheet number starts with A."


def apply_page_label_scope_identity(pages: list[dict]) -> None:
    for page in pages:
        if page.get("sheet_number"):
            continue
        label_number = str(page.get("page_label_sheet_number") or "").strip()
        if not label_number:
            continue
        normalized = "".join(char for char in label_number.upper() if char.isalnum() or char == ".")
        if not (normalized.startswith("A") or is_cover_sheet_number(label_number)):
            continue
        page["sheet_number"] = label_number
        page["sheet_name"] = page.get("sheet_name") or ""
        page["title_block_confidence"] = max(float(page.get("title_block_confidence") or 0), float(page.get("page_label_confidence") or 0))
        page["sheet_source"] = "page_label_scope"
        page["physical_sheet_number_missing"] = False
        page["needs_review"] = False
        page["sheet_number_decision"] = {
            "sheet_number": label_number,
            "source": "page_label_scope",
            "physical_sheet_number_missing": False,
            "reason": "No readable title-block sheet number was extracted; page identity came from the PDF page label because it is in the configured cover/A-sheet scope.",
            "evidence": {
                "page_label": {
                    "sheet_number": label_number,
                    "text": page.get("page_label_text", ""),
                    "confidence": float(page.get("page_label_confidence") or 0),
                    "matches_final": True,
                },
            },
        }


def sheet_index_entries_from_scoped_pages(scoped_pages: list[dict]) -> list[dict]:
    entries = []
    seen = set()
    for page in scoped_pages:
        sheet_number = str(page.get("sheet_number") or "").strip()
        normalized = "".join(char for char in sheet_number.upper() if char.isalnum() or char == ".")
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        entries.append({
            "sheet_number": sheet_number,
            "sheet_name": page.get("sheet_name", ""),
            "page_number": page.get("page_number"),
            "index_position": len(entries) + 1,
            "confidence": page.get("title_block_confidence", 0),
            "source": "page_label_scope",
            "missing_sheet_number": False,
        })
    return entries


def _run_needs_qc_refresh(run_data: dict) -> bool:
    if not run_data.get("qc_result"):
        return False
    if int(run_data.get("qc_rules_version") or 0) < QC_RULES_VERSION:
        return True
    return False


def refresh_cover_geometry(run_id: str, run_data: dict) -> None:
    import fitz

    pdf_path = RUNS_DIR / run_id / str(run_data.get("filename") or "")
    if not pdf_path.exists():
        return
    cover_pages = {
        int(page.get("page_number") or 0): page
        for page in run_data.get("pages", [])
        if page.get("is_cover_sheet")
    }
    with fitz.open(pdf_path) as document:
        for extraction in run_data.get("pages", []):
            page_number = int(extraction.get("page_number") or 0)
            if 1 <= page_number <= document.page_count and is_architectural_or_cover_page(extraction):
                extraction["seal_check"] = detect_professional_seal(document[page_number - 1])
            if (
                extraction.get("manually_corrected")
                or extraction.get("sheet_number") != "COVER"
                or not 1 <= page_number <= document.page_count
            ):
                continue
            label_number, label_confidence = detect_sheet_number_from_page_label(document[page_number - 1])
            if label_number and label_number != "COVER":
                extraction["sheet_number"] = label_number
                extraction["sheet_name"] = ""
                extraction["title_block_confidence"] = min(label_confidence, 92)
                extraction["needs_review"] = False
                extraction["sheet_source"] = "page_label_correction"
        if not cover_pages:
            return
        for page_number, extraction in cover_pages.items():
            if not 1 <= page_number <= document.page_count:
                continue
            pdf_page = document[page_number - 1]
            extraction["cover_visuals"] = detect_cover_visuals_from_page(pdf_page)
            extraction["owner_information"] = detect_owner_information_from_page(pdf_page)
            extraction["consultant_information"] = detect_consultant_information_from_page(pdf_page)


@app.post("/api/runs/{run_id}/spell-check")
async def spell_check_run(run_id: str, payload: dict | None = None) -> dict:
    run_data = load_run(run_id)
    custom_dictionary = (payload or {}).get("custom_dictionary", [])
    result = run_spell_check(
        run_id,
        pages=scoped_qc_pages(run_data.get("pages", [])),
        custom_dictionary=custom_dictionary,
    )
    run_data["spell_check"] = result
    save_run(run_id, run_data)
    return result


@app.get("/api/runs/{run_id}/export.csv")
def export_csv(run_id: str) -> Response:
    run_data = load_run(run_id)
    result = display_needs_review_as_pass(run_data.get("qc_result"))
    if not result:
        raise HTTPException(status_code=404, detail="QC result not found.")
    result = result_with_spell_check(run_id, run_data, result)
    return Response(
        result_to_csv(result),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="sga_qc_integrity_report.csv"'},
    )


@app.get("/api/runs/{run_id}/export.pdf")
def export_pdf(run_id: str) -> Response:
    run_data = load_run(run_id)
    result = display_needs_review_as_pass(run_data.get("qc_result"))
    if not result:
        raise HTTPException(status_code=404, detail="QC result not found.")
    result = result_with_spell_check(run_id, run_data, result)
    return Response(
        result_to_pdf(result),
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="sga_qc_integrity_report.pdf"'},
    )


@app.post("/api/runs/{run_id}/export.{export_format}/show")
def save_and_show_export(run_id: str, export_format: str) -> dict:
    run_data = load_run(run_id)
    result = display_needs_review_as_pass(run_data.get("qc_result"))
    if not result:
        raise HTTPException(status_code=404, detail="QC result not found.")
    if export_format not in {"csv", "pdf"}:
        raise HTTPException(status_code=400, detail="Export format must be CSV or PDF.")
    result = result_with_spell_check(run_id, run_data, result)

    downloads_dir = Path.home() / "Downloads"
    downloads_dir.mkdir(parents=True, exist_ok=True)
    export_path = downloads_dir / f"Quality Assurance Check Report.{export_format}"
    if export_format == "pdf":
        export_path.write_bytes(result_to_pdf(result))
    else:
        export_path.write_text(result_to_csv(result), encoding="utf-8-sig")

    try:
        subprocess.Popen(["explorer.exe", str(downloads_dir)])
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Export saved, but File Explorer could not be opened: {export_path}") from exc
    return {"path": str(export_path), "message": f"Export saved to Downloads: {export_path.name}"}


@app.get("/api/runs/{run_id}/thumbnail/{page_number}")
def thumbnail(run_id: str, page_number: int) -> FileResponse:
    run_data = load_run(run_id)
    page = next((item for item in run_data["pages"] if int(item["page_number"]) == page_number), None)
    if not page or not page.get("thumbnail_path"):
        raise HTTPException(status_code=404, detail="Thumbnail not found.")
    thumbnail_path = Path(page["thumbnail_path"])
    if not thumbnail_path.exists():
        pdf_path = RUNS_DIR / run_id / str(run_data.get("filename") or "")
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail="Source document not found.")
        try:
            render_pdf_thumbnail(pdf_path, thumbnail_path, page_number)
        except Exception as exc:
            raise HTTPException(status_code=404, detail="Thumbnail could not be generated.") from exc
    return FileResponse(thumbnail_path)


@app.get("/api/runs/{run_id}/preview/{page_number}")
def page_preview(run_id: str, page_number: int) -> FileResponse:
    run_data = load_run(run_id)
    page = next((item for item in run_data["pages"] if int(item["page_number"]) == page_number), None)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found.")
    pdf_path = RUNS_DIR / run_id / str(run_data.get("filename") or "")
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="Source document not found.")
    preview_path = RUNS_DIR / run_id / "previews" / f"page-{page_number:04d}.png"
    try:
        render_pdf_preview(pdf_path, preview_path, page_number)
    except Exception as exc:
        raise HTTPException(status_code=404, detail="Preview could not be generated.") from exc
    return FileResponse(preview_path)


def run_path(run_id: str) -> Path:
    if not run_id.replace("-", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid run id.")
    return RUNS_DIR / run_id / "run.json"


def load_run(run_id: str) -> dict:
    path = run_path(run_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Run not found.")
    return read_json(path)


def save_run(run_id: str, run_data: dict) -> None:
    path = run_path(run_id)
    write_json_atomic(path, run_data)


def result_with_spell_check(run_id: str, run_data: dict, result: dict) -> dict:
    export_result = dict(result)
    spell_check = run_data.get("spell_check")
    if not spell_check:
        spell_check = run_spell_check(run_id, pages=scoped_qc_pages(run_data.get("pages", [])))
        run_data["spell_check"] = spell_check
        save_run(run_id, run_data)
    export_result["spell_check"] = spell_check
    return export_result


def process_uploaded_pdf(run_id: str, pdf_path: Path) -> None:
    try:
        write_run_status(run_id, "Scanning", 3, "Opening PDF.")

        def ingestion_progress(done: int, total: int, message: str) -> None:
            if total <= 0:
                percent = 10
            else:
                percent = 5 + round((done / total) * 75)
            write_run_status(run_id, "Scanning", min(percent, 80), message)

        run_data = ingest_pdf(pdf_path, run_id, ingestion_progress)
        classify_cover_sheets(run_data["pages"])
        write_run_status(run_id, "Scanning", 82, "Checking professional seals.")
        refresh_cover_geometry(run_id, run_data)
        write_run_status(run_id, "Scanning", 84, "Extracting sheet index.")
        sheet_index = extract_sheet_index(run_data["pages"])
        run_data["pages"] = apply_index_position_fallback_to_pages(run_data["pages"], sheet_index)
        apply_extraction_scope(run_data, sheet_index)
        write_run_status(run_id, "Scanning", 88, "Checking cover sheet.")
        cover = analyze_cover_sheet(run_data["pages"], run_data.get("sheet_index", {}), run_data.get("filename", ""))
        write_run_status(run_id, "Scanning", 92, "Comparing sheet index to PDF order.")
        review_pages = run_data["pages"]
        review_sheet_index_entries = run_data.get("sheet_index", {}).get("entries", [])
        review_physical_sheets = run_data["physical_sheets"]
        index_check = compare_index_to_physical(
            review_sheet_index_entries,
            review_physical_sheets,
            review_pages,
        )
        write_run_status(run_id, "Scanning", 96, "Running keynote and viewport review.")
        keynote = evaluate_keynote_compliance(review_pages, cover.get("cover_page_number"))
        scale_findings = evaluate_missing_scale_checks(review_pages)
        review_run_data = {
            **run_data,
            "pages": review_pages,
            "physical_sheets": review_physical_sheets,
            "sheet_index": run_data["sheet_index"],
            "qc_review_scope": "Cover sheet and sheets whose sheet number starts with A.",
        }
        result = build_qc_result(
            review_run_data, cover, index_check, keynote["viewport_findings"], keynote["sheet_reviews"], scale_findings
        )
        result["review_scope"] = review_run_data["qc_review_scope"]
        run_data["qc_result"] = result
        run_data["qc_rules_version"] = QC_RULES_VERSION
        save_run(run_id, run_data)
        write_run_status(run_id, "Complete", 100, "Scan complete.")
    except Exception as error:
        write_run_status(run_id, "Failed", 100, str(error))


def status_path(run_id: str) -> Path:
    if not run_id.replace("-", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid run id.")
    return RUNS_DIR / run_id / "status.json"


def read_run_status(run_id: str) -> dict:
    path = status_path(run_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Run status not found.")
    return read_json(path)


def write_run_status(run_id: str, status: str, percent: int, message: str) -> None:
    path = status_path(run_id)
    payload = {
        "run_id": run_id,
        "status": status,
        "percent": max(0, min(100, int(percent))),
        "message": message,
    }
    write_json_atomic(path, payload)


def public_run_payload(run_data: dict) -> dict:
    public = dict(run_data)
    public["qc_result"] = display_needs_review_as_pass(public.get("qc_result"))
    pages = []
    for page in public.get("pages", []):
        visible = dict(page)
        visible["thumbnail_url"] = f"/api/runs/{public['run_id']}/thumbnail/{page['page_number']}"
        visible["preview_url"] = f"/api/runs/{public['run_id']}/preview/{page['page_number']}"
        visible.pop("thumbnail_path", None)
        visible["text"] = visible.get("text", "")[:5000]
        visible["sheet_name"] = str(visible.get("sheet_name", "")).replace("\x00", "").strip()
        visible["ignored_for_sheet_index"] = (
            visible.get("cover_type") == "secondary"
            and not bool(str(visible.get("sheet_number", "")).strip())
        )
        visible["missing_sheet_number"] = (
            not visible["ignored_for_sheet_index"]
            and (
                bool(visible.get("physical_sheet_number_missing"))
                or not bool(str(visible.get("sheet_number", "")).strip())
            )
        )
        pages.append(visible)
    public["pages"] = pages
    return public


def display_needs_review_as_pass(value):
    if value == "Needs Review":
        return "Pass"
    if isinstance(value, str):
        return value.replace("Needs Review", "Pass")
    if isinstance(value, list):
        return [display_needs_review_as_pass(item) for item in value]
    if isinstance(value, dict):
        return {
            key: display_needs_review_as_pass(item)
            for key, item in value.items()
        }
    return value
