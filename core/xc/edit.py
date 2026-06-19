"""
Isolated edits to the prose layer of a v2 .xc document.

Rewriting an EXPLANATION's body touches only that block's lines; the monolithic
code block is untouched, so `extract()` and its hash are provably unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from . import parser
from .core import code_hash


@dataclass
class EditResult:
    text: str
    code_unchanged: bool
    old_code_hash: str
    new_code_hash: str


def _split(s: str) -> List[str]:
    return s.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def update_explanation_block(text: str, block_id: str, new_body: str) -> EditResult:
    """Replace the markdown body of EXPLANATION `block_id`, preserving its
    heading and `lines:` marker. Guarantees the code hash is unchanged."""
    old_hash = code_hash(text)
    result = parser.parse(text)
    target = result.explanation_by_id(block_id)
    if target is None:
        raise KeyError(f"no EXPLANATION block with id '{block_id}'")

    lines = list(result.lines)
    # Body starts after the lines: marker (or after heading if absent).
    body_start = (target.lines_line + 1) if target.lines_line is not None \
        else (target.heading_line + 1)
    # Body ends where the recognizer stopped collecting (before the next
    # heading). Recompute from the next block's heading or the code heading.
    headings = [e.heading_line for e in result.explanations]
    if result.code_heading_line is not None:
        headings.append(result.code_heading_line)
    body_end = len(lines)
    for h in sorted(headings):
        if h > target.heading_line:
            body_end = h
            break

    new_lines = _split(new_body)
    rebuilt = lines[:body_start] + new_lines
    if body_end < len(lines) and (not new_lines or new_lines[-1].strip() != ""):
        rebuilt.append("")
    rebuilt += lines[body_end:]

    new_text = "\n".join(rebuilt)
    new_hash = code_hash(new_text)
    return EditResult(
        text=new_text,
        code_unchanged=(old_hash == new_hash),
        old_code_hash=old_hash,
        new_code_hash=new_hash,
    )
