# Explained Code (`.xc`)

**One file for the code and the reasoning behind it.** `.xc` keeps executable
source and its semantic layer — architectural context, invariants, requirements,
edge cases — in a single, version-control-friendly text file, without mixing the
two in a way that confuses tools, models, or `git`.

A `.xc` file is a valid Markdown document with a fixed block structure. The
prose explaining a unit of code lives *before* the code; the code lives inside a
fenced block. Tooling can losslessly pull out the pure code, edit the prose
without touching the code, and render the two side by side.

````markdown
---
xc_spec: "1.0"
language: "python"
module: "core.auth"
---

# [EXPLANATION: verify_session]
## Architectural context
Validates session tokens before a request is served.

## Security invariants
* A token with no `exp` field is rejected (fail-closed).
* An expired token (`exp <= now`) is never accepted.

# [CODE: verify_session]
```python
import time

def verify_session(token: dict) -> bool:
    if "exp" not in token:
        return False
    return token["exp"] > time.time()
```
````

The repository contains three components that share one parser:

| Component | Path | Summary |
|-----------|------|---------|
| **Core & CLI** | [`core/`](core/) | `xc-cli` — `init`, `extract`, `run`, `validate` |
| **Agent tools (MCP)** | [`mcp/`](mcp/) | Atomic operations for AI agents over the Model Context Protocol |
| **IDE extension** | [`vscode-extension/`](vscode-extension/) | Split-view editor + isolated `git` diff for VS Code / Cursor |

---

## Why `.xc`

Putting documentation inside code is old; doing it so that **automated tooling
and language models stay reliable** is the point of this format. Three design
principles drive every decision:

- **Layer isolation (LangSec).** A single, line-oriented, *total* recognizer
  classifies every line of the file. Code inside a fence is never re-parsed as
  Markdown, and Markdown is never parsed as code. The two languages occupy
  disjoint line ranges, which avoids the "two parsers disagree" class of bugs.

- **Planning conditioning.** The explanation and invariants are physically
  written *before* the code they describe. When a model generates an `.xc`
  artifact, it must commit to the plan and edge cases first, then the
  implementation — the order that produces better code.

- **No diff noise.** Extracting code depends *only* on the contents of `[CODE]`
  fences, so editing prose can never change the extracted code or its hash. A
  `git` `textconv` driver makes `git diff` show only the code layer, so prose
  edits don't clutter review.

These are not aspirations — they are enforced and tested (see *Guarantees*).

---

## The format

A `.xc` file is:

1. An optional YAML **frontmatter** block (`---` … `---`) carrying metadata such
   as `language` and `module`.
2. A sequence of **blocks**, each introduced by a heading:
   - `# [EXPLANATION: <id>]` — Markdown prose (context, invariants, checklists,
     LaTeX math, tables).
   - `# [CODE: <id>]` — a single fenced code block holding executable source.

Blocks are paired by their `<id>`: an explanation and the code it describes
share one id, which is also the anchor used for editor focus-sync. Free-standing
explanation notes (no code) and code without an explanation are both allowed.

The recognizer is resilient: a file truncated mid-stream (e.g. by an
interrupted LLM response) still parses up to the last valid boundary, and
`validate` reports where that is.

---

## Component 1 — `xc-cli`

A deterministic, local command-line tool. Requires Python ≥ 3.9.

```bash
cd core
python3 -m venv .venv
.venv/bin/pip install -e .          # installs the `xc-cli` entry point
```

```bash
xc-cli init mymodule.py             # wrap raw source -> mymodule.xc (with a stub explanation)
xc-cli extract file.xc              # stream the pure code to stdout (linear time)
xc-cli extract file.xc --hash       # SHA-256 of the extracted code layer
xc-cli run file.xc                  # extract + execute via the language's runner
xc-cli validate file.xc            # structural + YAML validation, with recovery point
```

`run` chooses an interpreter from the frontmatter `language` (Python, JavaScript,
TypeScript, Ruby, Bash, …). `extract` is a pure function of the code fences, so
its output — and `--hash` — are stable across any prose edit.

Tests: `cd core && .venv/bin/python -m pytest tests/ -q`.

---

## Component 2 — MCP tools

