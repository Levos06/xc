/**
 * TypeScript mirror of the .xc recognizer, v2 (monolithic code + line ranges).
 *
 * See core/xc/parser.py. The format:
 *   - YAML frontmatter
 *   - a sequence of `# [EXPLANATION: id]` blocks, each with a `lines: <ranges>`
 *     marker binding it to 1-indexed line ranges of the code
 *   - exactly one `# [CODE: MONOLITH]` fenced block holding the whole program
 *
 * The CLI (Python) and this module agree byte-for-byte on where code lives.
 */

export const MONOLITH_ID = "MONOLITH";

export interface Range {
  start: number; // 1-indexed inclusive
  end: number;
}

export interface Explanation {
  blockId: string;
  ranges: Range[];
  bodyLines: string[];
  headingLine: number;       // 0-based index in the document
  linesLine: number | null;  // 0-based index of the `lines:` marker
}

export interface ParseResult {
  frontmatterText: string;
  frontmatterClosed: boolean;
  explanations: Explanation[];
  codeLines: string[];
  codePresent: boolean;
  codeFenceLang?: string;
  codeFenceClosed: boolean;
  codeHeadingLine: number | null;
  codeFenceOpenLine: number | null;  // 0-based index of the opening fence
  errors: string[];
  lines: string[];
}

const HEADING_RE = /^#\s*\[\s*(EXPLANATION|CODE)\s*:\s*([^\]]+?)\s*\]\s*$/;
const FENCE_RE = /^(`{3,}|~{3,})\s*([^`~]*?)\s*$/;
const LINES_RE = /^lines:\s*(.+?)\s*$/i;
const DELIM = "---";

function normalize(text: string): string[] {
  return text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}
function isClosingFence(open: string, close: string, info: string): boolean {
  if (info) return false;
  if (!close || close[0] !== open[0]) return false;
  return close.length >= open.length;
}

export function parseRanges(spec: string): Range[] {
  const out: Range[] = [];
  for (let part of spec.split(",")) {
    part = part.trim();
    if (!part) continue;
    if (part.indexOf("-") >= 0) {
      const [a, b] = part.split("-");
      let s = parseInt(a, 10);
      let e = parseInt(b, 10);
      if (isNaN(s) || isNaN(e)) continue;
      if (e < s) { const t = s; s = e; e = t; }
      out.push({ start: s, end: e });
    } else {
      const n = parseInt(part, 10);
      if (isNaN(n)) continue;
      out.push({ start: n, end: n });
    }
  }
  return out;
}

export function formatRanges(ranges: Range[]): string {
  return ranges.map((r) => (r.start === r.end ? String(r.start) : r.start + "-" + r.end)).join(", ");
}

