// Bundled webview logic for the .xc split-view editor (format v2, two modes).
// Bundled by esbuild (IIFE); pulls in highlight.js and the shared rowOwners().

import hljs from "highlight.js/lib/core";
import python from "highlight.js/lib/languages/python";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";

hljs.registerLanguage("python", python);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);

const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const wrap = $("wrap"), curtain = $("curtain"), slotLeft = $("slotLeft"), slotRight = $("slotRight");
const gutter = $("gutter"), swap = $("swap"), modesEl = $("modes");
const codePane = $("codePane"), rightPane = $("rightPane");
const ctxPane = $("ctxPane"), gridPane = $("gridPane"), gridInner = $("gridInner"), gridLines = $("gridLines");
const codeEl = $("code"), hlEl = $("hl"), hlPre = $("hlpre"), lineNos = $("linenos");
const codeBand = $("codeband"), errEl = $("errbar"), describeBtn = $("describe");

const PAD = 12; // editor padding-top (px), must match CSS
let lineHeight = 18;
let explanations = [];   // [{blockId, ranges, startLine, raw, html}]
let codeLineCount = 0;
let codeLang = "plaintext";
let driver = null;       // 'code' | 'grid'
let raf = 0;

const collapsed = new Set();          // collapsed blockIds
const activeTab = new Map();          // startLine -> active blockId
let expandedId = null;                // grid: a single cell expanded to full content
let hoverLine = 0;                    // context: code line currently hovered

const saved = vscode.getState() || {};
let mode = saved.mode === "context" ? "context" : "grid"; // grid is the priority default
let codeOnLeft = saved.codeOnLeft !== false;
let leftFraction = saved.leftFraction || 0.5;
function save() { vscode.setState({ mode, codeOnLeft, leftFraction }); }

// --------------------------------------------------------------------------- layout
function applyOrder() {
  if (codeOnLeft) { slotLeft.appendChild(codePane); slotRight.appendChild(rightPane); }
  else { slotLeft.appendChild(rightPane); slotRight.appendChild(codePane); }
}
function positionSwap() {
  const c = curtain.getBoundingClientRect();
  const g = gutter.getBoundingClientRect();
  swap.style.left = g.left + g.width / 2 - c.left + "px";
  // mode toggle always centered over the description (right) pane
  const r = rightPane.getBoundingClientRect();
  modesEl.style.left = r.left + r.width / 2 - c.left + "px";
}
function setSplit(f) {
  leftFraction = Math.max(0.15, Math.min(0.85, f));
  wrap.style.gridTemplateColumns = leftFraction + "fr 7px " + (1 - leftFraction) + "fr";
  requestAnimationFrame(positionSwap);
}
applyOrder();
setSplit(leftFraction);

swap.addEventListener("click", function () { codeOnLeft = !codeOnLeft; applyOrder(); save(); schedule(); });

let dragging = false;
gutter.addEventListener("pointerdown", function (e) { dragging = true; gutter.classList.add("dragging"); gutter.setPointerCapture(e.pointerId); });
gutter.addEventListener("pointermove", function (e) { if (dragging) { const r = wrap.getBoundingClientRect(); setSplit((e.clientX - r.left) / r.width); } });
gutter.addEventListener("pointerup", function () { if (dragging) { dragging = false; gutter.classList.remove("dragging"); save(); schedule(); } });

// mode toggle
function applyModeButtons() {
  modesEl.querySelectorAll("button").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-mode") === mode);
  });
  ctxPane.classList.toggle("on", mode === "context");
  gridPane.classList.toggle("on", mode === "grid");
}
modesEl.querySelectorAll("button").forEach(function (b) {
  b.addEventListener("click", function () { mode = b.getAttribute("data-mode"); save(); applyModeButtons(); renderRight(); });
});

