"""
LLM-as-a-Judge for the Teach-Back cognitive gate.

The judge scores a human's free-text explanation of a piece of code against
the SOLO taxonomy (Structure of Observed Learning Outcomes):

    0 prestructural   — misses the point / irrelevant
    1 unistructural   — names one relevant aspect
    2 multistructural — lists several relevant aspects, unconnected
    3 relational      — connects aspects, explains *why* / invariants / edge cases
    4 extended_abstract — generalizes, transfers, reasons about failure modes

The gate passes when the level reaches a configurable threshold
(default: relational, i.e. the human demonstrably understands the invariants
and edge cases, not just surface syntax).

Determinism: the model is called at T=0.1. If no API key is available, we fall
back to a transparent heuristic so the gate still functions offline (clearly
flagged as such in the result).
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass
from typing import Optional

SOLO_LEVELS = {
    0: "prestructural",
    1: "unistructural",
    2: "multistructural",
    3: "relational",
    4: "extended_abstract",
}

JUDGE_MODEL = os.environ.get("XC_JUDGE_MODEL", "claude-haiku-4-5-20251001")
JUDGE_TEMPERATURE = 0.1

_SYSTEM = """You are a strict but fair code-comprehension examiner. A developer \
has been shown a piece of code (possibly AI-generated) and asked to explain, in \
their own words, what it does, why it is correct, and what its edge cases and \
invariants are. This is a Teach-Back gate that prevents "vibe coding": merging \
code the author does not actually understand.

Score the developer's explanation against the SOLO taxonomy:
0 prestructural: irrelevant or wrong; misses the point.
1 unistructural: identifies a single relevant aspect, superficial.
2 multistructural: lists several correct aspects but does not connect them.
3 relational: connects the aspects, explains WHY the code is correct, names the \
key invariants and at least one real edge case.
4 extended_abstract: also reasons about failure modes, generalization, or \
alternatives.

Be skeptical of fluent but empty answers. If the explanation does not engage \
with the actual logic and edge cases of THIS code, cap the score at 1.

Respond with ONLY a JSON object:
{"level": <int 0-4>, "label": "<solo label>", "passed_reason": "<one sentence>", \
"missing": "<what a higher score would require, one sentence>"}"""


@dataclass
class JudgeVerdict:
    level: int
    label: str
    passed: bool
    threshold: int
    reasoning: str
    missing: str
    backend: str  # "anthropic" | "heuristic"

    def to_dict(self) -> dict:
        return asdict(self)


def _build_user_prompt(code: str, explanation: str, invariants: Optional[str]) -> str:
    inv = f"\n\nStated invariants/requirements for this code:\n{invariants}" if invariants else ""
    return (
        f"CODE UNDER REVIEW:\n```\n{code}\n```{inv}\n\n"
        f"DEVELOPER'S TEACH-BACK EXPLANATION:\n\"\"\"\n{explanation}\n\"\"\"\n\n"
        f"Score it now."
    )


def _judge_anthropic(code: str, explanation: str, invariants: Optional[str]) -> Optional[dict]:
    try:
        import anthropic
    except ImportError:
        return None
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        client = anthropic.Anthropic()
        msg = client.messages.create(
            model=JUDGE_MODEL,
            max_tokens=400,
            temperature=JUDGE_TEMPERATURE,
            system=_SYSTEM,
            messages=[{"role": "user", "content": _build_user_prompt(code, explanation, invariants)}],
        )
        text = "".join(part.text for part in msg.content if getattr(part, "type", "") == "text")
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            return None
        return json.loads(match.group(0))
    except Exception:
        return None


def _judge_heuristic(code: str, explanation: str, invariants: Optional[str]) -> dict:
    """Transparent offline fallback. Rewards explanations that engage with the
    code's own identifiers and with edge-case / invariant reasoning."""
    expl = explanation.strip()
    words = re.findall(r"\w+", expl.lower())
    nwords = len(words)

    # Identifiers actually present in the code.
    idents = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", code))
    mentioned = {w for w in words if w in {i.lower() for i in idents}}

    edge_terms = (
        "edge", "case", "invariant", "boundary", "empty", "none", "null",
        "expire", "expired", "overflow", "negative", "zero", "fail", "error",
        "exception", "граничн", "инвариант", "ошибк", "пуст", "истёк", "истек",
        "почему", "because", "why", "ensure", "guarantee",
    )
    edge_hits = sum(1 for t in edge_terms if t in expl.lower())

    level = 0
    if nwords >= 5 and mentioned:
        level = 1
    if len(mentioned) >= 2 and nwords >= 15:
        level = 2
    if edge_hits >= 1 and len(mentioned) >= 1 and nwords >= 20:
        level = 3
    if edge_hits >= 2 and len(mentioned) >= 2 and nwords >= 40:
        level = 4

    return {
        "level": level,
        "label": SOLO_LEVELS[level],
        "passed_reason": (
            f"heuristic: references {len(mentioned)} code identifier(s), "
            f"{edge_hits} edge/invariant cue(s), {nwords} words"
        ),
        "missing": (
            "engage explicitly with the code's invariants and at least one "
            "concrete edge case, referencing the actual identifiers"
        ),
    }


def judge_explanation(
    code: str,
    explanation: str,
    *,
    invariants: Optional[str] = None,
    threshold: int = 3,
) -> JudgeVerdict:
    """Score `explanation` and decide whether the Teach-Back gate opens."""
    backend = "anthropic"
    raw = _judge_anthropic(code, explanation, invariants)
    if raw is None:
        backend = "heuristic"
        raw = _judge_heuristic(code, explanation, invariants)

    level = int(raw.get("level", 0))
    level = max(0, min(4, level))
    return JudgeVerdict(
        level=level,
        label=raw.get("label", SOLO_LEVELS.get(level, "unknown")),
        passed=level >= threshold,
        threshold=threshold,
        reasoning=raw.get("passed_reason", ""),
        missing=raw.get("missing", ""),
        backend=backend,
    )
