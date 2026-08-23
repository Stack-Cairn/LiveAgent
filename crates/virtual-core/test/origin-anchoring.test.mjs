import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./helpers/harness.mjs";

// 'origin' scroll anchoring: above-viewport size corrections are absorbed
// into a layout origin instead of written to scrollTop, so no programmatic
// scroll can race the user's gesture. The accumulated debt is settled by a
// single verified write at a safe moment (idle / debt cap / near the top).

const ACTUAL = 400; // measured row height (estimate is 100)

function originHarness(options = {}) {
  return createHarness({ scrollAnchoring: "origin", ...options });
}

test("above-viewport first measurements absorb into the origin: no writes, viewport stable", () => {
  const h = originHarness();
  h.emitScroll(9880, true);

  const firstVisible = h.virtualizer.getVirtualItems()[0];
  const visibleBefore = h.virtualizer
    .getVirtualItems()
    .filter((item) => item.index > firstVisible.index)
    .map((item) => ({ key: item.key, start: item.start }));
  const offsetBefore = h.virtualizer.scrollOffset;

  for (const index of [firstVisible.index - 2, firstVisible.index - 1, firstVisible.index]) {
    h.virtualizer.resizeItem(index, ACTUAL);
  }

  assert.equal(h.writes.length, 0, "origin mode must not write scrollTop mid-scroll");
  assert.equal(h.virtualizer.scrollOffset, offsetBefore);
  assert.equal(h.originOffset(), -3 * (ACTUAL - 100));
  for (const { key, start } of visibleBefore) {
    assert.equal(h.itemByKey(key).start, start, `row ${key} must not move`);
  }
  assert.equal(h.blankBandAtViewportTop(), 0);
});

test("the compensation policy still gates absorption", () => {
  const h = originHarness();
  h.virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  h.emitScroll(9880, true);

  const firstVisible = h.virtualizer.getVirtualItems()[0];
  h.virtualizer.resizeItem(firstVisible.index - 1, ACTUAL);

  assert.equal(h.originOffset(), 0);
  assert.equal(h.writes.length, 0);
});

test("prepends anchor through the origin with zero writes (anchorTo end)", () => {
  const h = originHarness();
  h.emitScroll(9880, true);
  h.emitScroll(9880, false);
  h.writes.length = 0;

  const anchorBefore = h.itemByKey("row-98");
  const offsetBefore = h.virtualizer.scrollOffset;

  // Ten rows arrive above: same tail keys, shifted indexes, larger count.
  const prepended = 10;
  h.virtualizer.setOptions({
    ...h.virtualizer.options,
    count: 200 + prepended,
    getItemKey: (index) => (index < prepended ? `new-${index}` : `row-${index - prepended}`),
  });
  h.virtualizer._willUpdate();

  assert.equal(h.virtualizer.scrollOffset, offsetBefore, "scrollOffset must not move");
  assert.equal(h.writes.length, 0, "prepend must not write scrollTop");
  assert.equal(
    h.itemByKey("row-98").start,
    anchorBefore.start,
    "the row under the viewport must keep its position",
  );
  assert.equal(h.blankBandAtViewportTop(), 0);
});

test("idle away from the edges settles the debt with one verified write", () => {
  const h = originHarness();
  h.emitScroll(9880, true);

  const firstVisible = h.virtualizer.getVirtualItems()[0];
  for (const index of [firstVisible.index - 1, firstVisible.index]) {
    h.virtualizer.resizeItem(index, ACTUAL);
  }
  const debt = h.originOffset();
  assert.ok(debt < 0);

  // Still scrolling: no rebase (that would be the racy write again).
  h.emitScroll(9760, true);
  assert.equal(h.writes.length, 0);
  assert.equal(h.originOffset(), debt);

  const anchor = h.virtualizer.getVirtualItems()[1];
  const relativeBefore = h.itemByKey(anchor.key).start - h.virtualizer.scrollOffset;

  // Scroll settles: one write settles the whole debt.
  h.emitScroll(9760, false);
  assert.equal(h.originOffset(), 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].swallowed, false);
  assert.equal(
    h.itemByKey(anchor.key).start - h.virtualizer.scrollOffset,
    relativeBefore,
    "rebase must keep the viewport visually still",
  );
  assert.equal(h.blankBandAtViewportTop(), 0);
});

