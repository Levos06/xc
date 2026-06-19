/** Minimal assertion harness for the TS recognizer — no test runner needed. */
import * as assert from "assert";
import {
  parse,
  codeBlocks,
  extract,
  spliceCode,
  codeViews,
  setExplanationBody,
  insertExplanationBefore,
  describeSelection,
  renameBlockId,
  deleteExplanationBlock,
} from "../src/xcParser";

const SAMPLE = `---
language: "python"
module: "m"
---

# [EXPLANATION: a]
Some prose about A.

# [CODE: a]
\`\`\`python
def a():
    return 1
\`\`\`

# [EXPLANATION: b]
Prose about B.

# [CODE: b]
\`\`\`python
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

check("finds two code blocks", () => {
  const r = parse(SAMPLE);
  assert.strictEqual(codeBlocks(r).length, 2);
});

check("extract has no markup", () => {
  const code = extract(SAMPLE);
  assert.ok(code.includes("def a()"));
  assert.ok(code.includes("def b()"));
  assert.ok(!code.includes("EXPLANATION"));
  assert.ok(!code.includes("```"));
});

check("editing explanation does not change extracted code", () => {
  // Simulate the editor only ever splicing CODE; explanation lines differ.
  const edited = SAMPLE.replace("Some prose about A.", "TOTALLY new prose\nwith two lines");
  assert.strictEqual(extract(edited), extract(SAMPLE));
});

check("spliceCode round-trips edited code, leaving prose intact", () => {
  const newCode = "def a():\n    return 100\ndef b():\n    return 2\n";
  const spliced = spliceCode(SAMPLE, newCode);
  assert.ok(spliced.includes("return 100"));
  assert.ok(spliced.includes("Some prose about A."), "prose must survive");
  assert.ok(spliced.includes("# [EXPLANATION: b]"));
  assert.strictEqual(extract(spliced).trim(), newCode.trim());
});

check("codeViews map flat lines to blocks", () => {
  const views = codeViews(parse(SAMPLE));
  assert.strictEqual(views.length, 2);
  assert.strictEqual(views[0].blockId, "a");
  assert.strictEqual(views[0].flatStartLine, 0);
  assert.strictEqual(views[1].blockId, "b");
});

check("resilient to unclosed fence", () => {
  const truncated = `# [CODE: x]\n\`\`\`python\ndef x():\n    pass\n`;
  const r = parse(truncated);
  assert.ok(r.errors.some((e) => e.includes("never closed")));
  assert.ok(extract(truncated).includes("def x()"));
});

check("multi-block splice attributes inserted lines to the right block (no collapse)", () => {
  // Insert a line into block A — line count CHANGES. Block B must stay put,
  // and the new line must land in A, not collapse everything into block 1.
  const flat = extract(SAMPLE);
  const edited = flat.replace("    return 1\n", "    y = 1\n    return 1\n");
  const spliced = spliceCode(SAMPLE, edited);
  const r = parse(spliced);
  const blocks = codeBlocks(r);
  const aCode = r.lines.slice(blocks[0].bodyStart, blocks[0].bodyEnd).join("\n");
  const bCode = r.lines.slice(blocks[1].bodyStart, blocks[1].bodyEnd).join("\n");
  assert.ok(aCode.includes("y = 1"), "new line went to block A");
  assert.ok(aCode.includes("def a()"));
  assert.ok(!aCode.includes("def b()"), "block A must NOT swallow block B");
  assert.strictEqual(bCode.trim(), "def b():\n    return 2", "block B intact");
  // Round-trip: extracted code equals what the user typed.
  assert.strictEqual(extract(spliced).trim(), edited.trim());
});

check("multi-block splice handles deletions within one block", () => {
  const flat = extract(SAMPLE);
  const edited = flat.replace("def a():\n    return 1\n", "def a():\n    pass\n");
  const spliced = spliceCode(SAMPLE, edited);
  const blocks = codeBlocks(parse(spliced));
  const r = parse(spliced);
  const bCode = r.lines.slice(blocks[1].bodyStart, blocks[1].bodyEnd).join("\n");
  assert.strictEqual(bCode.trim(), "def b():\n    return 2", "block B intact after A shrinks");
});

