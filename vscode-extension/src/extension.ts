/**
 * Explained Code (.xc) — VS Code / Cursor extension (format v2, monolithic code).
 *
 *  1. A custom split-view editor: editable monolithic code on the left; the
 *     prose layer on the right in one of two modes — "Sticky context" (cards for
 *     the focused line) or "Grid" (Excel-style rows aligned 1:1 to code lines).
 *     Explanation blocks bind to code by 1-indexed line ranges (`lines: 5-8`).
 *  2. Git diff isolation commands (code-only / explanation-only).
 */

import * as vscode from "vscode";
import MarkdownIt = require("markdown-it");
import {
  parse,
  extract,
  extractExplanations,
  applyCodeEdit,
  setExplanationBody,
  setExplanationRange,
  renameBlockId,
  insertExplanation,
  deleteExplanationBlock,
  uniqueId,
  Range as XcRange,
} from "./xcParser";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const texmath = require("markdown-it-texmath");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const temml = require("temml");
  md.use(texmath, {
    engine: {
      renderToString: (tex: string, opts: any) =>
        temml.renderToString(tex, { displayMode: !!(opts && opts.displayMode), throwOnError: false }),
    },
    delimiters: "dollars",
  });
} catch {
  /* math optional */
}

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
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    panel.webview.html = this.html(panel.webview);

    let updatingFromWebview = false;
    let pendingEdit: string | undefined;
    const undoStack: string[] = [];
    const redoStack: string[] = [];

    const pushToWebview = () => {
      const text = document.getText();
      const res = parse(text);
      const explanations = res.explanations.map((e) => {
        const body = e.bodyLines.join("\n");
        return {
          blockId: e.blockId,
          ranges: e.ranges,
          startLine: e.ranges.length ? Math.min(...e.ranges.map((r) => r.start)) : 0,
          raw: body.replace(/\s+$/, ""),
          html: md.render(body),
        };
      });
      panel.webview.postMessage({
        type: "doc",
        code: extract(text),
        codeLang: (res.frontmatterText.match(/language:\s*"?([\w+#-]+)"?/)?.[1]
          || res.codeFenceLang || "plaintext").toLowerCase(),
        codeLineCount: res.codeLines.length,
        explanations,
        errors: res.errors,
        autoEditBlockId: pendingEdit,
      });
      pendingEdit = undefined;
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString() && !updatingFromWebview) {
        pushToWebview();
      }
    });
    panel.onDidDispose(() => changeSub.dispose());

    const replaceDoc = async (newText: string) => {
      if (newText === document.getText()) return;
      updatingFromWebview = true;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), newText);
      await vscode.workspace.applyEdit(edit);
      updatingFromWebview = false;
      pushToWebview();
    };
    const mutate = async (newText: string) => {
      if (newText === document.getText()) return;
      undoStack.push(document.getText());
      if (undoStack.length > 200) undoStack.shift();
      redoStack.length = 0;
      await replaceDoc(newText);
    };

    const toRanges = (spec: any): XcRange[] => {
      if (Array.isArray(spec)) return spec as XcRange[];
      return [];
    };

    panel.webview.onDidReceiveMessage(async (msg) => {
      const text = document.getText();
      try {
        if (msg.type === "editCode") {
          await mutate(applyCodeEdit(text, msg.code));
        } else if (msg.type === "editExplanation") {
          let working = text;
          let targetId = msg.blockId;
          const newId = (msg.newId || "").trim();
          if (newId && newId !== msg.blockId) {
            const taken = new Set(parse(text).explanations.map((e) => e.blockId));
            if (taken.has(newId)) {
              vscode.window.showWarningMessage(`Идентификатор «${newId}» уже занят.`);
            } else {
              working = renameBlockId(working, msg.blockId, newId);
              targetId = newId;
            }
          }
          const ranges = toRanges(msg.ranges);
          if (ranges.length) working = setExplanationRange(working, targetId, ranges);
          await mutate(setExplanationBody(working, targetId, msg.markdown));
        } else if (msg.type === "insertBlock") {
          const id = uniqueId(text);
          const line = Math.max(1, msg.line || 1);
          pendingEdit = id;
          await mutate(insertExplanation(text, id, [{ start: line, end: line }], "## Новый блок\n\nОпишите здесь…"));
        } else if (msg.type === "describeSelection") {
          const id = uniqueId(text);
          const s = Math.max(1, msg.startLine);
          const e = Math.max(s, msg.endLine);
          pendingEdit = id;
          await mutate(insertExplanation(text, id, [{ start: s, end: e }], "## Описание\n\nОпишите здесь…"));
        } else if (msg.type === "deleteBlock") {
          await mutate(deleteExplanationBlock(text, msg.blockId));
        } else if (msg.type === "undo") {
          if (undoStack.length) { redoStack.push(document.getText()); await replaceDoc(undoStack.pop()!); }
        } else if (msg.type === "redo") {
          if (redoStack.length) { undoStack.push(document.getText()); await replaceDoc(redoStack.pop()!); }
        } else if (msg.type === "ready") {
          pushToWebview();
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`xc: ${err?.message || err}`);
      }
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Date.now()) + Math.floor(Math.random() * 1e6);
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.bundle.js")
    );
    const csp =
      `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: light dark; --curtain-h: 30px; }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: flex; flex-direction: column;
         background: var(--vscode-editor-background);
         font-family: var(--vscode-font-family); color: var(--vscode-foreground); }

  .curtain { position: relative; flex: 0 0 var(--curtain-h); height: var(--curtain-h);
             display: flex; align-items: center; justify-content: center;
             background: var(--vscode-editor-background); }
  .modes { display: inline-flex; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
  .modes button { font: 500 11px var(--vscode-font-family); cursor: pointer; padding: 3px 10px;
                  border: 0; background: transparent; color: var(--vscode-foreground); opacity: .7; }
  .modes button.active { background: var(--vscode-button-background, #0e639c);
                         color: var(--vscode-button-foreground, #fff); opacity: 1; }
  .swap-btn { position: absolute; top: 50%; transform: translate(-50%, -50%);
              width: 26px; height: 24px; border-radius: 6px; padding: 0; z-index: 6; cursor: pointer;
              display: flex; align-items: center; justify-content: center; border: none; outline: none;
              color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: var(--vscode-editor-background); }
  .swap-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .swap-btn svg { width: 14px; height: 14px; display: block; }

  .wrap { display: grid; grid-template-columns: 1fr 7px 1fr; flex: 1 1 auto; min-height: 0; }
  .slot { overflow: hidden; min-width: 0; height: 100%; display: flex; }
  .gutter { cursor: col-resize; background: var(--vscode-panel-border); transition: background .1s; }
  .gutter:hover, .gutter.dragging { background: var(--vscode-focusBorder, #007fd4); }

  /* left: code editor */
  .code-pane { position: relative; flex: 1 1 auto; min-width: 0; background: var(--vscode-editor-background); }
  .editor { position: absolute; inset: 0; overflow: hidden; --gutter-w: 48px; }
  .editor pre.hl, .editor textarea {
    margin: 0; border: 0; background: transparent; position: absolute; inset: 0; width: 100%; height: 100%;
    padding: 12px 12px 12px calc(var(--gutter-w) + 8px); tab-size: 4;
    font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.5; letter-spacing: 0; white-space: pre; }
  .editor pre.hl { overflow: hidden; z-index: 1; pointer-events: none; color: var(--vscode-editor-foreground); }
  .editor pre.hl code { font: inherit; white-space: pre; display: block; background: none; }
  .editor textarea { z-index: 2; resize: none; outline: none; overflow: auto; color: transparent;
                     caret-color: var(--vscode-editor-foreground); }
  .editor textarea::selection { background: var(--vscode-editor-selectionBackground, #264f78); }
  .linenos { position: absolute; top: 0; left: 0; bottom: 0; width: var(--gutter-w); z-index: 3; overflow: hidden;
             text-align: right; padding: 12px 6px 12px 0; box-sizing: border-box;
             font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px);
             line-height: 1.5; white-space: pre; color: var(--vscode-editorLineNumber-foreground, #6e7681);
             background: var(--vscode-editor-background); user-select: none; pointer-events: none; }
  .codeband { position: absolute; left: var(--gutter-w); right: 0; z-index: 0; display: none;
              background: var(--vscode-editor-rangeHighlightBackground, rgba(127,127,127,.12)); pointer-events: none; }
  .describe-btn { position: absolute; z-index: 7; display: none; cursor: pointer; font: 500 12px var(--vscode-font-family);
                  padding: 4px 10px; border-radius: 6px; color: var(--vscode-button-foreground, #fff);
                  background: var(--vscode-button-background, #0e639c); border: 1px solid var(--vscode-focusBorder, #007fd4);
                  box-shadow: 0 2px 6px rgba(0,0,0,.35); }
  .describe-btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }

  .hljs-comment, .hljs-quote, .hljs-doctag { color: #6a9955; font-style: italic; }
  .hljs-keyword, .hljs-literal, .hljs-selector-tag, .hljs-built_in { color: #569cd6; }
  .hljs-string, .hljs-meta .hljs-string { color: #ce9178; }
  .hljs-number, .hljs-symbol { color: #b5cea8; }
  .hljs-title, .hljs-name, .hljs-title.function_ { color: #dcdcaa; }
  .hljs-attr, .hljs-attribute, .hljs-variable, .hljs-params, .hljs-template-variable { color: #9cdcfe; }
  .hljs-type, .hljs-title.class_ { color: #4ec9b0; }
  .hljs-meta, .hljs-meta .hljs-keyword { color: #c586c0; }

  /* right pane */
  .right-pane { position: relative; flex: 1 1 auto; min-width: 0; height: 100%; overflow: hidden; }

  /* shared markdown styling */
  .md code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
  .md pre { background: var(--vscode-textCodeBlock-background); padding: 10px 12px; border-radius: 6px; overflow: auto; }
  .md pre code { background: none; padding: 0; }
  .md table { border-collapse: collapse; margin: 8px 0; }
  .md th, .md td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; text-align: left; }
  .md blockquote { margin: 8px 0; padding: 4px 12px; opacity: .85; border-left: 3px solid var(--vscode-focusBorder, #007fd4); }
  .md math { font-size: 1.25em; }
  .md eqn, .md math[display="block"] { display: block; margin: 12px 0; overflow: visible; }
  .md math[display="block"] { font-size: 1.4em; }
  .md > :first-child { margin-top: 0; }
  .md h1, .md h2, .md h3 { margin: 12px 0 6px; line-height: 1.25; }
  .block-id { font: 600 11px var(--vscode-font-family); letter-spacing: .05em; text-transform: uppercase; opacity: .5; }

  /* context mode */
  .ctx-pane { position: absolute; inset: 0; overflow: auto; padding: 12px 16px; display: none; }
  .ctx-pane.on { display: block; }
  .ctx-card { padding: 10px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .ctx-card:last-child { border-bottom: 0; }
  .ctx-empty { opacity: .4; font-size: 12px; padding: 12px 0; }

  /* grid mode */
  .grid-pane { position: absolute; inset: 0; overflow: auto; display: none; }
  .grid-pane.on { display: block; }
  .grid-inner { position: relative; }
  .grid-lines { position: absolute; left: 0; right: 0; pointer-events: none; z-index: 0; }
  .cell { position: absolute; left: 0; right: 0; overflow: hidden; z-index: 1;
          border-top: 1px solid var(--vscode-panel-border);
          background: var(--vscode-editor-background); padding: 0 14px; }
  .cell.active { background: var(--vscode-editor-selectionHighlightBackground, rgba(127,127,127,.10)); }
  .cell-inner { position: relative; }
  .cell-head { display: flex; align-items: center; gap: 6px; padding-top: 4px; }
  .cell-tabs { display: inline-flex; gap: 4px; flex-wrap: wrap; }
  .cell-tab { font: 600 10px var(--vscode-font-family); letter-spacing: .04em; text-transform: uppercase;
              padding: 1px 6px; border-radius: 4px; cursor: pointer; opacity: .55;
              border: 1px solid transparent; }
  .cell-tab.active { opacity: 1; border-color: var(--vscode-focusBorder, #007fd4); }
  .cell-btn { cursor: pointer; border: 0; background: transparent; color: var(--vscode-foreground);
              opacity: .6; padding: 0 4px; font-size: 12px; }
  .cell-btn:hover { opacity: 1; }
  .cell-actions { margin-left: auto; display: inline-flex; gap: 2px; }

  /* inline edit */
  .xc-edit-id-row { display: flex; align-items: baseline; gap: 6px; margin: 4px 0 6px; }
  .xc-edit-id-row::before { content: "#"; opacity: .35; font: 600 12px var(--vscode-editor-font-family, monospace); }
  .xc-edit-id { font: 600 11px var(--vscode-font-family); letter-spacing: .06em; text-transform: uppercase;
                color: var(--vscode-foreground); opacity: .7; background: none; border: none; border-radius: 0;
                box-shadow: none; appearance: none; -webkit-appearance: none; outline: none;
                padding: 0 0 2px; border-bottom: 1px solid var(--vscode-panel-border); }
  .xc-edit-id:focus { opacity: 1; border-bottom-color: var(--vscode-focusBorder, #007fd4); }
  .xc-edit-range { font: 12px var(--vscode-editor-font-family, monospace); width: 84px; background: none;
                   border: none; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground);
                   outline: none; padding: 0 0 2px; }
  .xc-edit-range:focus { border-bottom-color: var(--vscode-focusBorder, #007fd4); }
  .xc-edit { width: 100%; box-sizing: border-box; min-height: 110px; resize: vertical;
             font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; line-height: 1.5;
             padding: 8px 10px; border-radius: 6px; color: var(--vscode-input-foreground);
             background: var(--vscode-input-background); border: 1px solid var(--vscode-focusBorder, #007fd4); outline: none; }
  .xc-edit-bar { display: flex; align-items: center; gap: 6px; margin: 6px 0 0; }
  .xc-edit-bar button { font: 500 12px var(--vscode-font-family); cursor: pointer; padding: 3px 12px; border-radius: 4px;
                        border: 1px solid var(--vscode-panel-border); color: var(--vscode-button-foreground, #fff);
                        background: var(--vscode-button-background, #0e639c); }
  .xc-edit-bar button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground, transparent); }
  .xc-edit-bar .danger { margin-left: auto; color: var(--vscode-errorForeground, #e55); background: transparent;
                         border: 1px solid transparent; width: 26px; height: 26px; padding: 0; display: flex;
                         align-items: center; justify-content: center; }
  .xc-edit-bar .danger:hover { border-color: var(--vscode-errorForeground, #e55); }
  .xc-edit-bar .danger svg { width: 14px; height: 14px; }

  .errbar { flex: 0 0 auto; padding: 3px 12px; font-size: 12px; color: var(--vscode-errorForeground, #e55);
            background: var(--vscode-inputValidation-errorBackground, transparent);
            border-top: 1px solid var(--vscode-panel-border); }
  .errbar:empty { display: none; }
</style>
</head>
<body>
  <div class="curtain" id="curtain">
    <div class="modes" id="modes">
      <button data-mode="context">Контекст</button>
      <button data-mode="grid">Сетка</button>
    </div>
    <button id="swap" class="swap-btn" title="Поменять стороны" aria-label="Поменять стороны">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2 5.5h9M8 2.5l3 3-3 3"/><path d="M14 10.5H5M8 13.5l-3-3 3-3"/>
      </svg>
    </button>
  </div>
  <div class="wrap" id="wrap">
    <div class="slot" id="slotLeft">
      <div id="codePane" class="code-pane">
        <div class="editor">
          <div id="codeband" class="codeband"></div>
          <pre id="hlpre" class="hl" aria-hidden="true"><code id="hl" class="hljs"></code></pre>
          <textarea id="code" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off"></textarea>
          <div id="linenos" class="linenos"></div>
          <button id="describe" class="describe-btn" title="Описать выделенный код">＋ Описать выделение</button>
        </div>
      </div>
    </div>
    <div class="gutter" id="gutter"></div>
    <div class="slot" id="slotRight">
      <div id="rightPane" class="right-pane">
        <div id="ctxPane" class="ctx-pane"></div>
        <div id="gridPane" class="grid-pane"><div id="gridInner" class="grid-inner"><div id="gridLines" class="grid-lines"></div></div></div>
      </div>
    </div>
  </div>
  <div id="errbar" class="errbar"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// --------------------------------------------------------------------------- //
// Git diff isolation (unchanged from v1 — uses extract / extractExplanations).
// --------------------------------------------------------------------------- //

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
  await vscode.commands.executeCommand("vscode.diff", left, right,
    `${baseName(uri)} — ${layer} layer (HEAD ↔ working)`);
}

function baseName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() || uri.path;
}

async function readHead(uri: vscode.Uri): Promise<string | null> {
  try {
    const ext = vscode.extensions.getExtension<any>("vscode.git");
    const git = ext?.isActive ? ext.exports : await ext?.activate();
    const api = git?.getAPI?.(1);
    const repo = api?.repositories?.find((r: any) => uri.path.startsWith(r.rootUri.path));
    if (!repo) return null;
    return await repo.show("HEAD", uri.fsPath);
  } catch {
    return null;
  }
}

class XcLayerFs implements vscode.FileSystemProvider {
  private static readonly scheme = "xc-layer";
  private static store = new Map<string, Uint8Array>();
  private static registered = false;
  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  onDidChangeFile = this._emitter.event;

  static register(key: string, content: string, layer: string): vscode.Uri {
    if (!this.registered) {
      vscode.workspace.registerFileSystemProvider(this.scheme, new XcLayerFs(), { isReadonly: true });
      this.registered = true;
    }
    const path = `/${encodeURIComponent(key)}.${layer === "code" ? "code" : "md"}`;
    this.store.set(path, Buffer.from(content, "utf-8"));
    return vscode.Uri.from({ scheme: this.scheme, path });
  }
  readFile(uri: vscode.Uri): Uint8Array { return XcLayerFs.store.get(uri.path) ?? new Uint8Array(); }
  stat(): vscode.FileStat { return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 }; }
  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(): void {}
  writeFile(): void {}
  delete(): void {}
  rename(): void {}
}
