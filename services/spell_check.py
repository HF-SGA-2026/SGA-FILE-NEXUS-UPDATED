from __future__ import annotations

import re
from collections import Counter
from typing import Any

try:
    from spellchecker import SpellChecker
except ImportError:  # pragma: no cover - exercised when optional dependency is absent
    SpellChecker = None


ARCHITECTURE_DICTIONARY = {
    "soffit",
    "gypsum",
    "millwork",
    "storefront",
    "egress",
    "parapet",
    "cladding",
    "firestopping",
    "waterproofing",
    "flashing",
    "substrate",
    "cmu",
    "eifs",
    "lvl",
    "act",
    "vct",
    "ada",
    "ansi",
    "astm",
    "bldg",
    "clearance",
    "concealed",
    "continuous",
    "coordination",
    "demolition",
    "fastener",
    "fasteners",
    "finish",
    "finishes",
    "firestop",
    "firestopped",
    "framing",
    "glazing",
    "membrane",
    "maneuvering",
    "masonry",
    "penetration",
    "penetrations",
    "rated",
    "required",
    "rough-in",
    "sealant",
    "sheathing",
    "termination",
    "typical",
    "verify",
    "shaped",
    "rated",
    "resistant",
    "mounted",
    "braced",
    "framed",
    "sized",
    "grade",
    "height",
    "width",
}

HYPHEN_COMPOUND_SUFFIXES = {
    "shaped",
    "rated",
    "resistant",
    "mounted",
    "braced",
    "framed",
    "sized",
    "grade",
    "height",
    "width",
}

FIRM_AND_CONSULTANT_TERMS = {
    "sam",
    "garcia",
    "architect",
    "architects",
    "ethos",
    "engineering",
    "consultant",
    "consultants",
    "mcallen",
}


KNOWN_CORRECTIONS = {
    "accomodate": "accommodate",
    "accomodates": "accommodates",
    "accomodated": "accommodated",
    "accomodating": "accommodating",
    "seperation": "separation",
    "seperate": "separate",
    "seperated": "separated",
    "waterproofng": "waterproofing",
    "firestoping": "firestopping",
    "flasing": "flashing",
    "substrat": "substrate",
    "recieve": "receive",
    "recieved": "received",
    "occured": "occurred",
    "occurance": "occurrence",
    "maintainence": "maintenance",
    "clearence": "clearance",
    "accesible": "accessible",
    "acessible": "accessible",
    "commerical": "commercial",
    "construcion": "construction",
    "coordiante": "coordinate",
    "coordinationg": "coordinating",
    "requred": "required",
    "requirment": "requirement",
    "requirments": "requirements",
    "typcial": "typical",
    "typicaly": "typically",
    "teh": "the",
    "windw": "window",
    "widnow": "window",
    "adress": "address",
    "enviroment": "environment",
    "manuevering": "maneuvering",
    "manuvering": "maneuvering",
    "penatration": "penetration",
    "penatrations": "penetrations",
}

