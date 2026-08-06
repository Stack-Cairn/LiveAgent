import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Battle 2: this suite now drives crates/core, the engine that actually ships.
// The frontend copy under src/lib was a duplicate and has been removed.
// crates/core modules that talk to the Rust backend read this at import time.
process.env.LIVEAGENT_BACKEND_PORT ??= "0";
const coreRootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)), "../core");
const coreSrc = (rel) => path.join(coreRootDir, "src", rel);
// core 走 HTTP callBackend，前端副本走 tauri invoke —— 迁移后 mock 换成前者。
const backendClientPath = coreSrc("backendClient.ts");

const invokeCalls = [];
const loader = createTsModuleLoader({
  mocks: {
    [backendClientPath]: {
      async callBackend(command, args) {
        invokeCalls.push({ command, args });
        if (command === "automation_claim_prompt_runs") return [];
        if (command === "automation_complete_prompt_run") {
          return { status: "completed" };
        }
        if (command === "automation_run_cron_now") {
          return { startedAt: 1234 };
        }
      },
    },
  },
});

const { backend } = loader.loadModule(coreSrc("automation/backend.ts"));
const {
  findManualCronRun,
  isManualCronRunFinished,
  MANUAL_CRON_RUN_POLL_INTERVAL_MS,
  MANUAL_CRON_RUN_TIMEOUT_MS,
} = loader.loadModule(coreSrc("automation/types.ts"));
const { createCompletePromptRunInput } = loader.loadModule(
  "src/components/cron/promptRunProtocol.ts",
);

test.beforeEach(() => {
  invokeCalls.length = 0;
});

test("Auto Prompt completion uses the Rust camelCase wire contract", async () => {
  const input = createCompletePromptRunInput("execution-1", true, 1200, "conclusion");

  assert.deepEqual(input, {
    executionId: "execution-1",
    success: true,
    durationMs: 1200,
    output: "conclusion",
  });

  await backend.completePromptRun(input);
  assert.deepEqual(invokeCalls, [
    {
      command: "automation_complete_prompt_run",
      args: { input },
    },
  ]);
});

test("Auto Prompt transport keeps command arguments snake_case", async () => {
  await backend.claimPromptRuns();
  await backend.releasePromptRun("execution-1");

  assert.deepEqual(invokeCalls, [
    { command: "automation_claim_prompt_runs", args: undefined },
    {
      command: "automation_release_prompt_run",
      args: { execution_id: "execution-1" },
    },
  ]);
});

test("Cron manual run uses the task-scoped run-now command", async () => {
  const response = await backend.runNow("task-1");

  assert.deepEqual(response, { startedAt: 1234 });
  assert.deepEqual(invokeCalls, [
    {
      command: "automation_run_cron_now",
      args: { task_id: "task-1" },
    },
  ]);
});

test("Cron manual run remains locked until its non-skip run reaches a terminal state", () => {
  const run = (id, state, startedAt, output = "") => ({
    id,
    taskId: "task-1",
    state,
    success: state === "done",
    startedAt,
    durationMs: 0,
    output,
  });
  const marker = 1_000;
  const skip = run(
    "skip",
    "done",
    marker + 1,
    "Skipped: previous run is still in progress.",
  );

  assert.equal(MANUAL_CRON_RUN_POLL_INTERVAL_MS, 1_000);
  assert.equal(MANUAL_CRON_RUN_TIMEOUT_MS, 6 * 60_000);
  assert.equal(findManualCronRun([skip], marker), undefined);
  assert.equal(isManualCronRunFinished([skip, run("pending", "pending", marker + 2)], marker), false);
  assert.equal(isManualCronRunFinished([skip, run("leased", "leased", marker + 2)], marker), false);
  assert.equal(isManualCronRunFinished([skip, run("done", "done", marker + 2)], marker), true);
  assert.equal(isManualCronRunFinished([skip, run("expired", "expired", marker + 2)], marker), true);
});
