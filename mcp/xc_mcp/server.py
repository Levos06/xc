"""
MCP server exposing atomic operations over .xc files for autonomous agents.

Tools:
    extract_code_layer        — pure code for an interpreter/compiler
    update_explanation_block  — isolated prose edit, code hash provably stable
    generate_explained_artifact — plan-first assembly (EXPLANATION before CODE)
    explanation_gate          — Teach-Back cognitive gate (LLM-as-judge, SOLO)

The tool *logic* lives in plain functions (see TOOL_FUNCTIONS) so it can be
imported directly by a LangChain client or any Python host, independent of the
MCP transport. `build_server()` wraps them for the MCP protocol.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional

# Make the sibling core package importable without installation.
_CORE = Path(__file__).resolve().parents[2] / "core"
if _CORE.exists() and str(_CORE) not in sys.path:
    sys.path.insert(0, str(_CORE))

import xc  # noqa: E402  (core library)

from .judge import judge_explanation  # noqa: E402


def _read_maybe_path(content_or_path: str) -> str:
    """Accept either raw .xc text or a filesystem path. A short single-line
    value that exists on disk is treated as a path; otherwise it is content."""
    if "\n" not in content_or_path and len(content_or_path) < 4096:
        p = Path(content_or_path)
        try:
            if p.is_file():
                return p.read_text(encoding="utf-8")
        except OSError:
            pass
    return content_or_path


# --------------------------------------------------------------------------- #
# Tool 1: extract_code_layer
# --------------------------------------------------------------------------- #

def extract_code_layer(xc_content: str) -> dict:
    """Return only the pure executable code from a .xc document.

    `xc_content` may be the raw .xc text or a path to a .xc file.
    """
    text = _read_maybe_path(xc_content)
    code = xc.extract(text)
    return {
        "language": xc.detect_language(text),
        "code": code,
        "code_sha256": xc.code_hash(text),
        "line_count": code.count("\n"),
    }


# --------------------------------------------------------------------------- #
# Tool 2: update_explanation_block
# --------------------------------------------------------------------------- #

def update_explanation_block(xc_content: str, block_id: str, new_explanation: str,
                             write_path: Optional[str] = None) -> dict:
    """Replace the prose of one EXPLANATION block, leaving all code untouched.

    Returns the new document and proof (matching hashes) that the code layer
    was not modified.
    """
    text = _read_maybe_path(xc_content)
    result = xc.update_explanation_block(text, block_id, new_explanation)
    if write_path:
        Path(write_path).write_text(result.text, encoding="utf-8")
    return {
        "xc_content": result.text,
        "code_unchanged": result.code_unchanged,
        "old_code_sha256": result.old_code_hash,
        "new_code_sha256": result.new_code_hash,
        "written_to": write_path,
    }


# --------------------------------------------------------------------------- #
# Tool 3: generate_explained_artifact
# --------------------------------------------------------------------------- #

def generate_explained_artifact(
    language: str,
    module: str,
    explanation_markdown: str,
    code: str,
    block_id: str = "main_logic",
    edge_cases: Optional[list[str]] = None,
    write_path: Optional[str] = None,
) -> dict:
    """Assemble a valid .xc document, ENFORCING plan-first ordering.

    The agent must supply the semantic layer (`explanation_markdown`, and
    optionally `edge_cases`) which is emitted *before* the `code`. This bakes
    Planning Conditioning into the artifact: the explanation/invariants
    physically precede the implementation.
    """
    if not explanation_markdown.strip():
        raise ValueError(
            "explanation_markdown is empty: an explained artifact must state "
            "its plan and invariants BEFORE the code (Planning Conditioning)."
        )

    fence = xc.core._choose_fence(code)
    edge_md = ""
    if edge_cases:
        edge_md = "\n## Граничные условия (edge cases)\n" + "".join(
            f"* {c}\n" for c in edge_cases
        )

    body = code.rstrip("\n")
    doc = (
        "---\n"
        'xc_spec: "1.0"\n'
        f'language: "{language}"\n'
        f'module: "{module}"\n'
        "always_apply: true\n"
        "---\n"
        "\n"
        f"# [EXPLANATION: {block_id}]\n"
        f"{explanation_markdown.rstrip()}\n"
        f"{edge_md}\n"
        f"# [CODE: {block_id}]\n"
        f"{fence}{language}\n"
        f"{body}\n"
        f"{fence}\n"
    )

    report = xc.validate(doc)
    if not report.ok:
        raise ValueError(f"assembled artifact is invalid: {report.errors}")

    if write_path:
        Path(write_path).write_text(doc, encoding="utf-8")

    return {
        "xc_content": doc,
        "valid": report.ok,
        "code_sha256": xc.code_hash(doc),
        "written_to": write_path,
    }


# --------------------------------------------------------------------------- #
# Tool 4: explanation_gate (Teach-Back)
# --------------------------------------------------------------------------- #

def explanation_gate(
    code: str,
    human_explanation: str,
    invariants: Optional[str] = None,
    threshold: int = 3,
) -> dict:
    """Teach-Back gate against vibe-coding.

    A human must explain AI-generated `code` in their own words. A judge model
    (T=0.1) scores the explanation on the SOLO taxonomy; the merge is allowed
    only when the score reaches `threshold` (default: relational).
    """
    code_text = _read_maybe_path(code)
    verdict = judge_explanation(
        code_text, human_explanation, invariants=invariants, threshold=threshold
    )
    return {
        "allow_merge": verdict.passed,
        "solo_level": verdict.level,
        "solo_label": verdict.label,
        "threshold": verdict.threshold,
        "judge_backend": verdict.backend,
        "reasoning": verdict.reasoning,
        "what_is_missing": verdict.missing,
    }


TOOL_FUNCTIONS = {
    "extract_code_layer": extract_code_layer,
    "update_explanation_block": update_explanation_block,
    "generate_explained_artifact": generate_explained_artifact,
    "explanation_gate": explanation_gate,
}


# --------------------------------------------------------------------------- #
# MCP wiring
# --------------------------------------------------------------------------- #

def build_server():
    """Construct a FastMCP server exposing the four tools."""
    from mcp.server.fastmcp import FastMCP

    mcp = FastMCP("xc-tools")

    @mcp.tool()
    def extract_code_layer_tool(xc_content: str) -> dict:
        """Extract the pure executable code from a .xc document (raw text or path)."""
        return extract_code_layer(xc_content)

    @mcp.tool()
    def update_explanation_block_tool(
        xc_content: str, block_id: str, new_explanation: str,
        write_path: Optional[str] = None,
    ) -> dict:
        """Rewrite one EXPLANATION block in isolation; code hash stays identical."""
        return update_explanation_block(xc_content, block_id, new_explanation, write_path)

    @mcp.tool()
    def generate_explained_artifact_tool(
        language: str, module: str, explanation_markdown: str, code: str,
        block_id: str = "main_logic", edge_cases: Optional[list[str]] = None,
        write_path: Optional[str] = None,
    ) -> dict:
        """Assemble a .xc artifact, explanation/invariants emitted BEFORE code."""
        return generate_explained_artifact(
            language, module, explanation_markdown, code, block_id, edge_cases, write_path
        )

    @mcp.tool()
    def explanation_gate_tool(
        code: str, human_explanation: str, invariants: Optional[str] = None,
        threshold: int = 3,
    ) -> dict:
        """Teach-Back gate: a judge model scores a human's explanation (SOLO)."""
        return explanation_gate(code, human_explanation, invariants, threshold)

    return mcp


def main() -> None:
    server = build_server()
    server.run()  # stdio transport by default


if __name__ == "__main__":
    main()
