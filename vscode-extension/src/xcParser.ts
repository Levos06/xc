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
 * Replace the flattened code (as edited in the left pane) back into the
 * document, distributing lines across the existing CODE blocks in order while
 * leaving every EXPLANATION and fence line untouched.
 *
 * For the MVP we support the common single-code-block case losslessly, and
 * multi-block by re-splitting on the original block sizes only when the line
 * count is unchanged; otherwise all code is written into the first block.
 */
export function spliceCode(text: string, newCode: string): string {
  const res = parse(text);
  const blocks = codeBlocks(res);
  const lines = [...res.lines];
  const newLines = newCode.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "").split("\n");

  if (blocks.length === 0) return text;

  if (blocks.length === 1) {
    const b = blocks[0];
    lines.splice(b.bodyStart, b.bodyEnd - b.bodyStart, ...newLines);
    return lines.join("\n");
  }

  // Multi-block: only re-distribute safely if sizes are unchanged.
  const origTotal = blocks.reduce((n, b) => n + (b.bodyEnd - b.bodyStart), 0);
  if (newLines.length === origTotal) {
    // Splice from the last block backwards so earlier indices stay valid.
    let cursor = 0;
    const slices: string[][] = blocks.map((b) => {
      const n = b.bodyEnd - b.bodyStart;
      const s = newLines.slice(cursor, cursor + n);
      cursor += n;
      return s;
    });
    for (let k = blocks.length - 1; k >= 0; k--) {
      const b = blocks[k];
      lines.splice(b.bodyStart, b.bodyEnd - b.bodyStart, ...slices[k]);
    }
    return lines.join("\n");
  }

  // Fallback: dump all code into the first block (rare; line count changed
  // across a multi-block file). Keeps data; user can re-split manually.
  const first = blocks[0];
  lines.splice(first.bodyStart, first.bodyEnd - first.bodyStart, ...newLines);
  return lines.join("\n");
}
