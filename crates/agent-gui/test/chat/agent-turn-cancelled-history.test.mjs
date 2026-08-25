import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const parentId = "call-parent|fc_parent";
const cardId = `${parentId}:agent:1`;

const parentToolCall = {
  type: "toolCall",
  id: parentId,
  name: "Agent",
  arguments: { agents: [{ id: "reviewer", prompt: "review" }] },
};
const cardToolCall = {
  type: "toolCall",
  id: cardId,
  name: "Agent",
  arguments: {
    subagent_card: true,
    parent_tool_call_id: parentId,
    id: "reviewer",
  },
};
const parentToolResult = {
  role: "toolResult",
  toolCallId: parentId,
  toolName: "Agent",
  content: [{ type: "text", text: "batch done" }],
  details: { kind: "subagent_batch" },
  isError: false,
  timestamp: 3,
};
const cardToolResult = {
  role: "toolResult",
  toolCallId: cardId,
  toolName: "Agent",
  content: [{ type: "text", text: "reviewer done" }],
  details: { kind: "subagent_card" },
  isError: false,
  timestamp: 3,
};
const toolUseAssistant = {
  role: "assistant",
  provider: "codex",
  api: "openai-responses",
  model: "gpt-5",
  content: [parentToolCall, cardToolCall],
  stopReason: "toolUse",
  timestamp: 2,
};
const abortedAssistant = {
  role: "assistant",
  provider: "codex",
  api: "openai-responses",
  model: "gpt-5",
  content: [{ type: "text", text: "partial final" }],
  stopReason: "aborted",
  timestamp: 4,
};

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
const taskToolsPath = fileURLToPath(
  new URL("../../src/lib/tools/taskTools.ts", import.meta.url),
);

async function replayCancelledHistoryScenario(params) {
  params.onTurnStart?.(1);
  params.onToolCall?.(parentToolCall, 1);
  params.onToolCall?.(cardToolCall, 1);
  params.onToolResult?.(parentToolCall, parentToolResult, 1);
  params.onToolResult?.(cardToolCall, cardToolResult, 1);
  params.onAssistantMessage?.(toolUseAssistant, 1);
  await params.onBeforeNextTurn?.({
    round: 1,
    assistant: toolUseAssistant,
    toolResults: [parentToolResult, cardToolResult],
    emittedMessages: [toolUseAssistant, parentToolResult, cardToolResult],
    runtimeContext: params.context,
    signal: params.signal,
  });

  params.onTurnStart?.(2);
  params.onTextDelta?.("partial final", 2);
  params.onAssistantMessage?.(abortedAssistant, 2);
  return {
    assistant: abortedAssistant,
    messages: [toolUseAssistant, parentToolResult, cardToolResult, abortedAssistant],
    emittedMessages: [toolUseAssistant, parentToolResult, cardToolResult, abortedAssistant],
  };
}

let runAssistantWithToolsScenario = replayCancelledHistoryScenario;
let taskListRuntimeContextScenario = "";
let memoryExtractionRequestScenario = async () => ({
  ok: true,
  acceptedCount: 0,
  rejectedCount: 0,
  writtenSlugs: [],
  emittedMessages: [],
});

