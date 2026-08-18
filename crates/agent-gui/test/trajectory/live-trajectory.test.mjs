import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  absorbLocalTrajectoryEvent,
  clearLocalTrajectory,
  localTrajectoryEvents,
  localTrajectoryRefreshRevision,
  subscribeLocalTrajectory,
} = loader.loadModule("@liveagent/app/lib/trajectory/liveTrajectory.ts");

test("desktop live trajectory publishes immutable snapshots", async () => {
  clearLocalTrajectory("c-live");
  const before = localTrajectoryEvents("c-live");
  absorbLocalTrajectoryEvent("c-live", { k: "user", t: 1, at: 10 });
  const after = localTrajectoryEvents("c-live");
  assert.notEqual(after, before);
  assert.deepEqual(after, [{ k: "user", t: 1, at: 10 }]);
});

test("desktop live trajectory accepts recorder batches and can be rebased", () => {
  clearLocalTrajectory("c-batch");
  absorbLocalTrajectoryEvent("c-batch", [
    { k: "user", t: 1, at: 10 },
    { k: "turn_end", t: 1, at: 20, st: "complete" },
  ]);
  assert.equal(localTrajectoryEvents("c-batch").length, 2);
  const revision = localTrajectoryRefreshRevision("c-batch");
  clearLocalTrajectory("c-batch");
  assert.equal(localTrajectoryEvents("c-batch").length, 0);
  assert.equal(localTrajectoryRefreshRevision("c-batch"), revision + 1);
});

test("desktop live subscription returns an unsubscribe function", () => {
  const unsubscribe = subscribeLocalTrajectory(() => undefined);
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
});
