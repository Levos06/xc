"""Tool-level tests — the way an autonomous agent / LangChain client calls them."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "core"))

from xc_mcp import (
    explanation_gate,
    extract_code_layer,
    generate_explained_artifact,
    update_explanation_block,
)


def test_extract_code_layer():
    doc = generate_explained_artifact(
        language="python", module="m",
        explanation_markdown="## Plan\nAdds one.",
        code="def f(x):\n    return x + 1\n",
    )["xc_content"]
    out = extract_code_layer(doc)
    assert out["language"] == "python"
    assert "def f" in out["code"]
    assert "Plan" not in out["code"]
    assert len(out["code_sha256"]) == 64


def test_generate_requires_explanation_first():
    import pytest
    with pytest.raises(ValueError):
        generate_explained_artifact(
            language="python", module="m", explanation_markdown="   ", code="x=1\n"
        )


def test_generate_emits_explanation_before_code():
    doc = generate_explained_artifact(
        language="python", module="m",
        explanation_markdown="## Plan\nValidate token.",
        code="x = 1\n",
        edge_cases=["empty input", "expired token"],
    )["xc_content"]
    assert doc.index("[EXPLANATION") < doc.index("[CODE")
    assert "empty input" in doc


def test_update_explanation_keeps_code_hash():
    doc = generate_explained_artifact(
        language="python", module="m",
        explanation_markdown="## Old\nold prose.",
        code="def f():\n    return 42\n",
    )["xc_content"]
    before = extract_code_layer(doc)["code_sha256"]
    res = update_explanation_block(doc, "main_logic", "## New\ncompletely new prose")
    assert res["code_unchanged"]
    assert res["new_code_sha256"] == before


def test_explanation_gate_rejects_empty(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    verdict = explanation_gate(
        code="def f(x):\n    return x + 1\n",
        human_explanation="idk it just works",
    )
    assert verdict["allow_merge"] is False
    assert verdict["judge_backend"] == "heuristic"


def test_explanation_gate_accepts_good_teachback(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    code = ("import time\n\n"
            "def verify_session(token_data):\n"
            "    if 'exp' not in token_data:\n"
            "        return False\n"
            "    return token_data['exp'] > time.time()\n")
    good = (
        "The verify_session function validates a session token. The key "
        "invariant is fail-closed: if the exp field is missing it returns "
        "False rather than allowing access. The edge case is an expired "
        "token, where exp is less than the current time, which is why we "
        "compare token_data exp against time.time and reject when it is not "
        "strictly greater."
    )
    verdict = explanation_gate(code=code, human_explanation=good)
    assert verdict["solo_level"] >= 3
    assert verdict["allow_merge"] is True
