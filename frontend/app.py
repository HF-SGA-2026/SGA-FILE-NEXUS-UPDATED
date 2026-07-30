from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import streamlit as st

from backend.scanner import scan_pdf_paths, scan_project_folder_to_db, stage_uploaded_files
from database.models import DocumentMetadata, QAIssue
from database.store import (
    DB_PATH,
    create_scan_job,
    initialize_database,
    list_reference_documents,
    list_standards_versions,
    remove_reference_document,
    save_issues,
    set_reference_enabled,
)
from reference_library.library import add_approved_standard, load_standards, rebuild_standards_cache, save_rules, set_discipline_enabled
from reports.generator import build_pdf_report, issues_to_csv, issues_to_excel_bytes, issues_to_json, issues_to_markdown, summarize_detected_findings
from rules.engine import compare_records_to_standards, summarize_issue_counts


st.set_page_config(page_title="Checkit", page_icon="CH", layout="wide")

DISCIPLINES = ["General", "Architectural", "Life Safety", "Civil", "Structural", "Mechanical", "Plumbing", "Electrical", "Fire Protection"]


def inject_styles() -> None:
    st.markdown(
        """
        <style>
        :root {
            --ink: #000000;
            --muted: #777777;
            --soft: #999999;
            --line: #d8d8d8;
            --panel: #ffffff;
            --panel-soft: #f7f7f7;
            --bg: #ffffff;
            --accent: #af2a31;
            --accent-dark: #842026;
            --focus: #af2a31;
        }

        html, body, .stApp {
            background: var(--bg);
            color: var(--ink);
            font-size: 17px;
            font-family: Arial, Helvetica, sans-serif;
        }

        .block-container {
            padding-top: 1.6rem;
            padding-bottom: 3rem;
            max-width: 1180px;
        }

        h1, h2, h3, p, label, span {
            letter-spacing: 0;
            font-family: Arial, Helvetica, sans-serif;
        }

        p, li, label, .stMarkdown, .stCaptionContainer {
            color: var(--ink);
        }

        div[data-testid="stMarkdownContainer"] p,
        div[data-testid="stText"],
        div[data-testid="stCaptionContainer"] {
            font-size: 1rem;
            line-height: 1.55;
        }

        label,
        div[data-testid="stWidgetLabel"] p {
            color: var(--ink) !important;
            font-size: 0.86rem !important;
            font-weight: 400 !important;
            text-transform: uppercase;
        }

        div[data-testid="stWidgetLabel"],
        div[data-testid="stWidgetLabel"] label,
        div[data-testid="stWidgetLabel"] p {
            color: var(--ink) !important;
        }

        .stTextInput input,
        .stSelectbox div[data-baseweb="select"] > div,
        .stMultiSelect div[data-baseweb="select"] > div,
        .stTextArea textarea {
            background: #ffffff;
            border: 1px solid var(--line);
            border-radius: 0;
            color: var(--ink);
            min-height: 2.7rem;
            font-size: 1rem;
        }

        .stTextInput input:focus,
        .stTextArea textarea:focus {
            border-color: var(--focus);
            box-shadow: inset 0 -2px 0 var(--accent);
        }

        div[data-testid="stMetric"] {
            background: var(--panel);
            border: 0;
            border-top: 1px solid var(--line);
            border-bottom: 1px solid var(--line);
            border-radius: 0;
            padding: 1rem 0;
            box-shadow: none;
        }

        div[data-testid="stMetricLabel"] p {
            color: var(--muted);
            font-size: 0.78rem;
            font-weight: 400;
            text-transform: uppercase;
        }

        div[data-testid="stMetricValue"] {
            font-size: 2rem;
            color: var(--accent);
            font-weight: 400;
        }

        .stButton > button,
        .stDownloadButton > button {
            border-radius: 0;
            border: 1px solid var(--ink);
            min-height: 2.7rem;
            font-size: 0.88rem;
            font-weight: 400;
            text-transform: uppercase;
            color: var(--ink);
            background: #ffffff;
        }

        .stButton > button:hover,
        .stDownloadButton > button:hover {
            border-color: var(--accent);
            color: var(--accent);
        }

        .stButton > button[kind="primary"] {
            background: var(--accent);
            border-color: var(--accent);
            color: #ffffff;
        }

        .stButton > button[kind="primary"]:hover {
            background: var(--accent-dark);
            border-color: var(--accent-dark);
            color: #ffffff;
        }

        button[data-testid="stBaseButton-secondary"],
        div[data-testid="stFileUploader"] button {
            background: #ffffff !important;
            border: 1px solid var(--ink) !important;
            border-radius: 0 !important;
            color: var(--ink) !important;
            font-size: 0.88rem !important;
            font-weight: 400 !important;
            text-transform: uppercase !important;
            min-height: 2.55rem !important;
        }

        button[data-testid="stBaseButton-secondary"] *,
        div[data-testid="stFileUploader"] button * {
            color: var(--ink) !important;
            font-weight: 400 !important;
        }

        button[data-testid="stBaseButton-secondary"]:hover,
        div[data-testid="stFileUploader"] button:hover {
            background: #ffffff !important;
            border-color: var(--accent) !important;
            color: var(--accent) !important;
        }

        button[data-testid="stBaseButton-segmented_control"],
        button[data-testid="stBaseButton-segmented_controlActive"] {
            background: #ffffff !important;
            border: 1px solid var(--line) !important;
            border-radius: 0 !important;
            color: var(--ink) !important;
            font-size: 0.88rem !important;
            font-weight: 400 !important;
            text-transform: uppercase !important;
            min-height: 2.65rem !important;
            padding: 0.35rem 0.9rem !important;
        }

        button[data-testid="stBaseButton-segmented_control"] *,
        button[data-testid="stBaseButton-segmented_controlActive"] * {
            color: inherit !important;
            font-size: inherit !important;
            font-weight: inherit !important;
        }

        button[data-testid="stBaseButton-segmented_control"]:hover {
            background: #ffffff !important;
            border-color: var(--accent) !important;
            color: var(--accent) !important;
        }

        button[data-testid="stBaseButton-segmented_controlActive"] {
            background: var(--accent) !important;
            border-color: var(--accent) !important;
            color: #ffffff !important;
            box-shadow: none;
        }

        div[data-testid="stFileUploader"] section {
            background: #ffffff;
            border: 1px dashed var(--soft);
            border-radius: 0;
            padding: 1.25rem;
        }

        div[data-testid="stFileUploaderDropzone"] {
            color: var(--ink) !important;
        }

        div[data-testid="stFileUploaderDropzone"] svg,
        div[data-testid="stFileUploaderDropzone"] [data-testid="stIconMaterial"] {
            color: var(--accent) !important;
            fill: var(--accent) !important;
        }

        div[data-testid="stFileUploader"] small {
            color: var(--muted) !important;
            font-size: 0.9rem !important;
            font-weight: 400 !important;
        }

        div[data-testid="stTabs"] [role="tablist"] {
            gap: 1.2rem;
            border-bottom: 1px solid var(--line);
            margin-bottom: 1.4rem;
        }

        div[data-testid="stTabs"] button[role="tab"] {
            background: transparent;
            border: 0;
            border-bottom: 2px solid transparent;
            border-radius: 0;
            min-height: 2.9rem;
            padding: 0.35rem 0;
            color: var(--ink);
            font-size: 0.88rem;
            font-weight: 400;
            text-transform: uppercase;
        }

        div[data-testid="stTabs"] button[aria-selected="true"] {
            background: transparent;
            color: var(--accent);
            border-bottom: 2px solid var(--accent);
        }

        div[data-testid="stDataFrame"] {
            border: 1px solid var(--line);
            border-radius: 0;
            overflow: hidden;
            background: #ffffff;
        }

        div[data-testid="stAlert"] {
            border-radius: 0;
            border: 1px solid var(--line);
        }

        .checkit-header {
            background: #ffffff;
            border: 0;
            border-bottom: 1px solid var(--line);
            border-radius: 0;
            padding: 0 0 1.25rem;
            margin-bottom: 1.75rem;
            box-shadow: none;
        }

        .checkit-brandline {
            display: flex;
            align-items: flex-end;
            justify-content: space-between;
            gap: 1.25rem;
            margin-bottom: 1.5rem;
        }

        .checkit-logo {
            color: var(--ink) !important;
            font-size: 0.9rem !important;
            font-weight: 400 !important;
            text-transform: uppercase;
            letter-spacing: 0.06em !important;
            margin: 0 !important;
        }

        .checkit-nav {
            display: flex;
            flex-wrap: wrap;
            gap: 1.15rem;
            color: var(--ink);
            font-size: 0.86rem;
            text-transform: uppercase;
        }

        .checkit-nav span {
            color: var(--ink) !important;
            font-size: 0.86rem !important;
            font-weight: 400 !important;
        }

        .checkit-title {
            font-size: 3.5rem !important;
            line-height: 1 !important;
            font-weight: 700 !important;
            margin: 0 !important;
            color: var(--accent) !important;
            text-transform: uppercase;
        }

        .checkit-subtitle {
            color: var(--muted) !important;
            margin: 0.65rem 0 0 !important;
            font-size: 1.35rem !important;
            line-height: 1.45 !important;
            font-weight: 400 !important;
            max-width: 760px;
        }

        .checkit-strip {
            display: flex;
            flex-wrap: wrap;
            gap: 0.55rem;
            margin-top: 1rem;
        }

        .checkit-pill {
            border: 0;
            border-left: 1px solid var(--line);
            border-radius: 0;
            padding: 0 0 0 0.65rem;
            color: var(--muted) !important;
            background: transparent;
            font-size: 0.86rem !important;
            font-weight: 400 !important;
            text-transform: uppercase;
            white-space: nowrap;
        }

        .checkit-section {
            background: #ffffff;
            border: 0;
            border-top: 1px solid var(--line);
            border-radius: 0;
            padding: 1.15rem 0 0.35rem;
            margin: 1.35rem 0 1.1rem;
            box-shadow: none;
        }

        .checkit-section-title {
            font-size: 1.55rem !important;
            font-weight: 400 !important;
            margin: 0 !important;
            color: var(--accent) !important;
            text-transform: lowercase;
        }

        .checkit-section-note {
            color: var(--muted) !important;
            font-size: 1.08rem !important;
            line-height: 1.45 !important;
            font-weight: 400 !important;
            margin: 0.35rem 0 0 !important;
        }

        @media (max-width: 900px) {
            html, body, .stApp { font-size: 16px; }
            .block-container { padding-left: 1rem; padding-right: 1rem; }
            .checkit-brandline { align-items: flex-start; flex-direction: column; }
            .checkit-title { font-size: 2.45rem !important; }
            .checkit-pill { width: 100%; }
        }
        </style>
        """,
        unsafe_allow_html=True,
    )


