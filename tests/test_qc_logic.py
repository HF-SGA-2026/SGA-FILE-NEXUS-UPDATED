from __future__ import annotations

import json
import base64
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

from services.cover_sheet_analyzer import analyze_cover_sheet, classify_cover_sheets, classify_set_type, detect_consultant_information_from_page, detect_cover_sheet, detect_cover_visuals_from_page, detect_owner_information_from_page, score_cover_checklist
from services.json_storage import read_json, write_json_atomic
from services.pdf_ingestion import should_run_page_operations
from services.qc_report_generator import build_qc_result, result_to_csv, result_to_pdf
from services.qc_scope import scoped_qc_index_entries, scoped_qc_pages
from services.sheet_index_extractor import apply_index_position_fallback_to_pages, compare_index_to_physical, extract_sheet_index, physical_sheets_from_pages
from services.seal_detector import detect_professional_seal
from services.spell_check import run_spell_check, should_ignore_candidate
from services.title_block_extractor import detect_sheet_name, detect_sheet_number, detect_sheet_number_from_page_label, extract_title_block, _sheet_number_from_words
from services.viewport_detector import detect_missing_scales_for_page, detect_viewports_for_page, evaluate_keynote_compliance, keynote_review_for_page
from web_app import apply_extraction_scope, convert_image_upload_to_pdf, merge_page_private_fields, sheet_index_entries_from_scoped_pages


FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "sample_qc_fixture.json").read_text())


class JsonStorageTests(unittest.TestCase):
    def test_atomic_json_write_replaces_complete_document(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "status.json"
            write_json_atomic(path, {"status": "Scanning", "percent": 50})
            write_json_atomic(path, {"status": "Complete", "percent": 100})
            self.assertEqual(
                read_json(path),
                {"status": "Complete", "percent": 100},
            )
            self.assertEqual(list(path.parent.glob(".status.json.*.tmp")), [])

    def test_atomic_json_write_is_always_readable_during_updates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "status.json"
            write_json_atomic(path, {"percent": 0})
            errors: list[Exception] = []
            finished = threading.Event()

            def writer() -> None:
                try:
                    for percent in range(200):
                        write_json_atomic(path, {"percent": percent, "message": "Scanning"})
                finally:
                    finished.set()

            def reader() -> None:
                while not finished.is_set():
                    try:
                        read_json(path)
                    except Exception as error:
                        errors.append(error)

            readers = [threading.Thread(target=reader) for _ in range(4)]
            for thread in readers:
                thread.start()
            writer_thread = threading.Thread(target=writer)
            writer_thread.start()
            writer_thread.join()
            for thread in readers:
                thread.join()

            self.assertEqual(errors, [])

    def test_public_page_updates_preserve_private_thumbnail_paths(self) -> None:
        existing = [
            {
                "page_number": 1,
                "sheet_number": "A1",
                "thumbnail_path": "cache/thumbnails/page-0001.png",
            }
        ]
        incoming = [{"page_number": 1, "sheet_number": "A1.01", "thumbnail_url": "/api/runs/run/thumbnail/1"}]
        merged = merge_page_private_fields(existing, incoming)
        self.assertEqual(merged[0]["sheet_number"], "A1.01")
        self.assertEqual(merged[0]["thumbnail_path"], "cache/thumbnails/page-0001.png")


class QcScopeTests(unittest.TestCase):
    def test_qc_scope_includes_cover_and_a_sheets_only(self) -> None:
        pages = [
            {"page_number": 1, "sheet_number": "CS", "is_cover_sheet": True},
            {"page_number": 2, "sheet_number": "G001"},
            {"page_number": 3, "sheet_number": "ADA"},
            {"page_number": 4, "sheet_number": "A2.01"},
            {"page_number": 5, "sheet_number": "S1.01"},
            {
                "page_number": 6,
                "sheet_number": "A1.02",
                "sheet_source": "sheet_index_position",
                "physical_sheet_number_missing": True,
            },
        ]

        scoped = scoped_qc_pages(pages)

        self.assertEqual([page["page_number"] for page in scoped], [1, 3, 4])

    def test_index_compare_is_limited_to_scoped_cover_and_a_sheets(self) -> None:
        pages = [
            {"page_number": 1, "sheet_number": "CS", "sheet_name": "COVER SHEET", "is_cover_sheet": True},
            {"page_number": 2, "sheet_number": "G001", "sheet_name": "GENERAL NOTES"},
            {"page_number": 3, "sheet_number": "A1.01", "sheet_name": "FLOOR PLAN"},
        ]
        entries = [
            {"sheet_number": "CS", "sheet_name": "COVER SHEET", "index_position": 1},
            {"sheet_number": "CS-CIVIL", "sheet_name": "COVER SHEET", "index_position": 2},
            {"sheet_number": "G001", "sheet_name": "GENERAL NOTES", "index_position": 2},
            {"sheet_number": "A1.01", "sheet_name": "FLOOR PLAN", "index_position": 3},
            {"sheet_number": "S1.01", "sheet_name": "STRUCTURAL PLAN", "index_position": 4},
        ]

        scoped_pages = scoped_qc_pages(pages)
        scoped_entries = scoped_qc_index_entries(entries, scoped_pages)
        result = compare_index_to_physical(
            scoped_entries,
            physical_sheets_from_pages(scoped_pages),
            scoped_pages,
        )

        self.assertEqual([entry["sheet_number"] for entry in scoped_entries], ["CS", "A1.01"])
        self.assertEqual(result["presence_compliance"]["status"], "Pass")
        self.assertEqual(result["missing_page_identification"]["missing_from_pdf"], [])

    def test_index_scope_does_not_keep_trade_sheet_named_cover_sheet(self) -> None:
        pages = [
            {"page_number": 1, "sheet_number": "CS", "sheet_name": "COVER SHEET", "is_cover_sheet": True},
            {"page_number": 2, "sheet_number": "A1.01", "sheet_name": "FLOOR PLAN"},
        ]
        entries = [
            {"sheet_number": "CS", "sheet_name": "COVER SHEET", "index_position": 1},
            {"sheet_number": "P2.01", "sheet_name": "COVER SHEET", "index_position": 2},
            {"sheet_number": "A1.01", "sheet_name": "FLOOR PLAN", "index_position": 3},
        ]

        scoped_entries = scoped_qc_index_entries(entries, scoped_qc_pages(pages))

        self.assertEqual([entry["sheet_number"] for entry in scoped_entries], ["CS", "A1.01"])

    def test_upload_page_operations_run_only_for_a_sheets_and_cover(self) -> None:
        self.assertTrue(should_run_page_operations({"sheet_number": "A1.01"}, []))
        self.assertTrue(should_run_page_operations({"sheet_number": "ADA"}, []))
        self.assertTrue(should_run_page_operations({"sheet_number": "G001"}, ["cover"]))
        self.assertFalse(should_run_page_operations({"sheet_number": "G001"}, []))
        self.assertFalse(should_run_page_operations({"sheet_number": "S1.01"}, []))
        self.assertFalse(should_run_page_operations({"sheet_number": "M2.01"}, ["keynotes"]))

    def test_saved_extractions_and_index_are_scoped_to_cover_and_a_sheets(self) -> None:
        run_data = {
            "pages": [
                {"page_number": 1, "sheet_number": "CS", "sheet_name": "COVER SHEET", "is_cover_sheet": True},
                {"page_number": 2, "sheet_number": "G001", "sheet_name": "GENERAL NOTES"},
                {"page_number": 3, "sheet_number": "A1.01", "sheet_name": "FLOOR PLAN"},
                {"page_number": 4, "sheet_number": "S1.01", "sheet_name": "STRUCTURAL PLAN"},
                {"page_number": 5, "sheet_number": "ADA", "sheet_name": "ACCESSIBILITY"},
            ],
        }
        sheet_index = {
            "entries": [
                {"sheet_number": "CS", "sheet_name": "COVER SHEET", "index_position": 1},
                {"sheet_number": "G001", "sheet_name": "GENERAL NOTES", "index_position": 2},
                {"sheet_number": "A1.01", "sheet_name": "FLOOR PLAN", "index_position": 3},
                {"sheet_number": "S1.01", "sheet_name": "STRUCTURAL PLAN", "index_position": 4},
                {"sheet_number": "ADA", "sheet_name": "ACCESSIBILITY", "index_position": 5},
            ],
        }

        apply_extraction_scope(run_data, sheet_index)

        self.assertEqual([page["sheet_number"] for page in run_data["pages"]], ["CS", "A1.01", "ADA"])
        self.assertEqual([entry["sheet_number"] for entry in run_data["sheet_index"]["entries"]], ["CS", "A1.01", "ADA"])
        self.assertEqual([entry["index_position"] for entry in run_data["sheet_index"]["entries"]], [1, 2, 3])
        self.assertEqual([entry["sheet_number"] for entry in run_data["physical_sheets"]], ["CS", "A1.01", "ADA"])

    def test_scope_uses_page_labels_when_title_block_sheet_number_is_blank(self) -> None:
        run_data = {
            "pages": [
                {"page_number": 1, "sheet_number": "", "page_label_sheet_number": "CS", "page_label_confidence": 97},
                {"page_number": 2, "sheet_number": "", "page_label_sheet_number": "ADA1", "page_label_confidence": 97},
                {"page_number": 3, "sheet_number": "", "page_label_sheet_number": "A100", "page_label_confidence": 97},
                {"page_number": 4, "sheet_number": "", "page_label_sheet_number": "M100", "page_label_confidence": 97},
                {"page_number": 5, "sheet_number": "", "page_label_sheet_number": "CS-CIVIL", "page_label_confidence": 97},
            ],
        }

        apply_extraction_scope(run_data, {"entries": []})

        self.assertEqual([page["sheet_number"] for page in run_data["pages"]], ["CS", "ADA1", "A100"])
        self.assertEqual([page["physical_sheet_number_missing"] for page in run_data["pages"]], [False, False, False])
        self.assertEqual([entry["sheet_number"] for entry in run_data["sheet_index"]["entries"]], ["CS", "ADA1", "A100"])
        self.assertEqual([entry["source"] for entry in run_data["sheet_index"]["entries"]], ["page_label_scope", "page_label_scope", "page_label_scope"])

    def test_scope_rejects_generic_cover_label_when_page_is_civil_cover(self) -> None:
        run_data = {
            "pages": [
                {"page_number": 1, "sheet_number": "CS", "is_cover_sheet": True},
                {
                    "page_number": 8,
                    "sheet_number": "",
                    "page_label_sheet_number": "COVER",
                    "page_label_text": "cover",
                    "page_label_confidence": 97,
                    "text": (
                        "COVER SHEET C1.0 GENERAL CONSTRUCTION NOTES "
                        "C2.0 DEMOLITION PLAN C3.0 DIMENSIONAL CONTROL PLAN "
                        "C4.0 UTILITY PLAN C5.3 GRADING & DRAINAGE PLAN "
                        "SOTEX ENGINEERING TBPELS FIRM REGISTRATION"
                    ),
                },
                {"page_number": 9, "sheet_number": "", "page_label_sheet_number": "A1.01", "page_label_confidence": 97},
            ],
        }

        apply_extraction_scope(run_data, {"entries": []})

        self.assertEqual([page["page_number"] for page in run_data["pages"]], [1, 9])
        self.assertEqual([page["sheet_number"] for page in run_data["pages"]], ["CS", "A1.01"])

    def test_split_sheet_index_sections_are_combined_before_scope(self) -> None:
        pages = [{
            "page_number": 1,
            "text": "\n".join([
                "SHEET INDEX",
                "GENERAL",
                "CS",
                "COVER SHEET",
                "ADA1",
                "ACCESSIBILITY STANDARDS",
                "CIVIL",
                "C1.01",
                "GENERAL CONST. NOTES",
                "SHEET INDEX",
                "ARCHITECTURE",
                "AS1.01",
                "SITE PLAN",
                "A1.01",
                "LIFE SAFETY PLAN",
                "A8.01",
                "MILLWORK DETAILS",
                "ELECTRICAL",
                "E1.01",
                "LIGHTING PLAN",
            ]),
        }]

        result = extract_sheet_index(pages)

        self.assertIn("CS", [entry["sheet_number"] for entry in result["entries"]])
        self.assertIn("AS1.01", [entry["sheet_number"] for entry in result["entries"]])
        self.assertIn("A1.01", [entry["sheet_number"] for entry in result["entries"]])
        self.assertIn("A8.01", [entry["sheet_number"] for entry in result["entries"]])

    def test_png_upload_is_converted_to_single_page_pdf(self) -> None:
        import fitz

        png_bytes = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        )
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "sheet.png"
            image_path.write_bytes(png_bytes)
            pdf_path = convert_image_upload_to_pdf(image_path)
            self.assertEqual(pdf_path.suffix, ".pdf")
            with fitz.open(pdf_path) as document:
                self.assertEqual(document.page_count, 1)


class CoverSheetClassificationTests(unittest.TestCase):
    def test_unnumbered_later_civil_cover_is_not_classified(self) -> None:
        pages = [
            {
                "page_number": 1,
                "sheet_number": "CS1",
                "text": "PROJECT COVER SHEET SHEET INDEX DESIGN CONSULTANT TEAM",
                "needs_review": False,
            },
            {
                "page_number": 11,
                "sheet_number": "",
                "text": (
                    "LOCATION MAP\nSHEET INDEX\nCOVER SHEET\n"
                    "CIVIL CONSTRUCTION PLANS\nPROJECT LOCATION"
                ),
                "needs_review": True,
            },
        ]
        covers = classify_cover_sheets(pages)
        self.assertEqual(
            [(item["page_number"], item["cover_type"]) for item in covers],
            [(1, "primary")],
        )
        self.assertFalse(pages[1]["is_cover_sheet"])
        self.assertEqual(pages[1]["sheet_number"], "")
        self.assertTrue(pages[1]["needs_review"])
        self.assertEqual(detect_cover_sheet(pages)["page_number"], 1)

    def test_cover_word_alone_does_not_classify_a_page(self) -> None:
        page = {
            "page_number": 2,
            "sheet_number": "ADA1",
            "text": "Floor covering requirements and accessibility standards",
        }
        self.assertEqual(classify_cover_sheets([page]), [])
        self.assertFalse(page["is_cover_sheet"])

    def test_later_civil_cover_is_not_classified_with_main_cover(self) -> None:
        pages = [
            {
                "page_number": 1,
                "sheet_number": "CS",
                "text": "COVER SHEET SHEET INDEX DESIGN CONSULTANT TEAM OWNER PROJECT TITLE",
            },
            {
                "page_number": 3,
                "sheet_number": "CS",
                "text": "COVER SHEET SHEET INDEX CIVIL CONSTRUCTION PLANS LOCATION MAP",
            },
        ]
        covers = classify_cover_sheets(pages)
        self.assertEqual(
            [(item["page_number"], item["cover_type"]) for item in covers],
            [(1, "primary")],
        )


