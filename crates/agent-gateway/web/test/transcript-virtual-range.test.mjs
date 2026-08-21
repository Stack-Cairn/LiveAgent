import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const {
  extractLiveRange,
  LIVE_RANGE_OVERSCAN_COST_BUDGET,
  LIVE_RANGE_OVERSCAN_MAX_ROWS,
} = loader.loadModule("src/lib/transcript-virtual/liveRangeExtractor.ts");

const range = { count: 30, endIndex: 12, overscan: 0, startIndex: 10 };

test("light transcript rows keep a small bounded warm range", () => {
  assert.equal(LIVE_RANGE_OVERSCAN_COST_BUDGET, 6);
  assert.equal(LIVE_RANGE_OVERSCAN_MAX_ROWS, 3);
  assert.deepEqual(extractLiveRange(range, -1, () => 1), [7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

test("one expensive Markdown neighbor consumes the overscan budget", () => {
  const costs = new Map([
    [9, 12],
    [13, 4],
    [14, 3],
  ]);
  assert.deepEqual(extractLiveRange(range, -1, (index) => costs.get(index) ?? 1), [
    9, 10, 11, 12, 13, 14,
  ]);
});

test("the live suffix remains mounted outside the visible and warm ranges", () => {
  assert.deepEqual(extractLiveRange(range, 25, () => 12), [
    9, 10, 11, 12, 13, 25, 26, 27, 28, 29,
  ]);
});
