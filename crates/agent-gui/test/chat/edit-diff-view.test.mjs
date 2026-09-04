import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("../../../agent-ui/src/components/chat/EditDiffView.tsx", import.meta.url),
  "utf8",
);

test("edit tool diff uses the compact code-block presentation", () => {
  assert.match(source, /data-chat-code-diff/);
  assert.match(source, /max-w-\[420px\]/);
  assert.match(source, /<CodeFileIcon \/>/);
  assert.match(source, /\+\{diff\.added\}/);
  assert.match(source, /-\{diff\.removed\}/);
  assert.match(source, /grid-cols-\[var\(--diff-gutter\)_minmax\(0,1fr\)\]/);
  assert.match(source, /DELETE_HATCH/);
  assert.match(source, /bg-emerald-500\/20/);
  assert.match(source, /bg-red-500\/20/);
});

test("edit tool diff sizes the line-number gutter from the widest line number", () => {
  assert.match(source, /gutterDigits: Math\.max\(2, String\(widestLineNumber\)\.length\)/);
  assert.match(source, /"--diff-gutter": `calc\(\$\{diff\.gutterDigits\}ch \+ 4px\)`/);
  // The vertical rule sits on the gutter edge, so it has to track the same width.
  assert.match(source, /left-\[var\(--diff-gutter\)\]/);
  assert.doesNotMatch(source, /grid-cols-\[\d+px_/);
});

test("edit tool diff keeps real unified diff data without the legacy renderer", () => {
  assert.match(source, /generateDiffFile/);
  assert.match(source, /buildUnifiedDiffLines/);
  assert.match(source, /DiffLineType\.Add/);
  assert.match(source, /DiffLineType\.Delete/);
  assert.doesNotMatch(source, /@git-diff-view\/react/);
  assert.doesNotMatch(source, /<DiffView/);
});
