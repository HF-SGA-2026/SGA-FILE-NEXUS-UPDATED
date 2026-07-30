from __future__ import annotations

import csv
import html
import io
import json
from typing import Any

from services.cover_sheet_analyzer import score_cover_checklist


def build_qc_result(
    run_data: dict[str, Any],
    cover: dict,
    index: dict,
    viewport_findings: list[dict],
    sheet_keynote_reviews: list[dict] | None = None,
    missing_scale_findings: list[dict] | None = None,
) -> dict[str, Any]:
    cover_score = score_cover_checklist(cover.get("checklist", []))
    reviewed_sheets = [item for item in (sheet_keynote_reviews or []) if item.get("hasSheetKeynotes")]
    failed_viewports = [item for item in viewport_findings if item.get("status") == "Fail"]
    failed_keynote_sheets = [item for item in reviewed_sheets if item.get("keynoteCheckStatus") == "Fail"]
    passed_keynote_sheets = [item for item in reviewed_sheets if item.get("keynoteCheckStatus") == "Pass"]
    scale_findings = missing_scale_findings or []
    missing_scale_count = sum(1 for item in scale_findings if item.get("status") == "Warning")
    official_set = cover.get("set_type") == "Official"
    seal_findings = [
        {
            "page_number": page.get("page_number"),
            "sheet_number": page.get("sheet_number", ""),
            "status": _seal_status(page.get("seal_check", {}), official_set),
            "evidence": page.get("seal_check", {}).get("evidence", "") if official_set else "",
            "comments": (
                page.get("seal_check", {}).get("comments", "Professional seal was not detected on the right side.")
                if official_set
                else "Seal check is not required unless the set type is official permit/construction."
            ),
        }
        for page in run_data.get("pages", [])
        if page.get("seal_check")
    ]
    missing_seals = [item for item in seal_findings if item["status"] == "Fail"]
    passed_seals = [item for item in seal_findings if item["status"] == "Pass"]
    seals_not_applicable = [item for item in seal_findings if item["status"] == "Not Applicable"]
    failed_index = [
        index.get("sequence_compliance", {}).get("status") == "Fail",
        index.get("presence_compliance", {}).get("status") == "Fail",
    ]
    failed_count = (
        cover_score["failed_count"]
        + len(failed_keynote_sheets)
        + len(failed_viewports)
        + len(missing_seals)
        + sum(1 for item in failed_index if item)
    )
    high_priority = []
    if cover_score["failed_count"]:
        high_priority.append("Resolve failed cover sheet required-item checks.")
    if any(failed_index):
        high_priority.append("Reconcile sheet index order/presence against physical PDF pages.")
    if failed_keynote_sheets or failed_viewports:
        high_priority.append("Add or verify keynotes in failed viewports.")
    if missing_seals:
        high_priority.append("Add or verify a professional seal on the right side of every sheet.")
    return {
        "executive_summary": {
            "overall_status": "Fail" if failed_count else ("Needs Review" if cover_score["needs_review_count"] else "Pass"),
            "failed_items": failed_count,
            "high_priority_corrections": high_priority,
        },
        "cover_sheet_checklist": cover,
        "index_integrity_check": index,
        "keynote_statistics": {
            "reviewed_sheet_count": len(reviewed_sheets),
            "passed_sheet_count": len(passed_keynote_sheets),
            "failed_sheet_count": len(failed_keynote_sheets),
            "compliance_percent": round((len(passed_keynote_sheets) / len(reviewed_sheets)) * 100, 1) if reviewed_sheets else None,
        },
        "sheet_keynote_compliance": reviewed_sheets,
        "viewport_keynote_compliance": viewport_findings,
        "missing_scale_check": scale_findings,
        "missing_scale_statistics": {
            "reviewed_view_count": len(scale_findings),
            "passed_view_count": len(scale_findings) - missing_scale_count,
            "warning_count": missing_scale_count,
        },
        "sheet_seal_compliance": seal_findings,
        "seal_statistics": {
            "reviewed_sheet_count": len(seal_findings),
            "passed_sheet_count": len(passed_seals),
            "failed_sheet_count": len(missing_seals),
            "not_applicable_count": len(seals_not_applicable),
        },
        "raw_extracted_data": {
            "extracted_sheet_index": run_data.get("sheet_index", {}).get("entries", []),
            "extracted_physical_sheet_list": run_data.get("physical_sheets", []),
            "detected_issue_label": cover.get("issue_label", ""),
            "detected_set_type": cover.get("set_type", "Unknown"),
            "pages": run_data.get("pages", []),
        },
    }