@st.cache_resource
def startup() -> dict:
    initialize_database(DB_PATH)
    return load_standards()


def refresh_standards() -> dict:
    st.cache_resource.clear()
    return startup()


def section_title(title: str, note: str) -> None:
    st.markdown(
        f"""
        <div class="checkit-section">
            <p class="checkit-section-title">{title}</p>
            <p class="checkit-section-note">{note}</p>
        </div>
        """,
        unsafe_allow_html=True,
    )


def render_header(standards: dict) -> None:
    cache = standards.get("cache", {})
    st.markdown(
        f"""
        <div class="checkit-header">
            <div class="checkit-brandline">
                <p class="checkit-logo">Sam Garcia Architect</p>
                <div class="checkit-nav">
                    <span>Home</span>
                    <span>Our Work</span>
                    <span>Client Portal</span>
                    <span>Dashboard</span>
                </div>
            </div>
            <p class="checkit-title">Checkit</p>
            <p class="checkit-subtitle">Local QA/QC for architectural construction document sets.</p>
            <div class="checkit-strip">
                <span class="checkit-pill">PDF and ZIP upload</span>
                <span class="checkit-pill">OCR fallback</span>
                <span class="checkit-pill">Production checklist</span>
                <span class="checkit-pill">{cache.get("document_count", 0)} approved references active</span>
            </div>
        </div>
        """,
        unsafe_allow_html=True,
    )


