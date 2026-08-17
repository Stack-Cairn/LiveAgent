import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// taskList 的权威 JSON 拼在 systemPrompt 里，而 systemPrompt 排在全部消息之前，
// 缓存前缀按字节匹配 —— run 内每轮重读 meta.taskList，等于一次 TaskUpdate 就把
// system 块连同其后的全部历史一起打穿。快照因此按“压缩纪元”冻结。这组用例盯住：
//   ① run 内任务状态推进不改变 systemPrompt 字节（且快照并未被丢掉）
//   ② runId 不匹配时依然不注入（沿用工具层口径，语义不得改变）
//   ③ 压缩之后快照刷新为当前状态（那一刻前缀本来就要重建，重新冻结是免费的）

const agentRunnerPath = fileURLToPath(
  new URL("../../src/lib/chat/runner/agentRunner.ts", import.meta.url),
);
const builtinRegistryPath = fileURLToPath(
  new URL("../../src/lib/tools/builtinRegistry.ts", import.meta.url),
);
const runtimePlatformPath = fileURLToPath(
  new URL("../../src/lib/runtimePlatform.ts", import.meta.url),
);
const memoryExtractionPath = fileURLToPath(
  new URL("../../src/lib/chat/memory/extractionController.ts", import.meta.url),
);
const fileToolStatePath = fileURLToPath(
  new URL("../../src/lib/tools/fileToolState.ts", import.meta.url),
);

// formatTaskListRuntimeContext 保持真实实现:冻结的是它的输出字节,mock 掉就测不到东西了。
let runAssistantWithToolsScenario = async () => {
  throw new Error("scenario was not installed");
};
const registryBuildCalls = [];

const loader = createTsModuleLoader({
  mocks: {
    [agentRunnerPath]: {
      async runAssistantWithTools(params) {
        return runAssistantWithToolsScenario(params);
      },
    },
    [builtinRegistryPath]: {
      async buildBuiltinToolRegistry(params) {
        registryBuildCalls.push(params);
        return {
          tools: [],
          async executeToolCall() {
            throw new Error("tool execution was not expected");
          },
        };
      },
    },
    [runtimePlatformPath]: {
      async resolveRuntimePlatform() {
        return "win32";
      },
    },
    [memoryExtractionPath]: {
      memoryExtraction: {
        noteTurnBoundary() {},
        async requestExtraction() {
          return {
            ok: true,
            acceptedCount: 0,
            rejectedCount: 0,
            writtenSlugs: [],
            emittedMessages: [],
          };
        },
      },
    },
    [fileToolStatePath]: {
      createFileToolState() {
        return {};
      },
    },
  },
});

const { runAgentConversationTurn } = loader.loadModule(
  "src/pages/chat/turns/runAgentConversationTurn.ts",
);
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const { formatTaskListRuntimeContext } = loader.loadModule("src/lib/tools/taskTools.ts");

const RUN_ID = "run-1";
const BASE_SYSTEM_PROMPT = "base system prompt";

function noOp() {}

function task(id, subject, status) {
  return {
    id,
    subject,
    description: `${subject} completion criteria`,
    activeForm: `${subject} in progress`,
    status,
  };
}

function taskListState(runId, tasks) {
  return { runId, revision: tasks.length, nextTaskId: tasks.length + 1, tasks };
}

const PENDING_TASKS = taskListState(RUN_ID, [task("1", "Wire the freeze", "pending")]);
const ADVANCED_TASKS = taskListState(RUN_ID, [
  task("1", "Wire the freeze", "completed"),
  task("2", "Cover it with tests", "in_progress"),
]);

function assistantMessage(content, stopReason) {
  return {
    role: "assistant",
    provider: "codex",
    api: "openai-responses",
    model: "gpt-5",
    content,
    stopReason,
    timestamp: 2,
  };
}

const taskUpdateAssistant = assistantMessage(
  [{ type: "toolCall", id: "call-task-update", name: "TaskUpdate", arguments: { taskId: "1" } }],
  "toolUse",
);
const taskUpdateResult = {
  role: "toolResult",
  toolCallId: "call-task-update",
  toolName: "TaskUpdate",
  content: [{ type: "text", text: "task updated" }],
  details: {},
  isError: false,
  timestamp: 3,
};
const finalAssistant = assistantMessage([{ type: "text", text: "done" }], "stop");

function createHookLifecycle() {
  return {
    startAgent: noOp,
    endAgent: noOp,
    startTurn: noOp,
    endTurn: noOp,
    ensureMessageEnded: noOp,
    assistantMessageCompleted: noOp,
    toolExecutionStarted: noOp,
    toolResultReceived: noOp,
  };
}

/**
 * 采集每一次真正喂给模型/压缩决策的 systemPrompt。三个采集点覆盖了
 * withAgentRuntimeContext 的全部产物：发送前预算、每轮请求、run 内压缩预算。
 */