def _seal_status(seal_check: dict, official_set: bool) -> str:
    if not official_set:
        return "Not Applicable"
    return "Pass" if seal_check.get("present") else "Fail"


def result_to_csv(result: dict[str, Any]) -> str:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Section", "Item", "Status", "Sheet", "Page", "Comment"])
    for item in result.get("cover_sheet_checklist", {}).get("checklist", []):
        writer.writerow(["Cover Sheet Checklist", item.get("item"), item.get("status"), "", "", item.get("comments")])
    index = result.get("index_integrity_check", {})
    writer.writerow(["Index Integrity Check", "Sequence Compliance", index.get("sequence_compliance", {}).get("status"), "", "", ""])
    writer.writerow(["Index Integrity Check", "Presence Compliance", index.get("presence_compliance", {}).get("status"), "", "", ""])
    for table_name in ["missing_from_pdf", "extra_in_pdf"]:
        for row in index.get("missing_page_identification", {}).get(table_name, []):
            writer.writerow(["Index Integrity Check", table_name, "Fail", row.get("sheet_number"), row.get("physical_page_number"), row.get("sheet_name")])
    for row in result.get("viewport_keynote_compliance", []):
        writer.writerow(["Viewport Keynote Compliance", row.get("view_label"), row.get("status"), row.get("sheet_number"), "", row.get("failure_reason")])
    for row in result.get("sheet_keynote_compliance", []):
        writer.writerow(["Sheet Keynote Compliance", "SHEET KEYNOTES gate", row.get("keynoteCheckStatus"), row.get("sheetNumber"), row.get("pageNumber"), row.get("comment")])
    for row in result.get("missing_scale_check", []):
        writer.writerow(["Missing Scale Check", row.get("view_label"), row.get("status"), row.get("sheet_number"), row.get("page_number"), row.get("scale") or row.get("comment")])
    for row in result.get("sheet_seal_compliance", []):
        writer.writerow(["Sheet Seal Compliance", "Right-side professional seal", row.get("status"), row.get("sheet_number"), row.get("page_number"), row.get("evidence") or row.get("comments")])
    for row in result.get("spell_check", {}).get("findings", []):
        writer.writerow([
            "Spell Check",
            row.get("word"),
            row.get("status", "Open"),
            row.get("sheet"),
            row.get("page"),
            f"Suggested: {row.get('suggested_correction', '')}. {row.get('context', '')}".strip(),
        ])
    return output.getvalue()


