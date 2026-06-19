"""
Streaming, single-pass recognizer for the .xc (Explained Code) format, v2.

v2 layout (monolithic code):

    ---
    xc_spec: "2.0"
    language: "python"
    ---

    # [EXPLANATION: <id>]
    lines: <ranges>
    <markdown body>

    # [EXPLANATION: <id2>]
    lines: <ranges>
    <markdown body>

    # [CODE: MONOLITH]
    ```python
    <the entire program, one fenced block>
    ```

Design (unchanged from v1 in spirit):

* The recognizer is line-oriented and *total*: every input line is classified
  by exactly one transition. Markup and code never share a parser — the code
  lives inside a single fenced block and is taken verbatim.
* A single forward scan is O(n); no backtracking.
* Resilient to truncated input: the last fully-closed boundary is tracked so a
  partial stream can be recovered.

The key v2 change: code is ONE monolithic block, and explanation blocks bind to
it by 1-indexed line ranges (`lines: 5-8, 12`) rather than by being physically
interleaved with code. Extraction is therefore trivial and the code is a clean,
compiler-ready program.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Iterator, List, Optional, Tuple

_HEADING_RE = re.compile(
    r"^\#\s*\[\s*(?P<kind>EXPLANATION|CODE)\s*:\s*(?P<id>[^\]]+?)\s*\]\s*$"
)
_FENCE_RE = re.compile(r"^(?P<fence>`{3,}|~{3,})\s*(?P<info>[^`~]*?)\s*$")
_LINES_RE = re.compile(r"^lines:\s*(?P<spec>.+?)\s*$", re.IGNORECASE)
_FRONTMATTER_DELIM = "---"

MONOLITH_ID = "MONOLITH"


class Kind(str, Enum):
    EXPLANATION = "EXPLANATION"
    CODE = "CODE"


Range = Tuple[int, int]  # 1-indexed inclusive [start, end]


def parse_ranges(spec: str) -> List[Range]:
    """Parse a `lines:` spec like ``5-8, 12`` into [(5, 8), (12, 12)]."""
    ranges: List[Range] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            try:
                start, end = int(a), int(b)
            except ValueError:
                continue
            if end < start:
                start, end = end, start
            ranges.append((start, end))
        else:
            try:
                n = int(part)
            except ValueError:
                continue
            ranges.append((n, n))
    return ranges


def format_ranges(ranges: List[Range]) -> str:
    """Inverse of parse_ranges, for serialization."""
    parts = []
    for a, b in ranges:
        parts.append(str(a) if a == b else f"{a}-{b}")
    return ", ".join(parts)


@dataclass
class Explanation:
    block_id: str
    ranges: List[Range] = field(default_factory=list)
    body_lines: List[str] = field(default_factory=list)
    heading_line: int = 0          # 0-based index of the heading line
    lines_line: Optional[int] = None

    @property
    def text(self) -> str:
        return "\n".join(self.body_lines)

    @property
    def start_line(self) -> int:
        return min((r[0] for r in self.ranges), default=0)


@dataclass
class ParseResult:
    frontmatter_text: str = ""
    frontmatter_closed: bool = True
    explanations: List[Explanation] = field(default_factory=list)
    code_lines: List[str] = field(default_factory=list)
    code_present: bool = False
    code_fence_lang: Optional[str] = None
    code_fence_closed: bool = True
    code_heading_line: Optional[int] = None
    errors: List[str] = field(default_factory=list)
    last_valid_line: int = 0
    total_lines: int = 0
    lines: List[str] = field(default_factory=list)

    @property
    def is_valid(self) -> bool:
        return not self.errors

    @property
    def code_line_count(self) -> int:
        return len(self.code_lines)

    def explanation_by_id(self, block_id: str) -> Optional[Explanation]:
        for e in self.explanations:
            if e.block_id == block_id:
                return e
        return None


class _State(Enum):
    START = 0
    FRONTMATTER = 1
    BODY = 2
    EXPL = 3
    CODE_AWAIT_FENCE = 4
    CODE_IN_FENCE = 5


def _normalize(text: str) -> List[str]:
    text = text.lstrip("﻿")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text.split("\n")


def _is_closing_fence(open_token: str, close_token: str, info: str) -> bool:
    if info:
        return False
    if not close_token or close_token[0] != open_token[0]:
        return False
    return len(close_token) >= len(open_token)


def parse(text: str) -> ParseResult:
    lines = _normalize(text)
    result = ParseResult(total_lines=len(lines), lines=lines)

    state = _State.START
    fm_lines: List[str] = []
    current: Optional[Explanation] = None
    lines_seen = False
    fence_token = ""

    def close_current() -> None:
        nonlocal current
        if current is not None:
            # trim trailing blank lines of the prose body
            while current.body_lines and current.body_lines[-1].strip() == "":
                current.body_lines.pop()
            result.explanations.append(current)
            current = None

    for idx, line in enumerate(lines):
        lineno = idx + 1

        if state is _State.START:
            if line.strip() == _FRONTMATTER_DELIM:
                state = _State.FRONTMATTER
                continue
            state = _State.BODY

        if state is _State.FRONTMATTER:
            if line.strip() == _FRONTMATTER_DELIM:
                result.frontmatter_text = "\n".join(fm_lines)
                result.frontmatter_closed = True
                result.last_valid_line = lineno
                state = _State.BODY
            else:
                fm_lines.append(line)
            continue

        if state is _State.CODE_IN_FENCE:
            m = _FENCE_RE.match(line)
            if m and _is_closing_fence(fence_token, m.group("fence"), m.group("info")):
                result.code_fence_closed = True
                result.last_valid_line = lineno
                state = _State.BODY
            else:
                result.code_lines.append(line)
            continue

        heading = _HEADING_RE.match(line)
        if heading:
            close_current()
            kind = Kind(heading.group("kind"))
            block_id = heading.group("id").strip()
            result.last_valid_line = lineno
            if kind is Kind.EXPLANATION:
                current = Explanation(block_id=block_id, heading_line=idx)
                lines_seen = False
                state = _State.EXPL
            else:  # CODE
                result.code_present = True
                result.code_heading_line = idx
                result.code_fence_closed = False
                state = _State.CODE_AWAIT_FENCE
            continue

        if state is _State.CODE_AWAIT_FENCE:
            m = _FENCE_RE.match(line)
            if m:
                fence_token = m.group("fence")
                result.code_fence_lang = (m.group("info") or "").strip() or None
                state = _State.CODE_IN_FENCE
            elif line.strip() == "":
                continue
            else:
                result.errors.append(
                    f"line {lineno}: expected opening fence after '# [CODE: ...]'"
                )
            continue

        if state is _State.EXPL:
            assert current is not None
            if not lines_seen:
                lm = _LINES_RE.match(line)
                if lm:
                    current.ranges = parse_ranges(lm.group("spec"))
                    current.lines_line = idx
                    lines_seen = True
                    continue
                if line.strip() == "":
                    continue
                # Missing lines marker: record and treat the rest as body.
                result.errors.append(
                    f"line {lineno}: EXPLANATION '{current.block_id}' has no "
                    f"'lines:' marker"
                )
                lines_seen = True
                current.body_lines.append(line)
                continue
            current.body_lines.append(line)
            continue

        # BODY: stray prose between blocks is ignored.

    # finalize
    if state is _State.FRONTMATTER:
        result.frontmatter_text = "\n".join(fm_lines)
        result.frontmatter_closed = False
        result.errors.append("frontmatter block was never closed with '---'")
    if state is _State.CODE_IN_FENCE:
        result.code_fence_closed = False
        result.errors.append("code block fence was never closed")
    close_current()

    return result


def iter_code_lines(text: str) -> Iterator[str]:
    """Stream the monolithic code lines (O(n), constant extra state)."""
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
                state = _State.EXPL
            continue
        if state is _State.CODE_AWAIT_FENCE:
            m = _FENCE_RE.match(line)
            if m:
                fence_token = m.group("fence")
                state = _State.CODE_IN_FENCE
            continue
        # EXPL / BODY: skip