class IndexComparisonTests(unittest.TestCase):
    def test_secondary_cover_is_excluded_from_physical_sheet_index(self) -> None:
        pages = [
            {"page_number": 1, "sheet_number": "CS1", "cover_type": "primary"},
            {"page_number": 11, "sheet_number": "", "cover_type": "secondary"},
            {"page_number": 12, "sheet_number": "C-1.0", "cover_type": ""},
        ]
        physical = physical_sheets_from_pages(pages)
        self.assertEqual([item["page_number"] for item in physical], [1, 12])
        result = compare_index_to_physical(
            [{"sheet_number": "CS1"}, {"sheet_number": "C-1.0"}],
            physical,
        )
        self.assertEqual(result["presence_compliance"]["status"], "Pass")
        self.assertEqual(result["presence_compliance"]["missing_sheet_number_pages"], [])

    def test_discipline_cover_is_kept_in_physical_sheet_index(self) -> None:
        pages = [
            {"page_number": 1, "sheet_number": "CS", "cover_type": "primary"},
            {"page_number": 59, "sheet_number": "B1.0", "sheet_name": "COVER SHEET", "cover_type": "secondary"},
        ]
        physical = physical_sheets_from_pages(pages)
        self.assertEqual([item["sheet_number"] for item in physical], ["CS", "B1.0"])
        result = compare_index_to_physical(
            [{"sheet_number": "CS"}, {"sheet_number": "B1.0", "sheet_name": "COVER SHEET"}],
            physical,
            pages,
        )
        self.assertEqual(result["presence_compliance"]["status"], "Pass")

    def test_named_secondary_cover_index_entry_is_not_reported_missing(self) -> None:
        pages = [
            {"page_number": 1, "sheet_number": "CS1", "cover_type": "primary"},
            {"page_number": 11, "sheet_number": "", "cover_type": "secondary"},
            {"page_number": 12, "sheet_number": "C-1.0", "cover_type": ""},
        ]
        index_entries = [
            {"sheet_number": "CS1", "sheet_name": "COVER SHEET", "index_position": 1},
            {"sheet_number": "CS-CIVIL", "sheet_name": "COVER SHEET", "index_position": 2},
            {"sheet_number": "C-1.0", "sheet_name": "SITE PLAN", "index_position": 3},
        ]
        result = compare_index_to_physical(index_entries, physical_sheets_from_pages(pages), pages)
        self.assertEqual(result["presence_compliance"]["status"], "Pass")
        self.assertEqual(result["missing_page_identification"]["missing_from_pdf"], [])
        self.assertEqual(result["ignored_secondary_cover_entries"][0]["sheet_number"], "CS-CIVIL")

    def test_named_cover_sheet_identifier_is_kept_whole_in_index(self) -> None:
        pages = [{"page_number": 1, "text": "SHEET INDEX\nCS-CIVIL    COVER SHEET"}]
        result = extract_sheet_index(pages)
        self.assertEqual(result["entries"][0]["sheet_number"], "CS-CIVIL")
        self.assertEqual(result["entries"][0]["sheet_name"], "COVER SHEET")

    def test_numbered_cover_sheet_identifier_is_extracted_from_index(self) -> None:
        pages = [{"page_number": 1, "text": "SHEET INDEX\nGENERAL\nCS1\nCOVER SHEET"}]
        result = extract_sheet_index(pages)
        self.assertEqual(result["entries"][0]["sheet_number"], "CS1")
        self.assertEqual(result["entries"][0]["sheet_name"], "COVER SHEET")

    def test_secondary_cover_is_not_filled_from_index_position(self) -> None:
        pages = [
            {
                "page_number": 2,
                "sheet_number": "",
                "cover_type": "secondary",
                "needs_review": True,
            }
        ]
        updated = apply_index_position_fallback_to_pages(
            pages,
            {"entries": [{"index_position": 2, "sheet_number": "C-1.0", "confidence": 90}]},
        )
        self.assertEqual(updated[0]["sheet_number"], "")
        self.assertTrue(updated[0]["ignored_for_sheet_index"])

    def test_low_confidence_pages_are_filled_from_aligned_index_positions(self) -> None:
        pages = [
            {"page_number": 17, "sheet_number": "", "sheet_name": "", "needs_review": True, "title_block_confidence": 0},
            {"page_number": 18, "sheet_number": "", "sheet_name": "", "needs_review": True, "title_block_confidence": 0},
        ]
        sheet_index = {
            "entries": [
                {"index_position": 17, "sheet_number": "C-7.0", "sheet_name": "DETAILS", "confidence": 80},
                {"index_position": 18, "sheet_number": "C-7.1", "sheet_name": "DETAILS", "confidence": 80},
            ]
        }
        updated = apply_index_position_fallback_to_pages(pages, sheet_index)
        self.assertEqual([page["sheet_number"] for page in updated], ["C-7.0", "C-7.1"])
        self.assertEqual([page["sheet_source"] for page in updated], ["sheet_index_position", "sheet_index_position"])
        self.assertEqual([page["physical_sheet_number_missing"] for page in updated], [True, True])
        physical = physical_sheets_from_pages(updated)
        result = compare_index_to_physical(sheet_index["entries"], physical)
        missing_pages = result["presence_compliance"]["missing_sheet_number_pages"]
        self.assertEqual([row["physical_page_number"] for row in missing_pages], [17, 18])
        self.assertIn("inferred", missing_pages[0]["comment"])

    def test_matching_pdf_page_label_and_index_position_keeps_missing_visible_sheet_number(self) -> None:
        pages = [
            {
                "page_number": 17,
                "sheet_number": "",
                "sheet_name": "",
                "needs_review": True,
                "title_block_confidence": 0,
                "page_label_sheet_number": "C-7.0",
                "page_label_confidence": 97,
            }
        ]
        sheet_index = {"entries": [{"index_position": 17, "sheet_number": "C-7.0", "sheet_name": "DETAILS", "confidence": 80}]}
        updated = apply_index_position_fallback_to_pages(pages, sheet_index)
        self.assertEqual(updated[0]["sheet_number"], "C-7.0")
        self.assertEqual(updated[0]["sheet_source"], "page_label_index_match")
        self.assertEqual(updated[0]["inferred_sheet_number"], "C-7.0")
        self.assertTrue(updated[0]["physical_sheet_number_missing"])
        self.assertEqual(updated[0]["sheet_number_decision"]["source"], "page_label_index_match")
        self.assertTrue(updated[0]["sheet_number_decision"]["physical_sheet_number_missing"])
        self.assertFalse(updated[0]["sheet_number_decision"]["evidence"]["visual_title_number"]["present"])
        result = compare_index_to_physical(sheet_index["entries"], physical_sheets_from_pages(updated))
        missing_pages = result["presence_compliance"]["missing_sheet_number_pages"]
        self.assertEqual([row["physical_page_number"] for row in missing_pages], [17])

    def test_civil_cover_page_label_does_not_match_primary_cs_index_entry(self) -> None:
        pages = [
            {
                "page_number": 3,
                "sheet_number": "",
                "sheet_name": "",
                "needs_review": True,
                "title_block_confidence": 0,
                "page_label_sheet_number": "CS",
                "page_label_text": "CS CIVIL",
                "page_label_confidence": 97,
                "visual_title_sheet_number": {"present": True, "confidence": 82},
            }
        ]
        sheet_index = {
            "entries": [
                {"index_position": 1, "sheet_number": "CS", "sheet_name": "COVER SHEET", "confidence": 80},
                {"index_position": 3, "sheet_number": "C1.0", "sheet_name": "CIVIL COVER SHEET", "confidence": 80},
            ]
        }

        updated = apply_index_position_fallback_to_pages(pages, sheet_index)

        self.assertNotEqual(updated[0]["sheet_number"], "CS")
        self.assertEqual(scoped_qc_pages(updated), [])

    def test_matching_pdf_page_label_with_visual_title_number_counts_as_physical(self) -> None:
        pages = [
            {
                "page_number": 17,
                "sheet_number": "",
                "sheet_name": "",
                "needs_review": True,
                "title_block_confidence": 0,
                "page_label_sheet_number": "S-1.1",
                "page_label_confidence": 97,
                "visual_title_sheet_number": {"present": True, "confidence": 82},
            }
        ]
        sheet_index = {"entries": [{"index_position": 17, "sheet_number": "S1.1", "sheet_name": "DETAILS", "confidence": 80}]}
        updated = apply_index_position_fallback_to_pages(pages, sheet_index)
        self.assertEqual(updated[0]["sheet_number"], "S1.1")
        self.assertEqual(updated[0]["sheet_source"], "page_label_visual_match")
        self.assertFalse(updated[0].get("physical_sheet_number_missing", False))
        self.assertEqual(updated[0]["sheet_number_decision"]["source"], "page_label_visual_match")
        self.assertFalse(updated[0]["sheet_number_decision"]["physical_sheet_number_missing"])
        self.assertTrue(updated[0]["sheet_number_decision"]["evidence"]["visual_title_number"]["present"])
        result = compare_index_to_physical(sheet_index["entries"], physical_sheets_from_pages(updated))
        self.assertEqual(result["presence_compliance"]["missing_sheet_number_pages"], [])

    def test_khit_style_civil_visual_title_number_counts_as_physical(self) -> None:
        pages = [
            {
                "page_number": 10,
                "sheet_number": "",
                "sheet_name": "",
                "needs_review": True,
                "title_block_confidence": 0,
                "page_label_text": "C1.0",
                "page_label_sheet_number": "C-1.0",
                "page_label_confidence": 97,
                "visual_title_sheet_number": {
                    "present": False,
                    "confidence": 0,
                    "dark_pixel_count": 4278,
                    "ink_pixel_count": 14626,
                },
            }
        ]
        sheet_index = {"entries": [{"index_position": 10, "sheet_number": "C1.0", "sheet_name": "GENERAL CONSTRUCTION NOTES", "confidence": 80}]}
        updated = apply_index_position_fallback_to_pages(pages, sheet_index)
        self.assertEqual(updated[0]["sheet_number"], "C1.0")
        self.assertEqual(updated[0]["sheet_source"], "page_label_visual_match")
        self.assertFalse(updated[0].get("physical_sheet_number_missing", False))
        self.assertTrue(updated[0]["sheet_number_decision"]["evidence"]["visual_title_number"]["present"])
        result = compare_index_to_physical(sheet_index["entries"], physical_sheets_from_pages(updated))
        self.assertEqual(result["presence_compliance"]["missing_sheet_number_pages"], [])

    def test_khit_style_structural_visual_title_number_counts_as_physical(self) -> None:
        pages = [
            {
                "page_number": 25,
                "sheet_number": "",
                "sheet_name": "",
                "needs_review": True,
                "title_block_confidence": 0,
                "page_label_text": "S1 - GENERAL NOTES",
                "page_label_sheet_number": "S1",
                "page_label_confidence": 97,
                "visual_title_sheet_number": {
                    "present": False,
                    "confidence": 0,
                    "dark_pixel_count": 2043,
                    "ink_pixel_count": 2251,
                },
            }
        ]
        sheet_index = {"entries": [{"index_position": 25, "sheet_number": "S1", "sheet_name": "GENERAL NOTES", "confidence": 80}]}
        updated = apply_index_position_fallback_to_pages(pages, sheet_index)
        self.assertEqual(updated[0]["sheet_number"], "S1")
        self.assertEqual(updated[0]["sheet_source"], "page_label_visual_match")
        self.assertFalse(updated[0].get("physical_sheet_number_missing", False))
        self.assertTrue(updated[0]["sheet_number_decision"]["evidence"]["visual_title_number"]["present"])
        result = compare_index_to_physical(sheet_index["entries"], physical_sheets_from_pages(updated))
        self.assertEqual(result["presence_compliance"]["missing_sheet_number_pages"], [])

    def test_visual_page_label_match_wins_over_shifted_index_position(self) -> None:
        pages = [
            {
                "page_number": 34,
                "sheet_number": "",
                "sheet_name": "",
                "needs_review": True,
                "title_block_confidence": 0,
                "page_label_sheet_number": "E1.1",
                "page_label_confidence": 97,
                "visual_title_sheet_number": {
                    "present": False,
                    "confidence": 0,
                    "dark_pixel_count": 1810,
                    "ink_pixel_count": 2859,
                },
            }
        ]
        sheet_index = {
            "entries": [
                {"index_position": 34, "sheet_number": "M4.1", "sheet_name": "MECHANICAL", "confidence": 80},
                {"index_position": 35, "sheet_number": "E1.1", "sheet_name": "ELECTRICAL", "confidence": 80},
            ]
        }
        updated = apply_index_position_fallback_to_pages(pages, sheet_index)
        self.assertEqual(updated[0]["sheet_number"], "E1.1")
        self.assertEqual(updated[0]["sheet_source"], "page_label_visual_match")
        self.assertFalse(updated[0].get("physical_sheet_number_missing", False))
        decision = updated[0]["sheet_number_decision"]
        self.assertEqual(decision["evidence"]["sheet_index_position"]["sheet_number"], "M4.1")
        self.assertEqual(decision["evidence"]["sheet_index_label_match"]["sheet_number"], "E1.1")

    def test_ada_page_label_with_visual_noise_still_reports_missing_sheet_number(self) -> None:
        pages = [
            {
                "page_number": 4,
                "sheet_number": "",
                "sheet_name": "",
                "needs_review": True,
                "title_block_confidence": 0,
                "page_label_sheet_number": "ADA3",
                "page_label_confidence": 97,
                "visual_title_sheet_number": {
                    "present": False,
                    "confidence": 0,
                    "dark_pixel_count": 1908,
                    "ink_pixel_count": 4837,
                },
            }
        ]
        sheet_index = {"entries": [{"index_position": 4, "sheet_number": "ADA3", "sheet_name": "ACCESSIBILITY", "confidence": 80}]}
        updated = apply_index_position_fallback_to_pages(pages, sheet_index)
        self.assertEqual(updated[0]["sheet_number"], "ADA3")
        self.assertEqual(updated[0]["sheet_source"], "page_label_index_match")
        self.assertTrue(updated[0]["physical_sheet_number_missing"])
        self.assertEqual(updated[0]["sheet_number_decision"]["source"], "page_label_index_match")

    def test_standalone_ada_is_valid_sheet_number(self) -> None:
        sheet_number, confidence = detect_sheet_number("SHEET NUMBER\nADA\nADA STANDARDS & GENERAL NOTES")
        self.assertEqual(sheet_number, "ADA")
        self.assertGreater(confidence, 0)

    def test_sheet_index_skips_ada_title_noise_but_keeps_clean_ada_row(self) -> None:
        pages = [
            {
                "page_number": 1,
                "text": "\n".join([
                    "SHEET INDEX",
                    "ADA STANDARDS & GENERAL NOTES",
                    "CS",
                    "G1.01",
                    "ADA",
                    "AD1.01",
                ]),
            }
        ]
        result = extract_sheet_index(pages)
        self.assertEqual(
            [entry["sheet_number"] for entry in result["entries"]],
            ["CS", "G1.01", "ADA", "AD1.01"],
        )

    def test_sheet_index_reads_number_column_before_header(self) -> None:
        pages = [
            {
                "page_number": 1,
                "text": "\n".join([
                    "CS",
                    "ADA1",
                    "ADA2",
                    "AD1.0",
                    "A1.01",
                    "A1.02",
                    "A1.03",
                    "M1.1",
                    "M2.1",
                    "M3.1",
                    "M3.2",
                    "E1.1",
                    "E2.1",
                    "E3.1",
                    "P1.1",
                    "P2.1",
                    "P3.1",
                    "N.T.S.",
                    "VICINITY MAP",
                    "No.",
                    "DESCRIPTION",
                    "DATE",
                    "SHEET INDEX",
                    "COVER SHEET",
                    "ACCESSIBILITY STANDARDS",
                    "FIRE PROTECTION PLAN",
                    "FP1.1",
                ]),
            }
        ]
        result = extract_sheet_index(pages)
        self.assertEqual(
            [entry["sheet_number"] for entry in result["entries"]],
            [
                "CS", "ADA1", "ADA2", "AD1.0", "A1.01", "A1.02", "A1.03",
                "M1.1", "M2.1", "M3.1", "M3.2", "E1.1", "E2.1", "E3.1",
                "P1.1", "P2.1", "P3.1", "FP1.1",
            ],
        )

    def test_sheet_index_reads_late_fire_protection_entry(self) -> None:
        pages = [
            {
                "page_number": 1,
                "text": "\n".join(
                    ["SHEET INDEX", "COVER SHEET", "CS"]
                    + [f"ELECTRICAL DETAILS {index}" for index in range(70)]
                    + ["PLUMBING", "PP01", "PLUMBING PLAN", "FP1.01", "FIRE PROTECTION SITE PLAN"]
                ),
            }
        ]
        result = extract_sheet_index(pages)
        self.assertIn("FP1.01", [entry["sheet_number"] for entry in result["entries"]])

    def test_sheet_index_reads_long_duplicated_architecture_section(self) -> None:
        architecture_rows = [
            "A1.01", "A1.02", "A1.03", "A1.04", "A1.05", "A1.06", "A1.07", "A1.08",
            "A1.09", "A1.10", "A1.11", "A1.12", "A1.13", "A1.14", "A1.15", "A2.01",
            "A2.02", "A3.01", "A3.02", "A3.03", "A3.04", "A3.05", "A3.06", "A3.07",
            "A3.08", "A3.09", "A4.01", "A4.02", "A4.03", "A4.04", "A4.05", "A5.01",
            "A5.02", "A5.03", "A6.01", "A6.02", "A6.03", "A7.01", "A7.02", "A7.03",
            "A7.04", "A7.05",
        ]
        lines = ["SHEET INDEX", "ARCHITECTURE"]
        for number in architecture_rows:
            lines.extend([number, number, "DETAILS", "DETAILS"])
        lines.extend(["MECHANICAL", "MG01", "MG01", "MECH. NOTES"])

        result = extract_sheet_index([{"page_number": 1, "text": "\n".join(lines)}])
        numbers = [entry["sheet_number"] for entry in result["entries"]]

        self.assertIn("A5.01", numbers)
        self.assertIn("A7.04", numbers)
        self.assertIn("A7.05", numbers)

    def test_sheet_index_reads_dotted_consultant_prefixes_before_fire_protection(self) -> None:
        pages = [
            {
                "page_number": 1,
                "text": "\n".join([
                    "SHEET INDEX",
                    "ELECTRICAL",
                    "EG.01",
                    "ELECTRICAL LEGEND",
                    "ES-1.01",
                    "SITE PLAN",
                    "EP.01",
                    "LIGHTING PLAN",
                    "EP.02",
                    "POWER PLAN",
                    "ES.01",
                    "ELECTRICAL DETAILS",
                    "ES.02",
                    "ELECTRICAL DETAILS",
                    "ES.03",
                    "ELECTRICAL DETAILS",
                    "ES.04",
                    "ELECTRICAL DETAILS",
                    "ES.05",
                    "ELECTRICAL DETAILS",
                    "ES.06",
                    "ELECTRICAL DETAILS",
                    "PLUMBING",
                    "PP01",
                    "PLUMBING PLAN",
                    "FP1.01",
                    "FIRE PROTECTION SITE PLAN",
                ]),
            }
        ]
        result = extract_sheet_index(pages)
        self.assertEqual(
            [entry["sheet_number"] for entry in result["entries"]],
            ["EG.01", "ES-1.01", "EP.01", "EP.02", "ES.01", "ES.02", "ES.03", "ES.04", "ES.05", "ES.06", "PP01", "FP1.01"],
        )

    def test_accessibility_page_does_not_fall_back_to_ad_sheet(self) -> None:
        pages = [
            {
                "page_number": 3,
                "sheet_number": "",
                "sheet_name": "",
                "title_block_text": "ADA STANDARDS & GENERAL NOTES",
                "text": "ACCESSIBILITY CLEARANCES",
                "needs_review": True,
                "title_block_confidence": 0,
                "visual_title_sheet_number": {"present": True, "dark_pixel_count": 5000, "ink_pixel_count": 7000},
            }
        ]
        sheet_index = {
            "entries": [
                {"index_position": 3, "sheet_number": "AD1.01", "sheet_name": "DEMOLITION PLAN", "confidence": 80},
                {"index_position": 4, "sheet_number": "AD1.02", "sheet_name": "DEMOLITION PLAN", "confidence": 80},
            ]
        }
        updated = apply_index_position_fallback_to_pages(pages, sheet_index)
        self.assertEqual(updated[0]["sheet_number"], "")
        self.assertTrue(updated[0]["needs_review"])

    def test_standalone_ada_visual_index_match_counts_as_physical(self) -> None:
        pages = [
            {
                "page_number": 3,
                "sheet_number": "",
                "sheet_name": "",
                "needs_review": True,
                "title_block_confidence": 0,
                "visual_title_sheet_number": {"present": True, "confidence": 82},
            }
        ]
        sheet_index = {"entries": [{"index_position": 3, "sheet_number": "ADA", "sheet_name": "", "confidence": 80}]}
        updated = apply_index_position_fallback_to_pages(pages, sheet_index)
        self.assertEqual(updated[0]["sheet_number"], "ADA")
        self.assertEqual(updated[0]["sheet_source"], "title_clue_visual_match")
        self.assertFalse(updated[0].get("physical_sheet_number_missing", False))

    def test_visual_title_number_with_matching_index_position_counts_as_physical(self) -> None:
        pages = [
            {
                "page_number": 6,
                "sheet_number": "",
                "sheet_name": "FLOOR PLAN",
                "needs_review": True,
                "title_block_confidence": 0,
                "visual_title_sheet_number": {"present": True, "confidence": 82},
            }
        ]
        sheet_index = {"entries": [{"index_position": 6, "sheet_number": "A1.01", "sheet_name": "FLOOR PLAN", "confidence": 80}]}
        updated = apply_index_position_fallback_to_pages(pages, sheet_index)
        self.assertEqual(updated[0]["sheet_number"], "A1.01")
        self.assertEqual(updated[0]["sheet_source"], "sheet_index_visual_match")
        self.assertFalse(updated[0].get("physical_sheet_number_missing", False))

    def test_position_visual_match_requires_reliable_index_alignment(self) -> None:
        pages = [
            {"page_number": 1, "sheet_number": "CS", "is_cover_sheet": True, "title_block_confidence": 90},
            {
                "page_number": 25,
                "sheet_number": "",
                "sheet_name": "",
                "needs_review": True,
                "title_block_confidence": 0,
                "visual_title_sheet_number": {"present": True, "confidence": 82},
            },
            {"page_number": 119, "sheet_number": "", "sheet_name": "", "needs_review": True, "title_block_confidence": 0},
        ]
        sheet_index = {
            "entries": [
                {"index_position": 1, "sheet_number": "CS", "sheet_name": "COVER SHEET", "confidence": 80},
                {"index_position": 2, "sheet_number": "G1.01", "sheet_name": "GENERAL NOTES", "confidence": 80},
                {"index_position": 25, "sheet_number": "A1.03", "sheet_name": "DIMENSION PLAN", "confidence": 80},
            ]
        }

        updated = apply_index_position_fallback_to_pages(pages, sheet_index)

        self.assertEqual(updated[1]["sheet_number"], "A1.03")
        self.assertEqual(updated[1]["sheet_source"], "sheet_index_position")
        self.assertTrue(updated[1]["physical_sheet_number_missing"])
        self.assertEqual(scoped_qc_pages(updated), [updated[0]])

    def test_confident_mismatched_page_label_blocks_index_position_visual_match(self) -> None:
        pages = [
            {
                "page_number": 15,
                "sheet_number": "",
                "sheet_name": "",
                "needs_review": True,
                "title_block_confidence": 0,
                "page_label_text": "S4.2",
                "page_label_sheet_number": "S-4.2",
                "page_label_confidence": 97,
                "visual_title_sheet_number": {"present": True, "confidence": 82},
            }
        ]
        sheet_index = {"entries": [{"index_position": 15, "sheet_number": "AS1.01", "sheet_name": "SITE PLAN", "confidence": 80}]}

        updated = apply_index_position_fallback_to_pages(pages, sheet_index)

        self.assertEqual(updated[0]["sheet_number"], "")
        self.assertTrue(updated[0]["physical_sheet_number_missing"])
        self.assertEqual(updated[0]["sheet_number_decision"]["source"], "title_block")

    def test_index_position_fallback_uses_counted_physical_sheet_position(self) -> None:
        pages = [
            {"page_number": 1, "sheet_number": "CS", "cover_type": "secondary", "title_block_confidence": 80},
            {"page_number": 2, "sheet_number": "CS", "cover_type": "primary", "title_block_confidence": 80},
            {
                "page_number": 3,
                "sheet_number": "",
                "sheet_name": "",
                "needs_review": True,
                "title_block_confidence": 0,
                "visual_title_sheet_number": {"present": True, "confidence": 82},
            },
        ]
        sheet_index = {
            "entries": [
                {"index_position": 1, "sheet_number": "CS", "sheet_name": "COVER SHEET", "confidence": 80},
                {"index_position": 2, "sheet_number": "A1.01", "sheet_name": "FLOOR PLAN", "confidence": 80},
                {"index_position": 3, "sheet_number": "A2.01", "sheet_name": "ELEVATIONS", "confidence": 80},
            ]
        }
        updated = apply_index_position_fallback_to_pages(pages, sheet_index)
        self.assertEqual(updated[2]["sheet_number"], "A1.01")
        self.assertEqual(updated[2]["sheet_source"], "sheet_index_visual_match")

    def test_d_prefix_visual_sheet_number_accepts_detail_sheets(self) -> None:
        examples = ["D1.00", "ED1.01", "PD1.01"]
        for sheet_number in examples:
            with self.subTest(sheet_number=sheet_number):
                pages = [
                    {
                        "page_number": 26,
                        "sheet_number": "",
                        "sheet_name": "",
                        "needs_review": True,
                        "title_block_confidence": 0,
                        "page_label_sheet_number": sheet_number,
                        "visual_title_sheet_number": {
                            "present": False,
                            "confidence": 0,
                            "dark_pixel_count": 1200,
                            "ink_pixel_count": 1600,
                        },
                    }
                ]
                sheet_index = {"entries": [{"index_position": 26, "sheet_number": sheet_number, "sheet_name": "DETAILS", "confidence": 80}]}
                updated = apply_index_position_fallback_to_pages(pages, sheet_index)
                self.assertEqual(updated[0]["sheet_number"], sheet_number)
                self.assertFalse(updated[0].get("physical_sheet_number_missing", False))
                self.assertEqual(updated[0]["sheet_number_decision"]["source"], "page_label_visual_match")

    def test_demolition_title_clue_wins_over_raw_index_position(self) -> None:
        pages = [
            {
                "page_number": 15,
                "sheet_number": "",
                "sheet_name": "",
                "needs_review": True,
                "title_block_confidence": 0,
                "title_block_text": "1/4\" = 1'-0\" ELECTRICAL DEMOLITION PLAN - FIRST FLOOR",
                "visual_title_sheet_number": {
                    "present": True,
                    "confidence": 82,
                    "dark_pixel_count": 13245,
                    "ink_pixel_count": 14616,
                },
            },
            {
                "page_number": 20,
                "sheet_number": "",
                "sheet_name": "",
                "needs_review": True,
                "title_block_confidence": 0,
                "title_block_text": "1/4\" = 1'-0\" PLUMBING DEMOLITION PLAN - FIRST FLOOR",
                "visual_title_sheet_number": {
                    "present": True,
                    "confidence": 82,
                    "dark_pixel_count": 13368,
                    "ink_pixel_count": 14747,
                },
            },
        ]
        sheet_index = {
            "entries": [
                {"index_position": 14, "sheet_number": "ED1.01", "sheet_name": "ELECTRICAL DEMOLITION PLAN", "confidence": 80},
                {"index_position": 15, "sheet_number": "E1.01", "sheet_name": "ELECTRICAL LIGHTING PLAN", "confidence": 80},
                {"index_position": 19, "sheet_number": "PD1.01", "sheet_name": "PLUMBING DEMOLITION PLAN", "confidence": 80},
                {"index_position": 20, "sheet_number": "P1.01", "sheet_name": "PLUMBING SEWER PLAN", "confidence": 80},
            ]
        }
        updated = apply_index_position_fallback_to_pages(pages, sheet_index)
        self.assertEqual([page["sheet_number"] for page in updated], ["ED1.01", "PD1.01"])
        self.assertEqual([page["sheet_source"] for page in updated], ["title_clue_visual_match", "title_clue_visual_match"])
        self.assertFalse(updated[0].get("physical_sheet_number_missing", False))
        self.assertFalse(updated[1].get("physical_sheet_number_missing", False))

    def test_mismatched_pdf_page_label_still_reports_missing_visible_sheet_number(self) -> None:
        pages = [
            {
                "page_number": 17,
                "sheet_number": "",
                "sheet_name": "",
                "needs_review": True,
                "title_block_confidence": 0,
                "page_label_sheet_number": "C-9.9",
                "page_label_confidence": 97,
            }
        ]
        sheet_index = {"entries": [{"index_position": 17, "sheet_number": "C-7.0", "sheet_name": "DETAILS", "confidence": 80}]}
        updated = apply_index_position_fallback_to_pages(pages, sheet_index)
        self.assertEqual(updated[0]["sheet_source"], "sheet_index_position")
        self.assertTrue(updated[0]["physical_sheet_number_missing"])

    def test_structural_si_page_label_can_match_s1_index_position(self) -> None:
        pages = [
            {
                "page_number": 25,
                "sheet_number": "",
                "sheet_name": "",
                "needs_review": True,
                "title_block_confidence": 0,
                "page_label_text": "SI - GENERAL NOTES",
                "page_label_sheet_number": "SI",
                "text": "TREVIÑO ENGINEERING STRUCTURAL GENERAL NOTES",
            }
        ]
        sheet_index = {"entries": [{"index_position": 25, "sheet_number": "S1", "sheet_name": "GENERAL NOTES", "confidence": 80}]}
        updated = apply_index_position_fallback_to_pages(pages, sheet_index)
        self.assertEqual(updated[0]["sheet_number"], "S1")
        self.assertEqual(updated[0]["sheet_source"], "page_label_index_match")
        self.assertTrue(updated[0]["physical_sheet_number_missing"])

    def test_aligned_civil_cover_entry_does_not_fill_unnumbered_secondary_cover(self) -> None:
        pages = [
            {
                "page_number": 10,
                "sheet_number": "",
                "sheet_name": "",
                "cover_type": "secondary",
                "needs_review": True,
                "title_block_confidence": 0,
            }
        ]
        sheet_index = {
            "entries": [
                {"index_position": 10, "sheet_number": "C-0.0", "sheet_name": "COVER SHEET", "confidence": 80},
            ]
        }
        updated = apply_index_position_fallback_to_pages(pages, sheet_index)
        self.assertEqual(updated[0]["sheet_number"], "")
        self.assertTrue(updated[0].get("ignored_for_sheet_index", False))
        physical = physical_sheets_from_pages(updated)
        self.assertEqual(physical, [])

    def test_sequence_compliance_passes_when_physical_order_matches_index(self) -> None:
        result = compare_index_to_physical(FIXTURE["index_entries"], FIXTURE["physical_entries"])
        self.assertEqual(result["sequence_compliance"]["status"], "Pass")
        self.assertEqual(result["presence_compliance"]["status"], "Pass")

    def test_sequence_compliance_fails_when_sheet_is_out_of_order(self) -> None:
        physical = [FIXTURE["physical_entries"][0], FIXTURE["physical_entries"][2], FIXTURE["physical_entries"][1]]
        result = compare_index_to_physical(FIXTURE["index_entries"], physical)
        self.assertEqual(result["sequence_compliance"]["status"], "Fail")
        self.assertTrue(result["sequence_compliance"]["out_of_sequence"])

    def test_missing_and_extra_sheets_are_identified(self) -> None:
        physical = [
            FIXTURE["physical_entries"][0],
            {"sheet_number": "A301", "sheet_name": "WALL SECTIONS", "page_number": 2, "confidence": 95, "source": "fixture"},
        ]
        result = compare_index_to_physical(FIXTURE["index_entries"], physical)
        missing = result["missing_page_identification"]["missing_from_pdf"]
        extra = result["missing_page_identification"]["extra_in_pdf"]
        self.assertEqual({row["sheet_number"] for row in missing}, {"A101", "A201"})
        self.assertEqual(extra[0]["sheet_number"], "A301")

    def test_extra_sheets_do_not_create_sequence_failure_without_order_issue(self) -> None:
        physical = [
            FIXTURE["physical_entries"][0],
            {"sheet_number": "A999", "sheet_name": "EXTRA", "page_number": 2, "confidence": 95, "source": "fixture"},
            FIXTURE["physical_entries"][1],
            FIXTURE["physical_entries"][2],
        ]
        result = compare_index_to_physical(FIXTURE["index_entries"], physical)
        self.assertEqual(result["presence_compliance"]["status"], "Fail")
        self.assertEqual(result["sequence_compliance"]["status"], "Pass")
        self.assertEqual(result["sequence_compliance"]["out_of_sequence"], [])

    def test_duplicate_physical_sheet_is_presence_issue_not_sequence_failure(self) -> None:
        physical = [
            FIXTURE["physical_entries"][0],
            {**FIXTURE["physical_entries"][0], "page_number": 2},
            FIXTURE["physical_entries"][1],
            FIXTURE["physical_entries"][2],
        ]
        result = compare_index_to_physical(FIXTURE["index_entries"], physical)
        self.assertEqual(result["presence_compliance"]["status"], "Fail")
        self.assertEqual(result["sequence_compliance"]["status"], "Pass")
        self.assertEqual(
            result["presence_compliance"]["duplicate_in_pdf"][0]["sheet_number"],
            FIXTURE["physical_entries"][0]["sheet_number"],
        )

    def test_unnumbered_physical_page_fails_without_index_backfill(self) -> None:
        index_entries = [
            {"sheet_number": "CS1", "sheet_name": "COVER SHEET", "index_position": 1, "page_number": 1, "confidence": 95, "source": "fixture"},
            {"sheet_number": "G001", "sheet_name": "GENERAL NOTES", "index_position": 2, "page_number": 1, "confidence": 95, "source": "fixture"},
        ]
        physical_entries = [
            {"sheet_number": "", "sheet_name": "", "page_number": 1, "confidence": 0, "source": "title_block"},
            {"sheet_number": "G001", "sheet_name": "GENERAL NOTES", "page_number": 2, "confidence": 90, "source": "title_block"},
        ]
        result = compare_index_to_physical(index_entries, physical_entries)
        missing_pages = result["presence_compliance"]["missing_sheet_number_pages"]
        self.assertEqual(result["presence_compliance"]["status"], "Fail")
        self.assertEqual(missing_pages[0]["physical_page_number"], 1)
        self.assertIn("not used to fill", missing_pages[0]["comment"])

    def test_confident_sheet_index_is_not_rebuilt_when_an_indexed_page_is_deleted(self) -> None:
        sheet_index = {
            "source_pages": [1],
            "confidence": 90,
            "needs_review": False,
            "entries": [
                {"index_position": 1, "sheet_number": "D1.00", "source": "sheet_index"},
                {"index_position": 2, "sheet_number": "D1.01", "source": "sheet_index"},
                {"index_position": 3, "sheet_number": "D1.02", "source": "sheet_index"},
            ],
        }
        pages = [
            {"page_number": 1, "sheet_number": "D1.00", "title_block_confidence": 90},
            {"page_number": 2, "sheet_number": "D1.02", "title_block_confidence": 90},
        ]
        result = compare_index_to_physical(sheet_index["entries"], physical_sheets_from_pages(pages))
        self.assertEqual([item["sheet_number"] for item in result["missing_page_identification"]["missing_from_pdf"]], ["D1.01"])


