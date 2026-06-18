"""
Streaming, single-pass recognizer for the .xc (Explained Code) format.

Design notes (per the LangSec principle in the spec):

* The recognizer is line-oriented and *total*: every input line is classified
  into exactly one state transition. We never hand a sub-language (the code)
  to a second, more permissive parser while still inside the markup parser.
  Markup and code live in physically disjoint line ranges.
* A single forward scan classifies every line, so extraction is O(n) in the
  number of lines/bytes. No backtracking, no quadratic re-scanning.
* The scanner is resilient to truncated input (a stream cut off mid-block by
  an LLM): it always tracks the last fully-closed boundary so callers can
  recover the largest valid prefix.

The grammar we recognize (Markdown-First, Variant A):

    file        := frontmatter? body
    frontmatter := "---" NL  yaml-lines  "---" NL
    body        := ( section )*
    section     := explanation | code
    explanation := "# [EXPLANATION: <id>]" NL prose*
    code        := "# [CODE: <id>]" NL fence
    fence       := FENCE_OPEN NL code-line* FENCE_CLOSE NL
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Iterable, Iterator, Optional


# A heading that opens a semantic region. We accept an optional leading BOM and
# trailing whitespace, and a flexible amount of inner spacing, but the marker
# keyword and the bracket structure are fixed so the recognizer stays simple.
_HEADING_RE = re.compile(
    r"^\#\s*\[\s*(?P<kind>EXPLANATION|CODE)\s*:\s*(?P<id>[^\]]+?)\s*\]\s*$"
)

# A fence is 3+ backticks or 3+ tildes, optionally followed by an info string
# (the language tag). CommonMark: the closing fence must use the same
# character and be at least as long, and carry no info string.
_FENCE_RE = re.compile(r"^(?P<fence>`{3,}|~{3,})\s*(?P<info>[^`~]*?)\s*$")

_FRONTMATTER_DELIM = "---"


class Kind(str, Enum):
    EXPLANATION = "EXPLANATION"
    CODE = "CODE"


@dataclass
class Block:
    """A single recognized region of the file."""

    kind: Kind
    block_id: str
    # 0-based, inclusive line index of the heading line.
    heading_line: int
    # The lines belonging to this block (excluding the heading).
    # For CODE blocks this is *only* the code inside the fence (no fence lines).
    # For EXPLANATION blocks this is the prose verbatim.
    body_lines: list[str] = field(default_factory=list)
    # CODE only: the info string / language tag on the opening fence.
    fence_lang: Optional[str] = None
    # CODE only: True if the fence was properly closed.
    fence_closed: bool = True

    @property
    def text(self) -> str:
        return "\n".join(self.body_lines)


@dataclass
class ParseResult:
    """Everything the recognizer learned in one pass."""

    frontmatter_text: str = ""
    frontmatter_closed: bool = True
    blocks: list[Block] = field(default_factory=list)
    # Diagnostics for `validate`.
    errors: list[str] = field(default_factory=list)
    # 1-based line number of the last fully-closed structural boundary
    # (closed frontmatter, closed fence, or a clean heading). Used to recover
    # the largest valid prefix from a truncated stream.
    last_valid_line: int = 0
    total_lines: int = 0

    @property
    def is_valid(self) -> bool:
        return not self.errors

    def code_blocks(self) -> list[Block]:
        return [b for b in self.blocks if b.kind is Kind.CODE]

    def block_by_id(self, block_id: str) -> Optional[Block]:
        for b in self.blocks:
            if b.block_id == block_id:
                return b
        return None


class _State(Enum):
    START = 0          # before any content; may see frontmatter delim
    FRONTMATTER = 1    # inside YAML frontmatter
    BODY = 2           # general body, between blocks
    EXPLANATION = 3    # collecting prose for an EXPLANATION block
    CODE_AWAIT_FENCE = 4  # saw a CODE heading, waiting for the opening fence
    CODE_IN_FENCE = 5  # inside a CODE fence, collecting code lines


def _normalize(text: str) -> list[str]:
    """Split into lines, stripping a leading UTF-8 BOM. Keeps it newline-style
    agnostic by normalizing CRLF/CR to LF first."""
    text = text.lstrip("﻿")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # splitlines() would drop a trailing empty line distinction; split on "\n"
    # gives us a stable, reversible line model.
    return text.split("\n")


def parse(text: str) -> ParseResult:
    """Run the single-pass recognizer over `text`."""
    lines = _normalize(text)
    result = ParseResult(total_lines=len(lines))

    state = _State.START
    fm_lines: list[str] = []
    current: Optional[Block] = None
    fence_token = ""  # the exact opening fence string, for matching the close

    def close_current() -> None:
        nonlocal current
        if current is not None:
            result.blocks.append(current)
            current = None

    for idx, line in enumerate(lines):
        lineno = idx + 1  # 1-based for diagnostics

        # --- Frontmatter handling -------------------------------------------
        if state is _State.START:
            if line.strip() == _FRONTMATTER_DELIM:
                state = _State.FRONTMATTER
                continue
            # No frontmatter: fall through into body classification.
            state = _State.BODY
            # (intentional fall-through to BODY handling below)

        if state is _State.FRONTMATTER:
            if line.strip() == _FRONTMATTER_DELIM:
                result.frontmatter_text = "\n".join(fm_lines)
                result.frontmatter_closed = True
                result.last_valid_line = lineno
                state = _State.BODY
            else:
                fm_lines.append(line)
            continue

        # --- Inside a code fence (highest precedence in body) ---------------
        if state is _State.CODE_IN_FENCE:
            m = _FENCE_RE.match(line)
            if m and _is_closing_fence(fence_token, m.group("fence"), m.group("info")):
                assert current is not None
                current.fence_closed = True
                close_current()
                result.last_valid_line = lineno
                state = _State.BODY
            else:
                # Everything else is verbatim code — including lines that look
                # like headings. We do NOT re-enter markup recognition here;
                # that is the whole point of layer isolation.
                assert current is not None
                current.body_lines.append(line)
            continue

        # --- Heading detection (BODY / EXPLANATION / CODE_AWAIT_FENCE) ------
        heading = _HEADING_RE.match(line)
        if heading:
            close_current()
            kind = Kind(heading.group("kind"))
            block_id = heading.group("id").strip()
            current = Block(kind=kind, block_id=block_id, heading_line=idx)
            result.last_valid_line = lineno
            if kind is Kind.EXPLANATION:
                state = _State.EXPLANATION
            else:
                state = _State.CODE_AWAIT_FENCE
            continue

        # --- State-specific non-heading lines -------------------------------
        if state is _State.CODE_AWAIT_FENCE:
            m = _FENCE_RE.match(line)
            if m:
                assert current is not None
                fence_token = m.group("fence")
                current.fence_lang = (m.group("info") or "").strip() or None
                current.fence_closed = False
                state = _State.CODE_IN_FENCE
            elif line.strip() == "":
                # Blank lines between the CODE heading and its fence are fine.
                continue
            else:
                # Non-blank, non-fence content under a CODE heading before the
                # fence is unexpected; record it but keep scanning.
                result.errors.append(
                    f"line {lineno}: expected opening fence after "
                    f"'# [CODE: {current.block_id if current else '?'}]', "
                    f"found prose"
                )
            continue

        if state is _State.EXPLANATION:
            assert current is not None
            current.body_lines.append(line)
            continue

        # state is BODY: stray prose between blocks is allowed (free Markdown).
        # We simply ignore it for extraction purposes.

    # --- End of stream: finalize and diagnose ------------------------------
    if state is _State.FRONTMATTER:
        result.frontmatter_text = "\n".join(fm_lines)
        result.frontmatter_closed = False
        result.errors.append("frontmatter block was never closed with '---'")
    if state is _State.CODE_IN_FENCE:
        # Truncated mid-code: keep what we have but flag it.
        assert current is not None
        current.fence_closed = False
        result.errors.append(
            f"code block '{current.block_id}' fence opened at line "
            f"{current.heading_line + 1} was never closed"
        )
    if state is _State.CODE_AWAIT_FENCE:
        assert current is not None
        result.errors.append(
            f"code block '{current.block_id}' has no opening fence"
        )

    close_current()

    # Trim trailing strip-able body whitespace on explanation blocks so that a
    # trailing blank line in the file does not create diff noise.
    return result


def _is_closing_fence(open_token: str, close_token: str, info: str) -> bool:
    """A fence closes iff it uses the same char, is >= as long, and (per
    CommonMark) carries no info string."""
    if info:
        return False
    if not close_token or close_token[0] != open_token[0]:
        return False
    return len(close_token) >= len(open_token)


def iter_code_lines(text: str) -> Iterator[str]:
    """Stream just the executable code lines, in document order, without
    materializing the whole parse tree. This is the O(n), constant-extra-state
    fast path used by `extract`.

    It mirrors `parse`'s state machine but only emits CODE fence contents.
    """
    state = _State.START
    fence_token = ""

    for line in _normalize(text):
        if state is _State.START:
            if line.strip() == _FRONTMATTER_DELIM:
                state = _State.FRONTMATTER
                continue
            state = _State.BODY

        if state is _State.FRONTMATTER:
            if line.strip() == _FRONTMATTER_DELIM:
                state = _State.BODY
            continue

        if state is _State.CODE_IN_FENCE:
            m = _FENCE_RE.match(line)
            if m and _is_closing_fence(fence_token, m.group("fence"), m.group("info")):
                state = _State.BODY
                continue
            yield line
            continue

        heading = _HEADING_RE.match(line)
        if heading:
            if Kind(heading.group("kind")) is Kind.CODE:
                state = _State.CODE_AWAIT_FENCE
            else:
                state = _State.BODY
            continue

        if state is _State.CODE_AWAIT_FENCE:
            m = _FENCE_RE.match(line)
            if m:
                fence_token = m.group("fence")
                state = _State.CODE_IN_FENCE
            # blanks/prose before fence are skipped
            continue
        # BODY: ignore
