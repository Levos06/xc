"""
Demonstrates AC #4: the MCP tools are importable and callable by an
autonomous agent. Two paths are shown:

  1. Direct import (works today, no extra deps) — the same callables the MCP
     server wraps. This is what a LangChain `StructuredTool.from_function`
     would bind to.
  2. Over the MCP stdio transport via langchain-mcp-adapters (optional).

Run:  python examples/langchain_client.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "core"))

from xc_mcp import (
    explanation_gate,
    extract_code_layer,
    generate_explained_artifact,
)


def demo_direct():
    print("== generate_explained_artifact (plan-first) ==")
    art = generate_explained_artifact(
        language="python",
        module="core.auth",
        code=(
            "import time\n\n"
            "def verify_session(t):\n"
            "    if 'exp' not in t:\n"
            "        return False\n"
            "    return t['exp'] > time.time()\n"
        ),
        explanations=[
            {"block_id": "overview", "lines": "1-6",
             "markdown": "## Архитектурный контекст\nВалидация сессионного токена."},
            {"block_id": "fail_closed", "lines": "4-5",
             "markdown": "## Инвариант\nfail-closed при отсутствии `exp`."},
        ],
    )
    print(art["xc_content"])

    print("== extract_code_layer ==")
    print(extract_code_layer(art["xc_content"])["code"])

    print("== explanation_gate (Teach-Back) ==")
    verdict = explanation_gate(
        code=extract_code_layer(art["xc_content"])["code"],
        human_explanation=(
            "verify_session rejects tokens with no exp (fail-closed invariant) "
            "and rejects expired tokens by requiring exp strictly greater than "
            "the current time. Edge case: a token exactly at expiry is rejected."
        ),
    )
    print(verdict)


# Optional: bind the same functions as LangChain tools.
def as_langchain_tools():
    from langchain_core.tools import StructuredTool  # pip install langchain-core

    return [
        StructuredTool.from_function(extract_code_layer),
        StructuredTool.from_function(generate_explained_artifact),
        StructuredTool.from_function(explanation_gate),
    ]


if __name__ == "__main__":
    demo_direct()