WORD_RE = re.compile(r"[A-Za-z][A-Za-z'-]{2,}")
MAX_FINDINGS = 200
STATE_ABBREVIATIONS = {
    "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "ia", "id", "il",
    "in", "ks", "ky", "la", "ma", "md", "me", "mi", "mn", "mo", "ms", "mt", "nc", "nd",
    "ne", "nh", "nj", "nm", "nv", "ny", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn",
    "tx", "ut", "va", "vt", "wa", "wi", "wv", "wy", "dc",
}
TITLE_BLOCK_LABEL_RE = re.compile(
    r"\b(?:ARCHITECT|CONSULTANT|ENGINEER|CLIENT|OWNER|CONTRACTOR|PROJECT|MANUFACTURER|"
    r"COMPANY|ADDRESS|PHONE|EMAIL|WEBSITE|PERMIT|TDLR|REGISTRATION|PROJECT\s+NO|JOB\s+NO|"
    r"ISSUED\s+BY|DRAWN\s+BY|CHECKED\s+BY|CONTACT|CITY|LOCATION)\b",
    re.IGNORECASE,
)
BUSINESS_SUFFIX_RE = re.compile(
    r"\b(?:LLC|INC|CO|CORP|CORPORATION|COMPANY|LTD|LP|LLP|PLLC|PA|ARCHITECTS?|ENGINEERS?|"
    r"ENGINEERING|CONSULTANTS?|CONTRACTORS?|CONSTRUCTION|MANUFACTURING|SYSTEMS|PRODUCTS)\b",
    re.IGNORECASE,
)
ADDRESS_CONTEXT_RE = re.compile(
    r"(?:\b\d{1,6}\s+(?:[A-Za-z0-9'.-]+\s+){0,5}"
    r"(?:STREET|ST|ROAD|RD|AVENUE|AVE|BOULEVARD|BLVD|DRIVE|DR|LANE|LN|COURT|CT|"
    r"CIRCLE|CIR|HIGHWAY|HWY|PARKWAY|PKWY|LOOP|WAY|PLAZA|PLZ)\b)|"
    r"(?:\b(?:SUITE|STE|UNIT|BLDG|BUILDING|ROOM|RM|FLOOR|FL)\.?\s*[A-Z0-9-]+\b)|"
    r"(?:\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b)",
    re.IGNORECASE,
)
CONTACT_CONTEXT_RE = re.compile(
    r"(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})|"
    r"(?:(?:HTTPS?://|WWW\.)\S+)|"
    r"(?:\b(?:PHONE|TEL|FAX|EMAIL|WEB|WEBSITE|WWW)\b)|"
    r"(?:\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4})",
    re.IGNORECASE,
)
PROJECT_NUMBER_CONTEXT_RE = re.compile(
    r"\b(?:PROJECT|PROJ|JOB|PERMIT|TDLR|REGISTRATION|APPLICATION|NO|NUMBER|#)\b"
    r"[^A-Z0-9]{0,8}[A-Z0-9][A-Z0-9.-]{2,}",
    re.IGNORECASE,
)


def run_spell_check(
    file_or_document_id: str,
    *,
    pages: list[dict[str, Any]] | None = None,
    custom_dictionary: list[str] | None = None,
) -> dict[str, Any]:
    """Run a conservative spell check against already-extracted PDF page text.

    This intentionally starts with a high-confidence typo map instead of a broad
    dictionary so construction abbreviations and product codes are not flooded as
    false positives. Connect a production spelling engine here later by replacing
    KNOWN_CORRECTIONS lookup with backend spell suggestions, then keep routing
    every candidate through should_ignore_candidate before display.
    """
    custom_words = {
        item.lower()
        for item in [*ARCHITECTURE_DICTIONARY, *_metadata_dictionary_from_pages(pages or []), *(custom_dictionary or [])]
        if item
    }
    spell_checker = _build_spell_checker(custom_words)
    findings: list[dict[str, Any]] = []
    seen: set[tuple[int, str, str]] = set()

    for page in pages or []:
        text = str(page.get("text") or page.get("title_block_text") or "")
        if not text:
            continue
        page_number = _coerce_page_number(page.get("page_number"))
        sheet = str(page.get("sheet_number") or "").strip() or f"Page {page_number}"
        for match in WORD_RE.finditer(text):
            word = match.group(0)
            normalized = _normalize_word(word)
            if _should_ignore_hyphenated_word(word, custom_words, spell_checker):
                continue
            if _should_ignore_plural_word(word, custom_words, spell_checker):
                continue
            correction = KNOWN_CORRECTIONS.get(normalized)
            source = "known_correction"
            if not correction and spell_checker and _should_dictionary_check(word, normalized, custom_words):
                correction = _spellchecker_suggestion(spell_checker, normalized)
                source = "dictionary"
            if not correction:
                continue
            context = _context_for_match(text, match.start(), match.end())
            finding = {
                "sheet": sheet,
                "page": page_number,
                "word": word,
                "suggested_correction": correction,
                "context": context,
                "status": "Open",
                "source": source,
            }
            dedupe_key = (page_number, word.lower(), context.lower())
            if dedupe_key in seen or should_ignore_candidate(finding, custom_words):
                continue
            seen.add(dedupe_key)
            findings.append(finding)
            if len(findings) >= MAX_FINDINGS:
                break
        if len(findings) >= MAX_FINDINGS:
            break

    return {
        "document_id": file_or_document_id,
        "status": "Complete",
        "findings": findings,
        "spell_engine": "pyspellchecker" if spell_checker else "built-in typo map",
        "limited": len(findings) >= MAX_FINDINGS,
    }


