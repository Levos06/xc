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
const slotLeft = document.getElementById("slotLeft");
const slotRight = document.getElementById("slotRight");
const gutter = document.getElementById("gutter");
const swap = document.getElementById("swap");
const codePane = document.getElementById("codePane");
const docPane = document.getElementById("docPane");
const codeEl = document.getElementById("code");
const hlEl = document.getElementById("hl");
const hlPre = document.getElementById("hlpre");
const docEl = document.getElementById("doc");
const errEl = document.getElementById("errbar");
const describeBtn = document.getElementById("describe");

let views = [];
let rawById = {};
let codeLang = "plaintext";
let lineHeight = 18;
let codeAnchors = [0];
let docAnchors = [0];
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
  const g = gutter.getBoundingClientRect();
  swap.style.left = g.left + g.width / 2 + "px";
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
}

// ---------- scroll mirror (textarea -> highlight pre) ----------
codeEl.addEventListener("scroll", function () {
  hlPre.scrollTop = codeEl.scrollTop;
  hlPre.scrollLeft = codeEl.scrollLeft;
  if (driver === "code") syncDocFromCode();
  positionDescribe();
});

// ---------- anchor-interpolated smooth sync ----------
function cssEsc(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}
function monotonic(a) {
  for (let i = 1; i < a.length; i++) {
    if (a[i] <= a[i - 1]) a[i] = a[i - 1] + 0.001;
  }
}
function recomputeAnchors() {
  codeAnchors = [0];
  docAnchors = [0];
  const docRect = docPane.getBoundingClientRect();
  for (const v of views) {
    codeAnchors.push(v.flatStartLine * lineHeight);
    const el = docPane.querySelector('[data-block-id="' + cssEsc(v.blockId) + '"]');
    const y = el ? el.getBoundingClientRect().top - docRect.top + docPane.scrollTop : 0;
    docAnchors.push(y);
  }
  codeAnchors.push(Math.max(0, codeEl.scrollHeight - codeEl.clientHeight));
  docAnchors.push(Math.max(0, docPane.scrollHeight - docPane.clientHeight));
  monotonic(codeAnchors);
  monotonic(docAnchors);
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
function interp(x, xs, ys) {
  if (x <= xs[0]) return ys[0];
  for (let k = 0; k < xs.length - 1; k++) {
    if (x <= xs[k + 1]) {
      const t = (x - xs[k]) / (xs[k + 1] - xs[k]);
      return ys[k] + t * (ys[k + 1] - ys[k]);
    }
  }
  return ys[ys.length - 1];
}
function activeBlockForCode(top) {
  let id = null;
  for (let k = 0; k < views.length; k++) {
    if (top + 1 >= codeAnchors[k + 1] - lineHeight) id = views[k].blockId;
  }
  return id || (views[0] && views[0].blockId);
}
function highlight(id) {
  docPane.querySelectorAll(".xc-block").forEach(function (el) {
    el.classList.toggle("active", el.getAttribute("data-block-id") === id);
  });
}
function syncDocFromCode() {
  if (codeAnchors.length !== views.length + 2) recomputeAnchors();
  docPane.scrollTop = interp(codeEl.scrollTop, codeAnchors, docAnchors);
  highlight(activeBlockForCode(codeEl.scrollTop));
}
function syncCodeFromDoc() {
  if (docAnchors.length !== views.length + 2) recomputeAnchors();
  codeEl.scrollTop = interp(docPane.scrollTop, docAnchors, codeAnchors);
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
docPane.addEventListener("wheel", setDriver("doc"), { passive: true });
docPane.addEventListener("pointerdown", setDriver("doc"));
docPane.addEventListener("scroll", function () {
  if (driver === "doc") syncCodeFromDoc();
});

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
function enterEdit(blk, id) {
  if (blk.querySelector(".xc-edit")) return;
  const body = blk.querySelector(".xc-body");
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
  const hint = document.createElement("span");
  hint.className = "xc-edit-hint";
  hint.textContent = "⌘/Ctrl+Enter — сохранить · Esc — отмена";
  bar.appendChild(saveB);
  bar.appendChild(cancelB);
  bar.appendChild(hint);
  if (body) body.style.display = "none";
  blk.appendChild(ta);
  blk.appendChild(bar);
  ta.focus();
  ta.style.height = Math.max(120, ta.scrollHeight + 4) + "px";

  function commit() {
    vscode.postMessage({ type: "editExplanation", blockId: id, markdown: ta.value });
  }
  function close() {
    ta.remove();
    bar.remove();
    if (body) body.style.display = "";
  }
  saveB.addEventListener("click", commit);
  cancelB.addEventListener("click", close);
  ta.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") { ev.preventDefault(); close(); }
    else if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") { ev.preventDefault(); commit(); }
  });
}
docPane.addEventListener("dblclick", function (e) {
  const blk = e.target.closest ? e.target.closest(".xc-block") : null;
  if (blk) enterEdit(blk, blk.getAttribute("data-block-id"));
});

// ---------- add-block "+" affordances + edit pencils ----------
function makeAddZone(beforeBlockId) {
  const z = document.createElement("div");
  z.className = "add-zone";
  const b = document.createElement("button");
  b.className = "add-btn";
  b.textContent = "+";
  b.title = "Добавить блок";
  b.addEventListener("click", function () {
    vscode.postMessage({ type: "insertBlock", beforeBlockId: beforeBlockId });
  });
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
    pen.textContent = "✎";
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
});

window.addEventListener("resize", function () {
  scheduleAnchors();
  positionDescribe();
});
measure();
vscode.postMessage({ type: "ready" });
