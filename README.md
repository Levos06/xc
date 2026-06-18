# `.xc` — Explained Code Ecosystem (MVP)

A text format and toolchain that keep executable code and its semantic layer
(architectural context, invariants, requirements) in **one physical file** —
without the "two parsers" pathology, without diff noise, and with the
explanation physically *before* the code so model generation is conditioned by
the plan first.

This repository implements the three product layers from the spec:

| Layer | Path | What it is |
|-------|------|------------|
| 1. Core + CLI | [`core/`](core/) | `xc-cli` — `init` / `extract` / `run` / `validate` |
| 2. Agent tools | [`mcp/`](mcp/) | MCP server with 4 atomic tools for autonomous agents |
| 3. IDE display | [`vscode-extension/`](vscode-extension/) | Split-view editor + isolated git diff |

## The format (Markdown-First, Variant A)

A `.xc` file is a valid Markdown document with fixed line boundaries:

```markdown
---
xc_spec: "1.0"
language: "python"
module: "core.auth"
always_apply: true
---

# [EXPLANATION: main_logic]
## Архитектурный контекст
...invariants, requirements, edge cases...

# [CODE: main_logic]
` ` `python
import time
def verify_session(token_data: dict) -> bool: ...
` ` `
```

**Design principles enforced by the tooling**

- **Layer isolation (LangSec).** A single, line-oriented, *total* recognizer
  classifies every line. Code inside a fence is never re-parsed as markup and
  markup is never parsed as code. Markup and code occupy disjoint line ranges.
- **Planning Conditioning.** `EXPLANATION` blocks physically precede their
  `CODE` block. `generate_explained_artifact` *refuses* to emit an artifact
  without an explanation.
- **No diff noise.** `extract` is a pure function of the code fences only;
  prose edits cannot change the extracted code or its hash. A git `textconv`
  driver makes `git diff` show only the code layer.

---

## Layer 1 — `xc-cli`

```bash
cd core
python3 -m venv .venv && .venv/bin/pip install -e .   # installs `xc-cli`

xc-cli init mymodule.py            # -> mymodule.xc (explanation stub + code)
xc-cli extract file.xc             # pure code to stdout (streaming, O(n))
xc-cli extract file.xc --hash      # SHA-256 of the code layer
xc-cli run file.xc                 # extract + execute via language runner
xc-cli validate file.xc           # structural + YAML check, truncation-resilient
```

Run the tests: `cd core && .venv/bin/python -m pytest tests/ -q` (14 passing).

## Layer 2 — MCP tools

Four atomic tools, exposed over MCP (FastMCP) **and** importable directly by a
LangChain/Python host (`from xc_mcp import ...`):

- `extract_code_layer` — pure code for a compiler/interpreter.
- `update_explanation_block` — isolated prose edit; returns proof the code hash
  is unchanged.
- `generate_explained_artifact` — plan-first assembly (explanation + invariants
  before code).
- `explanation_gate` — **Teach-Back** cognitive gate against vibe-coding: a
  judge model (`T=0.1`) scores a human's explanation on the **SOLO taxonomy**
  and allows the merge only at/above a threshold. Falls back to a transparent
  offline heuristic when no `ANTHROPIC_API_KEY` is set.

```bash
cd mcp
../core/.venv/bin/pip install "mcp>=1.2.0"     # + optional: anthropic
../core/.venv/bin/python examples/langchain_client.py   # live demo
```

Register with Cursor / Claude Desktop using
[`mcp/mcp_config.example.json`](mcp/mcp_config.example.json). Tests:
`core/.venv/bin/python -m pytest mcp/tests/ -q` (6 passing).

## Layer 3 — VS Code / Cursor extension

```bash
cd vscode-extension
npm install
npm run compile        # bundles to out/extension.js
npm run test:parser    # TS recognizer parity tests
# Press F5 in VS Code to launch an Extension Development Host, open a .xc file.
```

- **Split view:** editable pure code (left, native-feeling), rendered Markdown
  explanations (right). Editing the left pane splices code back into the `.xc`
  file without touching a single explanation line.
- **Focus sync:** moving the caret into a function/block on the left scrolls and
  highlights the matching `block_id` on the right.
- **Isolated git diff:** the `XC: Diff Code Layer` / `XC: Diff Explanation
  Layer` commands open native diff editors over a single layer only.

## Git integration — kill diff noise at the source

```bash
git-integration/setup-xc-diff.sh /path/to/your/repo
```

Configures a `textconv` diff driver (`xc-cli extract`) + `.gitattributes`, so
`git diff` / code review on `.xc` files shows **only the code layer**.
Demonstrated: a prose-only edit yields an *empty* `git diff`.

---

## Acceptance criteria — status

1. **`xc-cli run script.xc` executes valid Python** — ✅ `test_cli_run_executes`,
   and `xc-cli run core/examples/auth.xc`.
2. **Explanation edits don't change the code / its hash** — ✅
   `test_explanation_edit_keeps_code_hash_stable`; git textconv shows empty diff.
3. **Parser resilient to truncated LLM streams** — ✅ `validate` reports the
   recoverable prefix line; `test_validate_detects_unclosed_fence`.
4. **MCP tools importable & callable by an autonomous agent** — ✅ FastMCP server
   lists all 4 tools; `examples/langchain_client.py` calls them directly.
