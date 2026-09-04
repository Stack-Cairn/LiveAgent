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

// Prepend a page of `pages` estimated rows above the loaded window, the way
// a history "load earlier" lands: same tail keys, shifted indexes, larger
// count. Returns the key of the row that was first before the prepend.
function prependPage(h, pages, previousCount = 200) {
  h.virtualizer.setOptions({
    ...h.virtualizer.options,
    count: previousCount + pages,
    getItemKey: (index) => (index < pages ? `new-${index}` : `row-${index - pages}`),
  });
  h.virtualizer._willUpdate();
}

test("a history page prepended onto an idle viewport settles on the next frame, with no jump", () => {
  // The reader sits near the top of the loaded window (the load-earlier
  // trigger fired) and has stopped scrolling. Before this fix the debt sat
  // until the next scroll event; then the write landed before the sizer had
  // grown and was clamped, and the layout — already shifted by the whole
  // page — tore off the viewport by ~one viewport height.
  const h = originHarness({ initialOffset: 300 });
  h.emitScroll(300, true);
  h.emitScroll(300, false);
  h.writes.length = 0;

  const relativeBefore = h.itemByKey("row-0").start - h.realScrollTop;
  const sizerBefore = h.domSizerHeight;

  // A page as tall as the whole loaded window: 200 rows x 100 px.
  prependPage(h, 200);
  assert.equal(h.writes.length, 0, "the prepend itself must not write scrollTop");
  assert.equal(h.itemByKey("row-0").start - h.realScrollTop, relativeBefore);
  // Distance from the true top of the content, for paging triggers.
  assert.equal(h.virtualizer.getSettledScrollOffset(), 300 + 200 * 100);
  assert.equal(h.virtualizer.scrollOffset, 300, "DOM scrollTop is still parked");

  // Next frame: the idle rebase publishes the grown layout, then writes.
  h.runRafs();
  assert.equal(h.originOffset(), 0);
  assert.equal(h.writes.length, 1);
  const write = h.writes[0];
  assert.equal(write.swallowed, false);
  assert.equal(write.landed, write.target, "the write must not be clamped");
  assert.equal(h.realScrollTop, 300 + 200 * 100);
  assert.equal(h.domSizerHeight, sizerBefore + 200 * 100, "the sizer grew before the write");
  assert.equal(
    h.itemByKey("row-0").start - h.realScrollTop,
    relativeBefore,
    "the row under the viewport must not move",
  );
  assert.equal(h.blankBandAtViewportTop(), 0);
  assert.equal(h.virtualizer.getSettledScrollOffset(), h.realScrollTop);

  // The echo confirms the landing; nothing else is written.
  h.emitEcho(true);
  h.emitScroll(h.realScrollTop, false);
  assert.equal(h.writes.length, 1);
  assert.equal(h.originOffset(), 0);
});

test("a rebase write clamped by a lagging sizer returns its remainder to the origin on the echo", () => {
  // A consumer that renders the published layout late (no synchronous
  // sizer growth): the write clamps at the old scrollable ceiling. The echo
  // arrives exactly on that ceiling — the signature of a clamp, not of user
  // movement — and the unconfirmed remainder must go back into the origin
  // so the layout re-attaches to where the viewport really is.
  const h = originHarness({ initialOffset: 300 });
  h.emitScroll(300, true);
  h.emitScroll(300, false);
  h.writes.length = 0;
  h.setSizerFollowsLayout(false);

  const relativeBefore = h.itemByKey("row-0").start - h.realScrollTop;
  prependPage(h, 200);
  h.runRafs();

  const write = h.writes[0];
  assert.equal(write.target, 300 + 200 * 100);
  assert.equal(write.landed, 200 * 100 - 600, "clamped at the stale ceiling");
  assert.notEqual(
    h.itemByKey("row-0").start - h.realScrollTop,
    relativeBefore,
    "between write and echo the layout is ahead of the viewport",
  );

  h.emitEcho(true);
  assert.equal(h.virtualizer.scrollOffset, h.realScrollTop);
  assert.equal(h.originOffset(), -(write.target - write.landed), "the residual is back in the origin");
  assert.equal(
    h.itemByKey("row-0").start - h.realScrollTop,
    relativeBefore,
    "the echo must re-attach the layout to the viewport",
  );
  assert.equal(h.blankBandAtViewportTop(), 0);

  // The late render lands; the next idle moment settles the remainder.
  h.syncSizer();
  h.emitScroll(h.realScrollTop, false);
  assert.equal(h.originOffset(), 0);
  assert.equal(h.writes.at(-1).landed, h.writes.at(-1).target);
  assert.equal(h.itemByKey("row-0").start - h.realScrollTop, relativeBefore);
  assert.equal(h.blankBandAtViewportTop(), 0);
});

