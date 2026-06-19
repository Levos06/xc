/** Assertion harness for the v2 TS recognizer — no test runner needed. */
import * as assert from "assert";
import {
  parse,
  extract,
  parseRanges,
  formatRanges,
  setExplanationBody,
  setExplanationRange,
  renameBlockId,
  deleteExplanationBlock,
  insertExplanation,
  remapRanges,
  applyCodeEdit,
  explanationsForLine,
  rowOwners,
} from "../src/xcParser";

const SAMPLE = `---
language: "python"
module: "m"
---

# [EXPLANATION: overview]
lines: 1-6
## Overview
The whole thing.

# [EXPLANATION: inner]
lines: 3-4
Inner detail.

# [CODE: MONOLITH]
\`\`\`python
def a():
    return 1

def b():
    return 2
\`\`\`
`;

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

check("parses explanations + monolith", () => {
  const r = parse(SAMPLE);
  assert.ok(r.errors.length === 0, r.errors.join("; "));
  assert.strictEqual(r.explanations.length, 2);
  assert.ok(r.codePresent);
  assert.strictEqual(r.codeFenceLang, "python");
  assert.strictEqual(r.codeLines.length, 5);
});

check("parses line ranges", () => {
  const r = parse(SAMPLE);
  assert.deepStrictEqual(r.explanations[0].ranges, [{ start: 1, end: 6 }]);
  assert.deepStrictEqual(r.explanations[1].ranges, [{ start: 3, end: 4 }]);
});

check("parseRanges / formatRanges", () => {
  assert.deepStrictEqual(parseRanges("5-8, 12"), [{ start: 5, end: 8 }, { start: 12, end: 12 }]);
  assert.strictEqual(formatRanges([{ start: 5, end: 8 }, { start: 12, end: 12 }]), "5-8, 12");
});

check("extract is clean code", () => {
  const code = extract(SAMPLE);
  assert.ok(code.includes("def a()") && code.includes("def b()"));
  assert.ok(!code.includes("EXPLANATION") && !code.includes("lines:") && !code.includes("```"));
});

check("overlapping ranges are independent (a key v2 win)", () => {
  // 'inner' (3-4) sits inside 'overview' (1-6) with no conflict.
  const r = parse(SAMPLE);
  assert.strictEqual(explanationsForLine(r, 3).length, 2);
  assert.strictEqual(explanationsForLine(r, 1).length, 1);
  assert.strictEqual(explanationsForLine(r, 6).length, 1);
});

check("setExplanationBody keeps code + range", () => {
  const before = extract(SAMPLE);
  const out = setExplanationBody(SAMPLE, "overview", "## New\nrewritten");
  assert.ok(out.includes("## New") && !out.includes("The whole thing."));
  assert.strictEqual(extract(out), before);
  assert.deepStrictEqual(parse(out).explanations[0].ranges, [{ start: 1, end: 6 }]);
});

check("renameBlockId renames the explanation", () => {
  const out = renameBlockId(SAMPLE, "inner", "edge");
  assert.ok(out.includes("# [EXPLANATION: edge]"));
  assert.ok(!out.includes("[EXPLANATION: inner]"));
  assert.strictEqual(extract(out), extract(SAMPLE));
});

check("setExplanationRange updates lines marker", () => {
  const out = setExplanationRange(SAMPLE, "inner", [{ start: 4, end: 5 }]);
  assert.deepStrictEqual(parse(out).explanations[1].ranges, [{ start: 4, end: 5 }]);
});

check("deleteExplanationBlock removes prose, keeps code", () => {
  const out = deleteExplanationBlock(SAMPLE, "inner");
  assert.ok(!out.includes("[EXPLANATION: inner]"));
  assert.ok(out.includes("[EXPLANATION: overview]"));
  assert.strictEqual(extract(out), extract(SAMPLE));
});

check("insertExplanation adds a block before the code", () => {
  const out = insertExplanation(SAMPLE, "note_1", [{ start: 5, end: 6 }], "## Note\nabout b");
  assert.ok(out.includes("# [EXPLANATION: note_1]"));
  assert.ok(out.indexOf("note_1") < out.indexOf("[CODE: MONOLITH]"));
  const inserted = parse(out).explanations.find((e) => e.blockId === "note_1")!;
  assert.deepStrictEqual(inserted.ranges, [{ start: 5, end: 6 }]);
  assert.strictEqual(extract(out), extract(SAMPLE));
});

check("remapRanges follows inserted lines", () => {
  const oldL = ["a", "b", "c", "d"];
  const newL = ["a", "X", "b", "c", "d"]; // insert X after line 1
  // range covering old lines 2-3 (b,c) -> new lines 3-4
  assert.deepStrictEqual(remapRanges(oldL, newL, [{ start: 2, end: 3 }]), [{ start: 3, end: 4 }]);
});

check("applyCodeEdit replaces code AND shifts ranges below", () => {
  // Insert a line at the top of the code; 'inner' (3-4) should shift to (4-5).
  const code = extract(SAMPLE);
  const newCode = "import x\n" + code; // prepend a line
  const out = applyCodeEdit(SAMPLE, newCode);
  assert.strictEqual(extract(out).trim(), newCode.trim());
  const r = parse(out);
  // Existing described lines move down by one; the new line 1 is not auto-claimed.
  assert.deepStrictEqual(r.explanations.find((e) => e.blockId === "inner")!.ranges, [{ start: 4, end: 5 }]);
  assert.deepStrictEqual(r.explanations.find((e) => e.blockId === "overview")!.ranges, [{ start: 2, end: 6 }]);
});

check("resilient to unclosed fence", () => {
  const truncated = `# [CODE: MONOLITH]\n\`\`\`python\ndef x():\n    pass\n`;
  const r = parse(truncated);
  assert.ok(r.errors.some((e) => e.includes("fence never closed")));
  assert.ok(extract(truncated).includes("def x()"));
});

check("rowOwners: blocks flow until the next anchor", () => {
  // overview@1, inner@3 over 6 lines -> rows 1,2 = overview; 3..6 = inner
  const owner = rowOwners(
    [
      { startLine: 1, activeId: "overview", collapsed: false },
      { startLine: 3, activeId: "inner", collapsed: false },
    ],
    6
  );
  assert.deepStrictEqual(owner.slice(1), ["overview", "overview", "inner", "inner", "inner", "inner"]);
});

check("rowOwners: a collapsed block reveals the one underneath", () => {
  // collapse 'inner' -> it owns only row 3; overview resumes on rows 4..6
  const owner = rowOwners(
    [
      { startLine: 1, activeId: "overview", collapsed: false },
      { startLine: 3, activeId: "inner", collapsed: true },
    ],
    6
  );
  assert.deepStrictEqual(owner.slice(1), ["overview", "overview", "inner", "overview", "overview", "overview"]);
});

console.log(`\n${passed} TS parser checks passed.`);