def result_to_pdf(result: dict[str, Any]) -> bytes:
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import letter
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import inch
        from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

        output = io.BytesIO()
        doc = SimpleDocTemplate(
            output,
            pagesize=letter,
            rightMargin=0.48 * inch,
            leftMargin=0.48 * inch,
            topMargin=0.48 * inch,
            bottomMargin=0.5 * inch,
            title="Quality Assurance Check",
        )
        styles = getSampleStyleSheet()
        title_style = ParagraphStyle(
            "ReportTitle",
            parent=styles["Title"],
            fontName="Helvetica-Bold",
            fontSize=17,
            leading=20,
            textColor=colors.HexColor("#1f2933"),
            spaceAfter=2,
        )
        subtitle_style = ParagraphStyle(
            "ReportSubtitle",
            parent=styles["BodyText"],
            fontSize=8.5,
            leading=11,
            textColor=colors.HexColor("#52606d"),
        )
        section_style = ParagraphStyle(
            "ReportSection",
            parent=styles["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=11,
            leading=14,
            textColor=colors.HexColor("#1f2933"),
            spaceBefore=8,
            spaceAfter=5,
        )
        body_style = ParagraphStyle(
            "ReportBody",
            parent=styles["BodyText"],
            fontSize=8.4,
            leading=11,
            textColor=colors.HexColor("#323f4b"),
        )
        small_style = ParagraphStyle(
            "ReportSmall",
            parent=body_style,
            fontSize=7.6,
            leading=9.5,
        )

        story = [
            Paragraph("Quality Assurance Check", title_style),
            Paragraph("Concise missing-items and confirmed-items report", subtitle_style),
            Spacer(1, 9),
        ]
        summary = result.get("executive_summary", {})
        overall_status = summary.get("overall_status", "Needs Review")
        status_color = {
            "Pass": "#137333",
            "Needs Review": "#9a6700",
            "Fail": "#b42318",
        }.get(overall_status, "#52606d")
        status_table = Table(
            [[
                Paragraph("<b>OVERALL STATUS</b>", small_style),
                Paragraph(f"<b>{_pdf_text(overall_status)}</b>", body_style),
                Paragraph(_pdf_text(_overall_status_explanation(result)), body_style),
            ]],
            colWidths=[1.18 * inch, 1.18 * inch, 4.48 * inch],
        )
        status_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (0, 0), colors.HexColor("#e4e7eb")),
            ("BACKGROUND", (1, 0), (1, 0), colors.HexColor(status_color)),
            ("TEXTCOLOR", (1, 0), (1, 0), colors.white),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#bcccdc")),
            ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#d9e2ec")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 7),
            ("RIGHTPADDING", (0, 0), (-1, -1), 7),
            ("TOPPADDING", (0, 0), (-1, -1), 7),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ]))
        story.append(status_table)

        story.append(Paragraph("At A Glance", section_style))
        summary_rows = [[
            Paragraph('<font color="#ffffff"><b>Check</b></font>', small_style),
            Paragraph('<font color="#ffffff"><b>Confirmed</b></font>', small_style),
            Paragraph('<font color="#ffffff"><b>Missing / Review</b></font>', small_style),
            Paragraph('<font color="#ffffff"><b>Result</b></font>', small_style),
        ]]
        for check, confirmed, missing, status in _pdf_check_summaries(result):
            summary_rows.append([
                Paragraph(_pdf_text(check), small_style),
                Paragraph(_pdf_text(confirmed), small_style),
                Paragraph(_pdf_text(missing), small_style),
                Paragraph(f"<b>{_pdf_text(status)}</b>", small_style),
            ])
        summary_table = Table(summary_rows, colWidths=[1.42 * inch, 2.18 * inch, 2.18 * inch, 0.96 * inch], repeatRows=1)
        summary_table.setStyle(_compact_table_style(colors))
        story.append(summary_table)

        missing_items = _pdf_missing_items(result)
        story.append(Paragraph("Missing Or Needs Review", section_style))
        if missing_items:
            missing_rows = [[
                Paragraph('<font color="#ffffff"><b>Area</b></font>', small_style),
                Paragraph('<font color="#ffffff"><b>Item</b></font>', small_style),
                Paragraph('<font color="#ffffff"><b>Status</b></font>', small_style),
                Paragraph('<font color="#ffffff"><b>What to verify or correct</b></font>', small_style),
            ]]
            for area, item, status, explanation in missing_items:
                missing_rows.append([
                    Paragraph(_pdf_text(area), small_style),
                    Paragraph(_pdf_text(item), small_style),
                    Paragraph(f"<b>{_pdf_text(status)}</b>", small_style),
                    Paragraph(_pdf_text(explanation), small_style),
                ])
            missing_table = Table(
                missing_rows,
                colWidths=[0.78 * inch, 2.22 * inch, 0.88 * inch, 2.86 * inch],
                repeatRows=1,
            )
            missing_table.setStyle(_compact_table_style(colors, issue_rows=True))
            story.append(missing_table)
        else:
            story.append(Paragraph(
                "No missing or review items were identified by the automated checks.",
                body_style,
            ))

        confirmed_items = _pdf_confirmed_items(result)
        story.append(Paragraph("Confirmed Present / Not Missing", section_style))
        confirmed_rows = [[
            Paragraph('<font color="#ffffff"><b>Area</b></font>', small_style),
            Paragraph('<font color="#ffffff"><b>Confirmed finding</b></font>', small_style),
        ]]
        for area, finding in confirmed_items:
            confirmed_rows.append([
                Paragraph(_pdf_text(area), small_style),
                Paragraph(_pdf_text(finding), small_style),
            ])
        confirmed_table = Table(confirmed_rows, colWidths=[1.15 * inch, 5.59 * inch], repeatRows=1)
        confirmed_table.setStyle(_compact_table_style(colors, success_rows=True))
        story.append(confirmed_table)

        story.append(Spacer(1, 8))
        story.append(KeepTogether([
            Paragraph("Reviewer Note", section_style),
            Paragraph(
                "Needs Review means the item was not confidently detected from PDF text or graphics; "
                "it is not proof that the item is absent. Confirm those items directly on the drawings.",
                body_style,
            ),
        ]))

        def add_page_number(canvas, document) -> None:
            canvas.saveState()
            canvas.setStrokeColor(colors.HexColor("#d9e2ec"))
            canvas.line(document.leftMargin, 0.36 * inch, letter[0] - document.rightMargin, 0.36 * inch)
            canvas.setFont("Helvetica", 7)
            canvas.setFillColor(colors.HexColor("#7b8794"))
            footer = f"Quality Assurance Check  |  Page {document.page}"
            canvas.drawString(document.leftMargin, 0.22 * inch, footer)
            generated_label = "Automated review - reviewer verification required"
            canvas.drawRightString(letter[0] - document.rightMargin, 0.22 * inch, generated_label)
            canvas.restoreState()

        doc.build(story, onFirstPage=add_page_number, onLaterPages=add_page_number)
        return output.getvalue()
    except Exception as exc:
        raise RuntimeError("Unable to generate QC PDF report.") from exc


