"""Acceptance tests for the xc core (v2 monolithic format)."""

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import xc
from xc import (
    code_hash,
    extract,
    init,
    parse,
    parse_ranges,
    update_explanation_block,
    validate,
)

EXAMPLE = (Path(__file__).resolve().parents[1] / "examples" / "auth.xc").read_text()


# --------------------------------------------------------------------------- #
# parsing
# --------------------------------------------------------------------------- #

def test_parse_explanations_and_monolith():
    r = parse(EXAMPLE)
    assert r.is_valid, r.errors
    assert r.code_present
    assert {e.block_id for e in r.explanations} == {"overview", "exp_invariant"}
    assert r.code_fence_lang == "python"
    assert r.code_fence_closed


def test_line_ranges_parsed():
    r = parse(EXAMPLE)
    inv = r.explanation_by_id("exp_invariant")
    assert inv.ranges == [(4, 7)]
    over = r.explanation_by_id("overview")
    assert over.ranges == [(1, 12)]


def test_parse_ranges_multi():
    assert parse_ranges("5-8, 12") == [(5, 8), (12, 12)]
    assert parse_ranges("3") == [(3, 3)]
    assert parse_ranges("9-7") == [(7, 9)]  # normalized


def test_frontmatter():
    fm = xc.parse_frontmatter(parse(EXAMPLE))
    assert fm["language"] == "python"
    assert fm["module"] == "core.auth"


# --------------------------------------------------------------------------- #
# extract: clean monolithic code
# --------------------------------------------------------------------------- #

def test_extract_is_clean_code():
    code = extract(EXAMPLE)
    assert "EXPLANATION" not in code
    assert "lines:" not in code
    assert "```" not in code
    assert "def verify_session" in code
    compile(code, "<x>", "exec")


def test_extract_line_count_matches_ranges_domain():
    r = parse(EXAMPLE)
    code = extract(EXAMPLE)
    assert code.count("\n") == r.code_line_count


# --------------------------------------------------------------------------- #
# prose edits never touch code
# --------------------------------------------------------------------------- #

def test_explanation_edit_keeps_code_hash():
    before = code_hash(EXAMPLE)
    edited = update_explanation_block(EXAMPLE, "overview", "## Новый текст\nдругое")
    assert edited.code_unchanged
    assert edited.new_code_hash == before
    assert extract(edited.text) == extract(EXAMPLE)


def test_edit_preserves_lines_marker():
    edited = update_explanation_block(EXAMPLE, "exp_invariant", "короткий текст")
    r = parse(edited.text)
    assert r.explanation_by_id("exp_invariant").ranges == [(4, 7)]


# --------------------------------------------------------------------------- #
# validate / resilience
# --------------------------------------------------------------------------- #

def test_validate_good():
    rep = validate(EXAMPLE)
    assert rep.ok, rep.errors


def test_validate_unclosed_fence():
    truncated = EXAMPLE.split("if __name__")[0]
    rep = validate(truncated)
    assert not rep.ok
    assert any("never closed" in e for e in rep.errors)
    assert 0 < rep.recoverable_prefix_line <= rep.total_lines


def test_validate_missing_code():
    rep = validate("---\nlanguage: python\n---\n\n# [EXPLANATION: x]\nlines: 1\nhi\n")
    assert not rep.ok
    assert any("MONOLITH" in e for e in rep.errors)


def test_extract_total_on_truncated():
    out = extract(EXAMPLE[: len(EXAMPLE) // 2])
    assert isinstance(out, str)


# --------------------------------------------------------------------------- #
# init round-trip
# --------------------------------------------------------------------------- #

def test_init_roundtrips():
    raw = "def f(x):\n    return x + 1\n"
    doc = init(raw, language="python", module="m")
    r = parse(doc)
    assert r.is_valid, r.errors
    assert r.code_present
    assert extract(doc).strip() == raw.strip()


def test_init_safe_fence_for_embedded_backticks():
    raw = 'doc = """\n```python\nx=1\n```\n"""\n'
    doc = init(raw, language="python", module="m")
    assert "x=1" in extract(doc)


# --------------------------------------------------------------------------- #
# run via CLI
# --------------------------------------------------------------------------- #

def test_cli_run_executes(tmp_path):
    xc_file = tmp_path / "script.xc"
    xc_file.write_text(init('print("hello from xc")\n', language="python", module="m"))
    cli = Path(__file__).resolve().parents[1]
    proc = subprocess.run(
        [sys.executable, "-m", "xc.cli", "run", str(xc_file)],
        cwd=str(cli), capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert "hello from xc" in proc.stdout
