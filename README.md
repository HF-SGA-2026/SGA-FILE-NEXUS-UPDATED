# SGA QC Integrity Check

Web-based drawing-set QC for architectural document review. The app accepts PDF and image drawing uploads, extracts sheet data, lets a reviewer correct extracted values, runs deterministic quality checks, and exports review reports.

## Features

- Document upload for PDF, JPG, JPEG, and PNG files.
- Sheet extraction with previews, sheet numbers, sheet names, and title-block confidence.
- Review scope limited to the cover sheet and sheets whose sheet number starts with `A`.
- Cover checklist, seal check, scale check, sheet index integrity, keynote, viewport, and spell-check reports.
- Manual correction of sheet numbers, sheet names, and sheet index entries before rerunning QC.
- Persistent custom dictionary for accepted spell-check terms.
- CSV/PDF report export.

## Stack

- Backend: FastAPI in `web_app.py`
- Frontend: static HTML/CSS/JavaScript in `web/static`
- PDF/image processing: PyMuPDF
- Reports: CSV and ReportLab PDF
- Tests: Python `unittest`

## Setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Run Locally

```powershell
uvicorn web_app:app --host 127.0.0.1 --port 8006 --reload
```

Open `http://127.0.0.1:8006`.

## Test

```powershell
python -m unittest discover -s tests
```

## Project Structure

- `web_app.py` - FastAPI app and run orchestration.
- `web/static/` - browser UI.
- `services/pdf_ingestion.py` - upload ingestion, extraction, thumbnails, and caching.
- `services/cover_sheet_analyzer.py` - cover sheet, set type, owner/consultant, and cover visual checks.
- `services/sheet_index_extractor.py` - sheet index extraction and index-to-PDF comparison.
- `services/title_block_extractor.py` - sheet number/name extraction.
- `services/qc_scope.py` - cover/A-sheet review scope filtering.
- `services/seal_detector.py` - professional seal detection.
- `services/keynote_detector.py` - keynote checks.
- `services/viewport_detector.py` - viewport and scale checks.
- `services/qc_report_generator.py` - QC result summaries and exports.
- `tests/` - regression tests for extraction and QC rules.

## GitHub Notes

Generated uploads, run data, cache folders, local databases, logs, virtual environments, and temporary debug images are intentionally ignored by `.gitignore`. Do not commit client PDFs or generated reports unless you deliberately add a sanitized sample fixture.
