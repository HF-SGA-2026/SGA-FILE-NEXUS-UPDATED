from __future__ import annotations

import re
from typing import Any


_SEAL_TEXT_CUE_RE = re.compile(
    r"\b("
    r"seal|sealed|registered|registration|license|licensed|"
    r"professional|architectural\s+examiners|engineer|"
    r"state\s+of|texas\s+board|not\s+for\s+regulatory"
    r")\b",
    re.IGNORECASE,
)

_LOGO_OR_CALLOUT_TEXT_RE = re.compile(
    r"\b("
    r"sam\s+garcia\s+architect|info@samgarciaarchitect|"
    r"know\s+what'?s\s+below|call\s+before\s+you|811|"
    r"city\s+of\s+edinburg|edinburg\s+engineering\s+department|"
    r"preliminary(?!\s+and\s+final)|subject\s+to\s+revision|not\s+for\s+construction|"
    r"not\s+for\s+regulatory|not\s+for\s+permitting|"
    r"issued\s+for\s+review|progress\s+set|95%\s*cd\s+set"
    r")\b",
    re.IGNORECASE,
)

_STRONG_SEAL_TEXT_CUE_RE = re.compile(
    r"\b("
    r"registered|licensed|license|state\s+of\s+texas|"
    r"texas\s+board|architectural\s+examiners|"
    r"professional\s+(?:engineer|architect)|"
    r"firm\s+registration|structural\s+engineers|consulting\s+structural"
    r")\b",
    re.IGNORECASE,
)

_NON_SEAL_ISSUE_MARKER_RE = re.compile(
    r"\b("
    r"preliminary(?!\s+and\s+final)|subject\s+to\s+revision|not\s+for\s+construction|"
    r"not\s+for\s+regulatory|not\s+for\s+permitting|"
    r"issued\s+for\s+review|progress\s+set|95%\s*cd\s+set"
    r")\b",
    re.IGNORECASE,
)

_PRELIMINARY_STAMP_RE = re.compile(
    r"\bPRELIMINARY\b(?!\s+AND\s+FINAL)|\bSUBJECT\s+TO\s+REVISION\b",
    re.IGNORECASE,
)


def detect_professional_seal(page: Any) -> dict:
    try:
        width = float(page.rect.width)
        height = float(page.rect.height)
        images = page.get_image_info(xrefs=True) or []
    except Exception:
        return {"present": False, "confidence": 0, "evidence": ""}

    issue_marker_detected = _has_non_seal_issue_marker(page, width, height)
    candidates = []
    for image in images:
        try:
            x0, y0, x1, y1 = map(float, image.get("bbox")[:4])
            image_width = float(image.get("width") or 0)
            image_height = float(image.get("height") or 0)
        except (TypeError, ValueError):
            continue
        box_width = x1 - x0
        box_height = y1 - y0
        aspect = box_width / max(box_height, 1)
        if (
            x0 >= width * 0.70
            and y0 >= height * 0.45
            and 0.72 <= aspect <= 1.38
            and width * 0.018 <= box_width <= width * 0.10
            and height * 0.018 <= box_height <= height * 0.11
            and image_width >= 700
            and image_height >= 700
        ):
            nearby_text = _nearby_text(page, (x0, y0, x1, y1), width, height)
            if _looks_like_non_seal_logo(nearby_text):
                continue
            if _has_seal_text_cues(nearby_text):
                candidates.append((image, box_width * box_height))

    if not candidates:
        stamp_box_result = _detect_stamp_box_seal(page, width, height)
        evidence = str(stamp_box_result.get("evidence", ""))
        has_progress_stamp = _has_progress_stamp_marker(page, width, height)
        has_preliminary_stamp = _has_preliminary_marker(page, width, height)
        if stamp_box_result.get("present") and (
            not issue_marker_detected
            or (not has_progress_stamp and not has_preliminary_stamp)
            or (not has_progress_stamp and has_preliminary_stamp and _has_permit_context(page))
            or (
                "black signed" in evidence.lower()
                and not has_progress_stamp
                and (not has_preliminary_stamp or _has_permit_context(page))
            )
        ):
            return {
                "present": True,
                "confidence": 88,
                "evidence": stamp_box_result["evidence"],
                "comments": "",
            }
        if stamp_box_result.get("partial") and not issue_marker_detected:
            return {
                "present": False,
                "partial": True,
                "confidence": 78,
                "evidence": stamp_box_result["evidence"],
                "comments": "Only a partial seal mark was detected in the right-side stamp box.",
            }
        vector_evidence = _detect_vector_seal(page, width, height)
        if vector_evidence and (
            not issue_marker_detected or _has_strong_seal_text_cues(_right_column_text(page, width, height))
        ):
            return {
                "present": True,
                "confidence": 86,
                "evidence": vector_evidence,
                "comments": "",
            }
        if issue_marker_detected:
            return {
                "present": False,
                "confidence": 90,
                "evidence": "",
                "comments": "Non-official/preliminary issue marker detected; unsigned title-block graphics were not counted as a seal.",
            }
        return {
            "present": False,
            "confidence": 84,
            "evidence": "",
            "comments": "No professional seal was detected on the right side of the sheet.",
        }

    image, _ = max(candidates, key=lambda item: item[1])
    bbox = image.get("bbox")
    return {
        "present": True,
        "confidence": 92,
        "evidence": f"Right-side seal image at ({round(float(bbox[0]))}, {round(float(bbox[1]))})",
        "comments": "",
    }


