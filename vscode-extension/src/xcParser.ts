/**
 * TypeScript mirror of the .xc recognizer (see core/xc/parser.py).
 *
 * Kept deliberately small and line-oriented so the editor and the CLI agree
 * byte-for-byte on where code lives. The extension only needs: locate blocks,
 * extract code, and splice edited code back WITHOUT touching explanation lines.
 */

export type Kind = "EXPLANATION" | "CODE";

export interface Block {
  kind: Kind;
  blockId: string;
  /** 0-based line index of the heading. */
  headingLine: number;
  /** 0-based line index of the opening fence (CODE only). */
  fenceOpenLine?: number;
  /** 0-based line index of the closing fence (CODE only). */
  fenceCloseLine?: number;
  /** Inclusive 0-based start of body content lines. */
  bodyStart: number;
  /** Exclusive 0-based end of body content lines. */
  bodyEnd: number;
  fenceLang?: string;
  fenceClosed: boolean;
}

export interface ParseResult {
  frontmatterText: string;
  frontmatterClosed: boolean;
  blocks: Block[];
  lines: string[];
  errors: string[];
}

const HEADING_RE = /^#\s*\[\s*(EXPLANATION|CODE)\s*:\s*([^\]]+?)\s*\]\s*$/;
const FENCE_RE = /^(`{3,}|~{3,})\s*([^`~]*?)\s*$/;
const DELIM = "---";