test("a clamped rebase write with no echo is rolled back by the verify frame", () => {
  const h = originHarness({ initialOffset: 300 });
  h.emitScroll(300, true);
  h.emitScroll(300, false);
  h.writes.length = 0;
  h.setSizerFollowsLayout(false);

  const relativeBefore = h.itemByKey("row-0").start - h.realScrollTop;
  prependPage(h, 200);
  h.runRafs(); // idle rebase: publish, clamped write, verify frame queued
  assert.notEqual(h.writes[0].landed, h.writes[0].target);

  h.runRafs(); // verify frame
  assert.equal(h.virtualizer.scrollOffset, h.realScrollTop);
  assert.equal(h.itemByKey("row-0").start - h.realScrollTop, relativeBefore);
  assert.equal(h.blankBandAtViewportTop(), 0);
});

test("an echo that carries user movement still settles the rebase as landed", () => {
  // The user kept scrolling on an engine that honors mid-gesture writes:
  // the echo misses the intent but is nowhere near a clamp bound. Rolling
  // back would freeze content for a frame; the movement is the user's.
  const h = originHarness();
  h.emitScroll(9880, true);
  const firstVisible = h.virtualizer.getVirtualItems()[0];
  h.virtualizer.resizeItem(firstVisible.index, ACTUAL);
  const debt = h.originOffset();
  assert.ok(debt < 0);

  h.emitScroll(9760, false); // idle rebase
  assert.equal(h.originOffset(), 0);
  const write = h.writes.at(-1);
  assert.equal(write.landed, write.target);

  h.emitScroll(write.target - 40, true); // echo + a wheel tick in one event
  assert.equal(h.originOffset(), 0, "user movement must not be mistaken for a clamp");
  assert.equal(h.virtualizer.scrollOffset, write.target - 40);
});

test("a rebase from inside the blank band at the top closes the band instead of retrying forever", () => {
  // Rows above measured smaller than estimated shift the layout down: a blank
  // band opens at the top (positive debt). When the rebase runs only after the
  // viewport has entered the band, it can bring the viewport no further than
  // 0 — the layout must still close the whole band, and the part the viewport
  // cannot follow is a one-time shift, not residual to roll back (rolling it
  // back would re-open the band and clamp again on every attempt).
  const h = originHarness({ initialOffset: 600 });
  h.emitScroll(600, true);
  for (let index = 0; index < 5; index += 1) {
    h.virtualizer.resizeItem(index, 20);
  }
  assert.equal(h.originOffset(), 5 * (100 - 20));
  assert.equal(h.itemByKey("row-0").start, 400, "the band sits above the first row");

  // The viewport lands inside the band; near the top the rebase is forced.
  h.emitScroll(300, true);
  assert.equal(h.originOffset(), 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].target, 0, "the write asks for the reachable offset");
  assert.equal(h.realScrollTop, 0);
  assert.equal(h.itemByKey("row-0").start, 0, "the band is closed");
  assert.equal(h.blankBandAtViewportTop(), 0);

  // Echo and verify frame both confirm the landing; nothing is rolled back.
  h.emitEcho(true);
  assert.equal(h.originOffset(), 0);
  h.runRafs();
  assert.equal(h.originOffset(), 0);
  assert.equal(h.itemByKey("row-0").start, 0);
  h.emitScroll(0, false);
  assert.equal(h.writes.length, 1, "no retry loop");
  assert.equal(h.blankBandAtViewportTop(), 0);
});

test("measurement debt absorbed while idle settles on the next frame", () => {
  // No scroll event is coming to settle debt created by an idle re-measure
  // (an image loading above the viewport); the idle frame must do it.
  const h = originHarness();
  h.emitScroll(9880, true);
  h.emitScroll(9880, false);
  h.writes.length = 0;

  const firstVisible = h.virtualizer.getVirtualItems()[0];
  const anchor = h.virtualizer.getVirtualItems()[1];
  const relativeBefore = h.itemByKey(anchor.key).start - h.realScrollTop;
  h.virtualizer.resizeItem(firstVisible.index - 1, ACTUAL);
  assert.ok(h.originOffset() < 0);
  assert.equal(h.writes.length, 0);

  h.runRafs();
  assert.equal(h.originOffset(), 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].landed, h.writes[0].target);
  assert.equal(h.itemByKey(anchor.key).start - h.realScrollTop, relativeBefore);
  assert.equal(h.blankBandAtViewportTop(), 0);
});

test("the rebase publishes the grown layout synchronously before it writes", () => {
  const h = originHarness({ initialOffset: 300 });
  h.emitScroll(300, true);
  h.emitScroll(300, false);
  h.writes.length = 0;
  h.notifies.length = 0;

  prependPage(h, 200);
  const notifiesBeforeRebase = h.notifies.length;
  h.runRafs();
  const rebaseNotify = h.notifies[notifiesBeforeRebase];
  assert.ok(rebaseNotify, "the rebase must notify");
  assert.equal(rebaseNotify.sync, true, "the publish must be synchronous (flushSync-able)");
  assert.equal(rebaseNotify.totalSize, 400 * 100);
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