def _detect_stamp_box_seal(page: Any, width: float, height: float) -> dict:
    stamp_masks = _stamp_box_pixel_masks(page, width, height, (0.88, 0.48, 0.99, 0.76))
    if not stamp_masks:
        return {}
    blue_count = int(stamp_masks["blue"].sum())
    dark_count = int(stamp_masks["dark"].sum())

    if blue_count >= 500 and dark_count >= 6000:
        return {"present": True, "evidence": "Right-side signed seal in title-block stamp box"}

    if _has_sparse_round_stamp_component(stamp_masks["dark"]):
        return {"present": True, "evidence": "Right-side stamped seal in title-block stamp box"}

    tall_masks = _stamp_box_pixel_masks(page, width, height, (0.84, 0.35, 0.99, 0.76))
    if tall_masks and _has_sparse_round_stamp_component(tall_masks["dark"]):
        return {"present": True, "evidence": "Right-side stamped seal in title-block stamp box"}

    broad_evidence = _detect_broad_right_title_column_seal(page, width, height)
    if broad_evidence:
        return {"present": True, "evidence": broad_evidence}
    lower_evidence = _detect_lower_title_block_light_stamp(page, width, height)
    if lower_evidence:
        return {"present": True, "evidence": lower_evidence}
    lower_signed_evidence = _detect_lower_right_signed_engineering_seal(page, width, height)
    if lower_signed_evidence:
        return {"present": True, "evidence": lower_signed_evidence}

    if blue_count >= 100 and dark_count >= 2000:
        return {"partial": True, "evidence": "Partial seal/signature mark in title-block stamp box"}

    return {}


def _stamp_box_pixel_masks(
    page: Any,
    width: float,
    height: float,
    region: tuple[float, float, float, float],
    *,
    scale: float = 1.0,
    dark_threshold: int = 135,
) -> dict[str, Any]:
    try:
        import fitz
        import numpy as np

        left, top, right, bottom = region
        clip = fitz.Rect(width * left, height * top, width * right, height * bottom)
        pixmap = page.get_pixmap(
            matrix=fitz.Matrix(scale, scale),
            clip=clip,
            colorspace=fitz.csRGB,
            alpha=False,
        )
        pixels = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, 3)
    except Exception:
        return {}

    red = pixels[:, :, 0].astype(int)
    green = pixels[:, :, 1].astype(int)
    blue = pixels[:, :, 2].astype(int)
    return {
        "blue": (blue > 140) & (blue > red + 45) & (blue > green + 25),
        "dark": (red < dark_threshold) & (green < dark_threshold) & (blue < dark_threshold),
    }


