# Explained Code (.xc) — VS Code / Cursor extension

Abstracts the physical `.xc` file into a developer-friendly experience.

## Features

- **Split view custom editor** for `*.xc`:
  - **Left:** pure executable code in an editable pane with **syntax
    highlighting** (highlight.js). Edits are spliced back into the `.xc`
    document without disturbing any explanation line — the code's byte range
    and hash only change when you actually change code.
  - **Right:** rendered Markdown explanations with tables, checklists and
    **LaTeX math** (`$inline$` / `$$display$$`, rendered to MathML via Temml).
  - **Resizable divider** (drag the gutter); width and pane order are
    remembered per file.
  - **Swap sides** via the ⇄ icon on the divider.
- **Smooth two-way scroll sync:** scrolling either pane drives the other
  continuously. Code-block starts and their explanation sections are treated as
  anchor points and the scroll position is linearly interpolated between them,
  so the panes track each other smoothly instead of snapping. The active block
  is highlighted. A driver-election guard prevents feedback loops.
- **Isolated git diff:** `XC: Diff Code Layer` and `XC: Diff Explanation Layer`
  open VS Code's native diff over a single layer (HEAD ↔ working), so prose
  edits never create code-review noise.

## Develop / run

```bash
npm install
npm run compile        # esbuild bundle -> out/extension.js
npm run typecheck      # tsc --noEmit
npm run test:parser    # recognizer parity tests (no VS Code needed)
```

Then open this folder in VS Code and press **F5** to launch an Extension
Development Host. Open any `.xc` file (e.g. `../core/examples/auth.xc`).

## Architecture notes

The extension shares the line-oriented recognizer with the CLI
(`src/xcParser.ts` mirrors `core/xc/parser.py`) so both agree exactly on where
code lives. Markdown is rendered host-side with `markdown-it`; the webview only
receives sanitized HTML and the flattened code, preserving layer isolation.