def _pdf_text(value: Any) -> str:
    return html.escape(str(value or "")).replace("\n", "<br/>")


def _overall_status_explanation(result: dict[str, Any]) -> str:
    issue_count = len(_pdf_missing_items(result))
    if issue_count == 0:
        return "All reviewed checks passed; no missing items were detected."
    if result.get("executive_summary", {}).get("overall_status") == "Fail":
        return f"{issue_count} missing or failed item(s) require correction."
    return f"{issue_count} item(s) were not confidently detected and require reviewer confirmation."


def _pdf_check_summaries(result: dict[str, Any]) -> list[tuple[str, str, str, str]]:
    cover_items = result.get("cover_sheet_checklist", {}).get("checklist", [])
    cover_pass = sum(item.get("status") == "Pass" for item in cover_items)
    cover_fail = sum(item.get("status") == "Fail" for item in cover_items)
    cover_review = sum(item.get("status") == "Needs Review" for item in cover_items)
    cover_status = "Fail" if cover_fail else ("Needs Review" if cover_review else "Pass")

    index = result.get("index_integrity_check", {})
    missing = index.get("missing_page_identification", {}).get("missing_from_pdf", [])
    extra = index.get("missing_page_identification", {}).get("extra_in_pdf", [])
    duplicate = index.get("missing_page_identification", {}).get("duplicate_in_pdf", [])
    unnumbered = index.get("missing_page_identification", {}).get("missing_sheet_number_pages", [])
    out_of_sequence = index.get("sequence_compliance", {}).get("out_of_sequence", [])
    index_issues = len(missing) + len(extra) + len(duplicate) + len(unnumbered) + len(out_of_sequence)
    index_status = "Pass" if index_issues == 0 else "Fail"

    keynote = result.get("keynote_statistics", {})
    keynote_reviewed = int(keynote.get("reviewed_sheet_count") or 0)
    keynote_passed = int(keynote.get("passed_sheet_count") or 0)
    keynote_failed = int(keynote.get("failed_sheet_count") or 0)
    keynote_status = "Pass" if keynote_failed == 0 else "Fail"

    scale = result.get("missing_scale_statistics", {})
    scale_reviewed = int(scale.get("reviewed_view_count") or 0)
    scale_passed = int(scale.get("passed_view_count") or 0)
    scale_warnings = int(scale.get("warning_count") or 0)
    scale_status = "Pass" if scale_warnings == 0 else "Needs Review"
    seals = result.get("seal_statistics", {})
    seals_reviewed = int(seals.get("reviewed_sheet_count") or 0)
    seals_passed = int(seals.get("passed_sheet_count") or 0)
    seals_failed = int(seals.get("failed_sheet_count") or 0)
    seals_not_applicable = int(seals.get("not_applicable_count") or 0)
    seals_status = "Not Required" if seals_not_applicable == seals_reviewed and seals_reviewed else ("Pass" if seals_failed == 0 else "Fail")
    spell = result.get("spell_check", {})
    spelling_findings = spell.get("findings", [])
    spelling_status = "Needs Review" if spelling_findings else ("Pass" if spell else "Not Run")

    return [
        (
            "Cover sheet",
            f"{cover_pass} of {len(cover_items)} required items detected",
            f"{cover_fail} missing; {cover_review} need review",
            cover_status,
        ),
        (
            "Sheet index",
            "No indexed sheets missing" if not missing else f"{len(missing)} indexed sheets missing",
            f"{index_issues} index issue(s)",
            index_status,
        ),
        (
            "Keynotes",
            f"{keynote_passed} of {keynote_reviewed} reviewed sheets passed",
            f"{keynote_failed} sheet(s) failed",
            keynote_status,
        ),
        (
            "Drawing scales",
            f"{scale_passed} of {scale_reviewed} views have a scale or NTS",
            f"{scale_warnings} view(s) need review",
            scale_status,
        ),
        (
            "Professional seals",
            (
                f"{seals_not_applicable} sheet(s) not required for this set type"
                if seals_status == "Not Required"
                else f"{seals_passed} of {seals_reviewed} sheets have a right-side seal"
            ),
            f"{seals_failed} sheet(s) missing a seal",
            seals_status,
        ),
        (
            "Spelling",
            "No possible spelling issues found" if spell and not spelling_findings else f"{len(spelling_findings)} possible issue(s) found",
            "Review suggested corrections" if spelling_findings else ("Spell check completed" if spell else "Spell check was not run"),
            spelling_status,
        ),
    ]


