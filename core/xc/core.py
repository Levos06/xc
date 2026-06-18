"""
High-level .xc operations built on the streaming recognizer in `parser.py`.

These are the deterministic, local primitives the CLI and the MCP layer both
call. Nothing here reaches the network or depends on wall-clock state, so the
same input always yields byte-identical output (a hard requirement for the
"no diff noise" / stable-hash acceptance criteria).
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from . import parser
from .parser import Block, Kind, ParseResult

try:
    import yaml  # PyYAML
except ImportError:  # pragma: no cover - yaml is a declared dependency
    yaml = None


# Map of language -> command template used by `run`. {file} is substituted
# with the path to the extracted temp file.
RUNNERS: dict[str, list[str]] = {
    "python": [sys.executable, "{file}"],
    "python3": [sys.executable, "{file}"],
    "javascript": ["node", "{file}"],
    "typescript": ["ts-node", "{file}"],
    "node": ["node", "{file}"],
    "ruby": ["ruby", "{file}"],
    "bash": ["bash", "{file}"],
    "sh": ["sh", "{file}"],
}

# Reasonable default file extension per language for the extracted artifact.
EXTENSIONS: dict[str, str] = {
    "python": ".py",
    "python3": ".py",
    "javascript": ".js",
    "typescript": ".ts",
    "node": ".js",
    "ruby": ".rb",
    "bash": ".sh",
    "sh": ".sh",
    "c": ".c",
    "cpp": ".cpp",
    "go": ".go",
    "rust": ".rs",
}


@dataclass
class ValidationReport:
    ok: bool
    errors: list[str]
    warnings: list[str]
    # 1-based line up to which the file forms a valid prefix (recovery point).
    recoverable_prefix_line: int
    total_lines: int
    block_count: int
    code_block_count: int

    def render(self) -> str:
        lines = []
        status = "VALID" if self.ok else "INVALID"
        lines.append(f"[{status}] {self.block_count} block(s), "
                     f"{self.code_block_count} code block(s), "
                     f"{self.total_lines} line(s)")
        for e in self.errors:
            lines.append(f"  error:   {e}")
        for w in self.warnings:
            lines.append(f"  warning: {w}")
        if not self.ok:
            lines.append(
                f"  recovery: largest valid prefix ends at line "
                f"{self.recoverable_prefix_line}"
            )
        return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Frontmatter
# --------------------------------------------------------------------------- #

def parse_frontmatter(result: ParseResult) -> dict:
    """Parse the YAML frontmatter into a dict. Returns {} if empty."""
    text = result.frontmatter_text.strip()
    if not text:
        return {}
    if yaml is None:
        raise RuntimeError("PyYAML is required to parse frontmatter")
    data = yaml.safe_load(text)
    return data if isinstance(data, dict) else {}


def detect_language(text: str, result: Optional[ParseResult] = None) -> Optional[str]:
    """Resolve the target language: frontmatter `language` wins, otherwise the
    first code fence's info string."""
    result = result or parser.parse(text)
    fm = {}
    try:
        fm = parse_frontmatter(result)
    except Exception:
        pass
    lang = fm.get("language")
    if lang:
        return str(lang).lower()
    for b in result.code_blocks():
        if b.fence_lang:
            return b.fence_lang.lower()
    return None


# --------------------------------------------------------------------------- #
# extract
# --------------------------------------------------------------------------- #

def extract(text: str) -> str:
    """Return the pure executable code, concatenated in document order.

    Streaming O(n). The output depends *only* on the contents of CODE fences,
    so editing any EXPLANATION prose or frontmatter cannot change a single
    byte here — that is what keeps the code hash stable across doc edits.
    """
    code = "\n".join(parser.iter_code_lines(text))
    # Guarantee a single trailing newline iff there is any code at all.
    if code and not code.endswith("\n"):
        code += "\n"
    return code


def code_hash(text: str) -> str:
    """SHA-256 of the extracted code layer. Stable across explanation edits."""
    return hashlib.sha256(extract(text).encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# init
# --------------------------------------------------------------------------- #

# Map source file extensions to a language tag for the code fence.
EXT_TO_LANG: dict[str, str] = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".rb": "ruby",
    ".sh": "bash",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".hpp": "cpp",
    ".go": "go",
    ".rs": "rust",
}