// --------------------------------------------------------------------------- measure + code highlight
function measure() {
  const cs = getComputedStyle(codeEl);
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font-family:" + cs.fontFamily + ";font-size:" + cs.fontSize + ";line-height:1.5";
  probe.textContent = "Xg";
  document.body.appendChild(probe);
  lineHeight = probe.offsetHeight || 18;
  probe.remove();
}
function escapeHtml(s) { return s.replace(/[&<>]/g, function (c) { return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"; }); }
function rehighlight() {
  const code = codeEl.value;
  hlEl.innerHTML = (codeLang && hljs.getLanguage(codeLang) ? hljs.highlight(code, { language: codeLang, ignoreIllegals: true }).value : escapeHtml(code)) + "\n";
  renderLineNumbers();
}
function renderLineNumbers() {
  const n = codeEl.value.replace(/\n$/, "").split("\n").length;
  const out = [];
  for (let i = 1; i <= n; i++) out.push(i);
  lineNos.textContent = out.join("\n");
  lineNos.scrollTop = codeEl.scrollTop;
}
// highlight band over a [minLine,maxLine] range of code (or null)
let bandRange = null;
function showBand(range) {
  bandRange = range;
  if (!range) { codeBand.style.display = "none"; return; }
  codeBand.style.display = "block";
  codeBand.style.top = PAD + (range.min - 1) * lineHeight - codeEl.scrollTop + "px";
  codeBand.style.height = (range.max - range.min + 1) * lineHeight + "px";
}
function blockSpan(b) {
  let mn = Infinity, mx = 0;
  b.ranges.forEach(function (r) { mn = Math.min(mn, r.start); mx = Math.max(mx, r.end); });
  return mn === Infinity ? null : { min: mn, max: mx };
}

// --------------------------------------------------------------------------- coverage
function blocksForLine(line1) {
  return explanations.filter(function (e) { return e.ranges.some(function (r) { return line1 >= r.start && line1 <= r.end; }); });
}
function caretLine() { return codeEl.value.slice(0, codeEl.selectionStart).split("\n").length; } // 1-indexed
function topVisibleLine() { return Math.floor(codeEl.scrollTop / lineHeight) + 1; }

// --------------------------------------------------------------------------- right pane
function schedule() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(function () { measure(); rehighlight(); hlPre.scrollTop = codeEl.scrollTop; positionSwap(); renderRight(); });
}
function renderRight() {
  if (mode === "grid") renderGrid();
  else renderContext(hoverLine);
}

function mdCard(b) {
  return '<div class="block-id">' + escapeHtml(b.blockId) + "</div><div class=\"md\">" + b.html + "</div>";
}

// ----- context mode -----
function renderContext(line1) {
  const cards = line1 ? blocksForLine(line1) : [];
  if (!cards.length) {
    ctxPane.innerHTML = '<div class="ctx-empty">' +
      (line1 ? "Нет описаний для строки " + line1 + "." : "Наведите курсор на строку кода.") + "</div>";
    return;
  }
  ctxPane.innerHTML = cards.map(function (b) {
    return '<section class="ctx-card" data-block-id="' + escAttr(b.blockId) + '">' + mdCard(b) + "</section>";
  }).join("");
}

// ----- grid mode -----
function groupsByStart() {
  const m = new Map();
  explanations.forEach(function (b) {
    if (b.startLine < 1 || b.startLine > codeLineCount) return;
    if (!m.has(b.startLine)) m.set(b.startLine, []);
    m.get(b.startLine).push(b);
  });
  return m;
}
function activeOf(startLine, group) {
  const want = activeTab.get(startLine);
  const found = group.find(function (b) { return b.blockId === want; });
  return found || group[0];
}
function renderGrid() {
  const groups = groupsByStart();
  const starts = Array.from(groups.keys()).sort(function (a, b) { return a - b; });

  // total height tracks the code editor exactly -> 1:1 scroll lock
  const totalH = codeEl.scrollHeight || (PAD * 2 + codeLineCount * lineHeight);
  gridInner.style.height = totalH + "px";
  gridLines.style.top = PAD + "px";
  gridLines.style.height = codeLineCount * lineHeight + "px";
  gridLines.style.background =
    "repeating-linear-gradient(to bottom, transparent 0, transparent " + (lineHeight - 1) + "px, var(--vscode-panel-border) " + (lineHeight - 1) + "px, var(--vscode-panel-border) " + lineHeight + "px)";
  gridLines.style.opacity = ".5";

  Array.from(gridInner.querySelectorAll(".cell")).forEach(function (c) { c.remove(); });

  // Each block owns a strict span [start_i, start_{i+1}). The next block ends
  // the previous one — so a collapsed block leaves empty grid, never reveals
  // a neighbour underneath it.
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const next = i + 1 < starts.length ? starts[i + 1] : codeLineCount + 1;
    const act = activeOf(s, groups.get(s));
    renderCell(act.blockId, s, next - s, groups);
  }
}
function renderCell(blockId, startRow, span, groups) {
  const b = explanations.find(function (x) { return x.blockId === blockId; });
  if (!b) return;
  const isCollapsed = collapsed.has(blockId);
  const isExpanded = blockId === expandedId && !isCollapsed;
  const spanPx = span * lineHeight;

  const cell = document.createElement("div");
  cell.className = "cell" + (isExpanded ? " expanded" : "");
  cell.setAttribute("data-block-id", blockId);
  cell.style.top = PAD + (startRow - 1) * lineHeight + "px";
  if (isExpanded) {
    // float to full content height over the rows below
  } else if (isCollapsed) {
    cell.style.height = lineHeight + "px";
  } else {
    // grow to fit the text, but never past the next block (real grid shows below)
    cell.style.maxHeight = spanPx + "px";
  }

  const inner = document.createElement("div");
  inner.className = "cell-inner";

  const head = document.createElement("div");
  head.className = "cell-head";
  const group = groups.get(b.startLine) || [b];
  if (group.length > 1) {
    const tabs = document.createElement("div");
    tabs.className = "cell-tabs";
    group.forEach(function (g) {
      const t = document.createElement("span");
      t.className = "cell-tab" + (g.blockId === blockId ? " active" : "");
      t.textContent = g.blockId;
      t.addEventListener("click", function (ev) { ev.stopPropagation(); activeTab.set(b.startLine, g.blockId); expandedId = null; renderGrid(); });
      tabs.appendChild(t);
    });
    head.appendChild(tabs);
  } else {
    const lab = document.createElement("div");
    lab.className = "block-id";
    lab.textContent = blockId;
    head.appendChild(lab);
  }
  const actions = document.createElement("div");
  actions.className = "cell-actions";
  const col = document.createElement("button");
  col.className = "cell-btn";
  col.textContent = isCollapsed ? "▸" : "▾";
  col.title = "Свернуть / развернуть";
  col.addEventListener("click", function (ev) {
    ev.stopPropagation();
    if (isCollapsed) collapsed.delete(blockId);
    else { collapsed.add(blockId); if (expandedId === blockId) expandedId = null; }
    renderGrid();
  });
  const ed = document.createElement("button");
  ed.className = "cell-btn"; ed.innerHTML = PENCIL_SVG; ed.title = "Редактировать";
  ed.addEventListener("click", function (ev) { ev.stopPropagation(); enterEdit(blockId); });
  const add = document.createElement("button");
  add.className = "cell-btn"; add.textContent = "+"; add.title = "Добавить блок на этой строке";
  add.addEventListener("click", function (ev) { ev.stopPropagation(); vscode.postMessage({ type: "insertBlock", line: b.startLine }); });
  actions.appendChild(col); actions.appendChild(ed); actions.appendChild(add);
  head.appendChild(actions);
  inner.appendChild(head);

  if (!isCollapsed) {
    const body = document.createElement("div");
    body.className = "md";
    body.innerHTML = b.html;
    inner.appendChild(body);
  }
  cell.appendChild(inner);
  cell.addEventListener("mouseenter", function () { const sp = blockSpan(b); if (sp) showBand(sp); });
  cell.addEventListener("mouseleave", function () { showBand(null); });
  cell.addEventListener("click", function (ev) {
    if (ev.target && ev.target.closest && ev.target.closest(".cell-btn, .cell-tab")) return;
    ev.stopPropagation();
    if (collapsed.has(blockId)) { collapsed.delete(blockId); expandedId = blockId; }
    else expandedId = expandedId === blockId ? null : blockId;
    renderGrid();
  });
  gridInner.appendChild(cell);
  if (isExpanded) {
    const need = cell.offsetTop + cell.offsetHeight + 16;
    if (need > parseFloat(gridInner.style.height || "0")) gridInner.style.height = need + "px";
  }
}

function escAttr(s) { return String(s).replace(/"/g, "&quot;"); }

// --------------------------------------------------------------------------- scroll sync
codeEl.addEventListener("scroll", function () {
  hlPre.scrollTop = codeEl.scrollTop; hlPre.scrollLeft = codeEl.scrollLeft; lineNos.scrollTop = codeEl.scrollTop;
  if (bandRange) showBand(bandRange);
  if (mode === "grid" && driver === "code" && !expandedId) gridPane.scrollTop = codeEl.scrollTop;
  positionDescribe();
});
gridPane.addEventListener("scroll", function () { if (mode === "grid" && driver === "grid" && !expandedId) codeEl.scrollTop = gridPane.scrollTop; });
codePane.addEventListener("wheel", function () { driver = "code"; }, { passive: true });
codePane.addEventListener("pointerdown", function () { driver = "code"; });
codeEl.addEventListener("focus", function () { driver = "code"; });
codeEl.addEventListener("keydown", function () { driver = "code"; });
gridPane.addEventListener("wheel", function () { driver = "grid"; }, { passive: true });
gridPane.addEventListener("pointerdown", function () { driver = "grid"; });
// click empty grid area collapses the expanded cell
gridPane.addEventListener("click", function (e) {
  if (e.target && e.target.closest && e.target.closest(".cell")) return;
  if (expandedId) { expandedId = null; renderGrid(); }
});

// line under the mouse / caret in the code pane (1-indexed)
function lineAt(clientY) {
  const rect = codeEl.getBoundingClientRect();
  const y = clientY - rect.top + codeEl.scrollTop - PAD;
  return Math.max(1, Math.min(codeLineCount || 1e9, Math.floor(y / lineHeight) + 1));
}
// Context mode: hovering code shows the covering block(s) as bordered cards.
codeEl.addEventListener("mousemove", function (e) {
  if (mode !== "context") return;
  const line = lineAt(e.clientY);
  if (line !== hoverLine) { hoverLine = line; renderContext(line); }
});
// click code: grid -> expand & highlight the covering block; context -> pin it
codeEl.addEventListener("click", function () {
  const covering = blocksForLine(caretLine());
  const ids = new Set(covering.map(function (b) { return b.blockId; }));
  gridInner.querySelectorAll(".cell").forEach(function (c) { c.classList.toggle("active", ids.has(c.getAttribute("data-block-id"))); });
  if (mode === "grid" && covering.length) {
    // expand the most specific (greatest start line) covering block
    const target = covering.reduce(function (a, b) { return b.startLine > a.startLine ? b : a; });
    expandedId = target.blockId;
    renderGrid();
  }
});

// --------------------------------------------------------------------------- code edits
let debounce;
codeEl.addEventListener("input", function () {
  rehighlight(); hlPre.scrollTop = codeEl.scrollTop; positionDescribe();
  clearTimeout(debounce);
  debounce = setTimeout(function () { vscode.postMessage({ type: "editCode", code: codeEl.value }); }, 300);
});

// --------------------------------------------------------------------------- describe selection
function positionDescribe() {
  if (codeEl.selectionStart === codeEl.selectionEnd) { describeBtn.style.display = "none"; return; }
  const endLine = codeEl.value.slice(0, codeEl.selectionEnd).split("\n").length - 1;
  const y = (endLine + 1) * lineHeight - codeEl.scrollTop + 6;
  const h = codePane.getBoundingClientRect().height;
  describeBtn.style.display = "block"; describeBtn.style.left = "auto"; describeBtn.style.right = "14px";
  describeBtn.style.top = Math.max(6, Math.min(h - 34, y)) + "px";
}
codeEl.addEventListener("select", positionDescribe);
codeEl.addEventListener("keyup", positionDescribe);
codeEl.addEventListener("mouseup", positionDescribe);
document.addEventListener("selectionchange", positionDescribe);
describeBtn.addEventListener("click", function () {
  const v = codeEl.value, s = codeEl.selectionStart;
  let e = codeEl.selectionEnd;
  if (e <= s) return;
  if (v[e - 1] === "\n") e--;
  const startLine = v.slice(0, s).split("\n").length;
  const endLine = v.slice(0, e).split("\n").length;
  vscode.postMessage({ type: "describeSelection", startLine: startLine, endLine: endLine });
  describeBtn.style.display = "none";
});

// --------------------------------------------------------------------------- floating editor (mode-agnostic)
let editorEl = null;
function closeEditor() { if (editorEl) { editorEl.remove(); editorEl = null; } }
function enterEdit(blockId) {
  closeEditor();
  const b = explanations.find(function (x) { return x.blockId === blockId; });
  if (!b) return;
  const wrapDiv = document.createElement("div");
  wrapDiv.className = "xc-editor md";
  wrapDiv.style.cssText = "position:absolute;left:10px;right:10px;top:10px;z-index:20;padding:12px 14px;border-radius:8px;max-height:calc(100% - 20px);overflow:auto;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));border:1px solid var(--vscode-focusBorder,#007fd4);box-shadow:0 6px 20px rgba(0,0,0,.4);";

  const idRow = document.createElement("div"); idRow.className = "xc-edit-id-row";
  const idInput = document.createElement("input"); idInput.className = "xc-edit-id"; idInput.value = blockId; idInput.spellcheck = false;
  const sizeId = function () {
    const cs = getComputedStyle(idInput);
    const p = document.createElement("span");
    p.style.cssText = "position:absolute;visibility:hidden;white-space:pre;text-transform:uppercase;font:" + cs.font + ";letter-spacing:" + cs.letterSpacing;
    p.textContent = idInput.value || " "; document.body.appendChild(p); idInput.style.width = p.offsetWidth + 6 + "px"; p.remove();
  };
  const rangeInput = document.createElement("input"); rangeInput.className = "xc-edit-range";
  rangeInput.value = b.ranges.map(function (r) { return r.start === r.end ? r.start : r.start + "-" + r.end; }).join(", ");
  rangeInput.title = "Строки кода, напр. 5-8, 12";
  const lab = document.createElement("span"); lab.className = "block-id"; lab.textContent = "строки";
  idRow.appendChild(idInput); idRow.appendChild(lab); idRow.appendChild(rangeInput);

  const ta = document.createElement("textarea"); ta.className = "xc-edit"; ta.value = b.raw || "";

  const bar = document.createElement("div"); bar.className = "xc-edit-bar";
  const saveB = document.createElement("button"); saveB.textContent = "Сохранить";
  const cancelB = document.createElement("button"); cancelB.className = "secondary"; cancelB.textContent = "Отмена";
  const delB = document.createElement("button"); delB.className = "danger"; delB.title = "Удалить блок (Ctrl/Cmd+Z — вернуть)"; delB.innerHTML = TRASH_SVG;
  bar.appendChild(saveB); bar.appendChild(cancelB); bar.appendChild(delB);

  wrapDiv.appendChild(idRow); wrapDiv.appendChild(ta); wrapDiv.appendChild(bar);
  rightPane.appendChild(wrapDiv);
  editorEl = wrapDiv;
  requestAnimationFrame(sizeId);
  idInput.addEventListener("input", sizeId);
  ta.focus();
  ta.style.height = Math.max(110, ta.scrollHeight + 4) + "px";

  function parseRangeInput(s) {
    const out = [];
    s.split(",").forEach(function (part) {
      part = part.trim(); if (!part) return;
      if (part.indexOf("-") >= 0) { const a = part.split("-"); const x = parseInt(a[0], 10), y = parseInt(a[1], 10); if (!isNaN(x) && !isNaN(y)) out.push({ start: Math.min(x, y), end: Math.max(x, y) }); }
      else { const n = parseInt(part, 10); if (!isNaN(n)) out.push({ start: n, end: n }); }
    });
    return out;
  }
  saveB.addEventListener("click", function () {
    vscode.postMessage({ type: "editExplanation", blockId: blockId, newId: idInput.value.trim(), ranges: parseRangeInput(rangeInput.value), markdown: ta.value });
    closeEditor();
  });
  cancelB.addEventListener("click", closeEditor);
  delB.addEventListener("click", function () { vscode.postMessage({ type: "deleteBlock", blockId: blockId }); closeEditor(); });
}
// click outside the floating editor closes it
document.addEventListener("pointerdown", function (e) {
  if (!editorEl) return;
  const t = e.target;
  if (t && t.closest && (t.closest(".xc-editor") || t.closest(".cell-btn") || t.closest(".ctx-card"))) return;
  closeEditor();
});

// undo / redo forwarded to the host
window.addEventListener("keydown", function (e) {
  if (!(e.metaKey || e.ctrlKey)) return;
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "TEXTAREA" || tag === "INPUT") return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); vscode.postMessage({ type: "undo" }); }
  else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); vscode.postMessage({ type: "redo" }); }
});

