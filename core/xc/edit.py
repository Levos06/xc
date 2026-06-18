"""
Isolated, line-surgical edits to .xc documents.

The key guarantee (acceptance criterion #2): rewriting an EXPLANATION block
touches *only* the lines that belong to that block. The byte range of every
CODE block — and therefore `extract()`'s output and its hash — is provably
unchanged. We do this by reusing the recognizer's line boundaries instead of
re-serializing the whole document.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import parser
from .core import code_hash, extract
from .parser import Kind


@dataclass
class EditResult:
    text: str
    code_unchanged: bool
    old_code_hash: str
    new_code_hash: str


def _block_span(text: str, block_id: str, kind: Kind) -> tuple[int, int]:
    """Return the [start, end) line indices of a block's *body* (the lines
    after the heading, up to but excluding the next block heading or EOF).

    For an EXPLANATION block this is exactly the prose region — the only thing
    we are allowed to rewrite.
    """
    lines = parser._normalize(text)
    result = parser.parse(text)

    target = None
    for b in result.blocks:
        if b.block_id == block_id and b.kind is kind:
            target = b
            break
    if target is None:
        raise KeyError(f"no {kind.value} block with id '{block_id}'")

    start = target.heading_line + 1  # first body line
    # End = the next block's heading line, or EOF.
    headings = sorted(b.heading_line for b in result.blocks)
    end = len(lines)
    for h in headings:
        if h > target.heading_line:
            end = h
            break
    return start, end


def update_explanation_block(text: str, block_id: str, new_body: str) -> EditResult:
    """Replace the prose body of EXPLANATION block `block_id`.

    Raises KeyError if the block does not exist. Guarantees the extracted code
    hash is unchanged (and asserts it).
    """
    old_hash = code_hash(text)
    lines = parser._normalize(text)
    start, end = _block_span(text, block_id, Kind.EXPLANATION)

    new_lines = new_body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    # Preserve the single blank separator before the next heading if there was
    # one, so we don't glue prose onto the following block heading.
    rebuilt = lines[:start] + new_lines
    # Re-insert a trailing blank line before the next block if the region we
    # replaced had one and the new body doesn't end blank.
    if end < len(lines) and (not new_lines or new_lines[-1].strip() != ""):
        rebuilt.append("")
    rebuilt += lines[end:]

    new_text = "\n".join(rebuilt)
    new_hash = code_hash(new_text)

    return EditResult(
        text=new_text,
        code_unchanged=(old_hash == new_hash),
        old_code_hash=old_hash,
        new_code_hash=new_hash,
    )