def _detect_lower_right_signed_engineering_seal(page: Any, width: float, height: float) -> str:
    masks = _stamp_box_pixel_masks(
        page,
        width,
        height,
        (0.70, 0.45, 1.0, 0.95),
        scale=0.5,
        dark_threshold=170,
    )
    if not masks:
        return ""
    blue_count = int(masks["blue"].sum())
    dark_count = int(masks["dark"].sum())
    if blue_count >= 500 and dark_count >= 8000:
        return "Right-side signed seal in lower title block"
    return ""


def _detect_broad_right_title_column_seal(page: Any, width: float, height: float) -> str:
    right_column_text = _right_column_text(page, width, height)
    title_column_text = _right_title_column_text(page, width, height)
    try:
        import fitz
        import numpy as np

        scale = 0.5
        clip = fitz.Rect(width * 0.52, height * 0.10, width, height * 0.95)
        pixmap = page.get_pixmap(
            matrix=fitz.Matrix(scale, scale),
            clip=clip,
            colorspace=fitz.csRGB,
            alpha=False,
        )
        pixels = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, 3)
    except Exception:
        return ""

    red = pixels[:, :, 0].astype(int)
    green = pixels[:, :, 1].astype(int)
    blue = pixels[:, :, 2].astype(int)
    dark = (red < 170) & (green < 170) & (blue < 170)
    blue_signature = (blue > 140) & (blue > red + 45) & (blue > green + 25)
    has_strong_context = _has_strong_seal_text_cues(title_column_text)
    has_stamp_context = _has_official_stamp_context(page, width, height)
    has_black_signed_stamp = _has_black_signed_stamp(page, dark, width, height, scale, 0.52, 0.10)
    if (
        _looks_like_non_seal_logo(right_column_text)
        and not _has_strong_seal_text_cues(right_column_text)
        and not _has_non_seal_issue_marker(page, width, height)
        and not has_stamp_context
        and not has_black_signed_stamp
    ):
        return ""
    if _has_broad_signed_stamp(dark, blue_signature):
        return "Right-side signed seal in title-block column"
    if (has_strong_context or has_stamp_context) and has_black_signed_stamp:
        return "Right-side black signed seal in title-block column"
    if not _has_non_seal_issue_marker(page, width, height) and has_black_signed_stamp:
        return "Right-side monochrome signed seal in title-block column"
    if _has_broad_round_stamp_component(page, dark, width, height, scale, 0.52, 0.10):
        return "Right-side stamped seal in title-block column"
    return ""


