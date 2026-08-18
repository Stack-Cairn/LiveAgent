import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { buildTrajectoryRuntimeContext } = loader.loadModule(
  "src/pages/chat/turns/trajectoryRuntimeContext.ts",
);

test("runtime context preserves source order and the exact model-visible prompt", () => {
  const built = buildTrajectoryRuntimeContext([
    { source: "subagent-roster", text: "  ROSTER  " },
    { source: "empty", text: "   " },
    { source: "parent-message-bus", text: "BUS" },
    { source: "task-list", text: " TASKS\n" },
  ]);
  assert.deepEqual(built.entries, [
    { source: "subagent-roster", text: "ROSTER" },
    { source: "parent-message-bus", text: "BUS" },
    { source: "task-list", text: "TASKS" },
  ]);
  assert.equal(built.prompt, "ROSTER\n\nBUS\n\nTASKS");
});

test("runtime context omits empty or source-less entries", () => {
  assert.deepEqual(
    buildTrajectoryRuntimeContext([
      { source: "", text: "hidden" },
      { source: "x", text: undefined },
    ]),
    { entries: [] },
  );
});
