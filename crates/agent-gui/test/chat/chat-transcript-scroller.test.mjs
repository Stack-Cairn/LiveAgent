import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("../../src/pages/chat/transcript/ChatTranscript.tsx", import.meta.url),
  "utf8",
);

test("chat transcript uses one native viewport for scrolling and follow listeners", () => {
  assert.doesNotMatch(source, /components\/ui\/scroll-area/);
  assert.doesNotMatch(source, /<ScrollArea\b/);
  assert.match(source, /listenerRoot:\s*scrollViewport/);
  assert.match(source, /ref=\{setScrollViewport\}/);
  assert.match(source, /data-scroll-viewport/);
  assert.match(source, /overflow-y-auto/);
  assert.match(source, /\[overflow-anchor:none\]/);
});

test("earlier-history rejection is handled before pagination cleanup", () => {
  assert.match(
    source,
    /onLoadEarlierHistory\(\)\s*\.catch\(\(\) => undefined\)\s*\.finally\(/,
  );
  assert.doesNotMatch(source, /onLoadEarlierHistory\(\)\.finally\(/);
});
