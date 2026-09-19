import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./helpers/harness.mjs";

// Directional pixel overscan: the visible window is widened toward the last
// known scroll direction so compositor-async scrolling (which paints ahead
// of the main thread) reveals pre-rendered rows instead of blank space.

test("backward scrolling pre-renders rows above the viewport", () => {
  const plain = createHarness();
  const overscanned = createHarness({ directionalOverscanPx: 480 });

  plain.emitScroll(9880, true);
  overscanned.emitScroll(9880, true);

  const plainFirst = plain.virtualizer.getVirtualItems()[0].index;
  const overscannedFirst = overscanned.virtualizer.getVirtualItems()[0].index;
  // 480px at 100px estimates is at least 4 extra rows above.
  assert.ok(
    overscannedFirst <= plainFirst - 4,
    `expected extension above (plain ${plainFirst}, overscanned ${overscannedFirst})`,
  );
});

test("forward scrolling pre-renders rows below the viewport", () => {
  const h = createHarness({ directionalOverscanPx: 480, initialOffset: 5000 });
  h.emitScroll(5120, true);
  const last = h.virtualizer.getVirtualItems().at(-1);
  // Window end 5720 plus 480 of forward overscan reaches past row 61.
  assert.ok(last.index >= 61, `expected extension below, got ${last.index}`);
});

test("the extension sticks to the last direction when scrolling settles", () => {
  const h = createHarness({ directionalOverscanPx: 480 });
  h.emitScroll(9880, true);
  const duringScroll = h.virtualizer.getVirtualItems()[0].index;
  h.emitScroll(9880, false);
  const afterSettle = h.virtualizer.getVirtualItems()[0].index;
  assert.equal(afterSettle, duringScroll, "settling must not churn the mounted range");
});

test("symmetric pixels warm both sides before a gesture and retain reversal content", () => {
  const h = createHarness({ overscanPx: 300, directionalOverscanPx: 900, initialOffset: 5000 });
  let items = h.virtualizer.getVirtualItems();
  assert.ok(items[0].start <= 4700);
  assert.ok(items.at(-1).end >= 5900);
  h.emitScroll(5120, true);
  items = h.virtualizer.getVirtualItems();
  assert.ok(items[0].start <= 4820, "keep already visited rows behind the forward scroll");
  assert.ok(items.at(-1).end >= 6920, "render two viewports ahead");
  // Reverse within the retained band before the next main-thread event.
  assert.ok(items[0].start <= 4920);
  h.emitScroll(4920, true);
  items = h.virtualizer.getVirtualItems();
  assert.ok(items[0].start <= 3720);
  assert.ok(items.at(-1).end >= 5820);
});

test("fast jumps cover the viewport while mounting a bounded slice of a huge history", () => {
  const h = createHarness({ count: 10000, overscanPx: 300, directionalOverscanPx: 900, initialOffset: 500000 });
  for (const offset of [490000, 485000, 300000, 310000, 700000, 0, 999400]) {
    h.emitScroll(offset, true);
    const items = h.virtualizer.getVirtualItems();
    assert.ok(items[0].start <= offset);
    assert.ok(items.at(-1).end >= offset + 600);
    assert.ok(items.length <= 24, `pixel budget must stay bounded, got ${items.length}`);
  }
});
