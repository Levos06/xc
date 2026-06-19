"""
High-level .xc operations (v2 monolithic format) built on the streaming
recognizer in `parser.py`.

Deterministic and local: the same input always yields byte-identical output, so
the extracted code hash is stable across any prose edit.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from . import parser
from .parser import MONOLITH_ID, Explanation, ParseResult, format_ranges

try:
    import yaml  # PyYAML
except ImportError:  # pragma: no cover
    yaml = None


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

EXTENSIONS: dict[str, str] = {
    "python": ".py", "python3": ".py", "javascript": ".js", "typescript": ".ts",
    "node": ".js", "ruby": ".rb", "bash": ".sh", "sh": ".sh",
    "c": ".c", "cpp": ".cpp", "go": ".go", "rust": ".rs",
}

EXT_TO_LANG: dict[str, str] = {
    ".py": "python", ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".rb": "ruby", ".sh": "bash",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
    ".go": "go", ".rs": "rust",
}


@dataclass
class ValidationReport:
    ok: bool
    errors: List[str]
    warnings: List[str]
    recoverable_prefix_line: int
    total_lines: int
    explanation_count: int
    code_line_count: int

    def render(self) -> str:
        status = "VALID" if self.ok else "INVALID"
        out = [
            f"[{status}] {self.explanation_count} explanation block(s), "
            f"{self.code_line_count} code line(s), {self.total_lines} line(s)"
        ]
        for e in self.errors:
            out.append(f"  error:   {e}")
        for w in self.warnings:
            out.append(f"  warning: {w}")
        if not self.ok:
            out.append(f"  recovery: largest valid prefix ends at line "
                       f"{self.recoverable_prefix_line}")
        return "\n".join(out)


# --------------------------------------------------------------------------- #
# frontmatter / language
# --------------------------------------------------------------------------- #

def parse_frontmatter(result: ParseResult) -> dict:
    text = result.frontmatter_text.strip()
    if not text:
        return {}
    if yaml is None:
        raise RuntimeError("PyYAML is required to parse frontmatter")
    data = yaml.safe_load(text)
    return data if isinstance(data, dict) else {}


def detect_language(text: str, result: Optional[ParseResult] = None) -> Optional[str]:
    result = result or parser.parse(text)
    try:
        lang = parse_frontmatter(result).get("language")
    except Exception:
        lang = None
    if lang:
        return str(lang).lower()
    if result.code_fence_lang:
        return result.code_fence_lang.lower()
    return None


# --------------------------------------------------------------------------- #
# extract
# --------------------------------------------------------------------------- #

def extract(text: str) -> str:
    """Return the pure monolithic code. Streaming O(n); depends only on the
    MONOLITH fence contents, so prose edits cannot change it."""
    code = "\n".join(parser.iter_code_lines(text))
    if code and not code.endswith("\n"):
        code += "\n"
    return code


def code_hash(text: str) -> str:
    return hashlib.sha256(extract(text).encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# init
# --------------------------------------------------------------------------- #

def _choose_fence(code: str) -> str:
    longest = 0
    run = 0
    for ch in code:
        if ch == "`":
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    return "`" * max(3, longest + 1)


def init(raw_code: str, *, language: str, module: str,
         xc_spec: str = "2.0") -> str:
    """Encapsulate raw source into a v2 .xc: a stub explanation covering the
    whole file, followed by the monolithic code block."""
    body = raw_code.rstrip("\n")
    n = len(body.split("\n")) if body else 0
    fence = _choose_fence(raw_code)
    return (
        "---\n"
        f'xc_spec: "{xc_spec}"\n'
        f'language: "{language}"\n'
        f'module: "{module}"\n'
        "---\n"
        "\n"
        "# [EXPLANATION: overview]\n"
        f"lines: 1-{max(1, n)}\n"
        "## Обзор\n"
        "<!-- TODO: опишите назначение модуля и ключевые инварианты. -->\n"
        "\n"
        f"# [CODE: {MONOLITH_ID}]\n"
        f"{fence}{language}\n"
        f"{body}\n"
        f"{fence}\n"
    )


def init_from_file(path: str | os.PathLike, *, module: Optional[str] = None,
                   language: Optional[str] = None) -> str:
    p = Path(path)
    raw = p.read_text(encoding="utf-8")
    lang = language or EXT_TO_LANG.get(p.suffix.lower(), "text")
    return init(raw, language=lang, module=module or p.stem)


# --------------------------------------------------------------------------- #
# validate
# --------------------------------------------------------------------------- #

def validate(text: str) -> ValidationReport:
    result = parser.parse(text)
    errors = list(result.errors)
    warnings: List[str] = []

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

    if not result.code_present:
        errors.append("no '# [CODE: MONOLITH]' block found")
    n = result.code_line_count
    for e in result.explanations:
        if not e.ranges:
            warnings.append(f"explanation '{e.block_id}' has no line range")
        for (a, b) in e.ranges:
            if a < 1 or (n and b > n):
                warnings.append(
                    f"explanation '{e.block_id}' range {a}-{b} is outside the "
                    f"code (1-{n})"
                )

    return ValidationReport(
        ok=not errors,
        errors=errors,
        warnings=warnings,
        recoverable_prefix_line=result.last_valid_line,
        total_lines=result.total_lines,
        explanation_count=len(result.explanations),
        code_line_count=n,
    )


# --------------------------------------------------------------------------- #
# run
# --------------------------------------------------------------------------- #

def run(text: str, *, extra_args: Optional[list[str]] = None,
        cwd: Optional[str] = None) -> int:
    result = parser.parse(text)
    lang = detect_language(text, result)
    if lang is None:
        raise ValueError("could not determine language")
    if lang not in RUNNERS:
        raise ValueError(f"no runner for language '{lang}'. "
                         f"Known: {', '.join(sorted(RUNNERS))}")
    code = extract(text)
    if not code.strip():
        raise ValueError("no executable code found in .xc file")

    import tempfile
    suffix = EXTENSIONS.get(lang, ".txt")
    with tempfile.NamedTemporaryFile("w", suffix=suffix, delete=False,
                                     encoding="utf-8") as tf:
        tf.write(code)
        tmp_path = tf.name
    try:
        cmd = [part.replace("{file}", tmp_path) for part in RUNNERS[lang]]
        if extra_args:
            cmd += extra_args
        return subprocess.run(cmd, cwd=cwd).returncode
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