const loader = createTsModuleLoader({
  mocks: {
    [agentRunnerPath]: {
      // Replays the real runner's hook payload shape by hand; that contract
      // (1-based rounds, results paired by toolCallId) is pinned against the
      // real runner in agent-runner.test.mjs.
      async runAssistantWithTools(params) {
        return runAssistantWithToolsScenario(params);
      },
    },
    [builtinRegistryPath]: {
      async buildBuiltinToolRegistry() {
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
      // buildToolsSuffix（turn runner 起始的用量环 fixed 校准）会走到这三个
      // 纯函数；整模块替换的桩必须补齐，否则 turn 一进门就抛错。
      normalizeRuntimePlatform(value) {
        return value === "windows" || value === "macos" || value === "linux" ? value : undefined;
      },
      inferRuntimePlatform() {
        return "linux";
      },
      runtimePlatformLabel(platform) {
        if (platform === "windows") return "Windows";
        if (platform === "macos") return "macOS";
        return "Linux";
      },
    },
    [memoryExtractionPath]: {
      memoryExtraction: {
        noteTurnBoundary() {},
        requestExtraction(params) {
          return memoryExtractionRequestScenario(params);
        },
      },
    },
    [fileToolStatePath]: {
      createFileToolState() {
        return {};
      },
    },
    [taskToolsPath]: {
      formatTaskListRuntimeContext() {
        return taskListRuntimeContextScenario;
      },
    },
  },
});

const { runAgentConversationTurn } = loader.loadModule(
  "src/pages/chat/turns/runAgentConversationTurn.ts",
);
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const { composeTrajectorySystemPrompt } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/sections.ts",
);

function noOp() {}

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

function createCompletedAgentDevTurnParams({
  state,
  applyConversationState = noOp,
  persistConversationWithHistorySync,
  gatewayTokens = [],
  extra = {},
}) {
  const userStop = new AbortController();
  return {
    providerId: "codex",
    model: "gpt-5",
    runtime: {},
    runtimeModel: {
      provider: "codex",
      api: "openai-responses",
      id: "gpt-5",
    },
    selectedModel: { customProviderId: "codex", model: "gpt-5" },
    effectiveWorkdir: "C:/workspace",
    effectiveSkillsEnabled: false,
    showSilentMemoryExtraction: true,
    agentTemplates: [],
    getMcpSettings: () => ({ servers: [], selected: [] }),
    sessionId: "session-1",
    taskStateStore: {
      runId: "run-1",
      getState: () => undefined,
      async commitState() {},
    },
    conversationId: "conversation-agent-dev",
    fallbackTitle: "title",
    createdAt: 1,
    titlePromise: null,
    transcriptStore: {},
    gatewayBridgeEvents: {
      hasForwardedText: () => false,
      queueToken(text, meta) {
        gatewayTokens.push({ text, meta });
      },
      queueEvent: noOp,
      queueToolStatus: noOp,
    },
    hookLifecycle: createHookLifecycle(),
    conversationDebugLogger: { enabled: false, logResult: noOp },
    getNextConversationState: () => state,
    applyConversationState,
    buildPreparedContext: (currentState) => ({
      systemPrompt: "",
      messages: currentState.segments.flatMap((segment) => segment.messages),
    }),
    compaction: {
      noteFixedOverheadTokens: noOp,
      async maybeCompactPreSend() {},
      beginRequest: noOp,
      observeContextMessages: () => 0,
      shouldProtectMidStream: () => false,
      async compactDuringRun() {
        return { context: null, shouldDisableProtection: false };
      },
    },
    cancellation: {
      userStop,
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
    persistConversationWithHistorySync,
    ...extra,
  };
}

function trajectoryRecorderSpy(calls) {
  return {
    beginTurn: (info) => calls.push(["beginTurn", info]),
    noteContext: (info) => calls.push(["noteContext", info]),
    captureHeader: (input) => {
      calls.push(["captureHeader", input]);
      return "header-1";
    },
    stepStart: (step, headerId) => calls.push(["stepStart", { step, headerId }]),
    firstToken: (step) => calls.push(["firstToken", step]),
    stepEnd: (step, info) => calls.push(["stepEnd", { step, info }]),
    noteRetry: noOp,
    toolStart: noOp,
    toolEnd: noOp,
    compactionStart: noOp,
    compactionEnd: noOp,
    endTurn: noOp,
    flush: async () => {},
    dispose: async () => {},
    discard: noOp,
  };
}

test("trajectory captures the exact runtime prompt, tool-first TTFT, and failover metadata", async () => {
  const calls = [];
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "BASE",
    messages: [],
  });
  state.meta.taskList = { runId: "run-1", items: [] };
  taskListRuntimeContextScenario = " TASKS ";
  const actualAssistant = {
    role: "assistant",
    provider: "deepseek",
    api: "openai-completions",
    model: "deepseek-reasoner",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
    timestamp: 2,
  };
  const toolCall = {
    type: "toolCall",
    id: "call-tool-first",
    name: "Read",
    arguments: { path: "README.md" },
  };
  runAssistantWithToolsScenario = async (params) => {
    const toolsSuffix = "TOOL RULES";
    params.onRequestStart?.({
      round: 1,
      context: {
        ...params.context,
        systemPrompt: `${params.context.systemPrompt}\n\n${toolsSuffix}`,
        tools: [],
      },
      toolsSuffix,
    });
    params.onTurnStart?.(1);
    params.onToolCall?.(toolCall, 1);
    params.onAssistantMessage?.(actualAssistant, 1);
    return {
      assistant: actualAssistant,
      messages: [actualAssistant],
      emittedMessages: [actualAssistant],
    };
  };

  try {
    await runAgentConversationTurn(
      createCompletedAgentDevTurnParams({
        state,
        persistConversationWithHistorySync: async () => true,
        extra: {
          trajectory: trajectoryRecorderSpy(calls),
          trajectoryTurn: 7,
          trajectoryMessageId: "user-7",
          readTrajectorySlots: () => ({ base: "BASE", agent: "AGENT" }),
          buildPreparedContext: () => ({
            systemPrompt: "BASE\n\nAGENT",
            messages: [],
          }),
        },
      }),
    );
  } finally {
    runAssistantWithToolsScenario = replayCancelledHistoryScenario;
    taskListRuntimeContextScenario = "";
  }

  const contextCall = calls.find(([kind]) => kind === "noteContext");
  assert.deepEqual(contextCall, ["noteContext", { source: "task-list", text: "TASKS" }]);
  const header = calls.find(([kind]) => kind === "captureHeader")[1];
  assert.equal(header.runtime, "TASKS");
  assert.equal(
    composeTrajectorySystemPrompt(header),
    "BASE\n\nAGENT\n\nTASKS\n\nTOOL RULES",
  );
  const firstTokenAt = calls.findIndex(([kind]) => kind === "firstToken");
  const stepEndAt = calls.findIndex(([kind]) => kind === "stepEnd");
  assert.ok(firstTokenAt >= 0 && firstTokenAt < stepEndAt);
  const stepEnd = calls[stepEndAt][1].info;
  assert.equal(stepEnd.provider, "deepseek");
  assert.equal(stepEnd.model, "deepseek-reasoner");
  assert.equal(stepEnd.api, "openai-completions");
});

