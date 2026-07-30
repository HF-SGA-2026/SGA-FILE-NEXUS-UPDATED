from __future__ import annotations


QA_KEYWORDS = ["SCALE", "KEYNOTES"]

DRAWING_TYPE_KEYWORDS = {
    "Architectural": ["ARCHITECTURAL", "FLOOR PLAN", "REFLECTED CEILING", "ELEVATION"],
    "Civil": ["CIVIL", "SITE PLAN", "GRADING", "DRAINAGE"],
    "Structural": ["STRUCTURAL", "FOUNDATION", "FRAMING"],
    "Mechanical": ["MECHANICAL", "HVAC", "DUCT"],
    "Electrical": ["ELECTRICAL", "POWER PLAN", "LIGHTING"],
    "Plumbing": ["PLUMBING", "PIPING", "SANITARY"],
    "Fire Protection": ["FIRE PROTECTION", "SPRINKLER"],
}


def detect_keywords(text: str, keywords: list[str] | None = None) -> list[str]:
    upper_text = text.upper()
    required_keywords = keywords or QA_KEYWORDS
    return [keyword for keyword in required_keywords if keyword in upper_text]


def detect_drawing_type(text: str, fallback_name: str = "") -> str:
    searchable_text = f"{fallback_name}\n{text}".upper()

    for drawing_type, keywords in DRAWING_TYPE_KEYWORDS.items():
        if any(keyword in searchable_text for keyword in keywords):
            return drawing_type

    return "Unknown"
