import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./helpers/harness.mjs";

// Regression for the "blank band until the next scroll" bug: in 'offset'
// anchoring, applyScrollAdjustment eagerly folds the compensation delta into
// the scrollOffset mirror and issues a scrollTo. Compositor-scrolled
// viewports (WKWebView during an active wheel gesture) can silently swallow
// that write — no scroll event ever re-syncs the mirror, ranges are computed
// for a window the viewport never reached, and the visible viewport top is
// blank until the user scrolls again. The write-landing verification must
// detect the swallowed write one frame later and roll the mirror back.

const ACTUAL = 400; // measured row height (estimate is 100)

test("swallowed compensation writes self-heal within one frame", () => {
  const h = createHarness();

  // Wheel tick up: backward scroll into unmeasured territory.
  h.emitScroll(9880, true);
  assert.equal(h.blankBandAtViewportTop(), 0);

  // ResizeObserver batch: first measurements for the rows mounted at/above
  // the viewport top. Each compensates via scrollTo — all swallowed.
  const firstVisible = h.virtualizer.getVirtualItems()[0];
  h.setSwallowWrites(true);
  for (const index of [firstVisible.index - 2, firstVisible.index - 1, firstVisible.index]) {
    h.virtualizer.resizeItem(index, ACTUAL);
  }
  h.setSwallowWrites(false);

  // Mirror diverged; the rendered window sits below the real viewport.
  assert.equal(h.writes.filter((w) => w.swallowed).length, 3);
  assert.ok(h.virtualizer.scrollOffset > h.realScrollTop + 100);
  assert.ok(h.blankBandAtViewportTop() > 0, "expected a blank band before verification");

  // One frame later the verification reads the DOM back, adopts it, and
  // recomputes the range — no user scroll needed.
  h.runRafs();
  assert.equal(h.virtualizer.scrollOffset, h.realScrollTop);
  assert.equal(h.blankBandAtViewportTop(), 0);
});

test("landed writes are left untouched by verification", () => {
  const h = createHarness();
  h.emitScroll(9880, true);

  const firstVisible = h.virtualizer.getVirtualItems()[0];
  h.virtualizer.resizeItem(firstVisible.index, ACTUAL);

  const write = h.writes.at(-1);
  assert.equal(write.swallowed, false);
  assert.equal(h.virtualizer.scrollOffset, write.landed);

  const before = h.virtualizer.scrollOffset;
  h.runRafs();
  assert.equal(h.virtualizer.scrollOffset, before);
  assert.equal(h.blankBandAtViewportTop(), 0);
});

test("a scroll-event echo consumes the intent before the verify frame", () => {
  const h = createHarness();
  h.emitScroll(9880, true);

  const firstVisible = h.virtualizer.getVirtualItems()[0];
  h.virtualizer.resizeItem(firstVisible.index, ACTUAL);
  h.emitEcho(true);

  const before = h.virtualizer.scrollOffset;
  h.runRafs();
  assert.equal(h.virtualizer.scrollOffset, before);
  assert.equal(h.virtualizer.scrollOffset, h.realScrollTop);
  assert.equal(h.blankBandAtViewportTop(), 0);
});