class CoverChecklistTests(unittest.TestCase):
    def test_classifies_official_and_non_official_sets(self) -> None:
        self.assertEqual(classify_set_type("100% Permit Set")["set_type"], "Official")
        self.assertEqual(classify_set_type("2025-002 PB 15451 EDINBURG PERMIT PDF 03.26.25.pdf")["set_type"], "Official")
        self.assertEqual(classify_set_type("STISD Rising Scholars Academy -- Construction Documents Vol. 2.pdf")["set_type"], "Official")
        self.assertEqual(classify_set_type("100% BID SET")["set_type"], "Official")
        self.assertEqual(classify_set_type("SIGNED AND SEALED")["set_type"], "Official")
        self.assertEqual(classify_set_type("Design Development Progress Set Not for Construction")["set_type"], "Non-Official")
        for marker in ("NOT FOR CONSTRUCTION", "PROGRESS SET", "SCHEMATIC DESIGN", "DESIGN DEVELOPMENT"):
            with self.subTest(marker=marker):
                result = classify_set_type(f"Cover Sheet {marker}")
                self.assertEqual(result["set_type"], "Non-Official")
                self.assertEqual(result["evidence"].upper(), marker)
        self.assertEqual(
            classify_set_type("100% BID SET - NOT FOR CONSTRUCTION")["set_type"],
            "Non-Official",
        )
        self.assertEqual(classify_set_type("Owner review package")["set_type"], "Unknown")

    def test_cover_checklist_scores_twelve_items(self) -> None:
        cover = analyze_cover_sheet(FIXTURE["cover_pages"], {"entries": FIXTURE["index_entries"]})
        self.assertEqual(len(cover["checklist"]), 12)
        score = score_cover_checklist(cover["checklist"])
        self.assertEqual(score["status"], "Pass")
        self.assertEqual(score["failed_count"], 0)

    def test_permit_set_without_seal_fails_set_type_marker_only(self) -> None:
        page = {
            "page_number": 1,
            "sheet_number": "G001",
            "title_block_text": "PROJECT: MAIN STREET OFFICE",
            "text": "PROJECT TITLE MAIN STREET OFFICE OWNER MAIN STREET HOLDINGS SHEET INDEX ISSUED FOR PERMIT 05/21/2026 PERMIT SET"
        }
        cover = analyze_cover_sheet([page], {"entries": FIXTURE["index_entries"]})
        marker = cover["checklist"][11]
        self.assertEqual(marker["status"], "Fail")

    def test_revision_table_with_bid_set_and_dot_date_counts_as_issue_label(self) -> None:
        page = {
            "page_number": 1,
            "sheet_number": "CS",
            "title_block_text": "PROJECT: PECAN CAMPUS",
            "text": "COVER SHEET\nNo.\nDESCRIPTION\nDATE\n1\n100% BID SET\n03.11.26\nSHEET INDEX",
        }
        cover = analyze_cover_sheet([page], {"entries": FIXTURE["index_entries"]})
        issue = cover["checklist"][10]
        self.assertEqual(issue["status"], "Pass")

    def test_owner_heading_without_spatial_owner_content_fails_populated_check(self) -> None:
        page = {
            "page_number": 1,
            "sheet_number": "CS",
            "text": "COVER SHEET OWNER ARCHITECT SAM GARCIA SHEET INDEX",
            "owner_information": {
                "section_present": True,
                "populated": False,
                "evidence": "",
                "confidence": 92,
            },
        }
        cover = analyze_cover_sheet([page], {"entries": FIXTURE["index_entries"]})
        self.assertEqual(cover["checklist"][6]["status"], "Pass")
        self.assertEqual(cover["checklist"][7]["status"], "Fail")
        self.assertIn("OWNER heading", cover["checklist"][7]["comments"])

    def test_sparse_cover_ocr_does_not_fail_owner_population(self) -> None:
        page = {
            "page_number": 1,
            "sheet_number": "CS",
            "text": "03/05/25",
            "title_block_text": "03/05/25",
            "seal_check": {"present": True},
        }

        cover = analyze_cover_sheet(
            [page],
            {"entries": [{"sheet_number": "CS"}]},
            "2025-002 PB 15451 EDINBURG PERMIT PDF 03.26.25.pdf",
        )

        self.assertEqual(cover["set_type"], "Official")
        self.assertEqual(cover["checklist"][7]["status"], "Needs Review")
        self.assertEqual(cover["checklist"][9]["status"], "Pass")
        self.assertEqual(cover["checklist"][11]["status"], "Pass")

    def test_owner_geometry_only_counts_words_below_owner_heading(self) -> None:
        class Page:
            def get_text(self, kind: str):
                self.kind = kind
                return [
                    (900, 1400, 980, 1430, "ARCHITECT", 0, 0, 0),
                    (900, 1480, 980, 1510, "SAM", 0, 1, 0),
                    (1589, 1434, 1681, 1469, "OWNER", 1, 0, 0),
                ]

        result = detect_owner_information_from_page(Page())
        self.assertTrue(result["section_present"])
        self.assertFalse(result["populated"])

    def test_unlabelled_owner_contact_block_counts_as_populated(self) -> None:
        class Rect:
            width = 2400
            height = 1728

        class Page:
            rect = Rect()

            def get_text(self, kind: str):
                return [
                    (1540, 1180, 1700, 1215, "HINOJOSA", 0, 0, 0),
                    (1710, 1180, 1800, 1215, "LAW", 0, 1, 0),
                    (1540, 1220, 1650, 1250, "RICHARD", 1, 0, 0),
                    (1660, 1220, 1800, 1250, "HINOJOSA", 1, 1, 0),
                    (1540, 1260, 1600, 1290, "3904", 2, 0, 0),
                    (1610, 1260, 1700, 1290, "BRANDT", 2, 1, 0),
                    (1710, 1260, 1800, 1290, "STREET", 2, 2, 0),
                    (1540, 1300, 1700, 1330, "(713) 884-1605", 3, 0, 0),
                ]

        result = detect_owner_information_from_page(Page())
        self.assertTrue(result["section_present"])
        self.assertTrue(result["populated"])

    def test_cover_geometry_requires_oversized_top_title(self) -> None:
        class Rect:
            width = 2400
            height = 1728

        class Page:
            rect = Rect()

            def __init__(self, title_height: float):
                self.title_height = title_height

            def get_text(self, kind: str):
                return [(100, 80, 800, 80 + self.title_height, "HINOJOSA", 0, 0, 0)]

            def get_image_info(self, xrefs: bool):
                return []

        self.assertTrue(detect_cover_visuals_from_page(Page(260))["large_project_title_present"])
        self.assertFalse(detect_cover_visuals_from_page(Page(70))["large_project_title_present"])

    def test_cover_geometry_detects_outlined_title_lettering(self) -> None:
        class Rect:
            width = 2400
            height = 1728

        class Pixmap:
            samples = bytes([0] * 4000 + [255] * 16000)

        class Page:
            rect = Rect()

            def get_text(self, kind: str):
                return []

            def get_image_info(self, xrefs: bool):
                return []

            def get_pixmap(self, **kwargs):
                return Pixmap()

        result = detect_cover_visuals_from_page(Page())
        self.assertTrue(result["large_project_title_present"])
        self.assertIn("outlined title", result["large_project_title_evidence"].lower())

    def test_cover_geometry_detects_thin_graphic_title_lettering(self) -> None:
        class Rect:
            width = 2400
            height = 1728

        class Pixmap:
            samples = bytes([0] * 540 + [255] * 19460)

        class Page:
            rect = Rect()

            def get_text(self, kind: str):
                return []

            def get_image_info(self, xrefs: bool):
                return []

            def get_pixmap(self, **kwargs):
                return Pixmap()

        result = detect_cover_visuals_from_page(Page())
        self.assertTrue(result["large_project_title_present"])

    def test_cover_visual_checks_leave_missing_large_title_as_only_cover_error(self) -> None:
        page = {
            "page_number": 1,
            "sheet_number": "CS1",
            "title_block_text": "PROJECT NO. 2023-013",
            "text": (
                "COVER SHEET 100% PERMIT SET 09/27/24 TDLR REGISTRATION TABS2024024161 "
                "DESIGN CONSULTANT TEAM CIVIL LANDSCAPE STRUCTURE MEP SHEET INDEX "
                "REGISTERED ARCHITECT"
            ),
            "owner_information": {
                "section_present": True,
                "populated": True,
                "evidence": "HINOJOSA LAW PLLC RICHARD HINOJOSA 3904 BRANDT STREET (713) 884-1605",
                "confidence": 84,
            },
            "cover_visuals": {
                "large_project_title_present": False,
                "central_project_image_present": True,
                "central_project_image_evidence": "Project rendering region",
                "vicinity_map_present": True,
                "vicinity_map_evidence": "Site-location map region",
                "confidence": 88,
            },
        }
        cover = analyze_cover_sheet([page], {"entries": FIXTURE["index_entries"]})
        non_pass = [item["item"] for item in cover["checklist"] if item["status"] != "Pass"]
        self.assertEqual(non_pass, ["Project title present at top center"])

    def test_empty_landscape_consultant_section_fails_population_check(self) -> None:
        page = {
            "page_number": 1,
            "sheet_number": "CS1",
            "title_block_text": "PROJECT 2025-001",
            "text": "COVER SHEET DESIGN CONSULTANT TEAM CIVIL LANDSCAPE SHEET INDEX",
            "consultant_information": {
                "sections": [
                    {"discipline": "CIVIL", "populated": True, "evidence": "SOTEX ENGINEERING"},
                    {"discipline": "LANDSCAPE", "populated": False, "evidence": ""},
                ],
                "missing_disciplines": ["LANDSCAPE"],
                "confidence": 88,
            },
        }
        result = analyze_cover_sheet([page], {"entries": [{"sheet_number": "CS1"}]})
        consultant = result["checklist"][5]
        self.assertEqual(consultant["status"], "Fail")
        self.assertIn("LANDSCAPE", consultant["comments"])

    def test_sheet_index_disciplines_do_not_count_as_empty_consultant_sections(self) -> None:
        page = {
            "page_number": 1,
            "sheet_number": "CS1",
            "title_block_text": "PROJECT 2025-001",
            "text": "COVER SHEET DESIGN TEAM ARCHITECT MEP SHEET INDEX PLUMBING P2.01 PLUMBING PLAN",
            "consultant_information": {
                "sections": [
                    {"discipline": "ARCHITECT", "populated": True, "evidence": "SAM GARCIA ARCHITECT"},
                    {"discipline": "MEP", "populated": True, "evidence": "ETHOS ENGINEERING"},
                ],
                "missing_disciplines": [],
                "confidence": 88,
            },
        }
        result = analyze_cover_sheet([page], {"entries": [{"sheet_number": "CS1"}]})
        consultant = result["checklist"][5]
        self.assertEqual(consultant["status"], "Pass")

    def test_consultant_info_above_discipline_header_counts_as_populated(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class Page:
            rect = Rect()

            def get_text(self, kind: str):
                return [
                    (100, 900, 260, 930, "DESIGN", 0, 0, 0),
                    (270, 900, 520, 930, "CONSULTANT", 0, 1, 0),
                    (530, 900, 650, 930, "TEAM", 0, 2, 0),
                    (950, 950, 1100, 980, "SAM", 1, 0, 0),
                    (1110, 950, 1300, 980, "GARCIA", 1, 1, 0),
                    (950, 990, 1110, 1020, "(956)", 2, 0, 0),
                    (1120, 990, 1260, 1020, "631-8327", 2, 1, 0),
                    (950, 1030, 1120, 1060, "McAllen", 3, 0, 0),
                    (1130, 1030, 1210, 1060, "TX", 3, 1, 0),
                    (950, 1070, 1180, 1100, "ARCHITECT", 4, 0, 0),
                ]

        result = detect_consultant_information_from_page(Page())
        architect = next(section for section in result["sections"] if section["discipline"] == "ARCHITECT")
        self.assertTrue(architect["populated"])
        self.assertIn("GARCIA", architect["evidence"])

    def test_project_title_match_counts_as_owner_information(self) -> None:
        class Rect:
            width = 2400
            height = 1728

        class Page:
            rect = Rect()

            def get_text(self, kind: str):
                return [
                    (100, 100, 400, 200, "HINOJOSA", 0, 0, 0),
                    (500, 100, 700, 200, "LAW", 0, 1, 0),
                    (1500, 1200, 1750, 1260, "HINOJOSA", 1, 0, 0),
                    (1760, 1200, 1850, 1260, "LAW", 1, 1, 0),
                ]

        result = detect_owner_information_from_page(Page())
        self.assertTrue(result["section_present"])
        self.assertTrue(result["populated"])
        self.assertEqual(result["source"], "project_title_match")

    def test_right_side_high_resolution_square_image_counts_as_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return [{"bbox": (2200, 1200, 2280, 1280), "width": 2200, "height": 2200}]

            def get_text(self, kind: str):
                return [
                    (2180, 1160, 2290, 1180, "REGISTERED", 0, 0, 0),
                    (2180, 1185, 2290, 1205, "ARCHITECT", 0, 1, 0),
                    (2180, 1290, 2290, 1310, "STATE", 0, 2, 0),
                    (2295, 1290, 2340, 1310, "OF", 0, 3, 0),
                    (2345, 1290, 2400, 1310, "TEXAS", 0, 4, 0),
                ]

        self.assertTrue(detect_professional_seal(Page())["present"])

    def test_right_side_firm_logo_does_not_count_as_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return [{"bbox": (2200, 1200, 2280, 1280), "width": 2200, "height": 2200}]

            def get_text(self, kind: str):
                return [
                    (2160, 1180, 2220, 1200, "SAM", 0, 0, 0),
                    (2225, 1180, 2300, 1200, "GARCIA", 0, 1, 0),
                    (2305, 1180, 2380, 1200, "ARCHITECT", 0, 2, 0),
                    (2160, 1290, 2380, 1310, "INFO@SAMGARCIAARCHITECT.COM", 0, 3, 0),
                ]

            def get_pixmap(self, **kwargs):
                raise RuntimeError("No vector fallback available")

        self.assertFalse(detect_professional_seal(Page())["present"])

    def test_right_side_signed_stamp_box_counts_as_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class Pixmap:
            width = 287
            height = 312

            pixels = bytearray([255, 255, 255] * width * height)
            for y in range(70, 150):
                for x in range(55, 170):
                    index = (y * width + x) * 3
                    pixels[index:index + 3] = bytes([35, 35, 35])
            for y in range(135, 160):
                for x in range(82, 112):
                    index = (y * width + x) * 3
                    pixels[index:index + 3] = bytes([20, 70, 210])
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str):
                return []

            def get_pixmap(self, **kwargs):
                return Pixmap()

        self.assertTrue(detect_professional_seal(Page())["present"])

    def test_revision_history_marker_does_not_veto_actual_signed_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class Pixmap:
            width = 287
            height = 312

            pixels = bytearray([255, 255, 255] * width * height)
            for y in range(70, 150):
                for x in range(55, 170):
                    index = (y * width + x) * 3
                    pixels[index:index + 3] = bytes([35, 35, 35])
            for y in range(135, 160):
                for x in range(82, 112):
                    index = (y * width + x) * 3
                    pixels[index:index + 3] = bytes([20, 70, 210])
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str, clip=None):
                return "DATE DESCRIPTION 07-02-2024 ISSUED FOR REVIEW 09-20-2024 100% UPDATED CD SET"

            def get_pixmap(self, **kwargs):
                return Pixmap()

        self.assertTrue(detect_professional_seal(Page())["present"])

    def test_lighter_signed_stamp_box_counts_as_full_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class Pixmap:
            width = 287
            height = 485

            pixels = bytearray([255, 255, 255] * width * height)
            for y in range(100, 170):
                for x in range(55, 145):
                    index = (y * width + x) * 3
                    pixels[index:index + 3] = bytes([35, 35, 35])
            for y in range(170, 200):
                for x in range(72, 108):
                    index = (y * width + x) * 3
                    pixels[index:index + 3] = bytes([20, 70, 210])
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str):
                return []

            def get_pixmap(self, **kwargs):
                return Pixmap()

        self.assertTrue(detect_professional_seal(Page())["present"])

    def test_high_round_stamp_box_counts_as_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class Pixmap:
            width = 360
            height = 697

            pixels = bytearray([255, 255, 255] * width * height)
            for y in range(70, 220):
                for x in range(80, 230):
                    dx = x - 155
                    dy = y - 145
                    distance = (dx * dx + dy * dy) ** 0.5
                    if 64 <= distance <= 67:
                        index = (y * width + x) * 3
                        pixels[index:index + 3] = bytes([35, 35, 35])
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str):
                return []

            def get_pixmap(self, **kwargs):
                return Pixmap()

        self.assertTrue(detect_professional_seal(Page())["present"])

    def test_broad_right_column_signed_seal_counts_as_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class BlankPixmap:
            width = 287
            height = 485
            samples = bytes([255, 255, 255] * width * height)

        class BroadPixmap:
            width = 576
            height = 722

            pixels = bytearray([255, 255, 255] * width * height)
            for y in range(250, 340):
                for x in range(250, 350):
                    dx = x - 300
                    dy = y - 295
                    distance = (dx * dx + dy * dy) ** 0.5
                    if 36 <= distance <= 45:
                        index = (y * width + x) * 3
                        pixels[index:index + 3] = bytes([35, 35, 35])
            for y in range(325, 350):
                for x in range(260, 335):
                    if (x + y) % 3 == 0:
                        index = (y * width + x) * 3
                        pixels[index:index + 3] = bytes([20, 70, 210])
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str):
                return []

            def get_pixmap(self, **kwargs):
                clip = kwargs.get("clip")
                if clip and clip.x0 < self.rect.width * 0.60:
                    return BroadPixmap()
                return BlankPixmap()

        self.assertTrue(detect_professional_seal(Page())["present"])

    def test_broad_right_column_monochrome_signed_seal_counts_as_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class BlankPixmap:
            width = 287
            height = 485
            samples = bytes([255, 255, 255] * width * height)

        class BroadPixmap:
            width = 576
            height = 722

            pixels = bytearray([255, 255, 255] * width * height)
            for y in range(250, 340):
                for x in range(250, 350):
                    dx = x - 300
                    dy = y - 295
                    distance = (dx * dx + dy * dy) ** 0.5
                    if 36 <= distance <= 45:
                        index = (y * width + x) * 3
                        pixels[index:index + 3] = bytes([35, 35, 35])
            for y in range(350, 378):
                for x in range(235, 375):
                    if (x + y) % 7 == 0 or abs((y - 362) - (x - 235) * 0.08) < 1:
                        index = (y * width + x) * 3
                        pixels[index:index + 3] = bytes([35, 35, 35])
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str, clip=None):
                return ""

            def get_pixmap(self, **kwargs):
                clip = kwargs.get("clip")
                if clip and clip.x0 < self.rect.width * 0.60:
                    return BroadPixmap()
                return BlankPixmap()

        result = detect_professional_seal(Page())
        self.assertTrue(result["present"])
        self.assertIn("monochrome", result["evidence"])

    def test_preliminary_and_final_cleaning_note_does_not_veto_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class BlankPixmap:
            width = 287
            height = 485
            samples = bytes([255, 255, 255] * width * height)

        class BroadPixmap:
            width = 576
            height = 722

            pixels = bytearray([255, 255, 255] * width * height)
            for y in range(250, 340):
                for x in range(250, 350):
                    dx = x - 300
                    dy = y - 295
                    distance = (dx * dx + dy * dy) ** 0.5
                    if 36 <= distance <= 45:
                        index = (y * width + x) * 3
                        pixels[index:index + 3] = bytes([35, 35, 35])
            for y in range(350, 378):
                for x in range(235, 375):
                    if (x + y) % 7 == 0 or abs((y - 362) - (x - 235) * 0.08) < 1:
                        index = (y * width + x) * 3
                        pixels[index:index + 3] = bytes([35, 35, 35])
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str, clip=None):
                return "The preliminary and final cleaning accepts wiping down millwork."

            def get_pixmap(self, **kwargs):
                clip = kwargs.get("clip")
                if clip and clip.x0 < self.rect.width * 0.60:
                    return BroadPixmap()
                return BlankPixmap()

        self.assertTrue(detect_professional_seal(Page())["present"])

    def test_broad_right_column_round_stamp_counts_as_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class BlankPixmap:
            width = 287
            height = 485
            samples = bytes([255, 255, 255] * width * height)

        class BroadPixmap:
            width = 576
            height = 722

            pixels = bytearray([255, 255, 255] * width * height)
            for y in range(190, 300):
                for x in range(410, 520):
                    dx = x - 465
                    dy = y - 245
                    distance = (dx * dx + dy * dy) ** 0.5
                    if 42 <= distance <= 47:
                        index = (y * width + x) * 3
                        pixels[index:index + 3] = bytes([35, 35, 35])
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str):
                return []

            def get_pixmap(self, **kwargs):
                clip = kwargs.get("clip")
                if clip and clip.x0 < self.rect.width * 0.60:
                    return BroadPixmap()
                return BlankPixmap()

        self.assertTrue(detect_professional_seal(Page())["present"])

    def test_small_sparse_right_column_stamp_counts_as_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class BlankPixmap:
            width = 287
            height = 485
            samples = bytes([255, 255, 255] * width * height)

        class BroadPixmap:
            width = 576
            height = 722

            pixels = bytearray([255, 255, 255] * width * height)
            for y in range(445, 500):
                for x in range(500, 555):
                    dx = x - 527
                    dy = y - 472
                    distance = (dx * dx + dy * dy) ** 0.5
                    if 20 <= distance <= 23:
                        index = (y * width + x) * 3
                        pixels[index:index + 3] = bytes([35, 35, 35])
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str):
                return []

            def get_pixmap(self, **kwargs):
                clip = kwargs.get("clip")
                if clip and clip.x0 < self.rect.width * 0.60:
                    return BroadPixmap()
                return BlankPixmap()

        self.assertTrue(detect_professional_seal(Page())["present"])

    def test_low_dense_title_block_logo_does_not_count_as_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class BlankPixmap:
            width = 287
            height = 485
            samples = bytes([255, 255, 255] * width * height)

        class BroadPixmap:
            width = 576
            height = 722

            pixels = bytearray([255, 255, 255] * width * height)
            for y in range(520, 570):
                for x in range(490, 540):
                    dx = x - 515
                    dy = y - 545
                    distance = (dx * dx + dy * dy) ** 0.5
                    if distance <= 20:
                        index = (y * width + x) * 3
                        pixels[index:index + 3] = bytes([35, 35, 35])
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str):
                return []

            def get_pixmap(self, **kwargs):
                clip = kwargs.get("clip")
                if clip and clip.x0 < self.rect.width * 0.60:
                    return BroadPixmap()
                return BlankPixmap()

        self.assertFalse(detect_professional_seal(Page())["present"])

    def test_lower_title_block_light_stamp_counts_as_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class BlankPixmap:
            width = 287
            height = 485
            samples = bytes([255, 255, 255] * width * height)

        class LowerPixmap:
            width = 390
            height = 441

            pixels = bytearray([255] * width * height)
            for y in range(195, 294):
                for x in range(256, 382):
                    dx = (x - 319) / 62
                    dy = (y - 244) / 48
                    distance = (dx * dx + dy * dy) ** 0.5
                    if 0.94 <= distance <= 1.02:
                        pixels[y * width + x] = 35
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str):
                return []

            def get_pixmap(self, **kwargs):
                clip = kwargs.get("clip")
                if clip and self.rect.width * 0.77 < clip.x0 < self.rect.width * 0.79:
                    return LowerPixmap()
                return BlankPixmap()

        self.assertTrue(detect_professional_seal(Page())["present"])

    def test_lower_right_signed_engineering_seal_counts_as_full_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class BlankPixmap:
            width = 287
            height = 485
            samples = bytes([255, 255, 255] * width * height)

        class LowerRightPixmap:
            width = 360
            height = 425

            pixels = bytearray([255, 255, 255] * width * height)
            for y in range(85, 205):
                for x in range(125, 255):
                    dx = x - 190
                    dy = y - 145
                    distance = (dx * dx + dy * dy) ** 0.5
                    if 15 <= distance <= 55 or 165 <= y <= 184 or x % 17 == 0:
                        index = (y * width + x) * 3
                        pixels[index:index + 3] = bytes([35, 35, 35])
            for y in range(190, 225):
                for x in range(120, 260):
                    if (x + y) % 2 == 0:
                        index = (y * width + x) * 3
                        pixels[index:index + 3] = bytes([20, 70, 210])
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str):
                return []

            def get_pixmap(self, **kwargs):
                clip = kwargs.get("clip")
                if clip and self.rect.width * 0.69 < clip.x0 < self.rect.width * 0.71:
                    return LowerRightPixmap()
                return BlankPixmap()

        result = detect_professional_seal(Page())
        self.assertTrue(result["present"])
        self.assertIn("lower title block", result["evidence"])

    def test_partial_stamp_box_mark_is_not_a_passing_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class Pixmap:
            width = 287
            height = 312

            pixels = bytearray([255, 255, 255] * width * height)
            for y in range(95, 140):
                for x in range(100, 170):
                    index = (y * width + x) * 3
                    pixels[index:index + 3] = bytes([35, 35, 35])
            for y in range(160, 172):
                for x in range(82, 102):
                    index = (y * width + x) * 3
                    pixels[index:index + 3] = bytes([20, 70, 210])
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str):
                return []

            def get_pixmap(self, **kwargs):
                return Pixmap()

        result = detect_professional_seal(Page())
        self.assertFalse(result["present"])
        self.assertTrue(result["partial"])

    def test_preliminary_title_block_graphics_do_not_count_as_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class Pixmap:
            width = 287
            height = 312

            pixels = bytearray([255, 255, 255] * width * height)
            for y in range(70, 150):
                for x in range(55, 170):
                    index = (y * width + x) * 3
                    pixels[index:index + 3] = bytes([35, 35, 35])
            for y in range(135, 160):
                for x in range(82, 112):
                    index = (y * width + x) * 3
                    pixels[index:index + 3] = bytes([20, 70, 210])
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str, clip=None):
                return "PRELIMINARY SUBJECT TO REVISION NOT FOR CONSTRUCTION"

            def get_pixmap(self, **kwargs):
                return Pixmap()

        result = detect_professional_seal(Page())
        self.assertFalse(result["present"])
        self.assertIn("preliminary", result["comments"].lower())

    def test_right_side_preliminary_box_does_not_count_as_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class Pixmap:
            width = 287
            height = 312

            pixels = bytearray([255, 255, 255] * width * height)
            for y in range(0, height):
                for x in range(20, 230):
                    if x in (20, 229) or y in (0, height - 1) or (120 <= y <= 150 and x % 5 == 0):
                        index = (y * width + x) * 3
                        pixels[index:index + 3] = bytes([30, 30, 30])
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str):
                return [(2100, 1000, 2300, 1020, "PRELIMINARY", 0, 0, 0)]

            def get_pixmap(self, **kwargs):
                return Pixmap()

        self.assertFalse(detect_professional_seal(Page())["present"])

    def test_city_title_block_logo_does_not_count_as_seal(self) -> None:
        class Rect:
            width = 2400
            height = 1700

        class BlankPixmap:
            width = 287
            height = 485
            samples = bytes([255, 255, 255] * width * height)

        class BroadPixmap:
            width = 576
            height = 722

            pixels = bytearray([255, 255, 255] * width * height)
            for y in range(90, 220):
                for x in range(430, 560):
                    dx = x - 495
                    dy = y - 155
                    distance = (dx * dx + dy * dy) ** 0.5
                    if 48 <= distance <= 58:
                        index = (y * width + x) * 3
                        pixels[index:index + 3] = bytes([35, 35, 35])
            samples = bytes(pixels)

        class Page:
            rect = Rect()

            def get_image_info(self, xrefs: bool):
                return []

            def get_text(self, kind: str, clip=None):
                return "CITY OF EDINBURG ENGINEERING DEPARTMENT WATER STANDARD DETAILS"

            def get_pixmap(self, **kwargs):
                clip = kwargs.get("clip")
                if clip and clip.x0 < self.rect.width * 0.60:
                    return BroadPixmap()
                return BlankPixmap()

        self.assertFalse(detect_professional_seal(Page())["present"])

    def test_missing_seal_only_fails_official_sets(self) -> None:
        run_data = {
            "pages": [{"page_number": 1, "sheet_number": "A1", "seal_check": {"present": False}}],
            "sheet_index": {},
            "physical_sheets": [],
        }
        index = {
            "sequence_compliance": {"status": "Pass"},
            "presence_compliance": {"status": "Pass"},
            "missing_page_identification": {},
        }
        official = build_qc_result(run_data, {"checklist": [], "set_type": "Official"}, index, [])
        non_official = build_qc_result(run_data, {"checklist": [], "set_type": "Non-Official"}, index, [])
        self.assertEqual(official["sheet_seal_compliance"][0]["status"], "Fail")
        self.assertEqual(non_official["sheet_seal_compliance"][0]["status"], "Not Applicable")

    def test_seal_like_graphics_are_not_applicable_when_set_type_is_unknown(self) -> None:
        run_data = {
            "pages": [{"page_number": 4, "sheet_number": "A1", "seal_check": {"present": True}}],
            "sheet_index": {},
            "physical_sheets": [],
        }
        index = {
            "sequence_compliance": {"status": "Pass"},
            "presence_compliance": {"status": "Pass"},
            "missing_page_identification": {},
        }
        result = build_qc_result(run_data, {"checklist": [], "set_type": "Unknown"}, index, [])
        self.assertEqual(result["sheet_seal_compliance"][0]["status"], "Not Applicable")


