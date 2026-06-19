// Bundled webview logic for the .xc split-view editor.
// Bundled by esbuild (IIFE) so it can pull in highlight.js for the left pane.

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

const wrap = document.getElementById("wrap");
const curtain = document.getElementById("curtain");
const slotLeft = document.getElementById("slotLeft");
const slotRight = document.getElementById("slotRight");
const gutter = document.getElementById("gutter");
const swap = document.getElementById("swap");
const codePane = document.getElementById("codePane");
const docPane = document.getElementById("docPane");
const codeEl = document.getElementById("code");
const hlEl = document.getElementById("hl");
const hlPre = document.getElementById("hlpre");
const lineNos = document.getElementById("linenos");
const codeBand = document.getElementById("codeband");
const docEl = document.getElementById("doc");
const errEl = document.getElementById("errbar");
const describeBtn = document.getElementById("describe");

const PADDING_TOP = 12; // must match the editor's padding-top in CSS
let hoverBand = null;   // the CodeView currently band-highlighted (doc hover)

let views = [];
let rawById = {};
let codeLang = "plaintext";
let lineHeight = 18;
let codeAnchors = [0];
let docAnchors = [0];
let splineCD = null; // code scrollTop -> doc scrollTop
let splineDC = null; // doc scrollTop -> code scrollTop
let driver = null; // 'code' | 'doc'
let raf = 0;

// ---------- persisted layout ----------
const saved = vscode.getState() || {};
let codeOnLeft = saved.codeOnLeft !== false;
let leftFraction = saved.leftFraction || 0.5;
function save() {
  vscode.setState({ codeOnLeft: codeOnLeft, leftFraction: leftFraction });
}

function applyOrder() {
  if (codeOnLeft) {
    slotLeft.appendChild(codePane);
    slotRight.appendChild(docPane);
  } else {
    slotLeft.appendChild(docPane);
    slotRight.appendChild(codePane);
  }
}
function positionSwap() {
  // Centre the swap button on the actual rendered divider, measured relative to
  // the curtain (so it stays correct regardless of margins / scrollbars).
  const g = gutter.getBoundingClientRect();
  const c = curtain.getBoundingClientRect();
  swap.style.left = g.left + g.width / 2 - c.left + "px";
}
function setSplit(f) {
  leftFraction = Math.max(0.15, Math.min(0.85, f));
  wrap.style.gridTemplateColumns = leftFraction + "fr 7px " + (1 - leftFraction) + "fr";
  requestAnimationFrame(positionSwap);
}

applyOrder();
setSplit(leftFraction);

swap.addEventListener("click", function () {
  codeOnLeft = !codeOnLeft;
  applyOrder();
  save();
  scheduleAnchors();
});

// ---------- draggable gutter ----------
let dragging = false;
gutter.addEventListener("pointerdown", function (e) {
  dragging = true;
  gutter.classList.add("dragging");
  gutter.setPointerCapture(e.pointerId);
});
gutter.addEventListener("pointermove", function (e) {
  if (!dragging) return;
  const r = wrap.getBoundingClientRect();
  setSplit((e.clientX - r.left) / r.width);
});
gutter.addEventListener("pointerup", function () {
  if (!dragging) return;
  dragging = false;
  gutter.classList.remove("dragging");
  save();
  scheduleAnchors();
});

// ---------- measurement ----------
function measure() {
  const cs = getComputedStyle(codeEl);
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;white-space:pre;" +
    "font-family:" + cs.fontFamily + ";font-size:" + cs.fontSize + ";line-height:1.5";
  probe.textContent = "Xg";
  document.body.appendChild(probe);
  lineHeight = probe.offsetHeight || 18;
  probe.remove();
}

// ---------- syntax highlighting ----------
function escapeHtml(s) {
  return s.replace(/[&<>]/g, function (c) {
    return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
  });
}
function rehighlight() {
  const code = codeEl.value;
  let html;
  if (codeLang && hljs.getLanguage(codeLang)) {
    html = hljs.highlight(code, { language: codeLang, ignoreIllegals: true }).value;
  } else {
    html = escapeHtml(code);
  }
  hlEl.innerHTML = html + "\n";
  renderLineNumbers();
}

