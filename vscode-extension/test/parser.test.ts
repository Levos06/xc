/** Minimal assertion harness for the TS recognizer — no test runner needed. */
import * as assert from "assert";
import { parse, codeBlocks, extract, spliceCode, codeViews } from "../src/xcParser";

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

console.log(`\n${passed} TS parser checks passed.`);