def _build_spell_checker(custom_words: set[str]):
    if SpellChecker is None:
        return None
    checker = SpellChecker(distance=1)
    checker.word_frequency.load_words(
        [
            *ARCHITECTURE_DICTIONARY,
            *FIRM_AND_CONSULTANT_TERMS,
            *custom_words,
        ]
    )
    return checker


def _spellchecker_suggestion(spell_checker: Any, normalized: str) -> str:
    if normalized not in spell_checker.unknown([normalized]):
        return ""
    suggestion = spell_checker.correction(normalized)
    if not suggestion or suggestion == normalized:
        return ""
    return suggestion


def _should_dictionary_check(word: str, normalized: str, custom_words: set[str]) -> bool:
    if len(normalized) < 4:
        return False
    if normalized in custom_words or normalized in FIRM_AND_CONSULTANT_TERMS:
        return False
    if word.isupper() and len(word) <= 3:
        return False
    return True


def _coerce_page_number(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _context_for_match(text: str, start: int, end: int, radius: int = 70) -> str:
    left = max(0, start - radius)
    right = min(len(text), end + radius)
    context = re.sub(r"\s+", " ", text[left:right]).strip()
    if left > 0:
        context = f"...{context}"
    if right < len(text):
        context = f"{context}..."
    return context


def should_ignore_candidate(
    finding: dict[str, Any],
    custom_dictionary: set[str] | None = None,
) -> bool:
    word = str(finding.get("word", "")).strip()
    context = str(finding.get("context", ""))
    dictionary = custom_dictionary or set()
    normalized = _normalize_word(word)
    if not normalized:
        return True
    if normalized in dictionary or normalized in FIRM_AND_CONSULTANT_TERMS:
        return True
    if normalized in STATE_ABBREVIATIONS:
        return True
    if _looks_like_metadata_context(context):
        return True
    if _should_ignore_hyphenated_word(word, dictionary):
        return True
    if finding.get("source") != "known_correction" and _should_ignore_plural_word(word, dictionary):
        return True
    if _looks_like_sheet_number(word) or _looks_like_detail_tag(word):
        return True
    if _looks_like_dimension(word) or _looks_like_address_or_number(word):
        return True
    if finding.get("source") != "known_correction" and (_looks_like_abbreviation(word) or _looks_like_material_code(word)):
        return True
    return False


def _metadata_dictionary_from_pages(pages: list[dict[str, Any]]) -> set[str]:
    title_tokens: Counter[str] = Counter()
    metadata_tokens: set[str] = set()
    for page in pages:
        title_text = str(page.get("title_block_text") or "")
        for token in _dictionary_tokens(title_text):
            title_tokens[token] += 1
        for field in ["project_name", "project_title", "client", "owner", "filename", "sheet_name"]:
            metadata_tokens.update(_dictionary_tokens(str(page.get(field) or "")))
        for line in re.split(r"[\r\n]+", f"{title_text}\n{page.get('text', '')}"):
            if TITLE_BLOCK_LABEL_RE.search(line) or BUSINESS_SUFFIX_RE.search(line) or ADDRESS_CONTEXT_RE.search(line) or CONTACT_CONTEXT_RE.search(line):
                metadata_tokens.update(_dictionary_tokens(line))
    repeated_title_tokens = {token for token, count in title_tokens.items() if count >= 2}
    return metadata_tokens | repeated_title_tokens


def _dictionary_tokens(value: str) -> set[str]:
    tokens: set[str] = set()
    for token in re.findall(r"[A-Za-z][A-Za-z'.-]{2,}", value or ""):
        cleaned = _normalize_word(token)
        if len(cleaned) < 3:
            continue
        if cleaned in KNOWN_CORRECTIONS:
            continue
        tokens.add(cleaned)
        if token.endswith("'s"):
            tokens.add(_normalize_word(token[:-2]))
    return tokens


def _looks_like_metadata_context(context: str) -> bool:
    if not context:
        return False
    return bool(
        CONTACT_CONTEXT_RE.search(context)
        or ADDRESS_CONTEXT_RE.search(context)
        or PROJECT_NUMBER_CONTEXT_RE.search(context)
        or TITLE_BLOCK_LABEL_RE.search(context)
        or BUSINESS_SUFFIX_RE.search(context)
    )


def _normalize_word(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", value).lower()


def _should_ignore_hyphenated_word(word: str, custom_words: set[str], spell_checker: Any | None = None) -> bool:
    if "-" not in word:
        return False
    parts = [part.strip("'").lower() for part in word.split("-") if part.strip("'")]
    if len(parts) < 2:
        return False
    if len(parts[0]) == 1 and parts[1] in HYPHEN_COMPOUND_SUFFIXES:
        return True
    known_words = {*ARCHITECTURE_DICTIONARY, *FIRM_AND_CONSULTANT_TERMS, *custom_words}
    if all(_is_known_hyphen_part(part, known_words, spell_checker) for part in parts):
        return True
    return False


def _should_ignore_plural_word(word: str, custom_words: set[str], spell_checker: Any | None = None) -> bool:
    normalized = _normalize_word(word)
    if normalized in KNOWN_CORRECTIONS:
        return False
    if not normalized.endswith("s") or len(normalized) < 4:
        return False
    known_words = {*ARCHITECTURE_DICTIONARY, *FIRM_AND_CONSULTANT_TERMS, *custom_words}
    return any(_is_known_word(candidate, known_words, spell_checker) for candidate in _singular_candidates(normalized))


def _singular_candidates(value: str) -> list[str]:
    candidates: list[str] = []
    if value.endswith("ies") and len(value) > 4:
        candidates.append(f"{value[:-3]}y")
    if value.endswith(("ches", "shes", "xes", "zes", "ses")) and len(value) > 4:
        candidates.append(value[:-2])
    if value.endswith("s") and not value.endswith("ss"):
        candidates.append(value[:-1])
    return [candidate for candidate in candidates if candidate and candidate != value]


def _is_known_hyphen_part(part: str, known_words: set[str], spell_checker: Any | None = None) -> bool:
    if not part:
        return False
    if len(part) == 1:
        return part.isalpha()
    return _is_known_word(part, known_words, spell_checker)


def _is_known_word(word: str, known_words: set[str], spell_checker: Any | None = None) -> bool:
    if word in known_words:
        return True
    if spell_checker is not None and word not in spell_checker.unknown([word]):
        return True
    return False


def _looks_like_sheet_number(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Z]{1,4}-?\d{1,4}(?:\.\d{1,3})?(?:-\d{1,3})?[A-Z]?", value.strip(), re.IGNORECASE))


def _looks_like_detail_tag(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Z]?\d+(?:\.\d+)?/[A-Z]?\d+(?:\.\d+)?", value.strip(), re.IGNORECASE))


def _looks_like_dimension(value: str) -> bool:
    return bool(re.search(r"(?:\d+['\"])|(?:\d+/\d+)|(?:\d+\s*-\s*\d+)|(?:\d+\s*(?:SF|SQ|FT|IN)\b)", value.strip(), re.IGNORECASE))


def _looks_like_address_or_number(value: str) -> bool:
    return bool(re.fullmatch(r"\d+[A-Z]?|[A-Z]?\d+[A-Z]?", value.strip(), re.IGNORECASE))


def _looks_like_abbreviation(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Z]{2,6}\.?", value.strip()))


def _looks_like_material_code(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Z]{1,5}[-.]?\d{1,5}[A-Z]?", value.strip(), re.IGNORECASE))


def _looks_like_all_caps_note(context: str) -> bool:
    letters = [char for char in context if char.isalpha()]
    if len(letters) < 12:
        return False
    uppercase = sum(1 for char in letters if char.isupper())
    return uppercase / len(letters) > 0.85