function renderLineNumbers() {
  const n = codeEl.value.replace(/\n$/, "").split("\n").length;
  const out = [];
  for (let i = 1; i <= n; i++) out.push(i);
  lineNos.textContent = out.join("\n");
  lineNos.scrollTop = codeEl.scrollTop;
}

// Highlight band over the code lines belonging to a hovered explanation block.
function showBand(view) {
  hoverBand = view || null;
  if (!hoverBand) {
    codeBand.style.display = "none";
    return;
  }
  codeBand.style.display = "block";
  codeBand.style.top = PADDING_TOP + hoverBand.flatStartLine * lineHeight - codeEl.scrollTop + "px";
  codeBand.style.height = hoverBand.lineCount * lineHeight + "px";
}

// ---------- scroll mirror (textarea -> highlight pre + gutter + band) ----------
codeEl.addEventListener("scroll", function () {
  hlPre.scrollTop = codeEl.scrollTop;
  hlPre.scrollLeft = codeEl.scrollLeft;
  lineNos.scrollTop = codeEl.scrollTop;
  if (hoverBand) showBand(hoverBand);
  if (driver === "code") syncDocFromCode();
  positionDescribe();
});

// ---------- anchor-interpolated smooth sync ----------
function cssEsc(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}
function recomputeAnchors() {
  const codeMax = Math.max(0, codeEl.scrollHeight - codeEl.clientHeight);
  const docMax = Math.max(0, docPane.scrollHeight - docPane.clientHeight);
  const docRect = docPane.getBoundingClientRect();

  // Build raw anchor pairs: (0,0), one per block, then the (max,max) endpoint.
  const raw = [[0, 0]];
  for (const v of views) {
    const el = docPane.querySelector('[data-block-id="' + cssEsc(v.blockId) + '"]');
    const dy = el ? el.getBoundingClientRect().top - docRect.top + docPane.scrollTop : 0;
    raw.push([v.flatStartLine * lineHeight, dy]);
  }

  // Keep pairs strictly increasing on BOTH axes (invertible), clamped to the
  // reachable range; then force the final pair to exactly (codeMax, docMax) so
  // the two panes always hit their ends together.
  const cs = [];
  const ds = [];
  let lc = -1;
  let ld = -1;
  for (const p of raw) {
    const c = Math.max(0, Math.min(codeMax, p[0]));
    const d = Math.max(0, Math.min(docMax, p[1]));
    if (c > lc && d > ld) { cs.push(c); ds.push(d); lc = c; ld = d; }
  }
  while (cs.length && (cs[cs.length - 1] >= codeMax || ds[ds.length - 1] >= docMax)) {
    cs.pop();
    ds.pop();
  }
  cs.push(codeMax);
  ds.push(docMax);
  codeAnchors = cs;
  docAnchors = ds;
  splineCD = buildSpline(codeAnchors, docAnchors);
  splineDC = buildSpline(docAnchors, codeAnchors);
}