A [Model Context Protocol](https://modelcontextprotocol.io) server exposing four
atomic tools, so autonomous agents (Cursor, Claude Desktop, LangChain, …) can
work with `.xc` files safely. Every tool is also importable directly as a Python
function (`from xc_mcp import …`).

| Tool | Purpose |
|------|---------|
| `extract_code_layer` | Return only the executable code (for a compiler/interpreter). |
| `update_explanation_block` | Rewrite one explanation in isolation; returns proof the code hash is unchanged. |
| `generate_explained_artifact` | Assemble a valid `.xc` artifact, **refusing** to emit code without an explanation first (planning conditioning). |
| `explanation_gate` | A **Teach-Back** gate against "vibe coding": a judge model (temperature 0.1) scores a human's explanation on the SOLO taxonomy and only allows a merge above a threshold. Falls back to a transparent offline heuristic with no API key. |

```bash
cd mcp
../core/.venv/bin/pip install "mcp>=1.2.0"   # optional: anthropic (enables the LLM judge)
../core/.venv/bin/python -m xc_mcp.server     # run over stdio
```

Register with an MCP client using
[`mcp/mcp_config.example.json`](mcp/mcp_config.example.json). A runnable
direct-import demo is in [`mcp/examples/langchain_client.py`](mcp/examples/langchain_client.py).

Tests: `core/.venv/bin/python -m pytest mcp/tests/ -q`.

---

## Component 3 — VS Code / Cursor extension

Turns the physical `.xc` file into a comfortable two-pane editing experience.
See [`vscode-extension/README.md`](vscode-extension/README.md) for full details.

- **Split view.** Left: pure code with syntax highlighting and line numbers,
  editable as a normal file — edits are spliced back into the `.xc` document
  without touching a single explanation line. Right: rendered Markdown with
  tables, checklists, and LaTeX math (`$inline$` / `$$display$$`).
- **Smooth two-way scroll sync.** Block boundaries are treated as anchor points
  and scroll position is mapped through a monotone cubic spline, so the panes
  track each other smoothly in both directions and reach their ends together.
- **Authoring in place.** Edit any explanation inline (✎ or double-click),
  rename a block, add a block with the **+** affordance between blocks, or select
  code and *Describe selection* to attach prose to that exact range. Delete a
  description with undo support.
- **Resizable & swappable panes**, persisted per file.
- **Isolated git diff.** Dedicated commands open VS Code's native diff over a
  single layer (code-only or explanation-only), HEAD ↔ working tree.

Install the packaged build:

```bash
code --install-extension vscode-extension/versions/explained-code-<version>.vsix
```

Or develop it:

```bash
cd vscode-extension
npm install
npm run compile          # bundle extension + webview
npm run test:parser      # recognizer parity tests
npm run package          # build versions/explained-code-<version>.vsix
# Press F5 in VS Code to launch an Extension Development Host; open a .xc file.
```

---

## Git integration — keep prose out of code review

```bash
git-integration/setup-xc-diff.sh /path/to/your/repo
```

Installs a `textconv` diff driver (`xc-cli extract`) and the matching
`.gitattributes` entry, so `git diff` and code review on `.xc` files show **only
the code layer**. An explanation-only edit produces an empty `git diff`.

---

## Guarantees

These properties are enforced by the implementation and covered by tests:

1. **Executable.** Any `.xc` with syntactically valid code runs via
   `xc-cli run`.
2. **Prose edits never change code.** Editing an `[EXPLANATION]` block leaves
   every byte of the extracted code — and its SHA-256 — identical. The git
   `textconv` driver demonstrates this with an empty diff.
3. **Robust to truncation.** A file cut off mid-stream still parses to the last
   valid boundary; `validate` reports the recoverable prefix.
4. **Agent-ready.** The MCP tools import and run from an autonomous agent or a
   plain Python/LangChain host.

---

## Repository layout

```
core/              Python library + xc-cli
  xc/parser.py     single-pass, total, O(n) recognizer (shared semantics)
  xc/core.py       extract / init / run / validate
  xc/edit.py       isolated explanation edits (hash-stable)
mcp/               MCP server + tools (FastMCP) and judge
vscode-extension/  TypeScript extension (parser mirrored in src/xcParser.ts)
  versions/        released .vsix packages
git-integration/   textconv setup script
```

The CLI (Python) and the extension (TypeScript) keep byte-for-byte agreement on
where code lives by mirroring the same line-oriented recognizer.

---

## Development

```bash
# Core + MCP (Python)
cd core && python3 -m venv .venv && .venv/bin/pip install -e '.[test]'
.venv/bin/pip install "mcp>=1.2.0"
.venv/bin/python -m pytest tests/ ../mcp/tests/ -q

# Extension (TypeScript)
cd ../vscode-extension && npm install
npm run typecheck && npm run test:parser
```

---

## License

See [LICENSE](LICENSE).
