import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./helpers/harness.mjs";

// `anchorTo: 'end'` pins the viewport to the end while a resize lands, but
// only when the viewport really is at the end. That distance must be measured
// against the browser's scroll clamp (DOM scrollHeight), not the virtual
// list's own end: the hosts render a fixed spacer (composer reserve) and
// shell padding below the sizer, so the list ends ~200px above the clamp. The
// old virtual-distance check treated that whole band as "at end" and dragged a
// detached reader down by every bottom-row growth.

const VIEWPORT = 600;
const ESTIMATE = 100;
// 18px shell padding-top + 194px bottom spacer in the WebUI transcript.
const NON_VIRTUAL_BOTTOM = 212;
const LAST_INDEX = 199;

function parkedHarness(gapFromClampPx) {
  const h = createHarness({
    scrollAnchoring: "origin",
    anchorTo: "end",
    viewport: VIEWPORT,
    estimate: ESTIMATE,
    extraScrollHeight: NON_VIRTUAL_BOTTOM,
    initialOffset: 0,
  });
  const offset = h.maxScrollOffset() - gapFromClampPx;
  h.emitScroll(offset, true);
  h.emitScroll(offset, false);
  h.runRafs();
  h.writes.length = 0;
  return h;
}

test("a reader parked inside the non-virtual bottom band is not end-anchored", () => {
  // 100px above the clamp = 112px *below* the virtual list's end: the old
  // check clamped this to a virtual distance of 0 and pinned.
  const h = parkedHarness(100);
  const before = h.realScrollTop;

  h.virtualizer.resizeItem(LAST_INDEX, ESTIMATE + 400);
  h.runRafs();

  assert.equal(h.writes.length, 0, "growth below the reader must not write scrollTop");
  assert.equal(h.realScrollTop, before);
  assert.equal(h.virtualizer.scrollOffset, before);
});

test("a reader just above the band edge is not end-anchored either", () => {
  // Virtual distance 8px (the old threshold hit exactly) is still 220px from
  // the real clamp.
  const h = parkedHarness(NON_VIRTUAL_BOTTOM + 8);
  const before = h.realScrollTop;

  h.virtualizer.resizeItem(LAST_INDEX, ESTIMATE + 400);
  h.runRafs();

  assert.equal(h.writes.length, 0);
  assert.equal(h.realScrollTop, before);
});

test("a reader at the real clamp keeps the end pinned when the bottom row grows", () => {
  const h = parkedHarness(0);
  const before = h.realScrollTop;

  h.virtualizer.resizeItem(LAST_INDEX, ESTIMATE + 400);

  assert.equal(h.writes.length, 1, "end anchoring writes once for the growth");
  assert.equal(h.writes[0].target, before + 400);
});

test("the default harness (no non-virtual height) keeps its clamp semantics", () => {
  const h = createHarness({ anchorTo: "end", initialOffset: 0 });
  assert.equal(h.maxScrollOffset(), 200 * 100 - 600);
  assert.equal(h.element.scrollHeight, 200 * 100);
});