def _pdf_missing_items(result: dict[str, Any]) -> list[tuple[str, str, str, str]]:
    items: list[tuple[str, str, str, str]] = []
    for item in result.get("cover_sheet_checklist", {}).get("checklist", []):
        status = item.get("status")
        if status == "Pass":
            continue
        explanation = item.get("comments") or (
            "This required cover-sheet item was not confidently detected."
            if status == "Needs Review"
            else "This required cover-sheet item was not detected."
        )
        items.append(("Cover", item.get("item", ""), status or "Needs Review", explanation))

    index = result.get("index_integrity_check", {})
    for row in index.get("missing_page_identification", {}).get("missing_from_pdf", []):
        sheet = row.get("sheet_number") or "Unknown sheet"
        items.append(("Index", sheet, "Missing", "Listed in the sheet index but not found in the PDF."))
    for row in index.get("missing_page_identification", {}).get("extra_in_pdf", []):
        sheet = row.get("sheet_number") or f"Page {row.get('physical_page_number', '?')}"
        items.append(("Index", sheet, "Mismatch", "Present in the PDF but not listed in the sheet index."))
    for row in index.get("missing_page_identification", {}).get("duplicate_in_pdf", []):
        sheet = row.get("sheet_number") or f"Page {row.get('physical_page_number', '?')}"
        items.append(("Index", sheet, "Duplicate", "This sheet number appears more than once in the document."))
    for row in index.get("missing_page_identification", {}).get("missing_sheet_number_pages", []):
        page = row.get("physical_page_number") or row.get("page_number") or "?"
        items.append(("Index", f"Page {page}", "Needs Review", "No reliable sheet number was detected."))
    for row in index.get("sequence_compliance", {}).get("out_of_sequence", []):
        sheet = row.get("sheet_number") if isinstance(row, dict) else str(row)
        items.append(("Index", sheet or "Sheet order", "Out of sequence", "Sheet order does not match the index."))

    for row in result.get("sheet_keynote_compliance", []):
        if row.get("keynoteCheckStatus") != "Pass":
            items.append((
                "Keynotes",
                f"{row.get('sheetNumber', '')} (page {row.get('pageNumber', '?')})",
                row.get("keynoteCheckStatus") or "Fail",
                row.get("comment") or "Required keynote symbols were not confirmed.",
            ))
    uncertain_viewports: list[dict] = []
    for row in result.get("viewport_keynote_compliance", []):
        if row.get("status") != "Pass":
            if str(row.get("view_label") or "").lower() == "possible viewport":
                uncertain_viewports.append(row)
                continue
            label = " ".join(str(value or "") for value in [
                row.get("sheet_number"),
                row.get("detail_number"),
                row.get("view_label"),
            ]).strip()
            items.append((
                "Viewport",
                label,
                row.get("status") or "Fail",
                row.get("failure_reason") or "Required keynote symbols were not confirmed.",
            ))
    if uncertain_viewports:
        sheets = sorted({str(row.get("sheet_number") or "") for row in uncertain_viewports if row.get("sheet_number")})
        items.append((
            "Viewport",
            f"{len(uncertain_viewports)} possible viewport title(s): {', '.join(sheets)}",
            "Needs Review",
            "Viewport-like text was found, but a reliable detail number, title, and scale combination was not parsed.",
        ))
    for row in result.get("missing_scale_check", []):
        if row.get("status") == "Pass":
            continue
        label = " ".join(str(value or "") for value in [
            row.get("sheet_number"),
            row.get("detail_number"),
            row.get("view_label"),
        ]).strip()
        items.append((
            "Scale",
            label,
            "Needs Review",
            row.get("comment") or "No scale or NTS designation was detected near the view title.",
        ))
    for row in result.get("sheet_seal_compliance", []):
        if row.get("status") == "Pass":
            continue
        if row.get("status") == "Not Applicable":
            continue
        sheet = row.get("sheet_number") or f"Page {row.get('page_number', '?')}"
        items.append((
            "Seal",
            sheet,
            "Missing",
            row.get("comments") or "No professional seal was detected on the right side of the sheet.",
        ))
    for row in result.get("spell_check", {}).get("findings", []):
        word = row.get("word") or "Possible typo"
        suggestion = row.get("suggested_correction") or ""
        sheet = row.get("sheet") or f"Page {row.get('page', '?')}"
        items.append((
            "Spelling",
            f"{sheet}: {word}",
            row.get("status") or "Open",
            f"Suggested correction: {suggestion}. Context: {row.get('context', '')}".strip(),
        ))
    return items


