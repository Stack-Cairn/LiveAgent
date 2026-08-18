import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  appendDesktopLiveTrajectory,
  clearDesktopLiveTrajectory,
  desktopLiveTrajectoryEvents,
} = loader.loadModule("src/lib/trajectory/liveTrajectory.ts");

test("desktop live trajectory snapshots update and clear per conversation", () => {
  clearDesktopLiveTrajectory("desktop-live-c1");
  const empty = desktopLiveTrajectoryEvents("desktop-live-c1");
  appendDesktopLiveTrajectory("desktop-live-c1", [{ k: "user", t: 1, at: 1 }]);
  const first = desktopLiveTrajectoryEvents("desktop-live-c1");
  assert.equal(first.length, 1);
  assert.notEqual(first, empty);
  appendDesktopLiveTrajectory("desktop-live-c1", [{ k: "turn_end", t: 1, at: 2, st: "complete" }]);
  const second = desktopLiveTrajectoryEvents("desktop-live-c1");
  assert.equal(second.length, 2);
  assert.notEqual(second, first);
  clearDesktopLiveTrajectory("desktop-live-c1");
  assert.equal(desktopLiveTrajectoryEvents("desktop-live-c1").length, 0);
});
