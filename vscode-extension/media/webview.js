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
const codePane = document.getElementById("codePane");
const docPane = document.getElementById("docPane");
const codeEl = document.getElementById("code");   // textarea (transparent)
const hlEl = document.getElementById("hl");        // <code> highlight layer
const hlPre = document.getElementById("hlpre");    // <pre> scroll mirror
const docEl = document.getElementById("doc");
const errEl = document.getElementById("errbar");

let views = [];
let codeLang = "plaintext";
let lineHeight = 18;
let codeAnchors = [0];
let docAnchors = [0];
let driver = null;       // 'code' | 'doc' — which pane the user is scrolling
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
function setSplit(f) {
  leftFraction = Math.max(0.15, Math.min(0.85, f));
  wrap.style.gridTemplateColumns = leftFraction + "fr 8px " + (1 - leftFraction) + "fr";
}

applyOrder();
setSplit(leftFraction);

// ---------- swap (icon on the gutter) ----------
document.getElementById("swap").addEventListener("click", function () {
  codeOnLeft = !codeOnLeft;
  applyOrder();
  save();
  scheduleAnchors();
});

// ---------- draggable gutter ----------
let dragging = false;
gutter.addEventListener("pointerdown", function (e) {
  // Don't start a drag when the swap button itself is pressed.
  if (e.target && e.target.id === "swap") return;
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
  // Trailing newline keeps the highlight layer the same height as the textarea.
  hlEl.innerHTML = html + "\n";
}

// ---------- scroll mirror (textarea -> highlight pre) ----------
codeEl.addEventListener("scroll", function () {
  hlPre.scrollTop = codeEl.scrollTop;
  hlPre.scrollLeft = codeEl.scrollLeft;
  if (driver === "code") syncDocFromCode();
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
    const y = el
      ? el.getBoundingClientRect().top - docRect.top + docPane.scrollTop
      : 0;
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
  const blocks = docPane.querySelectorAll(".xc-block");
  blocks.forEach(function (el) {
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
function makeDriver(name) {
  return function () { driver = name; };
}
codePane.addEventListener("wheel", makeDriver("code"), { passive: true });
codePane.addEventListener("pointerdown", makeDriver("code"));
codeEl.addEventListener("focus", makeDriver("code"));
codeEl.addEventListener("keydown", makeDriver("code"));
docPane.addEventListener("wheel", makeDriver("doc"), { passive: true });
docPane.addEventListener("pointerdown", makeDriver("doc"));

docPane.addEventListener("scroll", function () {
  if (driver === "doc") syncCodeFromDoc();
});

// Click an explanation card -> bring its code into view (one-off jump).
docPane.addEventListener("click", function (e) {
  const blk = e.target && e.target.closest ? e.target.closest(".xc-block") : null;
  if (!blk) return;
  driver = "doc";
  const id = blk.getAttribute("data-block-id");
  const v = views.find(function (x) { return x.blockId === id; });
  if (v) {
    highlight(id);
    codeEl.scrollTop = v.flatStartLine * lineHeight;
    hlPre.scrollTop = codeEl.scrollTop;
  }
});

// ---------- edits ----------
let debounce;
codeEl.addEventListener("input", function () {
  rehighlight();
  hlPre.scrollTop = codeEl.scrollTop;
  hlPre.scrollLeft = codeEl.scrollLeft;
  clearTimeout(debounce);
  debounce = setTimeout(function () {
    vscode.postMessage({ type: "editCode", code: codeEl.value });
  }, 300);
});

// ---------- receive document state ----------
window.addEventListener("message", function (e) {
  const m = e.data;
  if (m.type !== "doc") return;
  const pos = codeEl.selectionStart;
  const top = codeEl.scrollTop;
  if (codeEl.value !== m.code) codeEl.value = m.code;
  try { codeEl.setSelectionRange(pos, pos); } catch (err) {}
  codeLang = m.codeLang || "plaintext";
  docEl.innerHTML = m.explanationHtml;
  views = m.views || [];
  errEl.textContent = m.errors && m.errors.length ? "⚠ " + m.errors.join("; ") : "";
  rehighlight();
  codeEl.scrollTop = top;
  hlPre.scrollTop = top;
  scheduleAnchors();
});

window.addEventListener("resize", scheduleAnchors);
measure();
vscode.postMessage({ type: "ready" });