export function parse(text: string): ParseResult {
  const lines = normalize(text);
  const res: ParseResult = {
    frontmatterText: "",
    frontmatterClosed: true,
    explanations: [],
    codeLines: [],
    codePresent: false,
    codeFenceClosed: true,
    codeHeadingLine: null,
    codeFenceOpenLine: null,
    errors: [],
    lines,
  };

  type State = "START" | "FM" | "BODY" | "EXPL" | "AWAIT" | "FENCE";
  let state: State = "START";
  const fm: string[] = [];
  let cur: Explanation | null = null;
  let linesSeen = false;
  let fenceToken = "";

  const closeCur = () => {
    if (cur) {
      while (cur.bodyLines.length && cur.bodyLines[cur.bodyLines.length - 1].trim() === "") {
        cur.bodyLines.pop();
      }
      res.explanations.push(cur);
      cur = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (state === "START") {
      if (line.trim() === DELIM) { state = "FM"; continue; }
      state = "BODY";
    }
    if (state === "FM") {
      if (line.trim() === DELIM) { res.frontmatterText = fm.join("\n"); state = "BODY"; }
      else fm.push(line);
      continue;
    }
    if (state === "FENCE") {
      const m = FENCE_RE.exec(line);
      if (m && isClosingFence(fenceToken, m[1], m[2])) { res.codeFenceClosed = true; state = "BODY"; }
      else res.codeLines.push(line);
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      closeCur();
      if (h[1] === "EXPLANATION") {
        cur = { blockId: h[2].trim(), ranges: [], bodyLines: [], headingLine: i, linesLine: null };
        linesSeen = false;
        state = "EXPL";
      } else {
        res.codePresent = true;
        res.codeHeadingLine = i;
        res.codeFenceClosed = false;
        state = "AWAIT";
      }
      continue;
    }
    if (state === "AWAIT") {
      const m = FENCE_RE.exec(line);
      if (m) {
        fenceToken = m[1];
        res.codeFenceLang = (m[2] || "").trim() || undefined;
        res.codeFenceOpenLine = i;
        state = "FENCE";
      }
      continue;
    }
    if (state === "EXPL" && cur) {
      if (!linesSeen) {
        const lm = LINES_RE.exec(line);
        if (lm) { cur.ranges = parseRanges(lm[1]); cur.linesLine = i; linesSeen = true; continue; }
        if (line.trim() === "") continue;
        res.errors.push(`line ${i + 1}: EXPLANATION '${cur.blockId}' has no 'lines:' marker`);
        linesSeen = true;
        cur.bodyLines.push(line);
        continue;
      }
      cur.bodyLines.push(line);
      continue;
    }
  }

  if (state === "FM") { res.frontmatterText = fm.join("\n"); res.frontmatterClosed = false; res.errors.push("frontmatter never closed"); }
  if (state === "FENCE") { res.codeFenceClosed = false; res.errors.push("code fence never closed"); }
  closeCur();
  return res;
}

/** The pure monolithic code, with a single trailing newline. */
export function extract(text: string): string {
  const res = parse(text);
  let code = res.codeLines.join("\n");
  if (code && !code.endsWith("\n")) code += "\n";
  return code;
}

/** Concatenate the prose layer (for the explanation-only git diff). */
export function extractExplanations(text: string): string {
  const res = parse(text);
  const out: string[] = [];
  for (const e of res.explanations) {
    out.push(`# [EXPLANATION: ${e.blockId}]`);
    out.push(`lines: ${formatRanges(e.ranges)}`);
    out.push(...e.bodyLines);
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}

function splitLines(s: string): string[] {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/** End line (exclusive) of an explanation's body, i.e. the next heading. */
function bodyEnd(res: ParseResult, e: Explanation): number {
  const headings: number[] = res.explanations.map((x) => x.headingLine);
  if (res.codeHeadingLine !== null) headings.push(res.codeHeadingLine);
  headings.sort((a, b) => a - b);
  for (const h of headings) if (h > e.headingLine) return h;
  return res.lines.length;
}

/** Replace the markdown body of an explanation; heading + lines: preserved. */
export function setExplanationBody(text: string, blockId: string, newBody: string): string {
  const res = parse(text);
  const e = res.explanations.find((x) => x.blockId === blockId);
  if (!e) throw new Error(`no EXPLANATION block '${blockId}'`);
  const lines = [...res.lines];
  const start = e.linesLine !== null ? e.linesLine + 1 : e.headingLine + 1;
  const end = bodyEnd(res, e);
  let mid = splitLines(newBody);
  if (end < lines.length && (mid.length === 0 || mid[mid.length - 1].trim() !== "")) mid = [...mid, ""];
  return [...lines.slice(0, start), ...mid, ...lines.slice(end)].join("\n");
}

/** Rename an explanation's id (code is the monolith; nothing else to touch). */
export function renameBlockId(text: string, oldId: string, newId: string): string {
  const res = parse(text);
  const e = res.explanations.find((x) => x.blockId === oldId);
  if (!e) throw new Error(`no EXPLANATION block '${oldId}'`);
  const lines = [...res.lines];
  lines[e.headingLine] = `# [EXPLANATION: ${newId}]`;
  return lines.join("\n");
}

/** Change an explanation's line range (its `lines:` marker). */
export function setExplanationRange(text: string, blockId: string, ranges: Range[]): string {
  const res = parse(text);
  const e = res.explanations.find((x) => x.blockId === blockId);
  if (!e) throw new Error(`no EXPLANATION block '${blockId}'`);
  const lines = [...res.lines];
  const marker = `lines: ${formatRanges(ranges)}`;
  if (e.linesLine !== null) lines[e.linesLine] = marker;
  else lines.splice(e.headingLine + 1, 0, marker);
  return lines.join("\n");
}

/** Delete an explanation block (heading + lines: + body). Code is untouched. */
export function deleteExplanationBlock(text: string, blockId: string): string {
  const res = parse(text);
  const e = res.explanations.find((x) => x.blockId === blockId);
  if (!e) throw new Error(`no EXPLANATION block '${blockId}'`);
  const lines = [...res.lines];
  let end = bodyEnd(res, e);
  if (end < lines.length && lines[end].trim() === "") end++;
  lines.splice(e.headingLine, end - e.headingLine);
  return lines.join("\n");
}

/** Insert a new explanation block (with a line range) into the prose layer,
 *  just before the CODE heading. Returns the new document text. */
export function insertExplanation(
  text: string,
  blockId: string,
  ranges: Range[],
  markdown: string
): string {
  const res = parse(text);
  const lines = [...res.lines];
  const block = [`# [EXPLANATION: ${blockId}]`, `lines: ${formatRanges(ranges)}`, ...splitLines(markdown), ""];
  // Insert before the CODE heading if present, else at end.
  let at = res.codeHeadingLine;
  if (at === null) {
    let end = lines.length;
    while (end > 0 && lines[end - 1].trim() === "") end--;
    return [...lines.slice(0, end), "", ...block].join("\n");
  }
  return [...lines.slice(0, at), ...block, ...lines.slice(at)].join("\n");
}

export function uniqueId(text: string, base = "note"): string {
  const taken = new Set(parse(text).explanations.map((e) => e.blockId));
  let n = 1;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

// --------------------------------------------------------------------------- //
// LCS line diff — used to remap line ranges when the code is edited.
// --------------------------------------------------------------------------- //

function lcsMatches(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Remap 1-indexed line ranges from oldLines to newLines via LCS. */
export function remapRanges(oldLines: string[], newLines: string[], ranges: Range[]): Range[] {
  const pairs = lcsMatches(oldLines, newLines); // [oldIdx0, newIdx0]
  const keptOld: number[] = pairs.map((p) => p[0]);
  const keptNew: number[] = pairs.map((p) => p[1]);

  const mapAtOrAfter = (oldLine1: number): number => {
    const o0 = oldLine1 - 1;
    for (let k = 0; k < keptOld.length; k++) if (keptOld[k] >= o0) return keptNew[k] + 1;
    return newLines.length; // past the end
  };
  const mapAtOrBefore = (oldLine1: number): number => {
    const o0 = oldLine1 - 1;
    for (let k = keptOld.length - 1; k >= 0; k--) if (keptOld[k] <= o0) return keptNew[k] + 1;
    return 1;
  };

  const out: Range[] = [];
  for (const r of ranges) {
    let s = mapAtOrAfter(r.start);
    let e = mapAtOrBefore(r.end);
    if (newLines.length === 0) continue;
    s = Math.max(1, Math.min(newLines.length, s));
    e = Math.max(1, Math.min(newLines.length, e));
    if (e < s) e = s;
    out.push({ start: s, end: e });
  }
  return out;
}

/**
 * Apply an edit to the monolithic code: replace the fence contents with
 * `newCode` and remap every explanation's `lines:` range so the prose keeps
 * pointing at the same logical lines.
 */
export function applyCodeEdit(text: string, newCode: string): string {
  const res = parse(text);
  if (!res.codePresent || res.codeFenceOpenLine === null) return text;
  const oldLines = res.codeLines;
  const newLines = newCode.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "").split("\n");

  const lines = [...res.lines];
  // 1) rewrite each explanation's lines: marker (top-down indices unaffected by
  //    the code splice, which happens lower in the file).
  for (const e of res.explanations) {
    if (e.linesLine === null) continue;
    const remapped = remapRanges(oldLines, newLines, e.ranges);
    lines[e.linesLine] = `lines: ${formatRanges(remapped)}`;
  }
  // 2) splice the code fence body (between the opening fence and its close).
  const bodyStart = res.codeFenceOpenLine + 1;
  const bodyLen = oldLines.length;
  lines.splice(bodyStart, bodyLen, ...newLines);
  return lines.join("\n");
}

/**
 * For a flat selection of code lines [startLine, endLine] (1-indexed inclusive),
 * the explanation blocks that cover it (any range overlap). Used for highlight.
 */
export function explanationsForLine(res: ParseResult, line1: number): Explanation[] {
  return res.explanations.filter((e) =>
    e.ranges.some((r) => line1 >= r.start && line1 <= r.end)
  );
}

// --------------------------------------------------------------------------- //
// Excel-grid layout — pure row-ownership computation (used by the grid viewer).
// --------------------------------------------------------------------------- //

export interface GridAnchor {
  startLine: number;  // 1-indexed row where the (active) block begins
  activeId: string;   // the block id occupying this start row
  collapsed: boolean; // collapsed blocks own only their own start row
}

/**
 * Returns an array `owner` of length codeLineCount+1 where `owner[row]` (rows
 * 1..N) is the block id that paints that row, or null if none.
 *
 * Rules: blocks flow downward from their start line until the next anchor's
 * start. A collapsed block owns only its own start row, so the previously
 * flowing block resumes below it ("collapse reveals what was underneath").
 */
export function rowOwners(anchors: GridAnchor[], codeLineCount: number): (string | null)[] {
  const byStart = new Map<number, GridAnchor>();
  for (const a of anchors) byStart.set(a.startLine, a);
  const owner: (string | null)[] = new Array(codeLineCount + 1).fill(null);
  let active: string | null = null;
  for (let row = 1; row <= codeLineCount; row++) {
    const a = byStart.get(row);
    if (a) {
      if (a.collapsed) {
        owner[row] = a.activeId; // header only; `active` keeps flowing below
      } else {
        active = a.activeId;
        owner[row] = active;
      }
    } else {
      owner[row] = active;
    }
  }
  return owner;
}
