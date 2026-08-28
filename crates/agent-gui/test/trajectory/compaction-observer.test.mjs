import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { CompactionController } = loader.loadModule(
  "@liveagent/app/lib/chat/compaction/controller.ts",
);

test("a cancelled running compaction closes its trajectory observer as aborted exactly once", async () => {
  const controller = new CompactionController();
  const observed = [];
  const statuses = [];
  controller.bindTurn({
    sinks: {
      publishStatus: (status) => statuses.push(status),
    },
  });
  controller.setObserver({
    onStart: (info) => observed.push({ phase: "start", ...info }),
    onEnd: (info) => observed.push({ phase: "end", ...info }),
  });

  // TypeScript `private` is intentionally exercised through the compiled JS here: this is the
  // single transition point every real pre-send/mid-stream/post-tool/manual path uses.
  controller.publishRunning("manual", 0, {
    intent: "optimization",
    reason: "threshold",
    shouldCompact: true,
    totalTokens: 900,
    threshold: 800,
    contextWindow: 1_000,
    maxOutputToken: 100,
  });

  assert.equal(await controller.handleTurnAbort(), false);
  assert.deepEqual(
    observed.map((entry) => [entry.phase, entry.status, entry.trigger, entry.tokensBefore]),
    [
      ["start", undefined, "manual", 900],
      ["end", "aborted", "manual", 900],
    ],
  );
  assert.equal(statuses.at(-1)?.phase, "idle");

  await controller.handleTurnAbort();
  assert.equal(observed.filter((entry) => entry.phase === "end").length, 1);
});
