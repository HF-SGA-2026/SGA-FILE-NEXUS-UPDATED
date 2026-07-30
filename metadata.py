from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import re


@dataclass
class FileMetadata:
    path: str
    filename: str
    file_size: int
    file_type: str
    sheet_number: str = ""
    sheet_title: str = ""
    detected_keywords: list[str] | None = None
    drawing_type: str = "Unknown"

    def to_dict(self) -> dict:
        data = asdict(self)
        data["file_size_mb"] = round(self.file_size / (1024 * 1024), 2)
        data["detected_keywords"] = ", ".join(self.detected_keywords or [])
        return data


def file_type_from_path(path: Path) -> str:
    return path.suffix.lower().lstrip(".").upper() or "UNKNOWN"


def sheet_number_from_filename(path: Path) -> str:
    match = re.search(r"\b([A-Z]{0,3}\d{2,4}(?:\.\d+)?)\b", path.stem.upper())
    return match.group(1) if match else ""


def sheet_title_from_filename(path: Path, sheet_number: str = "") -> str:
    title = path.stem
    if sheet_number:
        title = re.sub(re.escape(sheet_number), "", title, flags=re.IGNORECASE)

    title = re.sub(r"[_\-]+", " ", title).strip()
    return re.sub(r"\s+", " ", title)


def summarize_project(records: list[FileMetadata], oversized_mb: int) -> dict:
    oversized_bytes = oversized_mb * 1024 * 1024
    duplicate_sheet_names = find_duplicate_sheet_names(records)

    return {
        "total_files": len(records),
        "oversized_files": [record for record in records if record.file_size > oversized_bytes],
        "duplicate_sheet_names": duplicate_sheet_names,
        "missing_sheet_sequences": find_missing_sheet_sequences(records),
        "detected_drawing_types": sorted({record.drawing_type for record in records if record.drawing_type != "Unknown"}),
    }


def find_duplicate_sheet_names(records: list[FileMetadata]) -> list[str]:
    counts: dict[str, int] = {}

    for record in records:
        sheet_name = (record.sheet_title or Path(record.filename).stem).strip().upper()
        if sheet_name:
            counts[sheet_name] = counts.get(sheet_name, 0) + 1

    return sorted(sheet_name for sheet_name, count in counts.items() if count > 1)


def find_missing_sheet_sequences(records: list[FileMetadata]) -> list[str]:
    groups: dict[str, set[int]] = {}
    widths: dict[str, int] = {}

    for record in records:
        match = re.match(r"^([A-Z]+)(\d+)$", record.sheet_number.upper())
        if not match:
            continue

        prefix, number_text = match.groups()
        groups.setdefault(prefix, set()).add(int(number_text))
        widths[prefix] = max(widths.get(prefix, 0), len(number_text))

    missing: list[str] = []
    for prefix, numbers in groups.items():
        if len(numbers) < 2:
            continue

        width = widths[prefix]
        for number in range(min(numbers), max(numbers) + 1):
            if number not in numbers:
                missing.append(f"{prefix}{number:0{width}d}")

    return sorted(missing)
