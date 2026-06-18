"""xc — the Explained Code core library.

Public, deterministic API used by the CLI and the MCP server.
"""

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
from .parser import Block, Kind, ParseResult, parse

__all__ = [
    "parse",
    "ParseResult",
    "Block",
    "Kind",
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

__version__ = "1.0.0"