test("agent dev skips memory extraction when final history persistence fails", async () => {
  const finalAssistant = {
    ...abortedAssistant,
    content: [{ type: "text", text: "durable answer" }],
    stopReason: "stop",
  };
  runAssistantWithToolsScenario = async (params) => {
    params.onTurnStart?.(1);
    params.onAssistantMessage?.(finalAssistant, 1);
    return {
      assistant: finalAssistant,
      messages: [finalAssistant],
      emittedMessages: [finalAssistant],
    };
  };

  try {
    for (const failure of ["false", "throw"]) {
      const state = conversationState.createConversationStateFromContext({
        systemPrompt: "",
        messages: [],
      });
      const order = [];
      memoryExtractionRequestScenario = async () => {
        order.push("memory-extraction");
        return {
          ok: true,
          acceptedCount: 0,
          rejectedCount: 0,
          writtenSlugs: [],
          emittedMessages: [],
        };
      };
      const run = runAgentConversationTurn(
        createCompletedAgentDevTurnParams({
          state,
          async persistConversationWithHistorySync() {
            order.push("history-failed");
            if (failure === "throw") {
              throw new Error("history unavailable");
            }
            return false;
          },
        }),
      );

      if (failure === "throw") {
        await assert.rejects(run, /history unavailable/);
      } else {
        await run;
      }
      assert.deepEqual(order, ["history-failed"]);
    }
  } finally {
    runAssistantWithToolsScenario = replayCancelledHistoryScenario;
    memoryExtractionRequestScenario = async () => ({
      ok: true,
      acceptedCount: 0,
      rejectedCount: 0,
      writtenSlugs: [],
      emittedMessages: [],
    });
  }
});

