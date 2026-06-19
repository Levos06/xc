"""xc — the Explained Code core library (v2, monolithic code)."""

from .core import (
    EXT_TO_LANG,
    RUNNERS,
    ValidationReport,
    code_hash,
    detect_language,
    extract,
    init,
    init_from_file,
    parse_frontmatter,
    run,
    validate,
)
from .edit import EditResult, update_explanation_block
from .parser import (
    MONOLITH_ID,
    Explanation,
    Kind,
    ParseResult,
    Range,
    format_ranges,
    parse,
    parse_ranges,
)

__all__ = [
    "parse",
    "ParseResult",
    "Explanation",
    "Kind",
    "Range",
    "parse_ranges",
    "format_ranges",
    "MONOLITH_ID",
    "extract",
    "code_hash",
    "init",
    "init_from_file",
    "validate",
    "ValidationReport",
    "run",
    "detect_language",
    "parse_frontmatter",
    "update_explanation_block",
    "EditResult",
    "RUNNERS",
    "EXT_TO_LANG",
]

__version__ = "2.0.0"
