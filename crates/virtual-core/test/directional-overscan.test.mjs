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
