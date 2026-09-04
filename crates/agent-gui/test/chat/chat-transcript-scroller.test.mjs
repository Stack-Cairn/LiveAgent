import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("../../src/pages/chat/transcript/ChatTranscript.tsx", import.meta.url),
  "utf8",
);
const transcriptListSource = fs.readFileSync(
  new URL("../../src/pages/chat/transcript/TranscriptList.tsx", import.meta.url),
  "utf8",
);
const applicationViewSource = fs.readFileSync(
  new URL("../../../agent-ui/src/application/ApplicationView.tsx", import.meta.url),
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
    transcriptListSource,
    /onLoadEarlierHistory\(\)\s*\.catch\(\(\) => undefined\)\s*\.finally\(/,
  );
  assert.doesNotMatch(transcriptListSource, /onLoadEarlierHistory\(\)\.finally\(/);
});

test("earlier-history paging is anchored by the virtualizer, not by manual scrollTop writes", () => {
  // A prepended page is anchored through the virtualizer's 'origin' mode;
  // a manual scrollTop compensation on top of it rewinds the viewport to the
  // position captured when the load was requested (a visible jump) and
  // bypasses the virtualizer's write tracking.
  assert.doesNotMatch(source, /scrollViewport\.scrollTop\s*=/);
  assert.doesNotMatch(transcriptListSource, /scrollViewport\.scrollTop\s*=/);
  // The trigger reads the settled offset: while a page is anchored through
  // the origin, DOM scrollTop stays parked near the top and a raw check
  // would re-arm on every wheel tick, stacking pages.
  assert.match(transcriptListSource, /virtualizer\.getSettledScrollOffset\(\)\s*<=/);
  assert.doesNotMatch(transcriptListSource, /scrollViewport\.scrollTop\s*>\s*\d/);
  assert.doesNotMatch(source, /scrollViewport\.scrollTop\s*>\s*\d/);
  // The hard top stays a trigger of its own (WebKit defers the rebase through
  // a fling, pinning the viewport at 0 with unsettled debt above it), latched
  // once per visit so rubber-band events at 0 cannot stack pages.
  assert.match(transcriptListSource, /const atHardTop = scrollViewport\.scrollTop <= 1;/);
  assert.match(transcriptListSource, /hardTopLatchedRef/);
});

test("application chat wrapper preserves the transcript flex height chain", () => {
  assert.match(
    applicationViewSource,
    /className=\{cn\(\s*"relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",\s*containerProps\?\.className,\s*\)\}/s,
  );
});