test("agent dev persists the answer before memory extraction and its visible status", async () => {
  const finalAssistant = {
    ...abortedAssistant,
    content: [{ type: "text", text: "durable answer" }],
    stopReason: "stop",
  };
  const extractionAssistant = {
    ...finalAssistant,
    provider: "liveagent",
    api: "liveagent-memory",
    model: "gpt-5",
    content: [{ type: "text", text: "Memory updated" }],
    timestamp: 5,
  };
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "",
    messages: [],
  });
  const order = [];
  const persistedStates = [];
  const appliedStates = [];
  runAssistantWithToolsScenario = async (params) => {
    params.onTurnStart?.(1);
    params.onAssistantMessage?.(finalAssistant, 1);
    return {
      assistant: finalAssistant,
      messages: [finalAssistant],
      emittedMessages: [finalAssistant],
    };
  };
  memoryExtractionRequestScenario = async (params) => {
    order.push("memory-extraction");
    params.visibleEvents?.onTurnStart?.(2);
    params.visibleEvents?.onTextDelta?.("Memory updated", 2);
    params.visibleEvents?.onAssistantMessage?.(extractionAssistant, 2);
    return {
      ok: true,
      acceptedCount: 1,
      rejectedCount: 0,
      writtenSlugs: ["user-preference"],
      emittedMessages: [extractionAssistant],
    };
  };

  try {
    await runAgentConversationTurn(
      createCompletedAgentDevTurnParams({
        state,
        applyConversationState(nextState) {
          appliedStates.push(nextState);
        },
        async persistConversationWithHistorySync(params) {
          order.push(`history-${persistedStates.length + 1}`);
          persistedStates.push(params.state);
          return true;
        },
      }),
    );
  } finally {
    runAssistantWithToolsScenario = replayCancelledHistoryScenario;
    memoryExtractionRequestScenario = async () => ({
      ok: true,
      acceptedCount: 0,
      rejectedCount: 0,
      writtenSlugs: [],
      emittedMessages: [],
    });
  }

  assert.deepEqual(order, ["history-1", "memory-extraction", "history-2"]);
  assert.equal(persistedStates.length, 2);
  assert.notEqual(persistedStates[0], persistedStates[1]);
  assert.equal(
    persistedStates[0].transcript.items.at(-1).rounds.some(
      (round) => round.meta?.contextRelevant === false,
    ),
    false,
  );
  assert.equal(
    persistedStates[1].transcript.items.at(-1).rounds.some(
      (round) => round.meta?.contextRelevant === false,
    ),
    true,
  );
  assert.equal(appliedStates.at(-1), persistedStates[1]);
});