def _detect_lower_title_block_light_stamp(page: Any, width: float, height: float) -> str:
    try:
        import fitz
        import numpy as np

        scale = 0.75
        clip = fitz.Rect(width * 0.78, height * 0.48, width * 0.98, height * 0.82)
        pixmap = page.get_pixmap(
            matrix=fitz.Matrix(scale, scale),
            clip=clip,
            colorspace=fitz.csGRAY,
            alpha=False,
        )
        pixels = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width)
        mask = pixels < 200
        seen = np.zeros(mask.shape, dtype=bool)
        starts = zip(*np.where(mask))
    except Exception:
        return ""

    height_px, width_px = mask.shape
    for start_y, start_x in starts:
        if seen[start_y, start_x]:
            continue
        stack = [(int(start_y), int(start_x))]
        seen[start_y, start_x] = True
        min_x = max_x = int(start_x)
        min_y = max_y = int(start_y)
        pixel_count = 0
        while stack:
            y, x = stack.pop()
            pixel_count += 1
            min_x, max_x = min(min_x, x), max(max_x, x)
            min_y, max_y = min(min_y, y), max(max_y, y)
            for delta_y in (-1, 0, 1):
                for delta_x in (-1, 0, 1):
                    if delta_y == 0 and delta_x == 0:
                        continue
                    neighbor_y = y + delta_y
                    neighbor_x = x + delta_x
                    if (
                        0 <= neighbor_y < height_px
                        and 0 <= neighbor_x < width_px
                        and mask[neighbor_y, neighbor_x]
                        and not seen[neighbor_y, neighbor_x]
                    ):
                        seen[neighbor_y, neighbor_x] = True
                        stack.append((neighbor_y, neighbor_x))
        box_width = max_x - min_x + 1
        box_height = max_y - min_y + 1
        density = pixel_count / max(box_width * box_height, 1)
        if (
            900 <= pixel_count <= 2500
            and 90 <= box_width <= 170
            and 55 <= box_height <= 130
            and 0.07 <= density <= 0.20
            and min_x >= width_px * 0.55
            and min_y <= height_px * 0.60
        ):
            return "Right-side light stamped seal in title block"
    return ""


def _integral_mask(mask: Any) -> Any:
    import numpy as np

    return np.pad(mask.astype(np.int32).cumsum(0).cumsum(1), ((1, 0), (1, 0)))


def _integral_sum(integral: Any, x0: int, y0: int, x1: int, y1: int) -> int:
    height = integral.shape[0] - 1
    width = integral.shape[1] - 1
    x0 = max(0, min(width, x0))
    y0 = max(0, min(height, y0))
    x1 = max(0, min(width, x1))
    y1 = max(0, min(height, y1))
    if x1 <= x0 or y1 <= y0:
        return 0
    return int(integral[y1, x1] - integral[y0, x1] - integral[y1, x0] + integral[y0, x0])


def _has_broad_signed_stamp(dark: Any, blue_signature: Any) -> bool:
    dark_integral = _integral_mask(dark)
    blue_integral = _integral_mask(blue_signature)
    height, width = dark.shape
    for size in (60, 72, 84, 96, 112, 128, 144):
        for y in range(0, max(height - size, 1), 8):
            for x in range(0, max(width - size, 1), 8):
                if x > width * 0.45 and y + size > height * 0.70:
                    continue
                outer = _integral_sum(dark_integral, x, y, x + size, y + size)
                if not 1500 <= outer <= 4500:
                    continue
                density = outer / max(size * size, 1)
                if not 0.035 <= density <= 0.45:
                    continue
                inner = _integral_sum(
                    dark_integral,
                    x + size // 4,
                    y + size // 4,
                    x + size * 3 // 4,
                    y + size * 3 // 4,
                )
                ring = outer - inner
                blue_near = _integral_sum(
                    blue_integral,
                    x - size // 3,
                    y,
                    x + size + size // 3,
                    y + size + size // 2,
                )
                if ring >= 900 and blue_near >= 250:
                    return True
    return False