class TitleBlockExtractionTests(unittest.TestCase):
    def test_title_block_metadata_is_not_used_as_sheet_name(self) -> None:
        title_block = (
            "ADA1\n"
            "2025-009\n"
            "3201 PECAN BLVD,\n"
            "MCALLEN TX 78501\n"
            "03.11.26\n"
            "ACCESSIBILITY\n"
            "STANDARDS\n"
            "03.11.26\n"
        )
        sheet_name, confidence = detect_sheet_name(title_block, "ADA1")
        self.assertEqual(sheet_name, "ACCESSIBILITY STANDARDS")
        self.assertGreaterEqual(confidence, 70)

    def test_sheet_number_under_sheet_no_label_is_preferred(self) -> None:
        text = "PROJECT NO.\n2023-013\nSHEET NO.\nC-2.0\nACCESSIBILITY NOTES A. RAMP 180"
        sheet_number, confidence = detect_sheet_number(text)
        self.assertEqual(sheet_number, "C-2.0")
        self.assertGreaterEqual(confidence, 90)

    def test_spaced_bold_sheet_number_is_reconstructed(self) -> None:
        text = "SHEET NO.\nC - 2 . 0\nNo. DESCRIPTION DATE"
        sheet_number, confidence = detect_sheet_number(text)
        self.assertEqual(sheet_number, "C-2.0")
        self.assertGreaterEqual(confidence, 90)

    def test_wide_tracking_sheet_numbers_are_reconstructed(self) -> None:
        examples = {
            "SHEET NO.\nCS": "CS",
            "SHEET NO.\nD101": "D101",
            "SHEET NO.\nEL3.11": "EL3.11",
            "SHEET NO.\nMG01": "MG01",
            "SHEET NO.\nMP01": "MP01",
            "SHEET NO.\nMD01": "MD01",
            "SHEET NO.\nEG.01": "EG.01",
            "SHEET NO.\nEP.01": "EP.01",
            "SHEET NO.\nPP01": "PP01",
            "SHEET NO.\nES1.01": "ES1.01",
            "SHEET NO.\nMEPD1.01": "MEPD1.01",
            "SHEET NO.\nL 3": "L3",
            "SHEET NO.\nD 1 0 1": "D101",
            "SHEET NO.\nM S 0 1": "MS01",
            "SHEET NO.\nA S 1 . 0 2": "AS1.02",
            "SHEET NO.\nA D A 1": "ADA1",
            "SHEET NO.\nADA3": "ADA3",
            "SHEET NO.\nD1.00": "D1.00",
            "SHEET NO.\nED1.01": "ED1.01",
            "SHEET NO.\nPD1.01": "PD1.01",
            "SHEET NO.\nI R 2": "IR2",
            "SHEET NO.\nS 3 . 1 - 1": "S3.1-1",
        }
        for text, expected in examples.items():
            with self.subTest(expected=expected):
                sheet_number, confidence = detect_sheet_number(text)
                self.assertEqual(sheet_number, expected)
                self.assertGreaterEqual(confidence, 90)

    def test_pdf_page_labels_are_used_for_cover_and_mep_labels(self) -> None:
        class Page:
            def __init__(self, label: str) -> None:
                self.label = label

            def get_label(self) -> str:
                return self.label

        examples = {
            "CS - COVER SHEET\x00": "CS",
            "cover": "COVER",
            ".MEP1.01": "MEP1.01",
            "MEPD1.01": "MEPD1.01",
            "EL3.11": "EL3.11",
            "MG01 - MECHANICAL NOTES AND LEGEND": "MG01",
            "MP01 - MECHANICAL1ST FLR PLAN": "MP01",
            "MD01 - MECHANICAL DETAILS": "MD01",
            "ES1.01 - ELECTRICAL SITE LIGHTING PLAN": "ES1.01",
            "SI - GENERAL NOTES": "SI",
            "SD1 - FOUNDATION DETAILS": "SD1",
            "B 1.0 - COVER SHEET": "B1.0",
            "ADA3 - ACCESSIBILITY STANDARDS": "ADA3",
            "D1.00 - DETAILS": "D1.00",
            "ED1.01 - ELECTRICAL DEMOLITION PLAN": "ED1.01",
            "PD1.01 - PLUMBING DEMOLITION PLAN": "PD1.01",
        }
        for label, expected in examples.items():
            with self.subTest(label=label):
                sheet_number, confidence = detect_sheet_number_from_page_label(Page(label))
                self.assertEqual(sheet_number, expected)
                self.assertEqual(confidence, 97)

    def test_named_civil_cover_page_label_is_detected(self) -> None:
        class Page:
            def get_label(self) -> str:
                return "CS-CIVIL"

        sheet_number, confidence = detect_sheet_number_from_page_label(Page())
        self.assertEqual(sheet_number, "CS-CIVIL")
        self.assertEqual(confidence, 97)

    def test_descriptive_page_label_does_not_backfill_missing_visible_sheet_number(self) -> None:
        class Page:
            rect = SimpleNamespace(x0=0, y0=0, x1=2592, y1=1728, width=2592, height=1728)

            def get_label(self) -> str:
                return "ADA1 - ACCESSIBILITY STANDARDS"

            def get_text(self, mode: str, clip=None):
                if mode == "words":
                    return []
                return "ACCESSIBILITY\nSTANDARDS\nPROJECT DATA\nNO SHEET NUMBER HERE"

        result = extract_title_block(Page(), "ACCESSIBILITY STANDARDS")
        self.assertEqual(result["sheet_number"], "")
        self.assertEqual(result["sheet_name"], "")
        self.assertTrue(result["needs_review"])

    def test_alpha_page_label_does_not_backfill_missing_visible_sheet_number(self) -> None:
        class Page:
            rect = SimpleNamespace(x0=0, y0=0, x1=2592, y1=1728, width=2592, height=1728)

            def get_label(self) -> str:
                return "SI - GENERAL NOTES"

            def get_text(self, mode: str, clip=None):
                if mode == "words":
                    return []
                return "GENERAL NOTES"

        result = extract_title_block(Page(), "GENERAL NOTES")
        self.assertEqual(result["sheet_number"], "")
        self.assertEqual(result["sheet_name"], "")
        self.assertTrue(result["needs_review"])

    def test_structural_s1_page_label_does_not_create_missing_visible_sheet_number(self) -> None:
        class Page:
            rect = SimpleNamespace(x0=0, y0=0, x1=2592, y1=1728, width=2592, height=1728)

            def get_label(self) -> str:
                return "SI - GENERAL NOTES"

            def get_text(self, mode: str, clip=None):
                if mode == "words":
                    return []
                return "TREVIÑO ENGINEERING FIRM No. F-7906 GENERAL NOTES"

        result = extract_title_block(Page(), "TREVIÑO ENGINEERING GENERAL NOTES")
        self.assertEqual(result["sheet_number"], "")
        self.assertEqual(result["sheet_name"], "")
        self.assertTrue(result["needs_review"])

    def test_civil_stamp_context_does_not_create_missing_visible_sheet_number(self) -> None:
        class Page:
            rect = SimpleNamespace(x0=0, y0=0, x1=2592, y1=1728, width=2592, height=1728)

            def get_label(self) -> str:
                return "C2.0"

            def get_text(self, mode: str, clip=None):
                if mode == "words":
                    return []
                return "538 S. TEXAS BLVD. TBPELS FIRM REGISTRATION F-21475 Know what's below Call before you dig"

        result = extract_title_block(Page(), "TBPELS FIRM REGISTRATION F-21475")
        self.assertEqual(result["sheet_number"], "")
        self.assertEqual(result["sheet_name"], "")
        self.assertTrue(result["needs_review"])

    def test_matching_page_label_raises_low_geometry_sheet_number_confidence(self) -> None:
        class Rect:
            x0 = 0
            y0 = 0
            x1 = 2592
            y1 = 1728
            width = 2592
            height = 1728

        class Page:
            rect = Rect()

            def get_label(self) -> str:
                return "S1.1"

            def get_text(self, kind: str, clip=None):
                if kind == "words":
                    return [(2360, 1600, 2460, 1635, "S-1.1", 0, 0, 0)]
                return ""

        result = extract_title_block(Page(), "")
        self.assertEqual(result["sheet_number"], "S-1.1")
        self.assertFalse(result["needs_review"])

    def test_civil_cover_label_does_not_create_missing_visible_sheet_number(self) -> None:
        class Page:
            rect = SimpleNamespace(x0=0, y0=0, x1=2592, y1=1728, width=2592, height=1728)

            def get_label(self) -> str:
                return "CS-CIVIL"

            def get_text(self, mode: str, clip=None):
                if mode == "words":
                    return []
                return "SHEET INDEX\nCIVIL CONSTRUCTION PLAN"

        result = extract_title_block(Page(), "SHEET INDEX CIVIL CONSTRUCTION PLAN")
        self.assertEqual(result["sheet_number"], "")
        self.assertEqual(result["sheet_name"], "")
        self.assertTrue(result["needs_review"])

    def test_page_label_is_not_used_when_visible_sheet_number_is_missing(self) -> None:
        class Page:
            rect = SimpleNamespace(x0=0, y0=0, x1=2592, y1=1728, width=2592, height=1728)

            def __init__(self, label: str, title_text: str) -> None:
                self.label = label
                self.title_text = title_text

            def get_label(self) -> str:
                return self.label

            def get_text(self, mode: str, clip=None):
                if mode == "words":
                    return []
                return self.title_text

        sparse = extract_title_block(Page("E2.1", ""), "")
        readable_missing = extract_title_block(Page("ADA3", "ACCESSIBILITY STANDARDS\nPROJECT DATA\nNO SHEET NUMBER HERE"), "ASME A18.1 PLATFORM LIFTS")
        self.assertEqual(sparse["sheet_number"], "")
        self.assertTrue(sparse["needs_review"])
        self.assertEqual(readable_missing["sheet_number"], "")

    def test_valid_page_label_overrides_false_cover_geometry(self) -> None:
        class Rect:
            x0 = 0
            y0 = 0
            x1 = 1000
            y1 = 1000
            width = 1000
            height = 1000

        class Page:
            rect = Rect()

            def get_label(self):
                return "IR2"

            def get_text(self, kind: str, clip=None):
                if kind == "text":
                    return "COVER"
                return [(900, 900, 980, 960, "COVER", 0, 0, 0)]

        result = extract_title_block(Page(), "IRRIGATION NOTES")
        self.assertEqual(result["sheet_number"], "IR2")

    def test_generic_notes_do_not_become_sheet_numbers(self) -> None:
        text = "TAS 2012 STANDARDS\nASME A17.1\nA18.1 PLATFORM LIFTS\nR 11' - 0\"\n36\" MINIMUM\nF.T. 38"
        sheet_number, confidence = detect_sheet_number(text)
        self.assertEqual(sheet_number, "")
        self.assertEqual(confidence, 0)

    def test_bottom_right_large_title_block_number_beats_notes_font_noise(self) -> None:
        rect = SimpleNamespace(width=2592, height=1728)
        words = [
            (2100, 900, 2160, 930, "A180"),
            (2382, 1601, 2499, 1709, "ADA1"),
        ]
        sheet_number, confidence = _sheet_number_from_words(words, rect)
        self.assertEqual(sheet_number, "ADA1")
        self.assertGreaterEqual(confidence, 90)

    def test_compact_extreme_bottom_right_sheet_number_is_detected(self) -> None:
        rect = SimpleNamespace(width=2592, height=1728)
        words = [
            (2367.24, 1623.12, 2451.06, 1653.293, "C-3.0"),
        ]
        sheet_number, confidence = _sheet_number_from_words(words, rect)
        self.assertEqual(sheet_number, "C-3.0")
        self.assertGreaterEqual(confidence, 80)

    def test_trailing_period_is_removed_from_title_block_sheet_number(self) -> None:
        rect = SimpleNamespace(width=2592, height=1728)
        words = [
            (2352.755, 1600.828, 2527.887, 1708.989, "A1.09."),
        ]
        sheet_number, confidence = _sheet_number_from_words(words, rect)
        self.assertEqual(sheet_number, "A1.09")
        self.assertGreaterEqual(confidence, 90)

    def test_code_references_do_not_become_geometry_sheet_numbers(self) -> None:
        rect = SimpleNamespace(width=2592, height=1728)
        words = [
            (1700, 1450, 1750, 1460, "SHALL"),
            (1755, 1450, 1810, 1460, "COMPLY"),
            (1815, 1450, 1860, 1460, "WITH"),
            (1865, 1450, 1910, 1460, "ASME"),
            (1915, 1450, 1980, 1460, "A18.1"),
            (1985, 1450, 2050, 1460, "SECTION"),
        ]
        sheet_number, confidence = _sheet_number_from_words(words, rect)
        self.assertEqual(sheet_number, "")
        self.assertEqual(confidence, 0)

    def test_small_lower_right_code_reference_is_not_sheet_number(self) -> None:
        rect = SimpleNamespace(width=2592, height=1728)
        words = [
            (1815, 1450, 1860, 1459, "WITH"),
            (1865, 1450, 1910, 1459, "ASME"),
            (1915, 1450, 1980, 1459, "A18.1"),
        ]
        sheet_number, confidence = _sheet_number_from_words(words, rect)
        self.assertEqual(sheet_number, "")
        self.assertEqual(confidence, 0)

    def test_bottom_right_split_words_are_rebuilt_as_sheet_number(self) -> None:
        rect = SimpleNamespace(width=2592, height=1728)
        words = [
            (2350, 1600, 2370, 1708, "A"),
            (2378, 1600, 2398, 1708, "S"),
            (2406, 1600, 2426, 1708, "1"),
            (2434, 1600, 2442, 1708, "."),
            (2450, 1600, 2470, 1708, "0"),
            (2478, 1600, 2498, 1708, "2"),
        ]
        sheet_number, confidence = _sheet_number_from_words(words, rect)
        self.assertEqual(sheet_number, "AS1.02")
        self.assertGreaterEqual(confidence, 90)


