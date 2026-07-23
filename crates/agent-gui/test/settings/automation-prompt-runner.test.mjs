import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const invokeCalls = [];
const loader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": {
      async invoke(command, args) {
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
    "@tauri-apps/api/event": {
      async listen() {
        return () => {};
      },
    },
  },
});

const { backend } = loader.loadModule("src/lib/automation/backend.ts");
const {
  findManualCronRun,
  isManualCronRunFinished,
  MANUAL_CRON_RUN_POLL_INTERVAL_MS,
  MANUAL_CRON_RUN_TIMEOUT_MS,
} = loader.loadModule("src/lib/automation/types.ts");
const { createCompletePromptRunInput, PROMPT_RUN_RECONCILE_INTERVAL_MS } = loader.loadModule(
  "src/components/cron/promptRunProtocol.ts",
);
const runnerSource = readFileSync(
  new URL("../../src/components/cron/CronPromptRunner.tsx", import.meta.url),
  "utf8",
);
const guiCronViewSource = readFileSync(
  new URL("../../src/pages/settings/CronTaskViewModal.tsx", import.meta.url),
  "utf8",
);
const webCronViewSource = readFileSync(
  new URL(
    "../../../agent-gateway/web/src/pages/settings/CronTaskViewModal.tsx",
    import.meta.url,
  ),
  "utf8",
);
const webAutomationBackendSource = readFileSync(
  new URL("../../../agent-gateway/web/src/lib/automation/backend.ts", import.meta.url),
  "utf8",
);
const guiCronModalSource = readFileSync(
  new URL("../../src/pages/settings/CronTaskModal.tsx", import.meta.url),
  "utf8",
);
const webCronModalSource = readFileSync(
  new URL(
    "../../../agent-gateway/web/src/pages/settings/CronTaskModal.tsx",
    import.meta.url,
  ),
  "utf8",
);
const cronToolsSource = readFileSync(
  new URL("../../src/lib/tools/cronTools.ts", import.meta.url),
  "utf8",
);
const builtinRegistrySource = readFileSync(
  new URL("../../src/lib/tools/builtinRegistry.ts", import.meta.url),
  "utf8",
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

test("Cron manual run stays wired across GUI and WebUI", () => {
  for (const source of [guiCronViewSource, webCronViewSource]) {
    assert.match(source, /const response = await runCronNow\(selectedTaskId\)/);
    assert.match(source, /disabled=\{isRunningNow\}/);
    assert.match(source, /if \(runNowLockRef\.current\) return/);
    assert.match(source, /setManualRunStartedAt\(response\.startedAt\)/);
    assert.match(source, /listCronRuns\(taskId, 500\)/);
    assert.match(source, /settings\.cronViewRunNow/);
    assert.match(source, /<Play className="h-3\.5 w-3\.5" \/>/);
  }
  assert.match(
    webAutomationBackendSource,
    /return cronManage<CronRunNowResponse>\("run_now", taskId\)/,
  );
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

test("Auto Prompt reconciles pending runs without relying only on events", () => {
  assert.equal(PROMPT_RUN_RECONCILE_INTERVAL_MS, 15_000);
  assert.match(
    runnerSource,
    /window\.setInterval\(requestClaim, PROMPT_RUN_RECONCILE_INTERVAL_MS\)/,
  );
  assert.match(runnerSource, /window\.clearInterval\(reconcileTimer\)/);
});

test("Auto Prompt run prefers the queue-time workdir with a global fallback", () => {
  assert.match(
    runnerSource,
    /const workdir = \(request\.workdir \?\? ""\)\.trim\(\) \|\| settings\.system\.workdir\.trim\(\)/,
  );
});

test("Cron workspace pin stays wired across GUI and WebUI", () => {
  for (const source of [guiCronModalSource, webCronModalSource]) {
    // Radix SelectItem rejects empty-string values, so "follow active" must
    // go through the sentinel and map back to "" on save; the custom-path
    // mode keeps arbitrary (tool-pinned) paths visible and editable.
    assert.match(
      source,
      /const FOLLOW_ACTIVE_WORKSPACE_VALUE = "__follow-active-workspace__"/,
    );
    assert.match(source, /const CUSTOM_WORKDIR_VALUE = "__custom-workdir__"/);
    assert.match(
      source,
      /customWorkdir \? CUSTOM_WORKDIR_VALUE : workdir \|\| FOLLOW_ACTIVE_WORKSPACE_VALUE/,
    );
    // The save payload must always carry the workdir key: an empty string is
    // the explicit clear signal — dropping the key would keep a stale pin.
    assert.match(source, /workdir: type === "http" \? "" : workdir\.trim\(\)/);
    assert.match(source, /workspaceOptions: CronWorkspaceOption\[\]/);
    // Windows pins may spell the same directory differently than the
    // workspace list ("\" vs "/", drive-letter case): matching must be
    // shape-insensitive and snap to the list entry's spelling.
    assert.match(source, /function comparableWorkdirPath\(path: string\)/);
    assert.match(source, /const isWindowsShape = \/\^\[A-Za-z\]:\/\.test\(normalized\)/);
    assert.match(
      source,
      /findWorkspaceOptionByPath\(workspaceOptions, initialWorkdir\)\?\.path \?\? initialWorkdir/,
    );
    assert.match(
      source,
      /Boolean\(initialWorkdir && !findWorkspaceOptionByPath\(workspaceOptions, initialWorkdir\)\)/,
    );
    assert.match(source, /: findWorkspaceOptionByPath\(workspaceOptions, workdir\)/);
  }
  for (const source of [guiCronViewSource, webCronViewSource]) {
    assert.match(source, /\{task\.workdir \? \(/);
  }
});

test("CronTaskManager create pins the agent's current workspace by default", () => {
  // Create with the workdir key absent injects the runtime workspace (http
  // tasks excluded); an explicitly EMPTY workdir also resolves to the
  // runtime workspace — the model has no "follow active workspace" spelling.
  assert.match(cronToolsSource, /fields\.type !== "http" && !Object\.hasOwn\(args, "workdir"\)/);
  assert.match(cronToolsSource, /if \(Object\.hasOwn\(fields, "workdir"\)\)/);
  assert.match(cronToolsSource, /if \(!explicit && runtimeWorkdir\)/);
  assert.match(cronToolsSource, /fields\.workdir = runtimeWorkdir/);
  // Prompt creation force-sets the runtime model and a medium thinking
  // level in code — neither is a model-facing parameter.
  assert.match(cronToolsSource, /fields\.selectedModel = options\.currentChatModel/);
  assert.match(cronToolsSource, /fields\.reasoning = "medium"/);
  // The registry wires the runtime workdir into the tool bundle.
  assert.match(
    builtinRegistrySource,
    /createCronTools\(\{\s*currentChatModel: params\.currentChatModel,\s*workdir: params\.workdir,\s*\}\)/,
  );
});

test("Cron reasoning levels follow the selected model across GUI and WebUI", () => {
  for (const source of [guiCronModalSource, webCronModalSource]) {
    assert.match(source, /providers: CustomProvider\[\]/);
    assert.match(source, /const selectedModel = parseModelValue\(selectedModelValue\)/);
    assert.match(source, /getChatRuntimeReasoningLevelsForProvider\(\{/);
    assert.match(source, /isThinkingAlwaysOnForModel\(/);
    assert.match(source, /return thinkingAlwaysOn \? supportedLevels : \["off", \.\.\.supportedLevels\]/);
    assert.match(source, /\{cronReasoningLevels\.map\(\(level\) => \(/);
    assert.match(source, /coerceCronReasoningLevel\(nextReasoningLevels, current\)/);
    assert.match(
      source,
      /if \(levels\.includes\(DEFAULT_CRON_REASONING\)\) return DEFAULT_CRON_REASONING;\s*return levels\[0\] \?\? DEFAULT_CRON_REASONING;/,
    );
  }
});
