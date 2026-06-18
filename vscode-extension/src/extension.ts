/**
 * Explained Code (.xc) — VS Code / Cursor extension.
 *
 * Provides:
 *  1. A custom split-view editor: editable pure code on the left, rendered
 *     Markdown explanations on the right, with caret-driven focus sync.
 *  2. Git diff isolation commands: view a code-only or explanation-only diff so
 *     prose edits never create noise on code review.
 *
 * Layer isolation (LangSec): the document on disk stays a single Markdown-First
 * .xc file. The webview never re-parses code as markup or vice-versa; it edits
 * disjoint line ranges computed by the shared recognizer (xcParser.ts).
 */

import * as vscode from "vscode";
import MarkdownIt = require("markdown-it");
import {
  parse,
  codeBlocks,
  codeViews,
  extract,
  extractExplanations,
  spliceCode,
} from "./xcParser";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      XcEditorProvider.viewType,
      new XcEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("xc.diffCode", () => showIsolatedDiff("code")),
    vscode.commands.registerCommand("xc.diffExplanation", () => showIsolatedDiff("explanation"))
  );
}

export function deactivate() {}

class XcEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "xc.splitView";

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = this.html(panel.webview);

    let updatingFromWebview = false;

    const pushToWebview = () => {
      const text = document.getText();
      const res = parse(text);
      const blocks = codeBlocks(res);
      const explanationHtml = res.blocks
        .filter((b) => b.kind === "EXPLANATION")
        .map((b) => {
          const body = res.lines.slice(b.bodyStart, b.bodyEnd).join("\n");
          return `<section class="xc-block" data-block-id="${escapeAttr(b.blockId)}">
            <div class="xc-block-id">${escapeHtml(b.blockId)}</div>
            ${md.render(body)}
          </section>`;
        })
        .join("\n");

      panel.webview.postMessage({
        type: "doc",
        code: extract(text),
        codeLang: res.frontmatterText.match(/language:\s*"?([\w+#-]+)"?/)?.[1] || "plaintext",
        explanationHtml,
        views: codeViews(res),
        blockIds: blocks.map((b) => b.blockId),
        errors: res.errors,
      });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString() && !updatingFromWebview) {
        pushToWebview();
      }
    });
    panel.onDidDispose(() => changeSub.dispose());

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "editCode") {
        const newText = spliceCode(document.getText(), msg.code);
        if (newText === document.getText()) return;
        updatingFromWebview = true;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          document.uri,
          new vscode.Range(0, 0, document.lineCount, 0),
          newText
        );
        await vscode.workspace.applyEdit(edit);
        updatingFromWebview = false;
      } else if (msg.type === "ready") {
        pushToWebview();
      }
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Date.now()) + Math.floor(Math.random() * 1e6);
    const csp =
      `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; height: 100vh; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  .wrap { display: grid; grid-template-columns: 1fr 6px 1fr; height: 100vh; }
  .pane { overflow: auto; height: 100vh; }
  .gutter { background: var(--vscode-panel-border); }
  .code-pane textarea {
    width: 100%; height: 100%; box-sizing: border-box; border: 0; resize: none;
    background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px); padding: 12px; tab-size: 4;
    outline: none; line-height: 1.5;
  }
  .doc-pane { padding: 0 20px; background: var(--vscode-editor-background); }
  .xc-block { padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border); scroll-margin-top: 12px; }
  .xc-block.active { background: var(--vscode-editor-selectionHighlightBackground); border-radius: 6px; }
  .xc-block-id {
    font: 600 11px var(--vscode-font-family); letter-spacing: .04em; text-transform: uppercase;
    opacity: .6; margin: 6px 0 2px;
  }
  .doc-pane code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  .doc-pane pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 6px; overflow:auto; }
  .errbar { background: var(--vscode-inputValidation-errorBackground, #80202055); color: var(--vscode-foreground);
            padding: 4px 12px; font-size: 12px; }
  .errbar:empty { display: none; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="pane code-pane"><textarea id="code" spellcheck="false"></textarea></div>
    <div class="gutter"></div>
    <div class="pane doc-pane"><div id="errbar" class="errbar"></div><div id="doc"></div></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const codeEl = document.getElementById('code');
    const docEl = document.getElementById('doc');
    const errEl = document.getElementById('errbar');
    let views = [];
    let debounce;

    function lineOfCaret() {
      const upto = codeEl.value.slice(0, codeEl.selectionStart);
      return upto.split('\\n').length - 1;
    }
    function blockForLine(line) {
      let chosen = null;
      for (const v of views) { if (line >= v.flatStartLine) chosen = v; }
      return chosen ? chosen.blockId : null;
    }
    function syncFocus() {
      const id = blockForLine(lineOfCaret());
      let target = null;
      document.querySelectorAll('.xc-block').forEach(el => {
        const match = el.getAttribute('data-block-id') === id;
        el.classList.toggle('active', match);
        if (match) target = el;
      });
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    codeEl.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        vscode.postMessage({ type: 'editCode', code: codeEl.value });
      }, 300);
    });
    codeEl.addEventListener('keyup', syncFocus);
    codeEl.addEventListener('click', syncFocus);

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type !== 'doc') return;
      // Preserve caret across external updates.
      const pos = codeEl.selectionStart;
      if (codeEl.value !== m.code) codeEl.value = m.code;
      try { codeEl.setSelectionRange(pos, pos); } catch {}
      docEl.innerHTML = m.explanationHtml;
      views = m.views || [];
      errEl.textContent = (m.errors && m.errors.length)
        ? '⚠ ' + m.errors.join('; ') : '';
      syncFocus();
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

/**
 * Git diff isolation. Builds a virtual document containing only the code layer
 * (or only the explanation layer) of both the working copy and HEAD, then opens
 * VS Code's native diff editor on the two. Prose edits therefore never appear
 * in the code diff, and vice-versa — eliminating review noise.
 */
async function showIsolatedDiff(layer: "code" | "explanation") {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith(".xc")) {
    vscode.window.showWarningMessage("Open a .xc file first.");
    return;
  }
  const uri = editor.document.uri;
  const project = layer === "code" ? extract : extractExplanations;

  const headText = await readHead(uri);
  if (headText === null) {
    vscode.window.showWarningMessage("No git HEAD version found for this file.");
    return;
  }

  const left = XcLayerFs.register(`HEAD:${layer}:${uri.path}`, project(headText), layer);
  const right = XcLayerFs.register(`WORK:${layer}:${uri.path}`, project(editor.document.getText()), layer);

  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    `${baseName(uri)} — ${layer} layer (HEAD ↔ working)`
  );
}

function baseName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() || uri.path;
}

async function readHead(uri: vscode.Uri): Promise<string | null> {
  try {
    const ext = vscode.extensions.getExtension<any>("vscode.git");
    const git = ext?.isActive ? ext.exports : await ext?.activate();
    const api = git?.getAPI?.(1);
    const repo = api?.repositories?.find((r: any) =>
      uri.path.startsWith(r.rootUri.path)
    );
    if (!repo) return null;
    return await repo.show("HEAD", uri.fsPath);
  } catch {
    return null;
  }
}

/** A tiny in-memory FS provider so diff tabs render synthetic layer content. */
class XcLayerFs implements vscode.FileSystemProvider {
  private static readonly scheme = "xc-layer";
  private static store = new Map<string, Uint8Array>();
  private static registered = false;
  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  onDidChangeFile = this._emitter.event;

  static register(key: string, content: string, layer: string): vscode.Uri {
    if (!this.registered) {
      vscode.workspace.registerFileSystemProvider(this.scheme, new XcLayerFs(), {
        isReadonly: true,
      });
      this.registered = true;
    }
    const path = `/${encodeURIComponent(key)}.${layer === "code" ? "code" : "md"}`;
    this.store.set(path, Buffer.from(content, "utf-8"));
    return vscode.Uri.from({ scheme: this.scheme, path });
  }

  readFile(uri: vscode.Uri): Uint8Array {
    return XcLayerFs.store.get(uri.path) ?? new Uint8Array();
  }
  stat(): vscode.FileStat {
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
  }
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }
  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(): void {}
  writeFile(): void {}
  delete(): void {}
  rename(): void {}
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
