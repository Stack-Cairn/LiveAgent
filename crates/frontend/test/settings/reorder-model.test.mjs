import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const reorder = loader.loadModule("src/lib/reorder/reorderModel.ts");

const slots = [
  { id: "a", start: 0, size: 40 },
  { id: "b", start: 48, size: 60 },
  { id: "c", start: 116, size: 30 },
];

test("vertical drag insert index reaches both ends with variable row heights", () => {
  assert.equal(reorder.computeDragInsertIndex(slots, "b", -48), 0);
  assert.equal(reorder.computeDragInsertIndex(slots, "b", 38), 2);
  assert.deepEqual(reorder.applyDragInsertIndex(["a", "b", "c"], "b", 2), ["a", "c", "b"]);
});

test("vertical drag shifts neighbours by dragged row height plus gap", () => {
  assert.deepEqual(reorder.computeDragShiftOffsets(slots, "b", 0, 8), { a: 68 });
  assert.deepEqual(reorder.computeDragShiftOffsets(slots, "b", 2, 8), { c: -68 });
});

test("vertical drag clamps to list bounds and auto-scrolls near edges", () => {
  assert.equal(reorder.clampDragOffset(slots, "b", -1_000), -48);
  assert.equal(reorder.clampDragOffset(slots, "b", 1_000), 38);
  assert.ok(reorder.computeDragAutoScrollVelocity(100, 500, 105) < 0);
  assert.equal(reorder.computeDragAutoScrollVelocity(100, 500, 300), 0);
  assert.ok(reorder.computeDragAutoScrollVelocity(100, 500, 495) > 0);
});

test("vertical keyboard reorder supports arrows and list boundaries", () => {
  assert.deepEqual(reorder.reorderIdsByKeyboard(["a", "b", "c"], "b", "ArrowUp", "vertical"), [
    "b",
    "a",
    "c",
  ]);
  assert.deepEqual(
    reorder.reorderIdsByKeyboard(["a", "b", "c"], "b", "ArrowDown", "vertical"),
    ["a", "c", "b"],
  );
  assert.deepEqual(reorder.reorderIdsByKeyboard(["a", "b", "c"], "b", "Home", "vertical"), [
    "b",
    "a",
    "c",
  ]);
  assert.deepEqual(reorder.reorderIdsByKeyboard(["a", "b", "c"], "b", "End", "vertical"), [
    "a",
    "c",
    "b",
  ]);
  assert.equal(reorder.reorderIdsByKeyboard(["a", "b", "c"], "a", "ArrowUp", "vertical"), null);
});