def valid_folder(path_text: str) -> Path | None:
    path = Path(path_text).expanduser()
    return path if path.exists() and path.is_dir() else None


def metadata_inputs(prefix: str) -> dict[str, str]:
    cols = st.columns(5)
    return {
        "project_type": cols[0].text_input("Project type", key=f"{prefix}-project-type"),
        "phase": cols[1].selectbox("Phase", ["", "SD", "DD", "CD", "Permit", "Bid", "Construction"], key=f"{prefix}-phase"),
        "client": cols[2].text_input("Client", key=f"{prefix}-client"),
        "building_type": cols[3].text_input("Building type", key=f"{prefix}-building-type"),
        "force_ocr": cols[4].toggle("Force OCR", value=False, key=f"{prefix}-ocr"),
    }


def run_scan_from_folder(project_folder: Path, standards: dict, metadata: dict[str, str]) -> None:
    job_id = f"scan-{uuid4().hex[:10]}"
    records = scan_project_folder_to_db(project_folder, job_id=job_id, **metadata)
    issues = compare_records_to_standards(records, standards)
    save_issues(job_id, issues)
    st.session_state["records"] = [record.to_dict() for record in records]
    st.session_state["issues"] = [issue.to_dict() for issue in issues]
    st.session_state["project_name"] = project_folder.name