class ViewportLogicTests(unittest.TestCase):
    def test_missing_scale_check_passes_with_architectural_scale(self) -> None:
        page = {
            "page_number": 10,
            "sheet_number": "A101",
            "text": "1/8\" = 1'-0\"\n1\nFLOOR PLAN",
        }
        findings = detect_missing_scales_for_page(page)
        self.assertEqual(findings[0]["status"], "Pass")
        self.assertEqual(findings[0]["view_label"], "FLOOR PLAN")
        self.assertEqual(findings[0]["scale"], "1/8\" = 1'-0\"")

    def test_missing_scale_check_recognizes_full_size_scale_reference(self) -> None:
        page = {
            "page_number": 6,
            "sheet_number": "AS1.01",
            "text": "1\u2033 = 20\u2032-0\u2033\n1\nSITE PLAN EXISTING DEMO",
        }
        findings = detect_missing_scales_for_page(page)
        self.assertEqual(findings[0]["status"], "Pass")
        self.assertEqual(findings[0]["scale"], "1\" = 20'-0\"")

    def test_missing_scale_check_recognizes_feet_only_engineering_scale(self) -> None:
        page = {
            "page_number": 7,
            "sheet_number": "C-2",
            "text": "SCALE: 1\" = 10'\n02\nSITE PLAN",
        }
        findings = detect_missing_scales_for_page(page)
        self.assertEqual(findings[0]["status"], "Pass")
        self.assertEqual(findings[0]["scale"], "1\" = 10'")

    def test_missing_scale_check_recognizes_title_bubble_number_after_label(self) -> None:
        page = {
            "page_number": 22,
            "sheet_number": "S2.1",
            "text": "FOUNDATION PLAN 1\n1/4\" = 1'-0\"",
        }
        findings = detect_missing_scales_for_page(page)
        self.assertEqual(findings[0]["detail_number"], "1")
        self.assertEqual(findings[0]["view_label"], "FOUNDATION PLAN")
        self.assertEqual(findings[0]["status"], "Pass")
        self.assertEqual(findings[0]["scale"], "1/4\" = 1'-0\"")

    def test_missing_scale_check_recognizes_title_bubble_number_after_scale(self) -> None:
        page = {
            "page_number": 22,
            "sheet_number": "S2.1",
            "text": "FOUNDATION PLAN\n1/4\"\n= 1'-0\"\n1",
        }
        findings = detect_missing_scales_for_page(page)
        self.assertEqual(findings[0]["detail_number"], "1")
        self.assertEqual(findings[0]["status"], "Pass")
        self.assertEqual(findings[0]["scale"], "1/4\" = 1'-0\"")

    def test_missing_scale_check_uses_visual_site_plan_scale_marker(self) -> None:
        page = {
            "page_number": 7,
            "sheet_number": "C-2",
            "text": "02\nSITE PLAN",
            "visual_scale_marker": {"present": True},
        }
        findings = detect_missing_scales_for_page(page)
        self.assertEqual(findings[0]["status"], "Pass")
        self.assertEqual(findings[0]["scale"], "Visual scale marker")

    def test_missing_scale_check_passes_with_nts(self) -> None:
        page = {
            "page_number": 20,
            "sheet_number": "A501",
            "text": "5 WALL DETAIL N.T.S.",
        }
        findings = detect_missing_scales_for_page(page)
        self.assertEqual(findings[0]["status"], "Pass")
        self.assertEqual(findings[0]["scale"], "NTS")

    def test_missing_scale_check_passes_with_spelled_out_not_to_scale(self) -> None:
        page = {
            "page_number": 67,
            "sheet_number": "E3.1",
            "text": "1\nTYPICAL MOUNTING HEIGHT DETAIL\nNOT TO SCALE",
        }
        findings = detect_missing_scales_for_page(page)
        self.assertEqual(findings[0]["status"], "Pass")
        self.assertEqual(findings[0]["scale"], "NTS")

    def test_missing_scale_check_passes_with_no_scale(self) -> None:
        page = {
            "page_number": 69,
            "sheet_number": "E5.01",
            "text": "03\nNO SCALE\nDIMMING WALL STATION SCHEMATIC DETAIL",
        }
        findings = detect_missing_scales_for_page(page)
        self.assertEqual(findings[0]["status"], "Pass")
        self.assertEqual(findings[0]["scale"], "NTS")

    def test_missing_scale_check_warns_when_scale_and_nts_are_absent(self) -> None:
        page = {
            "page_number": 15,
            "sheet_number": "A201",
            "text": "3\nBUILDING SECTION\nROOF ASSEMBLY",
        }
        findings = detect_missing_scales_for_page(page)
        self.assertEqual(findings[0]["status"], "Warning")
        self.assertEqual(findings[0]["comment"], "Missing scale or NTS designation.")

    def test_missing_scale_check_ignores_unnumbered_prose(self) -> None:
        page = {
            "page_number": 4,
            "sheet_number": "G101",
            "text": "Building section requirements shall comply with the code.",
        }
        self.assertEqual(detect_missing_scales_for_page(page), [])

    def test_missing_scale_check_ignores_keynote_section_heading(self) -> None:
        page = {
            "page_number": 10,
            "sheet_number": "D1.01",
            "text": (
                "17\nDEMOLITION PLAN KEYNOTES\n"
                "3/16\" = 1'-0\"\n1\nFIRST FLOOR - DEMO PLAN\n"
                "3/16\" = 1'-0\"\n2\nSECOND FLOOR - DEMOLITION PLAN ENLARGED"
            ),
        }
        findings = detect_missing_scales_for_page(page)
        self.assertEqual(len(findings), 2)
        self.assertTrue(all(item["status"] == "Pass" for item in findings))
        self.assertNotIn("17", {item["detail_number"] for item in findings})

    def test_missing_scale_check_ignores_floor_plan_reference_notes(self) -> None:
        page = {
            "page_number": 49,
            "sheet_number": "M6.01",
            "text": (
                "M10001\n*NOT TO SCALE\nTYPICAL MEP INSTALLATION\nRE: FLOOR PLAN FOR SIZES\n"
                "7\n8\n9\n2. REFER TO MECHANICAL FLOOR PLAN FOR NECK SIZES."
            ),
        }
        self.assertEqual(detect_missing_scales_for_page(page), [])

    def test_missing_scale_check_ignores_ref_notes_plan_reference(self) -> None:
        page = {
            "page_number": 7,
            "sheet_number": "AS1.02",
            "text": (
                "SHEET KEYNOTES\n"
                "31.\n"
                "4\" WIDE PAINTED STRIPES (REF. NOTES\n"
                "ON SITE PLAN FOR COLOR TYP.)\n"
                "3/4\" = 1'-0\"\n"
                "1\n"
                "PARKING SIGN DETAIL\n"
            ),
        }
        findings = detect_missing_scales_for_page(page)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["view_label"], "PARKING SIGN DETAIL")
        self.assertEqual(findings[0]["status"], "Pass")
        self.assertEqual(findings[0]["scale"], "3/4\" = 1'-0\"")

    def test_missing_scale_check_ignores_see_detail_reference(self) -> None:
        page = {
            "page_number": 9,
            "sheet_number": "AS1.04",
            "text": "8\nSHAPED PLATE SEE DETAIL\n1 1/2\" = 1'-0\"\n2\nGATE LATCH DETAILS",
        }
        findings = detect_missing_scales_for_page(page)
        self.assertEqual(findings, [])

    def test_missing_scale_check_ignores_roof_plan_reference_split_across_lines(self) -> None:
        page = {
            "page_number": 100,
            "sheet_number": "E1.02",
            "text": (
                "1\nELECTRICAL LIGHTING PLAN - 2ND FLOOR\n3/16\" = 1'-0\"\n"
                "3\nPOWER PACK FOR FAN CONTROL. ROUTE TO EXHAUST FAN EF-1. REFER TO\n"
                "ROOF PLAN, SHEET E2.03."
            ),
        }
        findings = detect_missing_scales_for_page(page)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["view_label"], "LIGHTING PLAN")
        self.assertEqual(findings[0]["status"], "Pass")

    def test_missing_scale_check_ignores_abbreviated_roof_plan_reference(self) -> None:
        page = {
            "page_number": 45,
            "sheet_number": "A2.01",
            "text": "10.\nTPO ROOFING, RE. ROOF PLAN",
        }
        self.assertEqual(detect_missing_scales_for_page(page), [])

    def test_missing_scale_check_ignores_roof_plan_reference_in_finish_sheet(self) -> None:
        page = {
            "page_number": 46,
            "sheet_number": "A1.13",
            "text": (
                "FLOOR FINISH LEGEND\n"
                "1\n"
                "FINISH PLAN\n"
                "REFER TO ROOF PLAN FOR ROOF MEMBRANE FINISHES"
            ),
        }
        findings = detect_missing_scales_for_page(page)
        self.assertEqual(findings, [])

    def test_missing_scale_check_skips_door_window_schedule_type_sheets(self) -> None:
        page = {
            "page_number": 69,
            "sheet_number": "A7.03",
            "sheet_name": "TEMPERED OUTDOOR LITE - GUARDIAN SUNGUARD",
            "text": (
                "CEILING TILE TYPES\n"
                "GLAZING TYPES - EXTERIOR\n"
                "DOOR SCHEDULE SUITE 2\n"
                "WINDOW SCHEDULE SUITE 2\n"
                "1\n"
                "DOOR HEAD DETAIL"
            ),
        }
        self.assertEqual(detect_missing_scales_for_page(page), [])

    def test_missing_scale_check_skips_scheduled_door_window_detail_sheet(self) -> None:
        page = {
            "page_number": 68,
            "sheet_number": "A7.02",
            "sheet_name": "LEAD-LINED STEEL HOLLOW-METAL",
            "text": (
                "FRAME AS SCHEDULED\n"
                "DOOR AS SCHEDULE\n"
                "WINDOW SILL DETAIL\n"
                "WINDOW JAMB DETAIL\n"
                "DOOR HEAD DETAILS\n"
                "1\n"
                "WINDOW JAMB DETAIL"
            ),
        }
        self.assertEqual(detect_missing_scales_for_page(page), [])

    def test_missing_scale_check_ignores_sheet_index_plan_rows(self) -> None:
        page = {
            "page_number": 118,
            "sheet_number": "P3.01",
            "text": (
                "INDEX OF SHEETS PLUM\nSheet Number\nSheet Name\n"
                "P3.01\nPLUMBING LEGEND\nP1.03\nPLUMBING ROOF PLAN\n"
            ),
        }
        self.assertEqual(detect_missing_scales_for_page(page), [])

    def test_missing_scale_check_skips_cover_index_sheet_rows(self) -> None:
        page = {
            "page_number": 1,
            "sheet_number": "A001",
            "sheet_name": "INDEX SHEET",
            "page_label_text": "A001 - INDEX SHEET",
            "text": (
                "SHEET INDEX\n"
                "MECHANICAL\n"
                "M100\nMECHANICAL FLOOR PLAN\n"
                "ELECTRICAL\n"
                "E100\nELECTRICAL FLOOR PLAN\n"
                "PLUMBING\n"
                "P100\nPLUMBING FLOOR PLAN\n"
            ),
        }
        self.assertEqual(detect_missing_scales_for_page(page), [])

    def test_text_only_keynote_reference_does_not_count_as_numbered_symbol(self) -> None:
        findings = detect_viewports_for_page(FIXTURE["viewport_page_with_keynotes"])
        self.assertEqual(findings[0]["status"], "Fail")
        self.assertEqual(findings[0]["detail_number"], "1")
        review = keynote_review_for_page(FIXTURE["viewport_page_with_keynotes"])
        self.assertTrue(review["hasSheetKeynotes"])
        self.assertEqual(review["keynoteCheckStatus"], "Fail")
        self.assertIn("no number", review["comment"].lower())

    def test_sheet_with_sheet_keynotes_and_viewport_missing_keynotes_fails(self) -> None:
        findings = detect_viewports_for_page(FIXTURE["viewport_page_without_keynotes"])
        self.assertEqual(findings[0]["status"], "Fail")
        self.assertIn("no keynote symbol", findings[0]["failure_reason"].lower())
        result = evaluate_keynote_compliance([FIXTURE["viewport_page_without_keynotes"]])
        self.assertEqual(result["sheet_reviews"][0]["keynoteCheckStatus"], "Fail")

    def test_sheet_with_graphic_keynote_symbol_passes_without_text_keynote_callout(self) -> None:
        findings = detect_viewports_for_page(FIXTURE["viewport_page_with_graphic_keynote_symbol"])
        result = evaluate_keynote_compliance([FIXTURE["viewport_page_with_graphic_keynote_symbol"]])
        self.assertEqual(findings[0]["status"], "Pass")
        self.assertEqual(result["sheet_reviews"][0]["keynoteCheckStatus"], "Pass")
        self.assertEqual(result["viewport_findings"][0]["status"], "Pass")

    def test_demolition_plan_keynotes_heading_is_reviewed(self) -> None:
        page = {
            "page_number": 10,
            "sheet_number": "D1.01",
            "text": "DEMOLITION PLAN KEYNOTES 1. REMOVE WALL 2. REMOVE DOOR",
            "keynote_symbols": {
                "present": True,
                "numbers": ["1", "2"],
                "count": 2,
                "confidence": 82,
                "has_number_inside_symbol": True,
            },
        }
        result = evaluate_keynote_compliance([page])
        self.assertTrue(page["hasSheetKeynotes"])
        self.assertEqual(result["sheet_reviews"][0]["keynoteCheckStatus"], "Pass")

    def test_sheet_with_text_extracted_numbered_keynote_callouts_passes(self) -> None:
        page = {
            "page_number": 58,
            "sheet_number": "A6.04",
            "text": (
                "2 3 4 5 6 7 ENLARGED FLOOR PLAN 1/4\" = 1'-0\" "
                "SHEET KEYNOTES 1. GYPSUM BOARD 2. BULLET RESISTANT PANEL "
                "3. BATTEN STRIP 4. WOOD STUD FRAMING 5. BATT INSULATION "
                "6. SHEATHING 7. BASIS OF DESIGN"
            ),
        }
        result = evaluate_keynote_compliance([page])
        self.assertEqual(result["sheet_reviews"][0]["keynoteCheckStatus"], "Pass")

    def test_unparsed_view_titles_do_not_fail_when_keynote_callouts_are_confirmed(self) -> None:
        page = {
            "page_number": 37,
            "sheet_number": "A6.03",
            "text": (
                "BREAK ROOM C116 1 5 3 2 26 "
                "SHEET KEYNOTES 1. DOOR AS SCHEDULED 2. WALL BASE AS SCHEDULED "
                "3. GYPSUM BOARD FINISH AS SCHEDULED 5. ROOM SIGNAGE 26. EQUIPMENT PROVIDED BY OWNER "
                "RESTROOM C106 1/4\" = 1'-0\" 16 C106 RESTROOM - EAST"
            ),
        }
        result = evaluate_keynote_compliance([page])
        self.assertEqual(result["sheet_reviews"][0]["keynoteCheckStatus"], "Pass")
        self.assertEqual(result["viewport_findings"], [])

    def test_text_extracted_keynote_callouts_after_legend_pass(self) -> None:
        page = {
            "page_number": 40,
            "sheet_number": "A5.01",
            "text": (
                "SHEET KEYNOTES SHEET KEYNOTES "
                "1. 1. 2. 2. 3. 3. 4. 4. 5. 5. 6. 6. 7. 7. "
                "8. 8. 9. 9. 10. 10. 11. 11. 12. 12. "
                "BRICK VENEER WINDOW AS SCHEDULED R-13 BATT INSULATION "
                "SMALL OFFICE 106 SECURITY 110 "
                "1 8 11 11 9 10 10 12 12 6 5 7 2 "
                "1 8 11 11 9 10 10 12 12 5 1 7 3 5 1 2"
            ),
        }
        result = evaluate_keynote_compliance([page])
        self.assertEqual(result["sheet_reviews"][0]["keynoteCheckStatus"], "Pass")

    def test_placeholder_keynote_legend_without_drawing_callouts_fails(self) -> None:
        page = {
            "page_number": 24,
            "sheet_number": "A1.02",
            "text": "SHEET PLAN KEYNOTES SHEET PLAN KEYNOTES 1. 1. 2. 2. SAMPLE SAMPLE SAMPLE",
        }
        result = evaluate_keynote_compliance([page])
        self.assertEqual(result["sheet_reviews"][0]["keynoteCheckStatus"], "Fail")

    def test_sample_only_keynote_legend_is_not_reviewed(self) -> None:
        page = {
            "page_number": 16,
            "sheet_number": "AS1.01",
            "text": "SHEET KEYNOTES\n1.\nSAMPLE\n2.\nSAMPLE\nBUILDING A\n1\" = 30'-0\"\n1\nSITE PLAN",
        }
        result = evaluate_keynote_compliance([page])
        self.assertEqual(result["sheet_reviews"], [])
        self.assertEqual(result["viewport_findings"], [])

    def test_single_view_number_before_keynote_legend_does_not_count_as_callout(self) -> None:
        page = {
            "page_number": 11,
            "sheet_number": "A1.01",
            "text": "1 FLOOR PLAN 1/8\" = 1'-0\" SHEET KEYNOTES 1. WALL 2. DOOR",
        }
        result = evaluate_keynote_compliance([page])
        self.assertEqual(result["sheet_reviews"][0]["keynoteCheckStatus"], "Fail")

    def test_unnumbered_graphic_keynote_symbol_fails_because_number_must_be_inside_symbol(self) -> None:
        findings = detect_viewports_for_page(FIXTURE["viewport_page_with_unnumbered_graphic_keynote_symbol"])
        result = evaluate_keynote_compliance([FIXTURE["viewport_page_with_unnumbered_graphic_keynote_symbol"]])
        self.assertEqual(findings[0]["status"], "Fail")
        self.assertEqual(result["sheet_reviews"][0]["keynoteCheckStatus"], "Fail")
        self.assertIn("no number", result["sheet_reviews"][0]["comment"])

    def test_sheet_with_sheet_keynotes_appears_in_keynote_report(self) -> None:
        result = evaluate_keynote_compliance([FIXTURE["viewport_page_with_keynotes"]])
        self.assertEqual(len(result["sheet_reviews"]), 1)
        self.assertEqual(result["sheet_reviews"][0]["sheetNumber"], "A101")
        self.assertEqual(result["sheet_reviews"][0]["keynoteCheckStatus"], "Fail")

    def test_sheet_without_sheet_keynotes_does_not_appear_in_keynote_report(self) -> None:
        page = FIXTURE["viewport_page_without_sheet_keynotes"]
        findings = detect_viewports_for_page(page)
        review = keynote_review_for_page(page)
        result = evaluate_keynote_compliance([page])
        self.assertEqual(findings, [])
        self.assertIsNone(review)
        self.assertEqual(result["sheet_reviews"], [])
        self.assertEqual(result["viewport_findings"], [])

    def test_negated_sheet_keynotes_phrase_does_not_create_requirement(self) -> None:
        page = {
            "page_number": 6,
            "sheet_number": "A501",
            "text": "5 DETAIL 1\" = 1'-0\" GENERAL DETAIL WITHOUT SHEET KEYNOTES",
        }
        review = keynote_review_for_page(page)
        self.assertIsNone(review)

    def test_sheet_without_sheet_keynotes_may_have_keynote_like_text_without_failure(self) -> None:
        page = FIXTURE["viewport_page_without_sheet_keynotes_with_keynote_like_symbols"]
        result = evaluate_keynote_compliance([page])
        self.assertEqual(result["viewport_findings"], [])
        self.assertEqual(result["sheet_reviews"], [])

    def test_duplicate_keynote_text_on_same_page_fails_sheet_review(self) -> None:
        page = {
            "page_number": 12,
            "sheet_number": "A101",
            "text": "SHEET KEYNOTES 5. Window 10. Window",
            "keynote_symbols": {"present": True, "numbers": ["5"], "count": 1, "confidence": 90},
        }
        result = evaluate_keynote_compliance([page])
        review = result["sheet_reviews"][0]
        self.assertEqual(review["keynoteCheckStatus"], "Fail")
        self.assertIn("Duplicate keynote text", review["comment"])
        self.assertEqual(review["duplicateKeynoteContents"][0]["keynoteNumbers"], ["5", "10"])

    def test_generic_finish_reference_keynote_duplicates_are_allowed(self) -> None:
        page = {
            "page_number": 37,
            "sheet_number": "A6.03",
            "text": (
                "1 2 3 6 20 27 28 "
                "SHEET KEYNOTES 1. DOOR AS SCHEDULED 2. WALL BASE AS SCHEDULED "
                "3. GYPSUM BOARD FINISH AS SCHEDULED 6. WALL CABINETS, REFER FINISHES "
                "20. BASE CABINETS, REFER FINISHES 27. WALL CABINETS, REFER FINISHES "
                "28. BASE CABINETS, REFER FINISHES"
            ),
        }
        result = evaluate_keynote_compliance([page])
        self.assertEqual(result["sheet_reviews"][0]["keynoteCheckStatus"], "Pass")
        self.assertEqual(result["sheet_reviews"][0]["duplicateKeynoteContents"], [])

    def test_duplicate_keynote_text_on_separate_pages_is_allowed(self) -> None:
        pages = [
            {
                "page_number": 12,
                "sheet_number": "A101",
                "text": "SHEET KEYNOTES 5. Window",
                "keynote_symbols": {"present": True, "numbers": ["5"], "count": 1, "confidence": 90},
            },
            {
                "page_number": 13,
                "sheet_number": "A102",
                "text": "SHEET KEYNOTES 10. Window",
                "keynote_symbols": {"present": True, "numbers": ["10"], "count": 1, "confidence": 90},
            },
        ]
        result = evaluate_keynote_compliance(pages)
        self.assertEqual([item["keynoteCheckStatus"] for item in result["sheet_reviews"]], ["Pass", "Pass"])
        self.assertFalse(any(item["duplicateKeynoteContents"] for item in result["sheet_reviews"]))

    def test_cover_page_is_exempt_from_viewport_keynote_requirement(self) -> None:
        findings = detect_viewports_for_page(FIXTURE["viewport_page_without_keynotes"], is_cover=True)
        self.assertEqual(findings, [])
        review = keynote_review_for_page(FIXTURE["viewport_page_without_keynotes"], is_cover=True)
        self.assertIsNone(review)

    def test_non_cover_first_page_with_keynotes_is_still_reviewed(self) -> None:
        page = {
            "page_number": 1,
            "sheet_number": "A1.09",
            "text": "1 2 SHEET KEYNOTES 1. WALL 2. DOOR",
            "keynote_symbols": {"present": True, "numbers": ["1", "2"], "count": 2, "confidence": 82},
        }
        result = evaluate_keynote_compliance([page], cover_page_number=1)
        self.assertEqual(len(result["sheet_reviews"]), 1)
        self.assertTrue(page["hasSheetKeynotes"])

    def test_statistics_only_count_reviewed_sheets(self) -> None:
        keynote = evaluate_keynote_compliance([
            FIXTURE["cover_pages"][0],
            FIXTURE["viewport_page_with_graphic_keynote_symbol"],
            FIXTURE["viewport_page_without_keynotes"],
            FIXTURE["viewport_page_without_sheet_keynotes"],
        ], cover_page_number=1)
        qc = _build_result(keynote)
        self.assertEqual(qc["keynote_statistics"]["reviewed_sheet_count"], 2)
        self.assertEqual(qc["keynote_statistics"]["passed_sheet_count"], 1)
        self.assertEqual(qc["keynote_statistics"]["failed_sheet_count"], 1)
        self.assertEqual(qc["keynote_statistics"]["compliance_percent"], 50.0)

    def test_empty_keynote_report_allowed_when_no_sheets_have_sheet_keynotes(self) -> None:
        keynote = evaluate_keynote_compliance([
            FIXTURE["cover_pages"][0],
            FIXTURE["viewport_page_without_sheet_keynotes"],
        ], cover_page_number=1)
        qc = _build_result(keynote)
        self.assertEqual(qc["sheet_keynote_compliance"], [])
        self.assertEqual(qc["viewport_keynote_compliance"], [])
        self.assertEqual(qc["keynote_statistics"]["reviewed_sheet_count"], 0)
        self.assertIsNone(qc["keynote_statistics"]["compliance_percent"])

    def test_csv_and_pdf_exports_exclude_non_keynote_sheets(self) -> None:
        keynote = evaluate_keynote_compliance([
            FIXTURE["viewport_page_with_graphic_keynote_symbol"],
            FIXTURE["viewport_page_without_sheet_keynotes"],
        ])
        qc = _build_result(keynote)
        csv_text = result_to_csv(qc)
        pdf_bytes = result_to_pdf(qc)
        self.assertIn("A111", csv_text)
        self.assertNotIn("A301", csv_text)
        self.assertNotIn("Not Applicable", csv_text)
        self.assertNotIn(b"A301", pdf_bytes)
        self.assertNotIn(b"Not Applicable", pdf_bytes)

    def test_pdf_export_is_concise_and_explains_missing_and_present_items(self) -> None:
        import fitz

        keynote = evaluate_keynote_compliance([FIXTURE["viewport_page_with_graphic_keynote_symbol"]])
        qc = _build_result(keynote)
        qc["cover_sheet_checklist"]["checklist"] = [
            {"item": "Vicinity map present", "status": "Needs Review", "comments": "Vicinity map was not confidently detected."},
            {"item": "Sheet index present", "status": "Pass", "comments": ""},
        ]
        pdf_bytes = result_to_pdf(qc)
        with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
            text = "\n".join(page.get_text() for page in document)
        self.assertIn("Missing Or Needs Review", text)
        self.assertIn("Confirmed Present / Not Missing", text)
        self.assertIn("Vicinity map was not confidently detected", text)
        self.assertNotIn("Raw Extracted Data", text)

    def test_pdf_export_includes_spell_check_findings(self) -> None:
        import fitz

        qc = _build_result({"viewport_findings": [], "sheet_reviews": []})
        qc["spell_check"] = {
            "status": "Complete",
            "findings": [
                {
                    "sheet": "A1.01",
                    "page": 14,
                    "word": "accomodate",
                    "suggested_correction": "accommodate",
                    "context": "Door clearance shall accomodate required maneuvering.",
                    "status": "Open",
                }
            ],
        }
        pdf_bytes = result_to_pdf(qc)
        with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
            text = "\n".join(page.get_text() for page in document)
        self.assertIn("Spelling", text)
        self.assertIn("accomodate", text)
        self.assertIn("accommodate", text)