test("agent turn preserves suppressed parent Agent trace for cancellation persistence", async () => {
  let liveRounds = [];
  const progressUpdates = [];
  let committed = false;
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "",
    messages: [],
  });

  await runAgentConversationTurn({
    providerId: "codex",
    model: "gpt-5",
    runtime: {},
    runtimeModel: {
      provider: "codex",
      api: "openai-responses",
      id: "gpt-5",
    },
    selectedModel: { customProviderId: "codex", model: "gpt-5" },
    effectiveWorkdir: "C:/workspace",
    effectiveSkillsEnabled: false,
    showSilentMemoryExtraction: false,
    agentTemplates: [],
    getMcpSettings: () => ({ servers: [], selected: [] }),
    sessionId: "session-1",
    conversationId: "conversation-1",
    fallbackTitle: "title",
    createdAt: 1,
    titlePromise: null,
    transcriptStore: {},
    gatewayBridgeEvents: {
      queueToken: noOp,
      queueEvent: noOp,
      queueToolStatus: noOp,
    },
    hookLifecycle: createHookLifecycle(),
    conversationDebugLogger: { enabled: false, logResult: noOp },
    getNextConversationState: () => state,
    applyConversationState: noOp,
    buildPreparedContext: () => ({ systemPrompt: "", messages: [] }),
    compaction: {
      noteFixedOverheadTokens: noOp,
      async maybeCompactPreSend() {},
      beginRequest: noOp,
      observeContextMessages: () => 0,
      shouldProtectMidStream: () => false,
      async compactDuringRun() {
        return { context: null, shouldDisableProtection: false };
      },
    },
    cancellation: {
      deriveScope() {
        return { controller: new AbortController(), release: noOp };
      },
    },
    resetLiveTranscript: noOp,
    settleLiveTranscript: noOp,
    batchLiveRoundsUpdate(updater) {
      liveRounds = updater(liveRounds);
    },
    updateToolStatus: noOp,
    updatePersistableAgentProgress(progress) {
      progressUpdates.push(progress);
    },
    commitVisibleAbortedConversation() {
      committed = true;
      return true;
    },
    updateConversationRuntimeEntry: noOp,
    async persistConversationWithHistorySync() {
      return true;
    },
  });

  assert.equal(committed, true);
  assert.equal(progressUpdates.length, 1);
  assert.equal(progressUpdates[0].completedThroughRound, 1);
  assert.deepEqual(
    progressUpdates[0].suppressedToolTrace.map((item) => [
      item.round,
      item.toolCall.id,
      item.toolResult?.toolCallId,
    ]),
    [[1, parentId, parentId]],
  );

  const visibleToolCalls = liveRounds.flatMap((round) =>
    round.blocks
      .filter((block) => block.kind === "tool")
      .map((block) => block.item.toolCall.id),
  );
  assert.deepEqual(visibleToolCalls, [cardId]);
  assert.equal(visibleToolCalls.includes(parentId), false);
});

