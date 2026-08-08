import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const roundContentSource = fs.readFileSync(
  new URL("../src/pages/chat/assistant-bubble/RoundContent.tsx", import.meta.url),
  "utf8",
);

test("live assistant text does not render a trailing caret row", () => {
  assert.doesNotMatch(roundContentSource, /showCaret=/);
});