class SpellCheckTests(unittest.TestCase):
    def test_spell_check_filters_construction_false_positives(self) -> None:
        self.assertTrue(should_ignore_candidate({"word": "A1.01", "context": "Detail reference A1.01"}))
        self.assertTrue(should_ignore_candidate({"word": "3'-6\"", "context": "Door clearance"}))
        self.assertTrue(should_ignore_candidate({"word": "CMU", "context": "CMU wall"}, {"cmu"}))

    def test_spell_check_uses_extracted_page_text(self) -> None:
        pages = [
            {
                "page_number": 14,
                "sheet_number": "A1.01",
                "text": "Door clearance shall accomodate required maneuvering. Detail A1.01 is 3'-6\" wide.",
            },
            {
                "page_number": 22,
                "sheet_number": "A2.01",
                "text": "Maintain fire seperation at rated wall penetrations.",
            },
            {
                "page_number": 5,
                "sheet_number": "G1.01",
                "text": "Coordinate waterproofng membrane termination with flashing.",
            },
        ]
        result = run_spell_check("fixture", pages=pages, custom_dictionary=["waterproofng"])
        words = {item["word"] for item in result["findings"]}
        self.assertEqual(result["status"], "Complete")
        self.assertIn("accomodate", words)
        self.assertIn("seperation", words)
        self.assertNotIn("waterproofng", words)

    def test_spell_check_keeps_known_typos_in_uppercase_notes(self) -> None:
        pages = [
            {
                "page_number": 3,
                "sheet_number": "A1.02",
                "text": "TEH WINDW CLEARANCE SHALL ACCOMODATE REQUIRED MANEUVERING AT ALL ACCESSIBLE ROUTES.",
            },
        ]
        result = run_spell_check("fixture", pages=pages)
        self.assertEqual([item["word"] for item in result["findings"]], ["TEH", "WINDW", "ACCOMODATE"])

    def test_spell_check_ignores_uppercase_abbreviations(self) -> None:
        pages = [
            {
                "page_number": 4,
                "sheet_number": "A1.03",
                "text": "COORD MANUF EQUIP WITH ARCH AND STRUCT. ACCOMODATE REQUIRED CLEARANCE.",
            },
        ]
        result = run_spell_check("fixture", pages=pages)
        self.assertEqual([item["word"] for item in result["findings"]], ["ACCOMODATE"])

    def test_spell_check_uses_dictionary_engine_when_available(self) -> None:
        pages = [
            {
                "page_number": 7,
                "sheet_number": "A2.10",
                "text": "Seal all penatrations through rated assemblies.",
            },
        ]
        result = run_spell_check("fixture", pages=pages)
        self.assertIn("penatrations", {item["word"] for item in result["findings"]})

    def test_spell_check_ignores_valid_hyphenated_architectural_terms(self) -> None:
        pages = [
            {
                "page_number": 8,
                "sheet_number": "A3.01",
                "text": "Provide T-shaped bracket at fire-rated partition and wall-mounted fixtures.",
            },
        ]
        result = run_spell_check("fixture", pages=pages)
        self.assertEqual(result["findings"], [])

    def test_spell_check_ignores_valid_plural_forms(self) -> None:
        pages = [
            {
                "page_number": 9,
                "sheet_number": "A4.01",
                "text": "WINDOWS, SOFFITS, FASTENERS, ASSEMBLIES, FINISHES, AND PENETRATIONS SHALL BE SEALED.",
            },
        ]
        result = run_spell_check("fixture", pages=pages)
        self.assertEqual(result["findings"], [])

    def test_spell_check_still_flags_known_plural_typos(self) -> None:
        pages = [
            {
                "page_number": 10,
                "sheet_number": "A4.02",
                "text": "Verify all requirments before installation.",
            },
        ]
        result = run_spell_check("fixture", pages=pages)
        self.assertIn("requirments", {item["word"] for item in result["findings"]})

    def test_spell_check_ignores_names_and_title_block_metadata(self) -> None:
        pages = [
            {
                "page_number": 1,
                "sheet_number": "G001",
                "title_block_text": "PROJECT RIO WINDW CENTER\nCLIENT ACME KYNDRYL LLC\nARCHITECT GARCIAA DESIGN GROUP",
                "text": "PROJECT RIO WINDW CENTER CLIENT ACME KYNDRYL LLC ARCHITECT GARCIAA DESIGN GROUP",
            },
            {
                "page_number": 2,
                "sheet_number": "A101",
                "title_block_text": "PROJECT RIO WINDW CENTER\nCLIENT ACME KYNDRYL LLC\nARCHITECT GARCIAA DESIGN GROUP",
                "text": "TEH door clearance shall be verified.",
            },
        ]
        result = run_spell_check("fixture", pages=pages)
        words = {item["word"] for item in result["findings"]}
        self.assertEqual(words, {"TEH"})

    def test_spell_check_ignores_address_contact_and_project_number_context(self) -> None:
        pages = [
            {
                "page_number": 1,
                "sheet_number": "G001",
                "text": (
                    "ADDRESS 1234 KYNDRYL PARKWAY SUITE 200 MCALLEN TX 78501 "
                    "PHONE 956-555-1212 EMAIL permitting@kyndryl-example.com "
                    "WEBSITE www.kyndryl-example.com PERMIT NO TABS2024024161 PROJECT NO RIO-2026-001"
                ),
            },
            {
                "page_number": 2,
                "sheet_number": "A101",
                "text": "Verify all requirments before installation.",
            },
        ]
        result = run_spell_check("fixture", pages=pages)
        words = {item["word"] for item in result["findings"]}
        self.assertEqual(words, {"requirments"})


def _build_result(keynote: dict) -> dict:
    return build_qc_result(
        {"sheet_index": {"entries": []}, "physical_sheets": [], "pages": []},
        {"checklist": [], "issue_label": "", "set_type": "Unknown"},
        {
            "sequence_compliance": {"status": "Pass", "out_of_sequence": []},
            "presence_compliance": {"status": "Pass", "missing_from_pdf": [], "extra_in_pdf": []},
            "missing_page_identification": {"missing_from_pdf": [], "extra_in_pdf": []},
        },
        keynote["viewport_findings"],
        keynote["sheet_reviews"],
    )


if __name__ == "__main__":
    unittest.main()
