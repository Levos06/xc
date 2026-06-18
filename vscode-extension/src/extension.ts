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
  setExplanationBody,
  insertExplanationBefore,
  describeSelection,
} from "./xcParser";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

// LaTeX math support: $inline$ and $$display$$ rendered to MathML via Temml
// (no web-font assets needed, so it works offline inside a webview).
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const texmath = require("markdown-it-texmath");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const temml = require("temml");
  md.use(texmath, {
    engine: {
      renderToString: (tex: string, opts: any) =>
        temml.renderToString(tex, {
          displayMode: !!(opts && opts.displayMode),
          throwOnError: false,
        }),
    },
    delimiters: "dollars",
  });
} catch {
  // Math rendering is optional; prose still renders without it.
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

    const pushToWebview = () => {
      const text = document.getText();
      const res = parse(text);
      const blocks = codeBlocks(res);
      const explBlocks = res.blocks.filter((b) => b.kind === "EXPLANATION");
      const rawById: Record<string, string> = {};
      const explanationHtml = explBlocks
        .map((b) => {
          const body = res.lines.slice(b.bodyStart, b.bodyEnd).join("\n");
          rawById[b.blockId] = body.replace(/\s+$/, "");
          return `<section class="xc-block" data-block-id="${escapeAttr(b.blockId)}">
            <div class="xc-block-id">${escapeHtml(b.blockId)}</div>
            <div class="xc-body">${md.render(body)}</div>
          </section>`;
        })
        .join("\n");

      panel.webview.postMessage({
        type: "doc",
        code: extract(text),
        codeLang: (res.frontmatterText.match(/language:\s*"?([\w+#-]+)"?/)?.[1]
          || blocks[0]?.fenceLang || "plaintext").toLowerCase(),
        explanationHtml,
        rawById,
        explanationOrder: explBlocks.map((b) => b.blockId),
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

    const replaceDoc = async (newText: string) => {
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
      pushToWebview();
    };

    const uniqueNoteId = (text: string): string => {
      const taken = new Set(parse(text).blocks.map((b) => b.blockId));
      let n = 1;
      while (taken.has(`note_${n}`)) n++;
      return `note_${n}`;
    };

    panel.webview.onDidReceiveMessage(async (msg) => {
      const text = document.getText();
      try {
        if (msg.type === "editCode") {
          await replaceDoc(spliceCode(text, msg.code));
        } else if (msg.type === "editExplanation") {
          await replaceDoc(setExplanationBody(text, msg.blockId, msg.markdown));
        } else if (msg.type === "insertBlock") {
          const id = uniqueNoteId(text);
          await replaceDoc(
            insertExplanationBefore(
              text,
              msg.beforeBlockId ?? null,
              id,
              "## Новый блок\n\nОпишите здесь…"
            )
          );
        } else if (msg.type === "describeSelection") {
          const r = describeSelection(
            text,
            msg.startLine,
            msg.endLine,
            "## Описание выделенного фрагмента\n\nОпишите здесь…"
          );
          if (!r.ok) {
            vscode.window.showWarningMessage(r.message || "Не удалось привязать описание.");
          } else {
            await replaceDoc(r.text!);
          }
        } else if (msg.type === "ready") {
          pushToWebview();
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`xc: ${e?.message || e}`);
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
  :root { color-scheme: light dark; --curtain-h: 28px; }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: flex; flex-direction: column;
         background: var(--vscode-editor-background);
         font-family: var(--vscode-font-family); color: var(--vscode-foreground); }

  /* thin top "curtain": holds the swap button above the divider */
  .curtain { position: relative; flex: 0 0 var(--curtain-h); height: var(--curtain-h);
             border-bottom: 1px solid var(--vscode-panel-border);
             background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)); }
  .swap-btn {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: 24px; height: 24px; border-radius: 6px; padding: 0; z-index: 6; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    color: var(--vscode-icon-foreground, var(--vscode-foreground));
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border); box-shadow: 0 1px 3px rgba(0,0,0,.3);
  }
  .swap-btn:hover { background: var(--vscode-toolbar-hoverBackground);
                    border-color: var(--vscode-focusBorder, #007fd4); }
  .swap-btn svg { width: 14px; height: 14px; display: block; }

  .wrap { display: grid; grid-template-columns: 1fr 7px 1fr; flex: 1 1 auto; min-height: 0; }
  .slot { overflow: hidden; min-width: 0; height: 100%; display: flex; }
  .gutter { cursor: col-resize; background: var(--vscode-panel-border); transition: background .1s; }
  .gutter:hover, .gutter.dragging { background: var(--vscode-focusBorder, #007fd4); }

  /* ---- left: syntax-highlighted editor (transparent textarea over <pre>) ---- */
  .code-pane { position: relative; flex: 1 1 auto; min-width: 0;
               background: var(--vscode-editor-background); }
  .editor { position: absolute; inset: 0; }
  .editor pre.hl, .editor textarea {
    margin: 0; border: 0; background: transparent; position: absolute; inset: 0;
    width: 100%; height: 100%; padding: 12px; tab-size: 4;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px); line-height: 1.5; letter-spacing: 0;
    white-space: pre;
  }
  .editor pre.hl { overflow: hidden; z-index: 0; pointer-events: none;
                   color: var(--vscode-editor-foreground); }
  .editor pre.hl code { font: inherit; white-space: pre; display: block; background: none; }
  .editor textarea {
    z-index: 1; resize: none; outline: none; overflow: auto;
    color: transparent; caret-color: var(--vscode-editor-foreground);
  }
  .editor textarea::selection { background: var(--vscode-editor-selectionBackground, #264f78); }

  /* floating "describe selection" button */
  .describe-btn {
    position: absolute; z-index: 7; display: none; cursor: pointer;
    font: 500 12px var(--vscode-font-family); padding: 4px 10px; border-radius: 6px;
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #0e639c);
    border: 1px solid var(--vscode-focusBorder, #007fd4); box-shadow: 0 2px 6px rgba(0,0,0,.35);
  }
  .describe-btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }

  /* highlight.js token palette (VS Code Dark+ flavoured) */
  .hljs-comment, .hljs-quote, .hljs-doctag { color: #6a9955; font-style: italic; }
  .hljs-keyword, .hljs-literal, .hljs-selector-tag, .hljs-built_in { color: #569cd6; }
  .hljs-string, .hljs-meta .hljs-string { color: #ce9178; }
  .hljs-number, .hljs-symbol { color: #b5cea8; }
  .hljs-title, .hljs-name, .hljs-title.function_ { color: #dcdcaa; }
  .hljs-attr, .hljs-attribute, .hljs-variable, .hljs-params, .hljs-template-variable { color: #9cdcfe; }
  .hljs-type, .hljs-title.class_ { color: #4ec9b0; }
  .hljs-meta, .hljs-meta .hljs-keyword { color: #c586c0; }

  /* ---- right: rendered explanations — flowing, no frames ---- */
  .doc-pane { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 4px 22px 40vh; }
  .xc-block {
    position: relative; padding: 10px 0 10px 12px; margin: 0;
    border-left: 2px solid transparent; scroll-margin-top: 12px;
  }
  .xc-block.active { border-left-color: var(--vscode-focusBorder, #007fd4); }
  .xc-block-id {
    font: 600 11px var(--vscode-font-family); letter-spacing: .05em; text-transform: uppercase;
    opacity: .45; margin: 2px 0 6px;
  }
  .xc-body > :first-child { margin-top: 0; }
  .xc-block h1, .xc-block h2, .xc-block h3 { margin: 14px 0 6px; line-height: 1.25; }
  .doc-pane code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
  .doc-pane pre { background: var(--vscode-textCodeBlock-background); padding: 10px 12px; border-radius: 6px; overflow: auto; }
  .doc-pane pre code { background: none; padding: 0; }
  .doc-pane table { border-collapse: collapse; margin: 8px 0; }
  .doc-pane th, .doc-pane td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; text-align: left; }
  .doc-pane blockquote { margin: 8px 0; padding: 4px 12px; opacity: .85;
                         border-left: 3px solid var(--vscode-focusBorder, #007fd4); }
  /* MathML (Temml) — larger, as requested */
  .doc-pane math { font-size: 1.28em; }
  .doc-pane eqn, .doc-pane .eqn, .doc-pane math[display="block"] {
    display: block; margin: 12px 0; overflow-x: auto; }
  .doc-pane math[display="block"] { font-size: 1.5em; }

  /* inline editing */
  .xc-edit { width: 100%; box-sizing: border-box; min-height: 120px; resize: vertical;
             font-family: var(--vscode-editor-font-family, monospace); font-size: 13px;
             line-height: 1.5; padding: 8px 10px; border-radius: 6px;
             color: var(--vscode-input-foreground); background: var(--vscode-input-background);
             border: 1px solid var(--vscode-focusBorder, #007fd4); outline: none; }
  .xc-edit-bar { display: flex; gap: 6px; margin: 6px 0 0; }
  .xc-edit-bar button { font: 500 12px var(--vscode-font-family); cursor: pointer;
             padding: 3px 12px; border-radius: 4px; border: 1px solid var(--vscode-panel-border);
             color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c); }
  .xc-edit-bar button.secondary { color: var(--vscode-foreground);
             background: var(--vscode-button-secondaryBackground, transparent); }
  .xc-edit-hint { opacity: .6; font-size: 11px; align-self: center; margin-left: auto; }

  /* per-block edit pencil */
  .edit-btn {
    position: absolute; top: 8px; right: 0; width: 22px; height: 22px; border-radius: 5px;
    cursor: pointer; opacity: 0; transition: opacity .1s; padding: 0; font-size: 12px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    color: var(--vscode-foreground); background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border); }
  .xc-block:hover .edit-btn { opacity: .9; }
  .edit-btn:hover { border-color: var(--vscode-focusBorder, #007fd4); }

  /* "+" add-block affordance between blocks */
  .add-zone { position: relative; height: 10px; margin: 0; }
  .add-zone .add-btn {
    position: absolute; top: 50%; left: 0; transform: translateY(-50%);
    width: 20px; height: 20px; border-radius: 50%; cursor: pointer; opacity: 0;
    display: flex; align-items: center; justify-content: center; font-size: 15px; line-height: 1;
    padding: 0; transition: opacity .1s;
    color: var(--vscode-foreground); background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border); }
  .add-zone::before { content: ""; position: absolute; top: 50%; left: 26px; right: 0; height: 1px;
                      background: var(--vscode-panel-border); opacity: 0; transition: opacity .1s; }
  .add-zone:hover .add-btn, .add-zone:hover::before { opacity: 1; }
  .add-zone .add-btn:hover { border-color: var(--vscode-focusBorder, #007fd4); }

  .errbar { flex: 0 0 auto; padding: 3px 12px; font-size: 12px;
            color: var(--vscode-errorForeground, #e55);
            background: var(--vscode-inputValidation-errorBackground, transparent);
            border-top: 1px solid var(--vscode-panel-border); }
  .errbar:empty { display: none; }
</style>
</head>
<body>
  <div class="curtain" id="curtain">
    <button id="swap" class="swap-btn" title="Поменять стороны местами" aria-label="Поменять стороны">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2 5.5h9M8 2.5l3 3-3 3"/><path d="M14 10.5H5M8 13.5l-3-3 3-3"/>
      </svg>
    </button>
  </div>
  <div class="wrap" id="wrap">
    <div class="slot" id="slotLeft">
      <div id="codePane" class="code-pane">
        <div class="editor">
          <pre id="hlpre" class="hl" aria-hidden="true"><code id="hl" class="hljs"></code></pre>
          <textarea id="code" spellcheck="false" autocapitalize="off"
                    autocomplete="off" autocorrect="off" wrap="off"></textarea>
          <button id="describe" class="describe-btn" title="Описать выделенный код">＋ Описать выделение</button>
        </div>
      </div>
    </div>
    <div class="gutter" id="gutter"></div>
    <div class="slot" id="slotRight">
      <div id="docPane" class="doc-pane"><div id="doc"></div></div>
    </div>
  </div>
  <div id="errbar" class="errbar"></div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
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