// Monotone cubic (Fritsch–Carlson PCHIP): smooth C1 mapping through the
// anchors that never overshoots — so scrolling stays monotonic and gentle.
function buildSpline(xs, ys) {
  const n = xs.length;
  const m = new Array(n);
  if (n < 2) { m[0] = 0; return { xs: xs, ys: ys, m: m }; }
  const h = new Array(n - 1);
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return { xs: xs, ys: ys, m: m };
}
function evalSpline(sp, x) {
  const xs = sp.xs, ys = sp.ys, m = sp.m;
  const n = xs.length;
  if (n < 2 || x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let k = 0;
  while (k < n - 1 && x > xs[k + 1]) k++;
  const hk = xs[k + 1] - xs[k];
  const t = (x - xs[k]) / hk;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * ys[k] + h10 * hk * m[k] + h01 * ys[k + 1] + h11 * hk * m[k + 1];
}
function scheduleAnchors() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(function () {
    measure();
    recomputeAnchors();
    rehighlight();
    hlPre.scrollTop = codeEl.scrollTop;
    positionSwap();
  });
}
// The explanation block whose CODE contains the caret line (null if the caret
// sits in code that no block describes).
function blockForCaret() {
  const line = codeEl.value.slice(0, codeEl.selectionStart).split("\n").length - 1;
  for (const v of views) {
    if (line >= v.flatStartLine && line < v.flatStartLine + v.lineCount) return v.blockId;
  }
  return null;
}
function highlight(id) {
  docPane.querySelectorAll(".xc-block").forEach(function (el) {
    el.classList.toggle("active", !!id && el.getAttribute("data-block-id") === id);
  });
}
function syncDocFromCode() {
  if (splineCD) docPane.scrollTop = evalSpline(splineCD, codeEl.scrollTop);
}
function syncCodeFromDoc() {
  if (splineDC) codeEl.scrollTop = evalSpline(splineDC, docPane.scrollTop);
  hlPre.scrollTop = codeEl.scrollTop;
}

// ---------- driver election (prevents feedback loops) ----------
function setDriver(name) {
  return function () { driver = name; };
}
codePane.addEventListener("wheel", setDriver("code"), { passive: true });
codePane.addEventListener("pointerdown", setDriver("code"));
codeEl.addEventListener("focus", setDriver("code"));
codeEl.addEventListener("keydown", setDriver("code"));
// Highlight the explanation of the block the user just clicked into (only then).
codeEl.addEventListener("click", function () { highlight(blockForCaret()); });
docPane.addEventListener("wheel", setDriver("doc"), { passive: true });
docPane.addEventListener("pointerdown", setDriver("doc"));
docPane.addEventListener("scroll", function () {
  if (driver === "doc") syncCodeFromDoc();
});

// Hovering an explanation block highlights its code lines on the left.
docPane.addEventListener("mouseover", function (e) {
  const blk = e.target.closest ? e.target.closest(".xc-block") : null;
  if (!blk) return;
  const id = blk.getAttribute("data-block-id");
  const v = views.find(function (x) { return x.blockId === id; });
  if (!v) { showBand(null); return; }
  if (!hoverBand || hoverBand.blockId !== v.blockId) showBand(v);
});
docPane.addEventListener("mouseleave", function () { showBand(null); });

// ---------- code edits ----------
let debounce;
codeEl.addEventListener("input", function () {
  rehighlight();
  hlPre.scrollTop = codeEl.scrollTop;
  hlPre.scrollLeft = codeEl.scrollLeft;
  positionDescribe();
  clearTimeout(debounce);
  debounce = setTimeout(function () {
    vscode.postMessage({ type: "editCode", code: codeEl.value });
  }, 300);
});

// ---------- "describe selection" floating button ----------
function positionDescribe() {
  if (codeEl.selectionStart === codeEl.selectionEnd) {
    describeBtn.style.display = "none";
    return;
  }
  const endLine = codeEl.value.slice(0, codeEl.selectionEnd).split("\n").length - 1;
  const y = (endLine + 1) * lineHeight - codeEl.scrollTop + 6;
  const h = codePane.getBoundingClientRect().height;
  describeBtn.style.display = "block";
  describeBtn.style.left = "auto";
  describeBtn.style.right = "14px";
  describeBtn.style.top = Math.max(6, Math.min(h - 34, y)) + "px";
}
codeEl.addEventListener("select", positionDescribe);
codeEl.addEventListener("keyup", positionDescribe);
codeEl.addEventListener("mouseup", positionDescribe);
// Fires on every caret/selection change (incl. collapsing a selection by a
// click), so the button vanishes the instant the selection is cleared.
document.addEventListener("selectionchange", positionDescribe);
describeBtn.addEventListener("click", function () {
  const v = codeEl.value;
  const s = codeEl.selectionStart;
  let e = codeEl.selectionEnd;
  if (e <= s) return;
  if (v[e - 1] === "\n") e--; // don't count a trailing line break as a whole extra line
  const startLine = v.slice(0, s).split("\n").length - 1;
  const endLine = v.slice(0, e).split("\n").length - 1;
  vscode.postMessage({ type: "describeSelection", startLine: startLine, endLine: endLine + 1 });
  describeBtn.style.display = "none";
});