function createHarness({ initialTaskList, compactDuringRun } = {}) {
  let current = conversationState.createConversationStateFromContext({
    systemPrompt: BASE_SYSTEM_PROMPT,
    messages: [],
  });
  if (initialTaskList) {
    current = conversationState.setTaskListState(current, initialTaskList);
  }

  const systemPrompts = [];
  const record = (label, context) => {
    if (context) systemPrompts.push({ label, systemPrompt: context.systemPrompt });
    return context;
  };

  return {
    systemPrompts,
    // onBeforeNextTurn 交回的续跑上下文，压缩发生时才非空。
    overrides: [],
    // 模拟 TaskUpdate 落库：taskStateStore.commitState 最终走 applyConversationState。
    commitTaskList(taskList) {
      current = conversationState.setTaskListState(current, taskList);
    },
    params: {
      providerId: "codex",
      model: "gpt-5",
      runtime: {},
      runtimeModel: { provider: "codex", api: "openai-responses", id: "gpt-5" },
      selectedModel: { customProviderId: "codex", model: "gpt-5" },
      effectiveWorkdir: "C:/workspace",
      effectiveSkillsEnabled: false,
      showSilentMemoryExtraction: false,
      agentTemplates: [],
      getMcpSettings: () => ({ servers: [], selected: [] }),
      sessionId: "session-1",
      taskStateStore: {
        runId: RUN_ID,
        getState: () => current.meta.taskList,
        async commitState() {},
      },
      conversationId: "conversation-task-freeze",
      fallbackTitle: "title",
      createdAt: 1,
      titlePromise: null,
      transcriptStore: {},
      gatewayBridgeEvents: {
        hasForwardedText: () => false,
        queueToken: noOp,
        queueEvent: noOp,
        queueToolStatus: noOp,
      },
      hookLifecycle: createHookLifecycle(),
      conversationDebugLogger: { enabled: false, logResult: noOp },
      getNextConversationState: () => current,
      applyConversationState(nextState) {
        current = nextState;
      },
      buildPreparedContext: (state) => ({
        systemPrompt: BASE_SYSTEM_PROMPT,
        messages: state.segments.flatMap((segment) => segment.messages),
      }),
      compaction: {
        async maybeCompactPreSend({ budgetContext }) {
          record("pre-send", budgetContext);
        },
        beginRequest(context) {
          record("request", context);
        },
        observeContextMessages: () => 0,
        shouldProtectMidStream: () => false,
        async compactDuringRun({ budgetContext }) {
          record("during-run", budgetContext);
          return compactDuringRun
            ? compactDuringRun()
            : { context: null, shouldDisableProtection: false };
        },
      },
      cancellation: {
        userStop: new AbortController(),
        deriveScope() {
          return { controller: new AbortController(), release: noOp };
        },
      },
      resetLiveTranscript: noOp,
      settleLiveTranscript: noOp,
      batchLiveRoundsUpdate: noOp,
      updateToolStatus: noOp,
      updateRetryAttempts: noOp,
      updatePersistableAgentProgress: noOp,
      commitVisibleAbortedConversation: () => false,
      freezeGatewayFinalProjection: noOp,
      async persistConversationWithHistorySync() {
        return true;
      },
    },
  };
}

/** 三轮工具循环：每轮结束前推进一次任务状态，模拟模型持续调用 TaskUpdate。 */
function threeToolRounds(harness, nextTaskListByRound) {
  return async (params) => {
    for (const round of [1, 2]) {
      params.onTurnStart?.(round);
      params.onToolCall?.(taskUpdateAssistant.content[0], round);
      params.onToolResult?.(taskUpdateAssistant.content[0], taskUpdateResult, round);
      params.onAssistantMessage?.(taskUpdateAssistant, round);
      const nextTaskList = nextTaskListByRound[round];
      if (nextTaskList) harness.commitTaskList(nextTaskList);
      harness.overrides.push(
        await params.onBeforeNextTurn?.({
          round,
          assistant: taskUpdateAssistant,
          toolResults: [taskUpdateResult],
          emittedMessages: [taskUpdateAssistant, taskUpdateResult],
          runtimeContext: params.context,
          signal: params.signal,
        }),
      );
    }
    params.onTurnStart?.(3);
    params.onAssistantMessage?.(finalAssistant, 3);
    return {
      assistant: finalAssistant,
      messages: [finalAssistant],
      emittedMessages: [finalAssistant],
    };
  };
}

function runWithScenario(scenario, params) {
  runAssistantWithToolsScenario = scenario;
  return runAgentConversationTurn(params).finally(() => {
    runAssistantWithToolsScenario = async () => {
      throw new Error("scenario was not installed");
    };
  });
}

// ---------------------------------------------------------------------------
// ① run 内的任务状态推进不得改变 systemPrompt 字节