def init(raw_code: str, *, language: str, module: str, block_id: str = "main_logic",
         xc_spec: str = "1.0", always_apply: bool = True) -> str:
    """Encapsulate raw source into the Markdown-First .xc structure.

    The semantic (EXPLANATION) layer is emitted *before* the code (Planning
    Conditioning), with a stub the author/agent is expected to fill in.
    """
    fence = _choose_fence(raw_code)
    body = raw_code.rstrip("\n")

    return (
        "---\n"
        f'xc_spec: "{xc_spec}"\n'
        f'language: "{language}"\n'
        f'module: "{module}"\n'
        f"always_apply: {'true' if always_apply else 'false'}\n"
        "---\n"
        "\n"
        f"# [EXPLANATION: {block_id}]\n"
        "## Архитектурный контекст\n"
        "<!-- TODO: опишите назначение этого слоя. -->\n"
        "\n"
        "## Инварианты\n"
        "* <!-- TODO: перечислите ключевые инварианты и граничные условия. -->\n"
        "\n"
        f"# [CODE: {block_id}]\n"
        f"{fence}{language}\n"
        f"{body}\n"
        f"{fence}\n"
    )


def init_from_file(path: str | os.PathLike, *, module: Optional[str] = None,
                   language: Optional[str] = None, block_id: str = "main_logic") -> str:
    p = Path(path)
    raw = p.read_text(encoding="utf-8")
    lang = language or EXT_TO_LANG.get(p.suffix.lower(), "text")
    mod = module or p.stem
    return init(raw, language=lang, module=mod, block_id=block_id)


def _choose_fence(code: str) -> str:
    """Pick a backtick fence longer than any backtick run inside the code, so
    embedded code fences (e.g. markdown samples) cannot prematurely close it."""
    longest = 0
    run = 0
    for ch in code:
        if ch == "`":
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    return "`" * max(3, longest + 1)


# --------------------------------------------------------------------------- #
# validate
# --------------------------------------------------------------------------- #

def validate(text: str) -> ValidationReport:
    """Structural + YAML validation, resilient to truncated LLM streams."""
    result = parser.parse(text)
    errors = list(result.errors)
    warnings: list[str] = []

    # YAML check.
    if result.frontmatter_text.strip():
        if yaml is None:
            warnings.append("PyYAML not installed; skipped frontmatter validation")
        else:
            try:
                data = yaml.safe_load(result.frontmatter_text)
                if data is not None and not isinstance(data, dict):
                    errors.append("frontmatter is not a YAML mapping")
            except yaml.YAMLError as e:  # type: ignore[union-attr]
                errors.append(f"invalid YAML frontmatter: {e}")
    else:
        warnings.append("no YAML frontmatter found")

    # Pairing sanity: every CODE id should have an EXPLANATION (Planning
    # Conditioning encourages explanation-before-code, but we only warn).
    expl_ids = {b.block_id for b in result.blocks if b.kind is Kind.EXPLANATION}
    seen_code: set[str] = set()
    for b in result.blocks:
        if b.kind is Kind.CODE:
            seen_code.add(b.block_id)
            if b.block_id not in expl_ids:
                warnings.append(
                    f"code block '{b.block_id}' has no matching EXPLANATION block"
                )
    if not seen_code:
        warnings.append("file contains no CODE blocks")

    return ValidationReport(
        ok=not errors,
        errors=errors,
        warnings=warnings,
        recoverable_prefix_line=result.last_valid_line,
        total_lines=result.total_lines,
        block_count=len(result.blocks),
        code_block_count=len(result.code_blocks()),
    )


# --------------------------------------------------------------------------- #
# run
# --------------------------------------------------------------------------- #

def run(text: str, *, extra_args: Optional[list[str]] = None,
        cwd: Optional[str] = None) -> int:
    """Extract code and execute it via the runner for its language.

    Returns the child process exit code. Raises ValueError for unknown
    languages or unrunnable input.
    """
    result = parser.parse(text)
    lang = detect_language(text, result)
    if lang is None:
        raise ValueError("could not determine language (no frontmatter "
                         "`language` and no fenced language tag)")
    if lang not in RUNNERS:
        raise ValueError(f"no runner configured for language '{lang}'. "
                         f"Known: {', '.join(sorted(RUNNERS))}")

    code = extract(text)
    if not code.strip():
        raise ValueError("no executable code found in .xc file")

    import tempfile

    suffix = EXTENSIONS.get(lang, ".txt")
    with tempfile.NamedTemporaryFile(
        "w", suffix=suffix, delete=False, encoding="utf-8"
    ) as tf:
        tf.write(code)
        tmp_path = tf.name

    try:
        cmd = [part.replace("{file}", tmp_path) for part in RUNNERS[lang]]
        if extra_args:
            cmd += extra_args
        proc = subprocess.run(cmd, cwd=cwd)
        return proc.returncode
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