// ---------- inline editing of explanation blocks ----------
function closeAllEdits() {
  docEl.querySelectorAll(".xc-block").forEach(function (b) {
    const ta = b.querySelector(".xc-edit");
    if (ta) ta.remove();
    const idr = b.querySelector(".xc-edit-id-row");
    if (idr) idr.remove();
    const bar = b.querySelector(".xc-edit-bar");
    if (bar) bar.remove();
    const chip = b.querySelector(".xc-block-id");
    if (chip) chip.style.display = "";
    const body = b.querySelector(".xc-body");
    if (body) body.style.display = "";
  });
}
function enterEdit(blk, id) {
  if (blk.querySelector(".xc-edit")) return;
  closeAllEdits(); // editing another block closes the previous editor
  const body = blk.querySelector(".xc-body");
  const idChip = blk.querySelector(".xc-block-id");
  if (idChip) idChip.style.display = "none"; // the input replaces the title chip

  // editable block name, styled as the title itself
  const idRow = document.createElement("div");
  idRow.className = "xc-edit-id-row";
  const idInput = document.createElement("input");
  idInput.className = "xc-edit-id";
  idInput.value = id;
  idInput.spellcheck = false;
  idInput.title = "Имя блока";
  const sizeId = function () {
    // Measure the rendered width (uppercase + letter-spacing) so nothing clips.
    const cs = getComputedStyle(idInput);
    const probe = document.createElement("span");
    probe.style.cssText =
      "position:absolute;visibility:hidden;white-space:pre;text-transform:uppercase;" +
      "font:" + cs.font + ";letter-spacing:" + cs.letterSpacing;
    probe.textContent = idInput.value || " ";
    document.body.appendChild(probe);
    idInput.style.width = probe.offsetWidth + 6 + "px";
    probe.remove();
  };
  idRow.appendChild(idInput);
  requestAnimationFrame(sizeId);
  idInput.addEventListener("input", sizeId);

  const ta = document.createElement("textarea");
  ta.className = "xc-edit";
  ta.value = rawById[id] || "";
  const bar = document.createElement("div");
  bar.className = "xc-edit-bar";
  const saveB = document.createElement("button");
  saveB.textContent = "Сохранить";
  const cancelB = document.createElement("button");
  cancelB.className = "secondary";
  cancelB.textContent = "Отмена";
  const delB = document.createElement("button");
  delB.className = "danger";
  delB.title = "Удалить блок описания (Ctrl/Cmd+Z — вернуть)";
  delB.innerHTML = TRASH_SVG;
  bar.appendChild(saveB);
  bar.appendChild(cancelB);
  bar.appendChild(delB);

  if (body) body.style.display = "none";
  blk.insertBefore(idRow, idChip || blk.firstChild); // name sits where the title was
  blk.appendChild(ta);
  blk.appendChild(bar);
  ta.focus();
  ta.style.height = Math.max(120, ta.scrollHeight + 4) + "px";

  function close() {
    idRow.remove();
    ta.remove();
    bar.remove();
    if (idChip) idChip.style.display = "";
    if (body) body.style.display = "";
  }
  // Save always closes the editor — even when nothing changed.
  saveB.addEventListener("click", function () {
    vscode.postMessage({
      type: "editExplanation",
      blockId: id,
      newId: idInput.value.trim(),
      markdown: ta.value,
    });
    close();
  });
  cancelB.addEventListener("click", close);
  delB.addEventListener("click", function () {
    vscode.postMessage({ type: "deleteBlock", blockId: id });
    close();
  });
}

// trash icon (codicon-ish)
const TRASH_SVG =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
  '<path d="M10 3h3v1h-1v9.5l-.5.5h-7l-.5-.5V4H3V3h3V1.5l.5-.5h3l.5.5V3zM7 3h2V2H7v1zM5 4v9h6V4H5zm2 1h1v7H7V5zm2 0h1v7H9V5z"/>' +
  "</svg>";