test("debt past its budget forces a rebase even mid-scroll", () => {
  const h = originHarness();
  h.emitScroll(9880, true);

  // Accumulate more than max(2*viewport, 2000) px of debt.
  const firstVisible = h.virtualizer.getVirtualItems()[0];
  for (let step = 0; step < 8; step += 1) {
    h.virtualizer.resizeItem(firstVisible.index - step, 400);
  }
  assert.ok(Math.abs(h.originOffset()) > 2000);

  h.emitScroll(9760, true);
  assert.equal(h.originOffset(), 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.blankBandAtViewportTop(), 0);
});

test("approaching the top with debt forces a rebase before the broken zone", () => {
  const h = originHarness({ initialOffset: 2000 });
  // Off row-boundary so the first visible row starts above the viewport top
  // (the absorption predicate is itemStart < scrollOffset).
  h.emitScroll(1850, true);

  const firstVisible = h.virtualizer.getVirtualItems()[0];
  h.virtualizer.resizeItem(firstVisible.index, ACTUAL);
  assert.ok(h.originOffset() < 0);

  // Next tick lands within the near-top window (scrollOffset < 2*viewport + |debt|).
  h.emitScroll(1300, true);
  assert.equal(h.originOffset(), 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.blankBandAtViewportTop(), 0);
});

test("on iOS, forced rebases wait for the gesture to settle", () => {
  // A rebase must shift the layout and write scrollTop in the same pass. On
  // iOS mid-gesture the write is deferred (it would cancel the momentum), so
  // rebasing there would leave the shifted layout visibly inconsistent until
  // the deferred flush — the rebase itself must wait for settle instead.
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "iPhone", platform: "iPhone", maxTouchPoints: 5 },
    configurable: true,
  });
  const h = originHarness();
  h.core._resetIOSDetectionForTests();
  try {
    h.emitScroll(9880, true);

    // Accumulate over-budget debt: on desktop this forces a mid-scroll rebase.
    const firstVisible = h.virtualizer.getVirtualItems()[0];
    for (let step = 0; step < 8; step += 1) {
      h.virtualizer.resizeItem(firstVisible.index - step, 400);
    }
    const debt = h.originOffset();
    assert.ok(Math.abs(debt) > 2000);

    h.emitScroll(9760, true);
    assert.equal(h.originOffset(), debt, "mid-gesture rebase must be deferred on iOS");
    assert.equal(h.writes.length, 0);

    // Gesture settles: the rebase runs with one direct write.
    h.emitScroll(9760, false);
    assert.equal(h.originOffset(), 0);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].swallowed, false);
    assert.equal(h.blankBandAtViewportTop(), 0);
  } finally {
    if (previousNavigator) {
      Object.defineProperty(globalThis, "navigator", previousNavigator);
    } else {
      delete globalThis.navigator;
    }
    h.core._resetIOSDetectionForTests();
  }
});

test("on macOS WKWebView (desktop WebKit), forced rebases wait for the gesture to settle", () => {
  // During a wheel gesture the WKWebView compositor owns the viewport and
  // can silently swallow a main-thread scrollTop write. A mid-gesture rebase
  // whose write is swallowed detaches the already-shifted layout from the
  // real viewport — the exact jump 'origin' mode exists to remove — so even
  // over-budget debt must wait for settle, where a landed rebase write is
  // visually a no-op.
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      platform: "MacIntel",
      maxTouchPoints: 0,
    },
    configurable: true,
  });
  const h = originHarness();
  h.core._resetIOSDetectionForTests();
  try {
    h.emitScroll(9880, true);

    const firstVisible = h.virtualizer.getVirtualItems()[0];
    for (let step = 0; step < 8; step += 1) {
      h.virtualizer.resizeItem(firstVisible.index - step, 400);
    }
    const debt = h.originOffset();
    assert.ok(Math.abs(debt) > 2000);

    h.emitScroll(9760, true);
    assert.equal(h.originOffset(), debt, "mid-gesture rebase must be deferred on WebKit");
    assert.equal(h.writes.length, 0);

    const anchor = h.virtualizer.getVirtualItems()[1];
    const relativeBefore = h.itemByKey(anchor.key).start - h.realScrollTop;

    // Gesture settles: the rebase runs with one landed write, invisibly.
    h.emitScroll(9760, false);
    assert.equal(h.originOffset(), 0);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].swallowed, false);
    assert.equal(
      h.itemByKey(anchor.key).start - h.realScrollTop,
      relativeBefore,
      "a settle-time rebase must keep the viewport visually still",
    );
    assert.equal(h.blankBandAtViewportTop(), 0);
  } finally {
    if (previousNavigator) {
      Object.defineProperty(globalThis, "navigator", previousNavigator);
    } else {
      delete globalThis.navigator;
    }
    h.core._resetIOSDetectionForTests();
  }
});