const PENCIL_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M10 3h3v1h-1v9.5l-.5.5h-7l-.5-.5V4H3V3h3V1.5l.5-.5h3l.5.5V3zM7 3h2V2H7v1zM5 4v9h6V4H5z"/></svg>';

// --------------------------------------------------------------------------- receive document
window.addEventListener("message", function (e) {
  const m = e.data;
  if (m.type !== "doc") return;
  const pos = codeEl.selectionStart, top = codeEl.scrollTop;
  if (codeEl.value !== m.code) codeEl.value = m.code;
  try { codeEl.setSelectionRange(pos, pos); } catch (err) {}
  codeLang = m.codeLang || "plaintext";
  explanations = m.explanations || [];
  codeLineCount = m.codeLineCount || 0;
  // prune stale UI state
  const ids = new Set(explanations.map(function (b) { return b.blockId; }));
  Array.from(collapsed).forEach(function (id) { if (!ids.has(id)) collapsed.delete(id); });
  errEl.textContent = m.errors && m.errors.length ? "⚠ " + m.errors.join("; ") : "";
  rehighlight();
  codeEl.scrollTop = top; hlPre.scrollTop = top;
  applyModeButtons();
  schedule();
  if (mode === "grid") requestAnimationFrame(function () { gridPane.scrollTop = codeEl.scrollTop; });
  if (m.autoEditBlockId) requestAnimationFrame(function () { enterEdit(m.autoEditBlockId); });
});

window.addEventListener("resize", function () { schedule(); positionDescribe(); });
measure();
applyModeButtons();
rehighlight();
requestAnimationFrame(function () { requestAnimationFrame(positionSwap); });
vscode.postMessage({ type: "ready" });
