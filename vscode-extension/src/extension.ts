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
  body { margin: 0; height: 100vh; display: flex; flex-direction: column;
         font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  .toolbar { display: flex; align-items: center; gap: 6px; padding: 4px 8px;
             border-bottom: 1px solid var(--vscode-panel-border);
             background: var(--vscode-editorGroupHeader-tabsBackground, transparent); flex: 0 0 auto; }
  .toolbar button {
    font: 500 12px var(--vscode-font-family); cursor: pointer;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 3px 9px;
  }
  .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
  .errbar { margin-left: auto; color: var(--vscode-errorForeground, #e55);
            font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .errbar:empty { display: none; }

  .wrap { display: grid; grid-template-columns: 1fr 7px 1fr; flex: 1 1 auto; min-height: 0; }
  .slot { overflow: hidden; min-width: 0; height: 100%; display: flex; }
  .gutter { cursor: col-resize; background: var(--vscode-panel-border); transition: background .1s; }
  .gutter:hover, .gutter.dragging { background: var(--vscode-focusBorder, #007fd4); }

  .code-pane { flex: 1 1 auto; min-width: 0; display: flex; }
  .code-pane textarea {
    width: 100%; height: 100%; box-sizing: border-box; border: 0; resize: none;
    background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px); padding: 12px; tab-size: 4;
    outline: none; line-height: 1.5; white-space: pre; overflow: auto;
  }
  .doc-pane { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 12px 16px;
              background: var(--vscode-editor-background); }
  .xc-block {
    padding: 10px 18px; margin: 0 0 10px; border-radius: 8px;
    border: 1px solid transparent; scroll-margin-top: 12px; cursor: pointer;
  }
  .xc-block:hover { border-color: var(--vscode-panel-border); }
  .xc-block.active {
    background: var(--vscode-editor-selectionHighlightBackground, #2a2d2e);
    border-color: var(--vscode-focusBorder, #007fd4);
  }
  .xc-block-id {
    font: 600 11px var(--vscode-font-family); letter-spacing: .05em; text-transform: uppercase;
    opacity: .55; margin: 2px 0 6px;
  }
  .xc-block > :first-of-type { margin-top: 0; }
  .xc-block h1, .xc-block h2, .xc-block h3 { margin: 12px 0 6px; line-height: 1.25; }
  .doc-pane code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
  .doc-pane pre { background: var(--vscode-textCodeBlock-background); padding: 10px 12px; border-radius: 6px; overflow: auto; }
  .doc-pane pre code { background: none; padding: 0; }
  .doc-pane table { border-collapse: collapse; margin: 8px 0; }
  .doc-pane th, .doc-pane td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; text-align: left; }
  .doc-pane blockquote { margin: 8px 0; padding: 4px 12px; opacity: .85;
                         border-left: 3px solid var(--vscode-focusBorder, #007fd4); }
</style>
</head>
<body>
  <div class="toolbar">
    <button id="swap" title="Поменять панели местами">&#8646; Поменять стороны</button>
    <button id="reset" title="Сбросить ширину панелей 50/50">&#8634; Сбросить</button>
    <span id="errbar" class="errbar"></span>
  </div>
  <div class="wrap" id="wrap">
    <div class="slot" id="slotLeft"></div>
    <div class="gutter" id="gutter"></div>
    <div class="slot" id="slotRight"></div>
  </div>

  <div id="codePane" class="code-pane"><textarea id="code" spellcheck="false"></textarea></div>
  <div id="docPane" class="doc-pane"><div id="doc"></div></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const wrap = document.getElementById('wrap');
    const slotLeft = document.getElementById('slotLeft');
    const slotRight = document.getElementById('slotRight');
    const gutter = document.getElementById('gutter');
    const codePane = document.getElementById('codePane');
    const docPane = document.getElementById('docPane');
    const codeEl = document.getElementById('code');
    const docEl = document.getElementById('doc');
    const errEl = document.getElementById('errbar');

    let views = [];
    let debounce;
    let active = 'code';        // which pane the user is driving
    let lockUntil = 0;          // ignore programmatic-scroll echoes until this time
    let lineHeight = 18;

    // ---- persisted layout ----
    const saved = vscode.getState() || {};
    let codeOnLeft = saved.codeOnLeft !== false;   // default: code on left
    let leftFraction = saved.leftFraction || 0.5;
    function save() { vscode.setState({ codeOnLeft: codeOnLeft, leftFraction: leftFraction }); }

    function applyOrder() {
      if (codeOnLeft) { slotLeft.appendChild(codePane); slotRight.appendChild(docPane); }
      else { slotLeft.appendChild(docPane); slotRight.appendChild(codePane); }
    }
    function setSplit(f) {
      leftFraction = Math.max(0.15, Math.min(0.85, f));
      wrap.style.gridTemplateColumns = leftFraction + 'fr 7px ' + (1 - leftFraction) + 'fr';
    }
    applyOrder();
    setSplit(leftFraction);

    document.getElementById('swap').addEventListener('click', function () {
      codeOnLeft = !codeOnLeft; applyOrder(); save(); measure(); syncFromCode();
    });
    document.getElementById('reset').addEventListener('click', function () {
      setSplit(0.5); save();
    });

    // ---- draggable gutter ----
    let dragging = false;
    gutter.addEventListener('pointerdown', function (e) {
      dragging = true; gutter.classList.add('dragging');
      gutter.setPointerCapture(e.pointerId);
    });
    gutter.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const r = wrap.getBoundingClientRect();
      setSplit((e.clientX - r.left) / r.width);
    });
    gutter.addEventListener('pointerup', function () {
      if (!dragging) return;
      dragging = false; gutter.classList.remove('dragging'); save();
    });

    // ---- measurement ----
    function measure() {
      const cs = getComputedStyle(codeEl);
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;' +
        'font-family:' + cs.fontFamily + ';font-size:' + cs.fontSize + ';line-height:1.5';
      probe.textContent = 'Xg';
      document.body.appendChild(probe);
      lineHeight = probe.offsetHeight || 18;
      probe.remove();
    }

    // ---- sync helpers ----
    function caretLine() {
      return codeEl.value.slice(0, codeEl.selectionStart).split('\\n').length - 1;
    }
    function codeTopLine() {
      return Math.round(codeEl.scrollTop / lineHeight);
    }
    function blockForFlatLine(line) {
      let chosen = null;
      for (const v of views) { if (line >= v.flatStartLine) chosen = v; }
      return chosen;
    }
    function highlight(id) {
      document.querySelectorAll('.xc-block').forEach(function (el) {
        el.classList.toggle('active', el.getAttribute('data-block-id') === id);
      });
    }
    function lock() { lockUntil = Date.now() + 140; }

    // code -> doc
    function syncFromCode() {
      if (!views.length) return;
      const v = blockForFlatLine(active === 'code' ? caretLine() : codeTopLine());
      if (!v) return;
      highlight(v.blockId);
      const el = docPane.querySelector('[data-block-id="' + cssEsc(v.blockId) + '"]');
      if (el) { lock(); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }
    // doc -> code
    function syncFromDoc() {
      if (!views.length) return;
      const pr = docPane.getBoundingClientRect();
      let best = null, bestTop = Infinity;
      docPane.querySelectorAll('.xc-block').forEach(function (el) {
        const t = el.getBoundingClientRect().top - pr.top;
        if (t >= -4 && t < bestTop) { bestTop = t; best = el; }
      });
      if (!best) return;
      const id = best.getAttribute('data-block-id');
      highlight(id);
      const v = views.find(function (x) { return x.blockId === id; });
      if (v) { lock(); codeEl.scrollTop = Math.max(0, v.flatStartLine * lineHeight); }
    }
    function cssEsc(s) { return String(s).replace(/["\\\\]/g, '\\\\$&'); }

    // ---- events: mark active pane, then sync automatically ----
    codePane.addEventListener('pointerenter', function () { active = 'code'; });
    docPane.addEventListener('pointerenter', function () { active = 'doc'; });
    codeEl.addEventListener('focus', function () { active = 'code'; });

    codeEl.addEventListener('scroll', function () {
      if (active === 'code' && Date.now() > lockUntil) syncFromCode();
    });
    codeEl.addEventListener('keyup', function () { active = 'code'; syncFromCode(); });
    codeEl.addEventListener('click', function () { active = 'code'; syncFromCode(); });
    docPane.addEventListener('scroll', function () {
      if (active === 'doc' && Date.now() > lockUntil) syncFromDoc();
    });
    docPane.addEventListener('click', function (e) {
      const blk = e.target.closest ? e.target.closest('.xc-block') : null;
      if (!blk) return;
      active = 'doc';
      const v = views.find(function (x) { return x.blockId === blk.getAttribute('data-block-id'); });
      if (v) { highlight(v.blockId); lock(); codeEl.scrollTop = Math.max(0, v.flatStartLine * lineHeight); }
    });

    codeEl.addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () {
        vscode.postMessage({ type: 'editCode', code: codeEl.value });
      }, 300);
    });

    // ---- receive document state ----
    window.addEventListener('message', function (e) {
      const m = e.data;
      if (m.type !== 'doc') return;
      const pos = codeEl.selectionStart;
      const top = codeEl.scrollTop;
      if (codeEl.value !== m.code) codeEl.value = m.code;
      try { codeEl.setSelectionRange(pos, pos); } catch (err) {}
      codeEl.scrollTop = top;
      docEl.innerHTML = m.explanationHtml;
      views = m.views || [];
      errEl.textContent = (m.errors && m.errors.length) ? '\\u26A0 ' + m.errors.join('; ') : '';
      measure();
      syncFromCode();
    });

    window.addEventListener('resize', measure);
    measure();
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
