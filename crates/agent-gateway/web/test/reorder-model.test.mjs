import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const reorder = loader.loadModule("src/lib/reorder/reorderModel.ts");

const slots = [
  { id: "a", start: 0, size: 40 },
  { id: "b", start: 48, size: 60 },
  { id: "c", start: 116, size: 30 },
];

test("WebUI vertical reorder uses the shared axis-neutral drag math", () => {
  assert.equal(reorder.computeDragInsertIndex(slots, "b", -48), 0);
  assert.equal(reorder.computeDragInsertIndex(slots, "b", 38), 2);
  assert.deepEqual(reorder.computeDragShiftOffsets(slots, "b", 0, 8), { a: 68 });
  assert.deepEqual(reorder.computeDragShiftOffsets(slots, "b", 2, 8), { c: -68 });
  assert.equal(reorder.clampDragOffset(slots, "b", -1_000), -48);
  assert.equal(reorder.clampDragOffset(slots, "b", 1_000), 38);
});

test("WebUI vertical reorder supports auto-scroll and keyboard movement", () => {
  assert.ok(reorder.computeDragAutoScrollVelocity(100, 500, 105) < 0);
  assert.equal(reorder.computeDragAutoScrollVelocity(100, 500, 300), 0);
  assert.ok(reorder.computeDragAutoScrollVelocity(100, 500, 495) > 0);
  assert.deepEqual(
    reorder.reorderIdsByKeyboard(["a", "b", "c"], "b", "ArrowDown", "vertical"),
    ["a", "c", "b"],
  );
}
);
