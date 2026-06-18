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

console.log(`\n${passed} TS parser checks passed.`);
