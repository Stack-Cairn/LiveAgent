import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// subagent roster 原本把身份字段（id/name/role）与运行状态
// （status/mode/last_task/last_summary）拼在同一行塞进 systemPrompt。子代理 run 状态一推进，
// 整个 reminder 就变，systemPrompt 随之失稳，system 块连同其后的全部历史一并作废。
// 拆开之后：稳定段留在 systemPrompt；易变段与 bus 增量合并成同一段 wireTailText，
// 只随出站请求投递，绝不写进 agent 状态消息（否则会经 emittedMessages 泄漏到
// 持久化 / UI / 记忆抽取）。
// 这组用例盯住接线层：
//   ① 易变段（含 mode）不得出现在 systemPrompt，run 内 systemPrompt 字节恒定
//   ② 状态未变的轮次不产生任何额外内容（onBeforeNextTurn 交回 null）
//   ③ 状态推进当轮以 wireTailText 送达，override.context.messages 不含尾部文本
//   ④ 与 bus 增量合并成一段 wireTailText，不是各投各的

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

// roster.ts 保持真实实现：被冻结/被投递的就是它的输出字节。
let runAssistantWithToolsScenario = async () => {
  throw new Error("scenario was not installed");
};

const loader = createTsModuleLoader({
  mocks: {
    [agentRunnerPath]: {
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

const RUN_ID = "run-roster";
const BASE_SYSTEM_PROMPT = "base system prompt";

function noOp() {}

function identity(agentId, overrides = {}) {
  return {
    parentConversationId: "conversation-roster",
    agentId,
    name: overrides.name ?? `Agent ${agentId}`,
    role: overrides.role ?? "R",
    identityPrompt: "",
    lastMode: overrides.lastMode ?? "readonly",
    createdAt: 1,
    updatedAt: overrides.updatedAt ?? 2,
  };
}

function run(agentId, overrides = {}) {
  return {
    id: `run-${agentId}`,
    agentId,
    status: overrides.status ?? "running",
    prompt: overrides.prompt ?? `task for ${agentId}`,
    summary: overrides.summary,
  };
}

function busMessage(seq, bodyMarkdown) {
  return {
    id: seq,
    parentConversationId: "conversation-roster",
    seq,
    senderId: "agent-a",
    recipientId: "parent",
    channel: "direct",
    bodyMarkdown,
    createdAt: 1_700_000_000_000 + seq,
  };
}

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

function toolCallAssistant(round) {
  return assistantMessage(
    [{ type: "toolCall", id: `call-${round}`, name: "Read", arguments: {} }],
    "toolUse",
  );
}

function toolResult(round) {
  return {
    role: "toolResult",
    toolCallId: `call-${round}`,
    toolName: "Read",
    content: [{ type: "text", text: `result ${round}` }],
    details: {},
    isError: false,
    timestamp: 3,
  };
}

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

/** 可变 roster + bus 存储：用例在轮次之间推进 run 状态，模拟子代理跑动。 */
function createSubagentStore({ identities = [], runs = [], busMessages = [] } = {}) {
  let identityList = [...identities];
  let runList = [...runs];
  let messages = [...busMessages];
  return {
    advanceRun(summary) {
      runList = runList.map((entry) =>
        entry.agentId === summary.agentId ? summary : entry,
      );
      if (!runList.some((entry) => entry.agentId === summary.agentId)) {
        runList = [...runList, summary];
      }
      // run 推进会 bump 身份的 updatedAt，listIdentities() 的顺序随之改变。
      identityList = [...identityList]
        .map((entry) =>
          entry.agentId === summary.agentId ? { ...entry, updatedAt: entry.updatedAt + 100 } : entry,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    deliverBus(...next) {
      messages = [...messages, ...next];
    },
    store: {
      async ready() {},
      // 真实实现按 updatedAt 倒序返回。
      listIdentities: () => [...identityList].sort((a, b) => b.updatedAt - a.updatedAt),
      latestRunsByAgent: () => new Map(runList.map((entry) => [entry.agentId, entry])),
      async listBusMessages() {
        return messages.map((message) => ({ ...message }));
      },
    },
  };
}

function createHarness(subagents) {
  let current = conversationState.createConversationStateFromContext({
    systemPrompt: BASE_SYSTEM_PROMPT,
    messages: [],
  });

  const systemPrompts = [];
  const requestMessages = [];
  const record = (label, context) => {
    if (context) {
      systemPrompts.push({ label, systemPrompt: context.systemPrompt });
      requestMessages.push({ label, messages: context.messages });
    }
    return context;
  };

  return {
    subagents,
    systemPrompts,
    requestMessages,
    overrides: [],
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
      subagentStore: subagents.store,
      getMcpSettings: () => ({ servers: [], selected: [] }),
      sessionId: "session-1",
      taskStateStore: {
        runId: RUN_ID,
        getState: () => current.meta.taskList,
        async commitState() {},
      },
      conversationId: "conversation-roster",
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
        noteFixedOverheadTokens() {},
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
          return { context: null, shouldDisableProtection: false };
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

/** 工具循环。`beforeRound[n]` 在第 n 轮 onBeforeNextTurn 之前执行。 */
function toolRounds(harness, { rounds = 2, beforeRound = {} } = {}) {
  return async (params) => {
    let emitted = [];
    for (let round = 1; round <= rounds; round += 1) {
      const assistant = toolCallAssistant(round);
      const result = toolResult(round);
      params.onTurnStart?.(round);
      params.onToolCall?.(assistant.content[0], round);
      params.onToolResult?.(assistant.content[0], result, round);
      params.onAssistantMessage?.(assistant, round);
      emitted = [...emitted, assistant, result];

      beforeRound[round]?.();

      const override = await params.onBeforeNextTurn?.({
        round,
        assistant,
        toolResults: [result],
        emittedMessages: emitted,
        runtimeContext: params.context,
        signal: params.signal,
      });
      harness.overrides.push(override ?? null);
      if (override) {
        emitted = override.emittedMessages.length === 0 ? [] : override.context.messages.slice();
      }
    }
    params.onTurnStart?.(rounds + 1);
    params.onAssistantMessage?.(finalAssistant, rounds + 1);
    return {
      assistant: finalAssistant,
      messages: [finalAssistant],
      emittedMessages: [...emitted, finalAssistant],
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

/** 返回锚点工具结果上被追加的文本块（原始的 `result N` 块不算）。 */
function appendedBlocks(messages) {
  return messages.flatMap((message) =>
    message.role === "toolResult" && Array.isArray(message.content)
      ? message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .filter((text) => !/^result \d+$/.test(text))
      : [],
  );
}

function uniqueSystemPrompt(harness) {
  const unique = new Set(harness.systemPrompts.map((entry) => entry.systemPrompt));
  assert.equal(
    unique.size,
    1,
    `systemPrompt 在 run 内发生了漂移：${[...unique].join("\n---\n")}`,
  );
  return [...unique][0];
}

// ---------------------------------------------------------------------------
// ① + ② 稳定段进 systemPrompt；状态未变的轮次不产生任何额外内容

test("身份段进 systemPrompt，运行状态不进；状态未变的轮次不产生额外内容", async () => {
  const subagents = createSubagentStore({
    identities: [identity("agent-b", { updatedAt: 20 }), identity("agent-a", { updatedAt: 10 })],
    runs: [run("agent-a", { status: "running", prompt: "audit the parser" })],
  });
  const harness = createHarness(subagents);
  await runWithScenario(toolRounds(harness, { rounds: 3 }), harness.params);

  const systemPrompt = uniqueSystemPrompt(harness);
  assert.match(systemPrompt, /Existing delegated agents in this parent conversation:/);
  // listIdentities() 交回的是 updatedAt 倒序（agent-b 在前），systemPrompt 里必须是 id 序。
  assert.ok(systemPrompt.indexOf("id=agent-a") < systemPrompt.indexOf("id=agent-b"));
  assert.doesNotMatch(systemPrompt, /status=/);
  assert.doesNotMatch(systemPrompt, /last_task=/);
  assert.doesNotMatch(systemPrompt, /audit the parser/);
  // mode 随每次 Agent 调用变化，属易变字段，不得进稳定段。
  assert.doesNotMatch(systemPrompt, /mode=/);

  // 第 1 轮首投运行状态（run 起始时尾部还没有锚点，此前无处可挂）。
  const first = harness.overrides[0];
  assert.ok(first?.wireTailText, "第 1 轮必须把运行状态作为 wireTailText 交给 runner");
  assert.match(first.wireTailText, /^Latest run state of the delegated agents/);
  assert.match(
    first.wireTailText,
    /- id=agent-a status=running mode=readonly last_task=audit the parser/,
  );
  // 尾部文本只随出站请求投递：不得写进 override.context.messages，
  // 否则会经 emittedMessages 泄漏到持久化 / UI / 记忆抽取。
  assert.deepEqual(appendedBlocks(first.context.messages), []);

  // 第 2、3 轮状态未变 → 一个字节都不许再加。
  assert.deepEqual(
    harness.overrides.slice(1),
    [null, null],
    "内容未变的轮次必须交回 null，不得产生任何额外内容",
  );
});

// ---------------------------------------------------------------------------
// ③ 状态推进当轮送达，且 systemPrompt 字节不变

test("run 状态推进当轮送达，systemPrompt 字节不变", async () => {
  const subagents = createSubagentStore({
    identities: [identity("agent-a", { updatedAt: 10 })],
    runs: [run("agent-a", { status: "running" })],
  });
  const harness = createHarness(subagents);
  await runWithScenario(
    toolRounds(harness, {
      rounds: 3,
      beforeRound: {
        2: () =>
          subagents.advanceRun(
            run("agent-a", { status: "completed", summary: "found three issues" }),
          ),
      },
    }),
    harness.params,
  );

  const systemPrompt = uniqueSystemPrompt(harness);
  assert.ok(
    !systemPrompt.includes("found three issues"),
    "run 内推进的状态不得被塞回 systemPrompt",
  );

  assert.match(harness.overrides[0].wireTailText, /status=running/);

  const second = harness.overrides[1];
  assert.ok(second?.wireTailText, "状态推进的那一轮必须当轮送达");
  assert.match(second.wireTailText, /status=completed .*last_summary=found three issues/);
  // 每个 override 只携带本轮增量；跨请求的累积重挂由 runner 负责，
  // agent 状态消息里始终不含尾部文本。
  assert.deepEqual(appendedBlocks(second.context.messages), []);

  assert.equal(harness.overrides[2], null, "推进后又没变的轮次不得再投");
});

// ---------------------------------------------------------------------------
// ④ 与 bus 增量合并成同一个块

test("同一轮内 bus 增量与运行状态合并成一个尾部块", async () => {
  const subagents = createSubagentStore({
    identities: [identity("agent-a")],
    runs: [run("agent-a", { status: "running" })],
  });
  const harness = createHarness(subagents);
  await runWithScenario(
    toolRounds(harness, {
      rounds: 1,
      beforeRound: { 1: () => subagents.deliverBus(busMessage(1, "report is ready")) },
    }),
    harness.params,
  );

  const first = harness.overrides[0];
  assert.ok(first?.wireTailText);
  assert.match(first.wireTailText, /^## LiveAgent Message Bus \(new messages\)/);
  assert.match(first.wireTailText, /report is ready/);
  assert.match(first.wireTailText, /Latest run state of the delegated agents/);
  assert.match(first.wireTailText, /- id=agent-a status=running/);
  // 两者合并成同一段 wireTailText（一段一个尾部块），且不落入 agent 状态消息。
  assert.deepEqual(appendedBlocks(first.context.messages), []);
});