docPane.addEventListener("dblclick", function (e) {
  const blk = e.target.closest ? e.target.closest(".xc-block") : null;
  if (blk) enterEdit(blk, blk.getAttribute("data-block-id"));
});

// Any pointer press outside the edit widget closes the open editor.
document.addEventListener("pointerdown", function (e) {
  const t = e.target;
  if (t && t.closest && t.closest(".xc-edit, .xc-edit-id, .xc-edit-id-row, .xc-edit-bar")) return;
  if (docEl.querySelector(".xc-edit")) closeAllEdits();
});

// Forward undo/redo to the host (which owns the document edit history), unless a
// text field is focused — there the native field undo should win.
window.addEventListener("keydown", function (e) {
  if (!(e.metaKey || e.ctrlKey)) return;
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "TEXTAREA" || tag === "INPUT") return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) {
    e.preventDefault();
    vscode.postMessage({ type: "undo" });
  } else if (k === "y" || (k === "z" && e.shiftKey)) {
    e.preventDefault();
    vscode.postMessage({ type: "redo" });
  }
});

// ---------- add-block "+" affordances + edit pencils ----------
// VS Code "edit" codicon pencil.
const PENCIL_SVG =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
  '<path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z"/>' +
  "</svg>";

function makeAddZone(beforeBlockId) {
  const z = document.createElement("div");
  z.className = "add-zone";
  const hit = document.createElement("div");
  hit.className = "hit";
  const b = document.createElement("button");
  b.className = "add-btn";
  b.textContent = "+";
  b.title = "Добавить блок описания";
  b.addEventListener("click", function () {
    vscode.postMessage({ type: "insertBlock", beforeBlockId: beforeBlockId });
  });
  z.appendChild(hit);
  z.appendChild(b);
  return z;
}
function renderAffordances() {
  const blocks = Array.from(docEl.querySelectorAll(".xc-block"));
  blocks.forEach(function (blk) {
    const id = blk.getAttribute("data-block-id");
    const pen = document.createElement("button");
    pen.className = "edit-btn";
    pen.title = "Редактировать описание";
    pen.innerHTML = PENCIL_SVG;
    pen.addEventListener("click", function (ev) {
      ev.stopPropagation();
      enterEdit(blk, id);
    });
    blk.appendChild(pen);
    docEl.insertBefore(makeAddZone(id), blk);
  });
  docEl.appendChild(makeAddZone(null)); // trailing zone -> append at end
}

// ---------- receive document state ----------
window.addEventListener("message", function (e) {
  const m = e.data;
  if (m.type !== "doc") return;
  const pos = codeEl.selectionStart;
  const top = codeEl.scrollTop;
  if (codeEl.value !== m.code) codeEl.value = m.code;
  try { codeEl.setSelectionRange(pos, pos); } catch (err) {}
  codeLang = m.codeLang || "plaintext";
  rawById = m.rawById || {};
  docEl.innerHTML = m.explanationHtml;
  renderAffordances();
  views = m.views || [];
  errEl.textContent = m.errors && m.errors.length ? "⚠ " + m.errors.join("; ") : "";
  rehighlight();
  codeEl.scrollTop = top;
  hlPre.scrollTop = top;
  scheduleAnchors();

  // After inserting a block or describing a selection, jump straight into
  // editing the affected block.
  if (m.autoEditBlockId) {
    const blk = docEl.querySelector('[data-block-id="' + cssEsc(m.autoEditBlockId) + '"]');
    if (blk) {
      enterEdit(blk, m.autoEditBlockId);
      blk.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
});

window.addEventListener("resize", function () {
  scheduleAnchors();
  positionDescribe();
});
measure();
rehighlight(); // initial line numbers
// Position the swap button once layout has actually settled.
requestAnimationFrame(function () { requestAnimationFrame(positionSwap); });
vscode.postMessage({ type: "ready" });
