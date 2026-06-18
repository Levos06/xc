"""Acceptance-criteria-driven tests for the xc core."""

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
    update_explanation_block,
    validate,
)

EXAMPLE = (Path(__file__).resolve().parents[1] / "examples" / "auth.xc").read_text()


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #

def test_parse_finds_blocks():
    r = parse(EXAMPLE)
    assert r.is_valid, r.errors
    assert {b.block_id for b in r.blocks} == {"main_logic"}
    code_blocks = r.code_blocks()
    assert len(code_blocks) == 1
    assert code_blocks[0].fence_lang == "python"
    assert code_blocks[0].fence_closed


def test_frontmatter_parsed():
    r = parse(EXAMPLE)
    fm = xc.parse_frontmatter(r)
    assert fm["language"] == "python"
    assert fm["module"] == "core.auth"
    assert fm["always_apply"] is True


# --------------------------------------------------------------------------- #
# extract: pure code only, no markup
# --------------------------------------------------------------------------- #

def test_extract_contains_no_markup():
    code = extract(EXAMPLE)
    assert "EXPLANATION" not in code
    assert "Архитектурный" not in code
    assert "```" not in code
    assert "def verify_session" in code
    assert "import time" in code


def test_extracted_code_is_executable_python():
    code = extract(EXAMPLE)
    compile(code, "<extracted>", "exec")  # must be syntactically valid


# --------------------------------------------------------------------------- #
# AC #2: explanation edits never change the code or its hash
# --------------------------------------------------------------------------- #

def test_explanation_edit_keeps_code_hash_stable():
    before = code_hash(EXAMPLE)
    edited = update_explanation_block(
        EXAMPLE,
        "main_logic",
        "## Полностью переписанное объяснение\n\nДлинный новый текст.\n* пункт\n* ещё пункт",
    )
    assert edited.code_unchanged
    assert edited.old_code_hash == before
    assert edited.new_code_hash == before
    # And the extracted code is byte-identical.
    assert extract(edited.text) == extract(EXAMPLE)


def test_explanation_edit_only_touches_prose_lines():
    edited = update_explanation_block(EXAMPLE, "main_logic", "short")
    # The code block content survives verbatim.
    assert "def verify_session(token_data: dict) -> bool:" in edited.text


# --------------------------------------------------------------------------- #
# AC #3: resilience to truncated LLM streams
# --------------------------------------------------------------------------- #

def test_validate_detects_unclosed_fence():
    truncated = EXAMPLE.split("if __name__")[0]  # cut off mid code block
    report = validate(truncated)
    assert not report.ok
    assert any("never closed" in e for e in report.errors)
    # Recovery point is a real, earlier line.
    assert 0 < report.recoverable_prefix_line <= report.total_lines


def test_validate_detects_unclosed_frontmatter():
    broken = "---\nlanguage: python\n# [EXPLANATION: x]\n"
    report = validate(broken)
    assert not report.ok
    assert any("frontmatter" in e for e in report.errors)


def test_validate_accepts_good_file():
    report = validate(EXAMPLE)
    assert report.ok, report.errors
    assert report.code_block_count == 1


def test_extract_is_total_on_truncated_input():
    # extract must not raise even on a half-streamed file.
    truncated = EXAMPLE[: len(EXAMPLE) // 2]
    out = extract(truncated)  # should not raise
    assert isinstance(out, str)


# --------------------------------------------------------------------------- #
# init round-trip
# --------------------------------------------------------------------------- #

def test_init_roundtrips_code():
    raw = "def f(x):\n    return x + 1\n"
    doc = init(raw, language="python", module="m")
    r = parse(doc)
    assert r.is_valid, r.errors
    assert extract(doc).strip() == raw.strip()


def test_init_picks_safe_fence_for_embedded_backticks():
    raw = 'doc = """\n```python\nx=1\n```\n"""\n'
    doc = init(raw, language="python", module="m")
    r = parse(doc)
    assert r.is_valid, r.errors
    # The embedded fence must not prematurely close the block.
    assert "x=1" in extract(doc)


# --------------------------------------------------------------------------- #
# AC #1: run executes Python through the CLI
# --------------------------------------------------------------------------- #

def test_cli_run_executes(tmp_path):
    xc_file = tmp_path / "script.xc"
    xc_file.write_text(init('print("hello from xc")\n', language="python", module="m"))
    cli = Path(__file__).resolve().parents[1]
    proc = subprocess.run(
        [sys.executable, "-m", "xc.cli", "run", str(xc_file)],
        cwd=str(cli),
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert "hello from xc" in proc.stdout


def test_longer_fence_inside_block():
    # A 4-backtick fence containing a 3-backtick line.
    doc = (
        "# [CODE: x]\n"
        "````python\n"
        "s = '```'\n"
        "````\n"
    )
    assert "s = '```'" in extract(doc)