test("a swallowed forced rebase rolls its layout shift back within one frame", () => {
  // Engines that honor mid-gesture writes (default harness navigator) keep
  // the forced rebase paths; if such a write is still swallowed, the verify
  // frame must return the unconfirmed debt to the origin so the layout
  // re-attaches to the unmoved viewport — no jump, debt settles later.
  const h = originHarness();
  h.emitScroll(9880, true);

  const firstVisible = h.virtualizer.getVirtualItems()[0];
  for (let step = 0; step < 8; step += 1) {
    h.virtualizer.resizeItem(firstVisible.index - step, 400);
  }
  const debt = h.originOffset();
  assert.ok(Math.abs(debt) > 2000);

  const anchor = h.virtualizer.getVirtualItems()[2];
  const startBefore = h.itemByKey(anchor.key).start;

  // Over-budget debt forces a mid-scroll rebase; the write is swallowed.
  h.setSwallowWrites(true);
  h.emitScroll(9760, true);
  h.setSwallowWrites(false);
  assert.ok(h.writes.at(-1)?.swallowed);
  assert.equal(h.originOffset(), 0, "the rebase provisionally settled the debt");
  assert.ok(h.virtualizer.scrollOffset !== h.realScrollTop, "mirror diverged from the DOM");

  // The verify frame rolls the whole transaction back: mirror re-adopts the
  // DOM, the origin takes the debt back, rows return to their exact
  // pre-rebase positions.
  h.runRafs();
  assert.equal(h.virtualizer.scrollOffset, h.realScrollTop);
  assert.equal(h.originOffset(), debt, "unconfirmed debt must return to the origin");
  assert.equal(
    h.itemByKey(anchor.key).start,
    startBefore,
    "a rolled-back rebase must not move any row",
  );
  assert.equal(h.blankBandAtViewportTop(), 0);

  // A later attempt with a landing write settles the debt invisibly.
  const relativeBefore = h.itemByKey(anchor.key).start - h.realScrollTop;
  h.emitScroll(9760, false);
  assert.equal(h.originOffset(), 0);
  assert.equal(h.writes.at(-1)?.swallowed, false);
  assert.equal(
    h.itemByKey(anchor.key).start - h.realScrollTop,
    relativeBefore,
    "the retried rebase must keep the viewport visually still",
  );
  assert.equal(h.blankBandAtViewportTop(), 0);
});

test("swallowed rebase writes self-heal through write verification", () => {
  const h = originHarness();
  h.emitScroll(9880, true);
  const firstVisible = h.virtualizer.getVirtualItems()[0];
  h.virtualizer.resizeItem(firstVisible.index, ACTUAL);
  const debt = h.originOffset();
  assert.ok(debt < 0);
  const anchor = h.virtualizer.getVirtualItems()[1];
  const startBefore = h.itemByKey(anchor.key).start;

  h.setSwallowWrites(true);
  h.emitScroll(9760, false); // idle -> rebase fires, write swallowed
  h.setSwallowWrites(false);

  assert.ok(h.writes.at(-1)?.swallowed);
  assert.ok(h.virtualizer.scrollOffset !== h.realScrollTop);

  // Verification adopts the DOM truth and rolls the layout shift back.
  h.runRafs();
  assert.equal(h.virtualizer.scrollOffset, h.realScrollTop);
  assert.equal(h.originOffset(), debt);
  assert.equal(h.itemByKey(anchor.key).start, startBefore);
  assert.equal(h.blankBandAtViewportTop(), 0);

  // The next safe moment settles the debt for real.
  h.emitScroll(9760, false);
  assert.equal(h.originOffset(), 0);
  assert.equal(h.writes.at(-1)?.swallowed, false);
  assert.equal(h.blankBandAtViewportTop(), 0);
});
