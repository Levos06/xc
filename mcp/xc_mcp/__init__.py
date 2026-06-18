"""xc_mcp — MCP tools for autonomous agents operating on .xc files."""

from .server import (
    TOOL_FUNCTIONS,
    explanation_gate,
    extract_code_layer,
    generate_explained_artifact,
    update_explanation_block,
)

__all__ = [
    "TOOL_FUNCTIONS",
    "extract_code_layer",
    "update_explanation_block",
    "generate_explained_artifact",
    "explanation_gate",
]
