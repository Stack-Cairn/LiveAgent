import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { CompactionController } = loader.loadModule('src/lib/chat/compaction/controller.ts');

test("aborting a running compaction closes the trajectory observer interval", async () => {
  const controller = new CompactionController();
  const ended = [];
  const statuses = [];
  controller.setObserver({
    onStart() {},
    onEnd(info) { ended.push(info); },
  });
  controller.bindTurn({
    sinks: { publishStatus: (status) => statuses.push(status) },
  });

  // These are deliberately set as the state immediately after publishRunning; private is a
  // TypeScript visibility boundary, not a runtime one, and avoids invoking the decision engine.
  controller.observedTrigger = "mid-stream";
  controller.observedTokensBefore = 72_000;
  controller.statusPhase = "running";

  assert.equal(await controller.handleTurnAbort(), false);
  assert.deepEqual(ended, [
    { trigger: "mid-stream", status: "aborted", tokensBefore: 72_000 },
  ]);
  assert.equal(statuses.at(-1)?.phase, "idle");
  assert.equal(controller.observedTrigger, undefined);
  assert.equal(controller.observedTokensBefore, undefined);
});