test("AskUserQuestion becomes visible only when execution starts while ordinary tools keep previews", async () => {
  const askToolCall = {
    type: "toolCall",
    id: "call-ask-lifecycle",
    name: "AskUserQuestion",
    arguments: {
      questions: [
        {
          id: "choice",
          prompt: "Choose one",
          options: [{ label: "First" }, { label: "Second", recommended: true }],
        },
      ],
    },
  };
  const readToolCall = {
    type: "toolCall",
    id: "call-read-lifecycle",
    name: "Read",
    arguments: { path: "README.md" },
  };
  const finalAssistant = {
    ...abortedAssistant,
    content: [{ type: "text", text: "done" }],
  };
  const gatewayEvents = [];
  let liveRounds = [];
  let protectionChecks = 0;
  let askDeadlineAt = null;
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "",
    messages: [],
  });
  const askTools = loader.loadModule("src/lib/tools/askUserQuestionTools.ts");
  const askShared = loader.loadModule("@liveagent/ui/lib/chat/askUserQuestion.ts");

  const visibleToolCalls = () =>
    liveRounds.flatMap((round) =>
      round.blocks
        .filter((block) => block.kind === "tool")
        .map((block) => block.item.toolCall),
    );
  const toolCallEvents = (name) =>
    gatewayEvents.filter((event) => event.type === "tool_call" && event.name === name);

  runAssistantWithToolsScenario = async (params) => {
    params.onTurnStart?.(1);

    params.onToolCall?.(askToolCall, 1);
    assert.equal(toolCallEvents("AskUserQuestion").length, 0);
    assert.equal(visibleToolCalls().some((call) => call.id === askToolCall.id), false);
    assert.deepEqual(liveRounds[0].runningToolCallIds, []);
    assert.equal(askTools.getAskUserQuestionDeadlineAt(askToolCall.id), null);

    // onToolCall 的内部回合语义仍须生效：后续长文本不能重新触发 mid-stream 保护。
    params.onTextDelta?.("x".repeat(200), 1);

    params.onToolExecutionStart?.(askToolCall, 1);
    const askEventsAfterStart = toolCallEvents("AskUserQuestion");
    assert.equal(askEventsAfterStart.length, 1);
    assert.equal(visibleToolCalls().filter((call) => call.id === askToolCall.id).length, 1);
    assert.deepEqual(liveRounds[0].runningToolCallIds, [askToolCall.id]);
    askDeadlineAt = askEventsAfterStart[0].arguments[askShared.ASK_USER_QUESTION_DEADLINE_ARG];
    assert.ok(askDeadlineAt > Date.now());
    assert.equal(askTools.getAskUserQuestionDeadlineAt(askToolCall.id), askDeadlineAt);

    params.onToolCall?.(readToolCall, 1);
    assert.equal(toolCallEvents("Read").length, 1);
    assert.equal(visibleToolCalls().filter((call) => call.id === readToolCall.id).length, 1);
    assert.deepEqual(liveRounds[0].runningToolCallIds, [askToolCall.id, readToolCall.id]);

    params.onToolExecutionStart?.(readToolCall, 1);
    assert.equal(toolCallEvents("Read").length, 2);
    assert.equal(visibleToolCalls().filter((call) => call.id === readToolCall.id).length, 1);

    params.onAssistantMessage?.(finalAssistant, 1);
    return {
      assistant: finalAssistant,
      messages: [finalAssistant],
      emittedMessages: [finalAssistant],
    };
  };

  try {
    await runAgentConversationTurn({
      providerId: "codex",
      model: "gpt-5",
      runtime: {},
      runtimeModel: {
        provider: "codex",
        api: "openai-responses",
        id: "gpt-5",
      },
      selectedModel: { customProviderId: "codex", model: "gpt-5" },
      effectiveWorkdir: "C:/workspace",
      effectiveSkillsEnabled: false,
      showSilentMemoryExtraction: false,
      agentTemplates: [],
      selectedSystemToolIds: [],
      getMcpSettings: () => ({ servers: [], selected: [] }),
      sessionId: "session-1",
      conversationId: "conversation-lifecycle",
      fallbackTitle: "title",
      createdAt: 1,
      titlePromise: null,
      transcriptStore: {},
      gatewayBridgeEvents: {
        queueToken: noOp,
        queueEvent(event) {
          gatewayEvents.push(event);
        },
        queueToolStatus: noOp,
      },
      hookLifecycle: createHookLifecycle(),
      conversationDebugLogger: { enabled: false, logResult: noOp },
      getNextConversationState: () => state,
      applyConversationState: noOp,
      buildPreparedContext: () => ({ systemPrompt: "", messages: [] }),
      compaction: {
        noteFixedOverheadTokens: noOp,
        async maybeCompactPreSend() {},
        beginRequest: noOp,
        observeContextMessages: () => 0,
        shouldProtectMidStream() {
          protectionChecks += 1;
          return false;
        },
        async compactDuringRun() {
          return { context: null, shouldDisableProtection: false };
        },
      },
      cancellation: {
        deriveScope() {
          return { controller: new AbortController(), release: noOp };
        },
      },
      resetLiveTranscript: noOp,
      settleLiveTranscript: noOp,
      batchLiveRoundsUpdate(updater) {
        liveRounds = updater(liveRounds);
      },
      updateToolStatus: noOp,
      updatePersistableAgentProgress: noOp,
      commitVisibleAbortedConversation() {
        return true;
      },
      updateConversationRuntimeEntry: noOp,
      async persistConversationWithHistorySync() {
        return true;
      },
    });
  } finally {
    runAssistantWithToolsScenario = replayCancelledHistoryScenario;
  }

  assert.equal(protectionChecks, 0);
  assert.equal(toolCallEvents("AskUserQuestion").length, 1);
  assert.equal(askTools.getAskUserQuestionDeadlineAt(askToolCall.id), askDeadlineAt);
});
