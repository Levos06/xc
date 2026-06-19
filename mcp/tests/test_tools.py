"""Tool-level tests — the way an autonomous agent / LangChain client calls them (v2)."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "core"))

from xc_mcp import (
    explanation_gate,
    extract_code_layer,
    generate_explained_artifact,
    update_explanation_block,
)

CODE = "def f(x):\n    return x + 1\n"


def _artifact():
    return generate_explained_artifact(
        language="python", module="m", code=CODE,
        explanations=[
            {"block_id": "overview", "lines": "1-2", "markdown": "## Plan\nAdds one."},
            {"block_id": "ret", "lines": "2", "markdown": "Returns x+1."},
        ],
    )["xc_content"]


def test_extract_code_layer():
    out = extract_code_layer(_artifact())
    assert out["language"] == "python"
    assert "def f" in out["code"]
    assert "Plan" not in out["code"] and "lines:" not in out["code"]
    assert len(out["code_sha256"]) == 64


def test_generate_requires_explanations():
    with pytest.raises(ValueError):
        generate_explained_artifact(language="python", module="m", code=CODE, explanations=[])


def test_generate_requires_line_range():
    with pytest.raises(ValueError):
        generate_explained_artifact(
            language="python", module="m", code=CODE,
            explanations=[{"block_id": "x", "markdown": "no lines"}],
        )


def test_generate_emits_explanations_before_code():
    doc = _artifact()
    assert doc.index("[EXPLANATION") < doc.index("[CODE: MONOLITH]")
    assert "lines: 1-2" in doc


def test_update_explanation_keeps_code_hash():
    doc = _artifact()
    before = extract_code_layer(doc)["code_sha256"]
    res = update_explanation_block(doc, "overview", "## New\ncompletely new prose")
    assert res["code_unchanged"]
    assert res["new_code_sha256"] == before


def test_explanation_gate_rejects_empty(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    v = explanation_gate(code=CODE, human_explanation="idk it just works")
    assert v["allow_merge"] is False
    assert v["judge_backend"] == "heuristic"


def test_explanation_gate_accepts_good_teachback(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    code = ("import time\n\ndef verify_session(token_data):\n"
            "    if 'exp' not in token_data:\n        return False\n"
            "    return token_data['exp'] > time.time()\n")
    good = (
        "verify_session validates a session token. The key invariant is "
        "fail-closed: if the exp field is missing it returns False rather than "
        "allowing access. The edge case is an expired token, where exp is less "
        "than the current time, which is why we compare token_data exp against "
        "time.time and reject when it is not strictly greater."
    )
    v = explanation_gate(code=code, human_explanation=good)
    assert v["solo_level"] >= 3 and v["allow_merge"] is True