check("setExplanationBody rewrites prose, code hash stable", () => {
  const before = extract(SAMPLE);
  const out = setExplanationBody(SAMPLE, "a", "Brand new prose for A\nwith two lines.");
  assert.ok(out.includes("Brand new prose for A"));
  assert.ok(!out.includes("Some prose about A."));
  assert.ok(out.includes("# [EXPLANATION: a]"), "heading preserved");
  assert.strictEqual(extract(out), before, "code untouched");
});

check("insertExplanationBefore adds a block before another", () => {
  const out = insertExplanationBefore(SAMPLE, "b", "note_1", "## Note\nbetween A and B");
  assert.ok(out.includes("# [EXPLANATION: note_1]"));
  assert.ok(out.indexOf("note_1") < out.indexOf("[EXPLANATION: b]"));
  assert.ok(out.indexOf("[EXPLANATION: a]") < out.indexOf("note_1"));
  assert.strictEqual(extract(out), extract(SAMPLE), "code untouched");
});

check("insertExplanationBefore(null) appends at end", () => {
  const out = insertExplanationBefore(SAMPLE, null, "tail", "## Tail note");
  assert.ok(out.trimEnd().endsWith("## Tail note") || out.includes("[EXPLANATION: tail]"));
  const r = parse(out);
  assert.ok(r.blocks.some((b) => b.blockId === "tail"));
});

check("describeSelection within a described block -> subblock", () => {
  const v = codeViews(parse(SAMPLE));
  // select inside block 'a' (its flat range)
  const r = describeSelection(SAMPLE, v[0].flatStartLine, v[0].flatStartLine + 1, "### Detail\nabout the return");
  assert.ok(r.ok && r.mode === "subblock" && r.blockId === "a");
  assert.ok(r.text!.includes("### Detail"));
  // still one explanation block 'a' (appended, not duplicated)
  const expl = parse(r.text!).blocks.filter((b) => b.kind === "EXPLANATION" && b.blockId === "a");
  assert.strictEqual(expl.length, 1);
  assert.strictEqual(extract(r.text!), extract(SAMPLE), "code untouched");
});

check("describeSelection on orphan code -> separate explanation", () => {
  const orphan = "# [CODE: lone]\n```python\ndef lone():\n    return 7\n```\n";
  const v = codeViews(parse(orphan));
  const r = describeSelection(orphan, v[0].flatStartLine, v[0].flatStartLine + 1, "## Lone\ndescribes lone()");
  assert.ok(r.ok && r.mode === "separate" && r.blockId === "lone");
  assert.ok(r.text!.indexOf("[EXPLANATION: lone]") < r.text!.indexOf("[CODE: lone]"));
  assert.strictEqual(extract(r.text!).trim(), "def lone():\n    return 7", "code untouched");
});

check("describeSelection across blocks is rejected", () => {
  const v = codeViews(parse(SAMPLE));
  const r = describeSelection(SAMPLE, v[0].flatStartLine, v[1].flatStartLine + v[1].lineCount, "x");
  assert.ok(!r.ok && /одного блока/.test(r.message || ""));
});

check("renameBlockId renames both explanation and code headings", () => {
  const out = renameBlockId(SAMPLE, "a", "alpha");
  assert.ok(out.includes("# [EXPLANATION: alpha]"));
  assert.ok(out.includes("# [CODE: alpha]"));
  assert.ok(!out.includes(": a]"));
  // 'b' untouched, code unchanged
  assert.ok(out.includes("# [EXPLANATION: b]"));
  assert.strictEqual(extract(out), extract(SAMPLE));
  const r = parse(out);
  assert.ok(r.blocks.some((x) => x.kind === "EXPLANATION" && x.blockId === "alpha"));
  assert.ok(r.blocks.some((x) => x.kind === "CODE" && x.blockId === "alpha"));
});

check("deleteExplanationBlock removes the description, keeps the code", () => {
  const out = deleteExplanationBlock(SAMPLE, "a");
  assert.ok(!out.includes("# [EXPLANATION: a]"));
  assert.ok(out.includes("# [CODE: a]"), "code block 'a' stays");
  assert.ok(out.includes("# [EXPLANATION: b]"), "block 'b' untouched");
  assert.strictEqual(extract(out), extract(SAMPLE), "code layer unchanged");
});

console.log(`\n${passed} TS parser checks passed.`);