def run_scan_from_uploads(uploaded_files: list, standards: dict, metadata: dict[str, str]) -> None:
    job_id = f"upload-{uuid4().hex[:10]}"
    root = stage_uploaded_files(uploaded_files, job_id)
    create_scan_job(job_id, root, DB_PATH)
    records = scan_pdf_paths(root.rglob("*.pdf"), job_id=job_id, root_path=root, **metadata)
    issues = compare_records_to_standards(records, standards)
    save_issues(job_id, issues)
    st.session_state["records"] = [record.to_dict() for record in records]
    st.session_state["issues"] = [issue.to_dict() for issue in issues]
    st.session_state["project_name"] = "Uploaded Set"


def render_scan_panel(standards: dict) -> None:
    section_title("Construction Document Scanner", "Upload PDFs, individual sheets, ZIP folders, or scan a local project folder.")
    scan_mode = st.segmented_control("Scan source", ["Upload files", "Local folder"], default="Upload files")
    metadata = metadata_inputs("scan")
    if scan_mode == "Upload files":
        uploads = st.file_uploader("Drag and drop PDF or ZIP files", type=["pdf", "zip"], accept_multiple_files=True)
        if st.button("Scan uploaded documents", type="primary", disabled=not uploads):
            with st.spinner("Extracting sheet metadata, OCR text, thumbnails, and QA/QC issues..."):
                run_scan_from_uploads(uploads, standards, metadata)
            st.success("Scan complete.")
    else:
        cols = st.columns([3, 1, 1])
        project_text = cols[0].text_input("Project folder", value=str(Path.cwd()))
        project_folder = valid_folder(project_text)
        pdf_count = len(list(project_folder.rglob("*.pdf"))) if project_folder else 0
        cols[1].metric("PDFs found", pdf_count)
        cols[2].write("")
        cols[2].write("")
        if cols[2].button("Scan folder", type="primary", disabled=project_folder is None or pdf_count == 0):
            with st.spinner("Scanning folder..."):
                run_scan_from_folder(project_folder, standards, metadata)
            st.success("Scan complete.")


def render_sheet_index(records: list[DocumentMetadata]) -> None:
    rows = []
    for record in records:
        for sheet in record.sheet_records:
            rows.append(
                {
                    "page": sheet.get("sheet_number"),
                    "drawing_title": sheet.get("sheet_title"),
                    "discipline": sheet.get("discipline"),
                    "phase": sheet.get("phase"),
                    "page_number": sheet.get("page"),
                    "source_file": sheet.get("source_file"),
                    "scale": sheet.get("scale"),
                    "revision": sheet.get("revision"),
                }
            )
    if rows:
        st.dataframe(rows, use_container_width=True, hide_index=True)
    else:
        st.info("No sheet index has been generated yet.")


def render_thumbnails(records: list[DocumentMetadata]) -> None:
    thumbs = [sheet for record in records for sheet in record.sheet_records if sheet.get("thumbnail_path")]
    if not thumbs:
        st.info("No thumbnails are available yet.")
        return
    cols = st.columns(4)
    for index, sheet in enumerate(thumbs[:24]):
        with cols[index % 4]:
            st.image(sheet["thumbnail_path"], caption=f"{sheet.get('sheet_number', '')} {sheet.get('sheet_title', '')}".strip(), use_container_width=True)


def render_visual_compare(records: list[DocumentMetadata]) -> None:
    reference_docs = list_reference_documents(DB_PATH, include_disabled=False)
    uploaded_sheets = [sheet for record in records for sheet in record.sheet_records]
    if not uploaded_sheets or not reference_docs:
        st.info("Visual comparison needs at least one scanned sheet and one approved reference document.")
        return
    left, right = st.columns(2)
    selected_sheet = left.selectbox("Uploaded page", uploaded_sheets, format_func=lambda item: f"{item.get('sheet_number')} - {item.get('source_file')}")
    selected_ref = right.selectbox("Approved reference", reference_docs, format_func=lambda item: f"{item['filename']} ({item['discipline']})")
    left.image(selected_sheet.get("thumbnail_path"), caption="Uploaded sheet", use_container_width=True)
    ref_sheets = selected_ref["metadata"].get("sheet_records", [])
    ref_thumb = next((sheet.get("thumbnail_path") for sheet in ref_sheets if sheet.get("thumbnail_path")), "")
    if ref_thumb:
        right.image(ref_thumb, caption="Approved standard", use_container_width=True)
    else:
        right.info("Reference thumbnail unavailable.")


