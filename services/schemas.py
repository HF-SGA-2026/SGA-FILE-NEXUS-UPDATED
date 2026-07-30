from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal


QCStatus = Literal["Pass", "Fail", "Needs Review", "Not Applicable"]
SetType = Literal["Official", "Non-Official", "Unknown"]


@dataclass
class Detection:
    status: QCStatus
    confidence: float
    evidence: str = ""
    comments: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SheetEntry:
    sheet_number: str
    sheet_name: str = ""
    page_number: int | None = None
    index_position: int | None = None
    confidence: float = 0
    source: str = "detected"
    missing_sheet_number: bool = False

    def normalized_number(self) -> str:
        return normalize_sheet_number(self.sheet_number)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PageExtraction:
    page_number: int
    text: str
    title_block_text: str
    sheet_number: str = ""
    sheet_name: str = ""
    page_label_text: str = ""
    page_label_sheet_number: str = ""
    page_label_confidence: float = 0
    thumbnail_path: str = ""
    title_block_confidence: float = 0
    detected_keywords: list[str] = field(default_factory=list)
    keynote_symbols: dict[str, Any] = field(default_factory=dict)
    owner_information: dict[str, Any] = field(default_factory=dict)
    cover_visuals: dict[str, Any] = field(default_factory=dict)
    consultant_information: dict[str, Any] = field(default_factory=dict)
    seal_check: dict[str, Any] = field(default_factory=dict)
    visual_scale_marker: dict[str, Any] = field(default_factory=dict)
    visual_title_sheet_number: dict[str, Any] = field(default_factory=dict)
    needs_review: bool = False

    def to_sheet_entry(self) -> SheetEntry:
        return SheetEntry(
            sheet_number=self.sheet_number,
            sheet_name=self.sheet_name,
            page_number=self.page_number,
            confidence=self.title_block_confidence,
            source="title_block",
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ViewportFinding:
    sheet_number: str
    detail_number: str = ""
    view_label: str = ""
    scale: str = ""
    status: QCStatus = "Needs Review"
    failure_reason: str = ""
    confidence: float = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def normalize_sheet_number(value: str | None) -> str:
    if not value:
        return ""
    return "".join(char for char in value.upper() if char.isalnum() or char == ".")