def _has_black_signed_stamp(
    page: Any,
    dark: Any,
    page_width: float,
    page_height: float,
    scale: float,
    region_left: float,
    region_top: float,
) -> bool:
    dark_integral = _integral_mask(dark)
    height, width = dark.shape
    for size in (36, 44, 52, 60, 68, 76, 84, 96):
        for y in range(0, max(height - size, 1), 6):
            for x in range(0, max(width - size, 1), 6):
                if x < width * 0.35:
                    continue
                if y + size > height * 0.88:
                    continue
                outer = _integral_sum(dark_integral, x, y, x + size, y + size)
                density = outer / max(size * size, 1)
                if not 0.045 <= density <= 0.24:
                    continue
                inner = _integral_sum(
                    dark_integral,
                    x + size // 4,
                    y + size // 4,
                    x + size * 3 // 4,
                    y + size * 3 // 4,
                )
                ring = outer - inner
                lower_band = _integral_sum(
                    dark_integral,
                    x - size // 3,
                    y + size // 2,
                    x + size + size // 2,
                    y + size + size // 2,
                )
                if ring >= max(120, int(size * size * 0.035)) and lower_band >= max(160, int(size * size * 0.045)):
                    candidate_center_y = page_height * region_top + (y + size / 2) / scale
                    if candidate_center_y > page_height * 0.76:
                        continue
                    seal_square = dark[max(0, y) : min(height, y + size), max(0, x) : min(width, x + size)]
                    if _circular_ring_coverage(seal_square) < 18:
                        continue
                    candidate_mask = dark[
                        max(0, y) : min(height, y + size + size // 2),
                        max(0, x - size // 3) : min(width, x + size + size // 2),
                    ]
                    if _largest_component_ratio(candidate_mask) > 0.55:
                        continue
                    page_box = (
                        page_width * region_left + x / scale,
                        page_height * region_top + y / scale,
                        page_width * region_left + (x + size) / scale,
                        page_height * region_top + (y + size + size // 2) / scale,
                    )
                    nearby_text = _tight_nearby_text(page, page_box, page_width, page_height)
                    if _looks_like_non_seal_logo(nearby_text) and not _has_strong_seal_text_cues(nearby_text):
                        continue
                    return True
    return False


def _largest_component_ratio(mask: Any) -> float:
    try:
        import numpy as np

        if mask.size == 0:
            return 0.0
        total = int(mask.sum())
        if total <= 0:
            return 0.0
        seen = np.zeros(mask.shape, dtype=bool)
        height, width = mask.shape
        largest = 0
        for start_y, start_x in zip(*np.where(mask)):
            if seen[start_y, start_x]:
                continue
            stack = [(int(start_y), int(start_x))]
            seen[start_y, start_x] = True
            count = 0
            while stack:
                y, x = stack.pop()
                count += 1
                for delta_y in (-1, 0, 1):
                    for delta_x in (-1, 0, 1):
                        if delta_y == 0 and delta_x == 0:
                            continue
                        neighbor_y = y + delta_y
                        neighbor_x = x + delta_x
                        if (
                            0 <= neighbor_y < height
                            and 0 <= neighbor_x < width
                            and mask[neighbor_y, neighbor_x]
                            and not seen[neighbor_y, neighbor_x]
                        ):
                            seen[neighbor_y, neighbor_x] = True
                            stack.append((neighbor_y, neighbor_x))
            largest = max(largest, count)
        return largest / max(total, 1)
    except Exception:
        return 0.0


def _circular_ring_coverage(mask: Any) -> int:
    try:
        import math
        import numpy as np

        if mask.size == 0:
            return 0
        height, width = mask.shape
        center_x = (width - 1) / 2
        center_y = (height - 1) / 2
        radius = min(width, height) / 2
        bins: set[int] = set()
        for y, x in zip(*np.where(mask)):
            dx = float(x) - center_x
            dy = float(y) - center_y
            distance = (dx * dx + dy * dy) ** 0.5
            if not radius * 0.42 <= distance <= radius * 0.88:
                continue
            angle = (math.atan2(dy, dx) + math.pi) / (2 * math.pi)
            bins.add(int(angle * 32) % 32)
        return len(bins)
    except Exception:
        return 0


def _has_broad_round_stamp_component(
    page: Any,
    mask: Any,
    page_width: float,
    page_height: float,
    scale: float,
    region_left: float,
    region_top: float,
) -> bool:
    try:
        import numpy as np

        seen = np.zeros(mask.shape, dtype=bool)
        height, width = mask.shape
        starts = zip(*np.where(mask))
    except Exception:
        return False

    for start_y, start_x in starts:
        if seen[start_y, start_x]:
            continue
        stack = [(int(start_y), int(start_x))]
        seen[start_y, start_x] = True
        min_x = max_x = int(start_x)
        min_y = max_y = int(start_y)
        pixel_count = 0
        while stack:
            y, x = stack.pop()
            pixel_count += 1
            min_x, max_x = min(min_x, x), max(max_x, x)
            min_y, max_y = min(min_y, y), max(max_y, y)
            for delta_y in (-1, 0, 1):
                for delta_x in (-1, 0, 1):
                    if delta_y == 0 and delta_x == 0:
                        continue
                    neighbor_y = y + delta_y
                    neighbor_x = x + delta_x
                    if (
                        0 <= neighbor_y < height
                        and 0 <= neighbor_x < width
                        and mask[neighbor_y, neighbor_x]
                        and not seen[neighbor_y, neighbor_x]
                    ):
                        seen[neighbor_y, neighbor_x] = True
                        stack.append((neighbor_y, neighbor_x))
        box_width = max_x - min_x + 1
        box_height = max_y - min_y + 1
        aspect = box_width / max(box_height, 1)
        density = pixel_count / max(box_width * box_height, 1)
        if not (
            100 <= pixel_count <= 1800
            and 30 <= box_width <= 120
            and 30 <= box_height <= 120
            and 0.55 <= aspect <= 1.80
            and 0.06 <= density <= 0.35
            and max_y < height * 0.70
            and (density <= 0.23 or max_y < height * 0.45)
        ):
            continue
        page_box = (
            page_width * region_left + min_x / scale,
            page_height * region_top + min_y / scale,
            page_width * region_left + max_x / scale,
            page_height * region_top + max_y / scale,
        )
        if _looks_like_non_seal_logo(_nearby_text(page, page_box, page_width, page_height)):
            continue
        return True
    return False


def _has_sparse_round_stamp_component(mask: Any) -> bool:
    try:
        import numpy as np

        seen = np.zeros(mask.shape, dtype=bool)
        height, width = mask.shape
        starts = zip(*np.where(mask))
    except Exception:
        return False

    for start_y, start_x in starts:
        if seen[start_y, start_x]:
            continue
        stack = [(int(start_y), int(start_x))]
        seen[start_y, start_x] = True
        min_x = max_x = int(start_x)
        min_y = max_y = int(start_y)
        pixel_count = 0
        while stack:
            y, x = stack.pop()
            pixel_count += 1
            min_x, max_x = min(min_x, x), max(max_x, x)
            min_y, max_y = min(min_y, y), max(max_y, y)
            for delta_y, delta_x in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                neighbor_y = y + delta_y
                neighbor_x = x + delta_x
                if (
                    0 <= neighbor_y < height
                    and 0 <= neighbor_x < width
                    and mask[neighbor_y, neighbor_x]
                    and not seen[neighbor_y, neighbor_x]
                ):
                    seen[neighbor_y, neighbor_x] = True
                    stack.append((neighbor_y, neighbor_x))
        box_width = max_x - min_x + 1
        box_height = max_y - min_y + 1
        density = pixel_count / max(box_width * box_height, 1)
        touches_box_edge = min_y <= 2 or max_y >= height - 3 or min_x <= 2 or max_x >= width - 3
        if (
            80 <= box_width <= 240
            and 70 <= box_height <= 340
            and 0.01 <= density <= 0.10
            and not touches_box_edge
        ):
            return True
    return False


def _detect_vector_seal(page: Any, width: float, height: float) -> str:
    try:
        import fitz
        import numpy as np

        scale = 0.5
        clip = fitz.Rect(width * 0.68, height * 0.35, width, height * 0.92)
        pixmap = page.get_pixmap(
            matrix=fitz.Matrix(scale, scale),
            clip=clip,
            colorspace=fitz.csGRAY,
            alpha=False,
        )
        pixels = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width)
    except Exception:
        return ""

    mask = pixels < 120
    seen = np.zeros(mask.shape, dtype=bool)
    for start_y, start_x in zip(*np.where(mask)):
        if seen[start_y, start_x]:
            continue
        stack = [(int(start_y), int(start_x))]
        seen[start_y, start_x] = True
        min_x = max_x = int(start_x)
        min_y = max_y = int(start_y)
        pixel_count = 0
        while stack:
            y, x = stack.pop()
            pixel_count += 1
            min_x, max_x = min(min_x, x), max(max_x, x)
            min_y, max_y = min(min_y, y), max(max_y, y)
            for delta_y in (-1, 0, 1):
                for delta_x in (-1, 0, 1):
                    neighbor_y = y + delta_y
                    neighbor_x = x + delta_x
                    if (
                        0 <= neighbor_y < mask.shape[0]
                        and 0 <= neighbor_x < mask.shape[1]
                        and mask[neighbor_y, neighbor_x]
                        and not seen[neighbor_y, neighbor_x]
                    ):
                        seen[neighbor_y, neighbor_x] = True
                        stack.append((neighbor_y, neighbor_x))
        box_width = max_x - min_x + 1
        box_height = max_y - min_y + 1
        aspect = box_width / max(box_height, 1)
        density = pixel_count / max(box_width * box_height, 1)
        if (
            pixel_count >= 250
            and 30 <= box_width <= 140
            and 30 <= box_height <= 140
            and 0.65 <= aspect <= 1.45
            and 0.12 <= density <= 0.62
        ):
            page_x = round(width * 0.68 + min_x / scale)
            page_y = round(height * 0.35 + min_y / scale)
            page_box = (
                width * 0.68 + min_x / scale,
                height * 0.35 + min_y / scale,
                width * 0.68 + max_x / scale,
                height * 0.35 + max_y / scale,
            )
            nearby_text = _nearby_text(page, page_box, width, height)
            if _looks_like_non_seal_logo(nearby_text):
                continue
            if not _has_strong_seal_text_cues(nearby_text):
                continue
            return f"Right-side vector seal at ({page_x}, {page_y})"
    return ""


def _nearby_text(page: Any, bbox: tuple[float, float, float, float], width: float, height: float) -> str:
    x0, y0, x1, y1 = bbox
    left = max(width * 0.62, x0 - width * 0.08)
    top = max(0, y0 - height * 0.08)
    right = min(width, x1 + width * 0.10)
    bottom = min(height, y1 + height * 0.12)
    try:
        words = page.get_text("words") or []
    except Exception:
        return ""
    values = [
        str(word[4])
        for word in words
        if len(word) >= 5
        and left <= float(word[0]) <= right
        and top <= float(word[1]) <= bottom
    ]
    return " ".join(values)


def _tight_nearby_text(page: Any, bbox: tuple[float, float, float, float], width: float, height: float) -> str:
    x0, y0, x1, y1 = bbox
    left = max(width * 0.62, x0 - width * 0.025)
    top = max(0, y0 - height * 0.025)
    right = min(width, x1 + width * 0.04)
    bottom = min(height, y1 + height * 0.04)
    try:
        words = page.get_text("words") or []
    except Exception:
        return ""
    values = [
        str(word[4])
        for word in words
        if len(word) >= 5
        and left <= float(word[0]) <= right
        and top <= float(word[1]) <= bottom
    ]
    return " ".join(values)


def _has_non_seal_issue_marker(page: Any, width: float, height: float) -> bool:
    return _has_non_seal_issue_marker_text(_issue_marker_text(page, width, height))


def _has_non_seal_issue_marker_text(text: str) -> bool:
    for match in _NON_SEAL_ISSUE_MARKER_RE.finditer(text or ""):
        if _is_preliminary_cleaning_note(text, match):
            continue
        return True
    return False


def _is_preliminary_cleaning_note(text: str, match: re.Match) -> bool:
    if match.group(0).lower() != "preliminary":
        return False
    nearby = text[max(0, match.start() - 80) : match.end() + 220]
    return bool(
        re.search(
            r"\bFINAL\s+CLEANING(?:S)?\b|"
            r"\bCLEANING\s+PRIOR\s+TO\s+OCCUPANCY\b|"
            r"\bOCCUPANCY\b[\s\S]{0,180}\b(?:CARPETS|WIPING\s+DOWN|CLEANING\s+WINDOW)\b",
            nearby,
            re.IGNORECASE,
        )
    )


def _issue_marker_text(page: Any, width: float, height: float) -> str:
    try:
        import fitz

        right_column = page.get_text(
            "text",
            clip=fitz.Rect(width * 0.64, height * 0.0, width, height),
        ) or ""
    except Exception:
        right_column = ""
    try:
        page_text = page.get_text("text") or ""
    except Exception:
        page_text = ""
    return f"{right_column}\n{page_text}"


def _has_preliminary_marker(page: Any, width: float, height: float) -> bool:
    try:
        import fitz

        text = page.get_text(
            "text",
            clip=fitz.Rect(width * 0.64, height * 0.35, width, height * 0.90),
        ) or ""
    except Exception:
        try:
            text = page.get_text("text") or ""
        except Exception:
            text = ""
    for match in _PRELIMINARY_STAMP_RE.finditer(str(text)):
        if _is_preliminary_cleaning_note(str(text), match):
            continue
        return True
    return False


def _has_progress_stamp_marker(page: Any, width: float, height: float) -> bool:
    try:
        import fitz

        right_column = page.get_text(
            "text",
            clip=fitz.Rect(width * 0.64, height * 0.35, width, height * 0.82),
        ) or ""
    except Exception:
        right_column = ""
    try:
        page_text = page.get_text("text") or ""
    except Exception:
        page_text = ""
    text = f"{right_column}\n{page_text}"
    return bool(re.search(r"\bPROGRESS\s+DRAWING\b|\bNOT\s+FOR\s+CONSTRUCTION\b", text, re.IGNORECASE))


def _has_official_stamp_context(page: Any, width: float, height: float) -> bool:
    try:
        import fitz

        text = page.get_text(
            "text",
            clip=fitz.Rect(width * 0.64, height * 0.35, width, height * 0.90),
        ) or ""
    except Exception:
        text = ""
    try:
        page_text = page.get_text("text") or ""
    except Exception:
        page_text = ""
    text = f"{text}\n{page_text}"
    return bool(re.search(r"\bISSUED\s+FOR\s+(?:PERMIT|CONSTRUCTION)\b|\bPERMIT\s+SET\b|\bCONSTRUCTION\s+SET\b", str(text), re.IGNORECASE))


def _has_permit_context(page: Any) -> bool:
    try:
        text = page.get_text("text") or ""
    except Exception:
        return False
    return bool(re.search(r"\bPERMIT\b|\bAPPLICATION\s+NUMBER\b", str(text), re.IGNORECASE))


def _right_column_text(page: Any, width: float, height: float) -> str:
    try:
        import fitz

        right_column = page.get_text(
            "text",
            clip=fitz.Rect(width * 0.64, height * 0.0, width, height),
        ) or ""
        page_text = page.get_text("text") or ""
    except Exception:
        return ""
    return f"{right_column}\n{page_text[-2500:]}"


def _right_title_column_text(page: Any, width: float, height: float) -> str:
    try:
        import fitz

        return page.get_text(
            "text",
            clip=fitz.Rect(width * 0.78, height * 0.30, width, height),
        ) or ""
    except Exception:
        return ""


def _has_seal_text_cues(text: str) -> bool:
    return bool(_SEAL_TEXT_CUE_RE.search(text or ""))


def _has_strong_seal_text_cues(text: str) -> bool:
    return bool(_STRONG_SEAL_TEXT_CUE_RE.search(text or ""))


def _looks_like_non_seal_logo(text: str) -> bool:
    return bool(_LOGO_OR_CALLOUT_TEXT_RE.search(text or ""))