def issue_display_rows(issues: list[QAIssue]) -> list[dict[str, str]]:
    return [issue.to_dict() for issue in issues]


def render_results() -> None:
    issue_dicts = st.session_state.get("issues", [])
    record_dicts = st.session_state.get("records", [])
    if not issue_dicts and not record_dicts:
        st.info("Run a scan to populate the dashboard.")
        return
    issues = [QAIssue(**item) for item in issue_dicts]
    records = [DocumentMetadata(**item) for item in record_dicts]
    counts = summarize_issue_counts(issues)
    metric_cols = st.columns(6)
    metric_cols[0].metric("Issues", len(issues))
    metric_cols[1].metric("High", sum(1 for issue in issues if issue.severity == "High"))
    metric_cols[2].metric("Project", counts.get("Missing or incorrect project information", 0) + counts.get("Missing drawing index", 0))
    metric_cols[3].metric("Sheets", counts.get("Incorrect or duplicate sheet numbers", 0) + counts.get("Missing, blank, or extra sheets", 0))
    metric_cols[4].metric("Refs/Text", counts.get("Missing or broken callouts/references", 0) + counts.get("Spelling errors", 0))
    metric_cols[5].metric("Pages", sum(len(record.sheet_records) for record in records))

    tabs = st.tabs(["Issue Dashboard", "Sheet Index", "Thumbnails", "Visual Compare", "AI Comments", "Reports"])
    with tabs[0]:
        rows = issue_display_rows(issues)
        if rows:
            severities = st.multiselect("Severity", sorted({row["severity"] for row in rows}), default=sorted({row["severity"] for row in rows}))
            categories = st.multiselect("Issue type", sorted({row["category"] for row in rows}), default=sorted({row["category"] for row in rows}))
            pages = st.multiselect("Page", sorted({row["sheet_id"] for row in rows}), default=[])
            visible = [row for row in rows if row["severity"] in severities and row["category"] in categories and (not pages or row["sheet_id"] in pages)]
            st.dataframe(
                visible,
                use_container_width=True,
                hide_index=True,
                column_config={
                    "sheet_id": st.column_config.TextColumn("Page", width="small"),
                    "message": st.column_config.TextColumn("Issue description", width="large"),
                    "suggested_correction": st.column_config.TextColumn("Suggested correction", width="large"),
                },
            )
        else:
            st.success("No issues detected.")
    with tabs[1]:
        render_sheet_index(records)
    with tabs[2]:
        render_thumbnails(records)
    with tabs[3]:
        render_visual_compare(records)
    with tabs[4]:
        st.caption("AI is optional and produces warnings/recommendations only from detected findings.")
        if st.button("Generate review comments"):
            st.write(summarize_detected_findings(issues))
    with tabs[5]:
        project_name = st.session_state.get("project_name", "Checkit Project")
        st.download_button("Export PDF", build_pdf_report(issues, project_name), "checkit_qa_report.pdf", "application/pdf")
        st.download_button("Export Excel", issues_to_excel_bytes(issues), "checkit_qa_report.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        st.download_button("Export CSV", issues_to_csv(issues), "checkit_qa_report.csv", "text/csv")
        st.download_button("Export JSON", issues_to_json(issues), "checkit_qa_report.json", "application/json")
        st.download_button("Export Markdown", issues_to_markdown(issues), "checkit_qa_report.md", "text/markdown")


def render_reference_library(standards: dict) -> None:
    section_title("Approved Document Reference Library", "Ingest gold-standard PDFs, extract metadata, and build local semantic vectors.")
    cache = standards.get("cache", {})
    cols = st.columns(5)
    cols[0].metric("Reference PDFs", cache.get("document_count", 0))
    cols[1].metric("Disciplines", len(cache.get("disciplines", {})))
    cols[2].metric("Common titles", len(cache.get("common_titles", [])))
    cols[3].metric("Rule versions", len(list_standards_versions(DB_PATH)))
    cols[4].metric("Active refs", cache.get("document_count", 0))

    upload_mode = st.segmented_control("Reference source", ["Upload approved PDFs", "Local folder"], default="Upload approved PDFs")
    metadata = metadata_inputs("reference")
    discipline = st.selectbox("Reference discipline", DISCIPLINES, index=1)
    if upload_mode == "Upload approved PDFs":
        approved = st.file_uploader("Approved reference PDFs", type=["pdf"], accept_multiple_files=True, key="approved-upload")
        if st.button("Learn approved standards", type="primary", disabled=not approved):
            run_name = f"references-{uuid4().hex[:10]}"
            root = stage_uploaded_files(approved, run_name)
            with st.spinner("Ingesting approved references..."):
                for pdf_path in root.rglob("*.pdf"):
                    add_approved_standard(pdf_path, discipline=discipline, **metadata)
            st.success(f"Learned {len(list(root.rglob('*.pdf')))} approved PDF(s).")
            refresh_standards()
            st.rerun()
    else:
        folder_text = st.text_input("Approved reference folder", value=str(Path.cwd() / "approved_reference_sheets"))
        folder = valid_folder(folder_text)
        pdf_count = len(list(folder.rglob("*.pdf"))) if folder else 0
        if st.button("Learn folder standards", type="primary", disabled=folder is None or pdf_count == 0):
            with st.spinner("Ingesting approved references..."):
                for pdf_path in folder.rglob("*.pdf"):
                    add_approved_standard(pdf_path, discipline=discipline, **metadata)
            st.success(f"Learned {pdf_count} approved PDF(s).")
            refresh_standards()
            st.rerun()

    documents = list_reference_documents(DB_PATH, include_disabled=True)
    if documents:
        st.dataframe(
            [
                {
                    "id": item["id"],
                    "filename": item["filename"],
                    "discipline": item["discipline"],
                    "project_type": item.get("project_type", ""),
                    "phase": item.get("phase", ""),
                    "client": item.get("client", ""),
                    "building_type": item.get("building_type", ""),
                    "enabled": item["enabled"],
                    "added_at": item["added_at"],
                }
                for item in documents
            ],
            use_container_width=True,
            hide_index=True,
        )
        manage_cols = st.columns([1, 1, 1])
        selected_doc_id = manage_cols[0].selectbox("Reference ID", [item["id"] for item in documents])
        if manage_cols[1].button("Toggle enabled"):
            selected = next(item for item in documents if item["id"] == selected_doc_id)
            set_reference_enabled(selected_doc_id, not selected["enabled"], DB_PATH)
            rebuild_standards_cache()
            st.rerun()
        if manage_cols[2].button("Remove reference"):
            remove_reference_document(selected_doc_id, DB_PATH)
            rebuild_standards_cache()
            st.rerun()
    else:
        st.info("No approved references have been learned yet.")

    with st.expander("Discipline rule sets"):
        for name, profile in standards.get("discipline_profiles", {}).items():
            enabled = st.toggle(name, value=profile.get("enabled", True), key=f"discipline-{name}")
            if enabled != profile.get("enabled", True):
                set_discipline_enabled(name, enabled)
                st.rerun()

    with st.expander("Editable standards JSON"):
        editable = st.text_area("Standards JSON", value=json.dumps({k: v for k, v in standards.items() if k != "cache"}, indent=2, sort_keys=True), height=320)
        if st.button("Save standards JSON"):
            save_rules(json.loads(editable))
            st.success("Standards JSON saved locally.")
            refresh_standards()


def main() -> None:
    inject_styles()
    standards = startup()
    render_header(standards)
    top_tabs = st.tabs(["Scan & Dashboard", "Reference Library", "Workflow"])
    with top_tabs[0]:
        render_scan_panel(standards)
        render_results()
    with top_tabs[1]:
        render_reference_library(standards)
    with top_tabs[2]:
        st.markdown(
            """
            1. Upload approved office-standard PDFs in the reference library.
            2. Upload a current project set as PDFs or a ZIP folder.
            3. Review the dashboard filters by severity, discipline, sheet, and issue type.
            4. Compare a project thumbnail side-by-side with an approved reference.
            5. Export a PDF, Excel, CSV, JSON, or Markdown QA/QC report for the project team.
            """
        )


if __name__ == "__main__":
    main()