function normalize(text: string): string[] {
  return text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function isClosingFence(open: string, close: string, info: string): boolean {
  if (info) return false;
  if (!close || close[0] !== open[0]) return false;
  return close.length >= open.length;
}

export function parse(text: string): ParseResult {
  const lines = normalize(text);
  const res: ParseResult = {
    frontmatterText: "",
    frontmatterClosed: true,
    blocks: [],
    lines,
    errors: [],
  };

  type State = "START" | "FM" | "BODY" | "EXPL" | "AWAIT" | "FENCE";
  let state: State = "START";
  const fmLines: string[] = [];
  let cur: Block | null = null;
  let fenceToken = "";

  const closeCur = (endExclusive: number) => {
    if (cur) {
      cur.bodyEnd = endExclusive;
      res.blocks.push(cur);
      cur = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (state === "START") {
      if (line.trim() === DELIM) {
        state = "FM";
        continue;
      }
      state = "BODY";
    }

    if (state === "FM") {
      if (line.trim() === DELIM) {
        res.frontmatterText = fmLines.join("\n");
        state = "BODY";
      } else {
        fmLines.push(line);
      }
      continue;
    }

    if (state === "FENCE") {
      const m = FENCE_RE.exec(line);
      if (m && isClosingFence(fenceToken, m[1], m[2])) {
        if (cur) {
          cur.fenceClosed = true;
          cur.fenceCloseLine = i;
          closeCur(i); // body ends before the closing fence
        }
        state = "BODY";
      }
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      closeCur(i);
      const kind = h[1] as Kind;
      cur = {
        kind,
        blockId: h[2].trim(),
        headingLine: i,
        bodyStart: i + 1,
        bodyEnd: i + 1,
        fenceClosed: kind === "EXPLANATION",
      };
      state = kind === "EXPLANATION" ? "EXPL" : "AWAIT";
      continue;
    }

    if (state === "AWAIT") {
      const m = FENCE_RE.exec(line);
      if (m) {
        fenceToken = m[1];
        if (cur) {
          cur.fenceLang = (m[2] || "").trim() || undefined;
          cur.fenceOpenLine = i;
          cur.bodyStart = i + 1;
          cur.fenceClosed = false;
        }
        state = "FENCE";
      }
      continue;
    }
    // EXPL / BODY: nothing to track line-by-line; bodyEnd set on close.
  }

  if (state === "FM") {
    res.frontmatterText = fmLines.join("\n");
    res.frontmatterClosed = false;
    res.errors.push("frontmatter never closed");
  }
  if (state === "FENCE" && cur) {
    cur.fenceClosed = false;
    res.errors.push(`code block '${cur.blockId}' fence never closed`);
  }
  closeCur(lines.length);

  return res;
}

export function codeBlocks(res: ParseResult): Block[] {
  return res.blocks.filter((b) => b.kind === "CODE");
}

/** Concatenate all code-fence contents in document order (mirrors extract). */
export function extract(text: string): string {
  const res = parse(text);
  const out: string[] = [];
  for (const b of codeBlocks(res)) {
    for (let i = b.bodyStart; i < b.bodyEnd; i++) out.push(res.lines[i]);
  }
  let code = out.join("\n");
  if (code && !code.endsWith("\n")) code += "\n";
  return code;
}

/** Concatenate all EXPLANATION prose (for the explanation-only git diff). */
export function extractExplanations(text: string): string {
  const res = parse(text);
  const out: string[] = [];
  for (const b of res.blocks) {
    if (b.kind !== "EXPLANATION") continue;
    out.push(`# [EXPLANATION: ${b.blockId}]`);
    for (let i = b.bodyStart; i < b.bodyEnd; i++) out.push(res.lines[i]);
  }
  return out.join("\n").trimEnd() + "\n";
}

/**
 * Build a per-code-block view used by the editor's left pane. Returns each
 * block's code text and a map from a (joined) code line offset back to the
 * document line, so the editor can sync the caret to the right block.
 */
export interface CodeView {
  blockId: string;
  /** 0-based line in the document where this block's code starts. */
  docStartLine: number;
  /** Line offset (within the flattened left-pane code) where this block starts. */
  flatStartLine: number;
  lineCount: number;
}

export function codeViews(res: ParseResult): CodeView[] {
  const views: CodeView[] = [];
  let flat = 0;
  for (const b of codeBlocks(res)) {
    const count = b.bodyEnd - b.bodyStart;
    views.push({
      blockId: b.blockId,
      docStartLine: b.bodyStart,
      flatStartLine: flat,
      lineCount: count,
    });
    flat += count;
  }
  return views;
}

/**
 * Longest-common-subsequence line matching. Returns pairs [i, j] of matched
 * indices (a[i] === b[j]) in increasing order. O(n*m) — fine for source files.
 */
function lcsMatches(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Replace the flattened code (as edited in the left pane) back into the
 * document, distributing lines across the existing CODE blocks while leaving
 * every EXPLANATION and fence line untouched.
 *
 * The mapping is computed by diffing the OLD flattened code against the new
 * one (LCS at line granularity): kept lines stay in their block, inserted
 * lines join the block of the preceding line, deleted lines vanish from their
 * block. This means a local edit only ever grows/shrinks the block it happened
 * in — code never collapses into the first block, no matter how the line count
 * changes. Blocks may legitimately become empty.
 */
export function spliceCode(text: string, newCode: string): string {
  const res = parse(text);
  const blocks = codeBlocks(res);
  const lines = [...res.lines];
  const newLines = newCode
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n$/, "")
    .split("\n");

  if (blocks.length === 0) return text;

  if (blocks.length === 1) {
    const b = blocks[0];
    lines.splice(b.bodyStart, b.bodyEnd - b.bodyStart, ...newLines);
    return lines.join("\n");
  }

  // Old flattened code + an owner map: which block each old line belongs to.
  const oldFlat: string[] = [];
  const owner: number[] = [];
  blocks.forEach((b, k) => {
    for (let t = b.bodyStart; t < b.bodyEnd; t++) {
      oldFlat.push(res.lines[t]);
      owner.push(k);
    }
  });

  // Guard against pathological cost on huge files: fall back to proportional
  // split (still per-block, never an all-into-first dump).
  const buckets: string[][] = blocks.map(() => []);
  if (oldFlat.length * newLines.length > 4_000_000) {
    const ratio = blocks.length / Math.max(1, newLines.length);
    newLines.forEach((ln, j) => {
      const k = Math.min(blocks.length - 1, Math.floor(j * ratio));
      buckets[k].push(ln);
    });
  } else {
    const assign = new Array<number>(newLines.length).fill(-1);
    for (const [i, j] of lcsMatches(oldFlat, newLines)) {
      assign[j] = owner[i];
    }
    // Forward-fill inserted lines into the preceding line's block (default 0).
    let last = 0;
    for (let j = 0; j < newLines.length; j++) {
      if (assign[j] === -1) assign[j] = last;
      else last = assign[j];
      buckets[assign[j]].push(newLines[j]);
    }
  }

  // Splice from the last block backwards so earlier indices stay valid.
  for (let k = blocks.length - 1; k >= 0; k--) {
    const b = blocks[k];
    lines.splice(b.bodyStart, b.bodyEnd - b.bodyStart, ...buckets[k]);
  }
  return lines.join("\n");
}

function splitLines(s: string): string[] {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/**
 * Replace the prose body of EXPLANATION block `blockId`. The heading and every
 * CODE line stay byte-identical (same guarantee as the MCP tool).
 */
export function setExplanationBody(text: string, blockId: string, newBody: string): string {
  const res = parse(text);
  const lines = [...res.lines];
  const b = res.blocks.find((x) => x.kind === "EXPLANATION" && x.blockId === blockId);
  if (!b) throw new Error(`no EXPLANATION block '${blockId}'`);
  const before = lines.slice(0, b.bodyStart);
  const after = lines.slice(b.bodyEnd);
  let mid = splitLines(newBody);
  // Keep a blank separator before the next heading.
  if (after.length && (mid.length === 0 || mid[mid.length - 1].trim() !== "")) {
    mid = [...mid, ""];
  }
  return [...before, ...mid, ...after].join("\n");
}

/**
 * Insert a brand-new EXPLANATION block. If `beforeBlockId` names an existing
 * EXPLANATION block, the new one is placed just before its heading; if null,
 * the block is appended at the end of the document. Used by the "+" affordance
 * between blocks. The new block has no paired CODE (a free-standing note).
 */
export function insertExplanationBefore(
  text: string,
  beforeBlockId: string | null,
  newId: string,
  markdown: string
): string {
  const res = parse(text);
  const lines = [...res.lines];
  const block = [`# [EXPLANATION: ${newId}]`, ...splitLines(markdown), ""];

  if (beforeBlockId == null) {
    let end = lines.length;
    while (end > 0 && lines[end - 1].trim() === "") end--;
    return [...lines.slice(0, end), "", ...block].join("\n");
  }
  const b = res.blocks.find((x) => x.kind === "EXPLANATION" && x.blockId === beforeBlockId);
  if (!b) throw new Error(`no EXPLANATION block '${beforeBlockId}'`);
  const at = b.headingLine;
  return [...lines.slice(0, at), ...block, ...lines.slice(at)].join("\n");
}

/**
 * Rename a block id everywhere it appears — both the EXPLANATION heading and
 * its paired CODE heading — so the explanation/code anchor link is preserved.
 */
export function renameBlockId(text: string, oldId: string, newId: string): string {
  const res = parse(text);
  const lines = [...res.lines];
  for (const b of res.blocks) {
    if (b.blockId === oldId) {
      lines[b.headingLine] = `# [${b.kind}: ${newId}]`;
    }
  }
  return lines.join("\n");
}

/**
 * Delete an EXPLANATION block (heading + its prose). Any paired CODE block is
 * left intact — only the description is removed.
 */
export function deleteExplanationBlock(text: string, blockId: string): string {
  const res = parse(text);
  const lines = [...res.lines];
  const b = res.blocks.find((x) => x.kind === "EXPLANATION" && x.blockId === blockId);
  if (!b) throw new Error(`no EXPLANATION block '${blockId}'`);
  let end = b.bodyEnd;
  if (end < lines.length && lines[end].trim() === "") end++; // eat one trailing blank
  lines.splice(b.headingLine, end - b.headingLine);
  return lines.join("\n");
}

export interface DescribeResult {
  ok: boolean;
  message?: string;
  mode?: "subblock" | "separate";
  blockId?: string;
  text?: string;
}

/**
 * Attach a description to a code selection (flat code-line range [startFlat,
 * endFlat), end-exclusive).
 *
 * - The selection must lie within a single CODE block (its anchor is obvious:
 *   that block's id).
 * - If that block already has an EXPLANATION, the description is appended as a
 *   sub-section of it (a "subblock").
 * - If the block is an orphan (code with no matching EXPLANATION), a new
 *   EXPLANATION is created for it, anchored by the same block id.
 */
export function describeSelection(
  text: string,
  startFlat: number,
  endFlat: number,
  markdown: string
): DescribeResult {
  const res = parse(text);
  const views = codeViews(res);
  let container: { blockId: string; flatStartLine: number; lineCount: number } | null = null;
  for (const v of views) {
    const lo = v.flatStartLine;
    const hi = v.flatStartLine + v.lineCount;
    if (startFlat >= lo && endFlat <= hi) {
      container = v;
      break;
    }
  }
  if (!container) {
    return { ok: false, message: "Выделите код в пределах одного блока кода." };
  }

  const expl = res.blocks.find(
    (x) => x.kind === "EXPLANATION" && x.blockId === container!.blockId
  );
  if (expl) {
    const body = res.lines
      .slice(expl.bodyStart, expl.bodyEnd)
      .join("\n")
      .replace(/\s+$/, "");
    const newBody = body + "\n\n" + markdown;
    return {
      ok: true,
      mode: "subblock",
      blockId: container.blockId,
      text: setExplanationBody(text, container.blockId, newBody),
    };
  }

  // Orphan code block: create its EXPLANATION right before the CODE heading.
  const codeBlock = res.blocks.find(
    (x) => x.kind === "CODE" && x.blockId === container!.blockId
  )!;
  const lines = [...res.lines];
  const at = codeBlock.headingLine;
  const block = [`# [EXPLANATION: ${container.blockId}]`, ...splitLines(markdown), ""];
  return {
    ok: true,
    mode: "separate",
    blockId: container.blockId,
    text: [...lines.slice(0, at), ...block, ...lines.slice(at)].join("\n"),
  };
}