test("run 内连续多轮 TaskUpdate 不改变 systemPrompt 字节", async () => {
  const harness = createHarness({ initialTaskList: PENDING_TASKS });
  await runWithScenario(
    threeToolRounds(harness, { 1: ADVANCED_TASKS, 2: taskListState(RUN_ID, []) }),
    harness.params,
  );

  const captured = harness.systemPrompts;
  assert.ok(captured.length >= 3, `期望至少 3 次采集，实际 ${captured.length}`);
  const unique = new Set(captured.map((entry) => entry.systemPrompt));
  assert.equal(
    unique.size,
    1,
    `systemPrompt 在 run 内发生了漂移：${JSON.stringify(captured, null, 2)}`,
  );

  // 冻结的是 run 起始那份快照，且必须原样保留在 system 段里 —— 不是被静默丢掉。
  const frozen = [...unique][0];
  assert.equal(
    frozen,
    `${BASE_SYSTEM_PROMPT}\n\n${formatTaskListRuntimeContext(PENDING_TASKS)}`,
  );
  assert.match(frozen, /<task_list>/);
  assert.ok(!frozen.includes("Cover it with tests"), "run 内新建的任务不应挤进 system 段");
});

// ---------------------------------------------------------------------------
// ② runId 判据必须原样保留：冻结只是把判据从“每轮执行”挪到“冻结时执行”

test("taskList 属于上一个 Run 时不注入", async () => {
  const harness = createHarness({
    initialTaskList: taskListState("run-stale", [task("1", "Stale task", "pending")]),
  });
  await runWithScenario(threeToolRounds(harness, {}), harness.params);

  assert.ok(harness.systemPrompts.length >= 3);
  for (const entry of harness.systemPrompts) {
    assert.equal(entry.systemPrompt, BASE_SYSTEM_PROMPT, `${entry.label} 注入了非本 Run 的任务状态`);
  }
});

test("没有任务状态时 systemPrompt 不带任务段", async () => {
  const harness = createHarness();
  await runWithScenario(threeToolRounds(harness, {}), harness.params);

  assert.ok(harness.systemPrompts.length >= 3);
  for (const entry of harness.systemPrompts) {
    assert.equal(entry.systemPrompt, BASE_SYSTEM_PROMPT);
  }
});

// ---------------------------------------------------------------------------
// ③ 压缩边界重新冻结：历史被截断后，这份快照是模型唯一的权威任务状态来源

test("run 内压缩之后快照刷新为当前任务状态", async () => {
  let compactionsLeft = 1;
  const harness = createHarness({
    initialTaskList: PENDING_TASKS,
    compactDuringRun: () =>
      compactionsLeft-- > 0
        ? {
            context: { systemPrompt: BASE_SYSTEM_PROMPT, messages: [] },
            shouldDisableProtection: false,
          }
        : { context: null, shouldDisableProtection: false },
  });

  await runWithScenario(threeToolRounds(harness, { 1: ADVANCED_TASKS }), harness.params);

  // 第 1 轮触发压缩，续跑上下文必须带上刷新后的快照。
  const continuation = harness.overrides[0];
  assert.ok(continuation?.context, "压缩返回上下文时必须交回续跑上下文");
  assert.equal(
    continuation.context.systemPrompt,
    `${BASE_SYSTEM_PROMPT}\n\n${formatTaskListRuntimeContext(ADVANCED_TASKS)}`,
  );
  assert.match(continuation.context.systemPrompt, /Cover it with tests/);

  // 压缩之前采集到的仍是旧快照：重新冻结只发生在压缩边界，不是每轮。
  const beforeCompaction = harness.systemPrompts.filter((entry) => entry.label !== "during-run");
  assert.equal(
    beforeCompaction[0].systemPrompt,
    `${BASE_SYSTEM_PROMPT}\n\n${formatTaskListRuntimeContext(PENDING_TASKS)}`,
  );
});

test("主 Agent turn 将每种命令安全模式传给工具 registry", async () => {
  const cases = [
    ["sandbox", { enabled: true, allowNetwork: true }],
    ["sandboxOffline", { enabled: true, allowNetwork: false }],
    ["ask", undefined],
    ["auto", undefined],
    [undefined, undefined],
  ];

  registryBuildCalls.length = 0;
  for (const [commandSafetyMode, expectedSandbox] of cases) {
    const harness = createHarness();
    harness.params.commandSafetyMode = commandSafetyMode;
    await runWithScenario(
      async (params) => {
        params.onTurnStart?.(1);
        params.onAssistantMessage?.(finalAssistant, 1);
        return {
          assistant: finalAssistant,
          messages: [finalAssistant],
          emittedMessages: [finalAssistant],
        };
      },
      harness.params,
    );
    const call = registryBuildCalls.at(-1);
    assert.ok(call, `registry was not built for mode ${commandSafetyMode ?? "undefined"}`);
    assert.deepEqual(call.sandbox, expectedSandbox, `sandbox mapping for ${commandSafetyMode}`);
  }
});