def _pdf_confirmed_items(result: dict[str, Any]) -> list[tuple[str, str]]:
    cover_items = result.get("cover_sheet_checklist", {}).get("checklist", [])
    cover_passed = [item.get("item", "") for item in cover_items if item.get("status") == "Pass"]
    index = result.get("index_integrity_check", {})
    keynote = result.get("keynote_statistics", {})
    scale = result.get("missing_scale_statistics", {})
    seals = result.get("seal_statistics", {})

    findings: list[tuple[str, str]] = []
    if cover_passed:
        findings.append(("Cover", f"{len(cover_passed)} confirmed items: " + "; ".join(cover_passed)))
    if index.get("presence_compliance", {}).get("status") == "Pass":
        findings.append(("Index", "Every indexed sheet was found in the PDF, with no unlisted physical sheets."))
    if index.get("sequence_compliance", {}).get("status") == "Pass":
        findings.append(("Index", "Physical sheet order matches the extracted sheet index."))
    reviewed = int(keynote.get("reviewed_sheet_count") or 0)
    passed = int(keynote.get("passed_sheet_count") or 0)
    if reviewed:
        findings.append(("Keynotes", f"{passed} of {reviewed} reviewed keynote sheets passed."))
    scale_reviewed = int(scale.get("reviewed_view_count") or 0)
    scale_passed = int(scale.get("passed_view_count") or 0)
    if scale_reviewed:
        findings.append(("Scales", f"{scale_passed} of {scale_reviewed} detected views include a scale or NTS designation."))
    seal_reviewed = int(seals.get("reviewed_sheet_count") or 0)
    seal_passed = int(seals.get("passed_sheet_count") or 0)
    seal_not_applicable = int(seals.get("not_applicable_count") or 0)
    if seal_reviewed and seal_not_applicable != seal_reviewed:
        findings.append(("Seals", f"{seal_passed} of {seal_reviewed} sheets include a right-side professional seal."))
    spell = result.get("spell_check", {})
    if spell and not spell.get("findings", []):
        findings.append(("Spelling", "Spell check completed with no possible spelling issues found."))
    return findings or [("QC review", "No confirmed-present findings were available.")]


def _compact_table_style(colors, issue_rows: bool = False, success_rows: bool = False):
    from reportlab.platypus import TableStyle

    commands = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#334e68")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#bcccdc")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f5f7fa")]),
    ]
    if issue_rows:
        commands.append(("BACKGROUND", (2, 1), (2, -1), colors.HexColor("#fff3cd")))
    if success_rows:
        commands.append(("BACKGROUND", (0, 1), (0, -1), colors.HexColor("#e7f4ea")))
    return TableStyle(commands)
