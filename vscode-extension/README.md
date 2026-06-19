# Explained Code (.xc) — VS Code / Cursor extension

Abstracts the physical `.xc` file into a developer-friendly experience.

The format is v2: a single monolithic `# [CODE: MONOLITH]` block, with
explanation blocks bound to it by 1-indexed line ranges (`lines: 5-8`).

## Features

- **Split view custom editor** for `*.xc`:
  - **Left:** the monolithic code with **syntax highlighting** (highlight.js)
    and line numbers, editable as a normal file. On edit the code block is
    rewritten and every explanation's `lines:` range is automatically remapped
    (via an LCS diff) so the prose keeps pointing at the same logical lines.
  - **Right:** the prose layer, rendered with tables, checklists and **LaTeX
    math** (`$inline$` / `$$display$$` → MathML via Temml), in one of two modes.
  - **Resizable divider** + **swap sides** (⇄), persisted per file.
- **Two display modes**, toggled in the top bar:
  - **Сетка / Grid (Excel-style, default).** The right panel is ruled into rows
    aligned 1:1 with code lines. An explanation renders from its start line and
    flows down until the next block starts; scroll is *monolithic* (one shared
    line index — desync is impossible). Blocks **collapse** to a single row
    (revealing the block underneath), and multiple blocks on the same start line
    become **tabs**.
  - **Контекст / Sticky context.** The right panel shows cards only for the
    block(s) whose range covers the focused code line.
- **Authoring.** Edit a block (id, line range, Markdown) in a floating editor;
  **Describe selection** attaches prose to selected code lines; **delete** a
  block with **undo** (Ctrl/Cmd+Z). Click code → highlight the covering block;
  hover a block → highlight its code lines.
- **Isolated git diff:** `XC: Diff Code Layer` / `XC: Diff Explanation Layer`
  open VS Code's native diff over a single layer (HEAD ↔ working).

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
