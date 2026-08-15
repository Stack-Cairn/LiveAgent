import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 子 agent 消息总线的快照拼在 systemPrompt 里，而 systemPrompt 排在全部消息之前。
// 每轮重刷快照 = 每次子 agent 投递都把 system 块连同其后的全部历史打穿。
// 但总线不能像 taskList 那样整体冻结 —— 延迟投递是功能回退。
// 因此：快照按“压缩纪元”冻结，run 内新到的消息渲染成增量块经 override.wireTailText
// 交给 runner——runner 累积后只挂到每次出站请求上，agent 运行时状态、
// emittedMessages 与持久化始终不含它。这组用例盯住：
//   ① 无新增消息时不产生任何额外内容（onBeforeNextTurn 交回 null）
//   ② 有新增消息时 systemPrompt 字节不变，增量当轮经 wireTailText 送达且不进消息列表
//   ③ 已投递的增量在后续轮经累积器原样重放（防“一次性追加下一轮又变回去”的回退）
//   ④ 没有安全锚点时不推进游标，下一轮补投，消息不丢
//   ⑤ 压缩边界重新冻结快照与游标
//   ⑥ 压缩边界重新冻结读失败时游标退回，增量下一轮经 wireTailText 补投

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

// bus.ts 保持真实实现：冻结/增量的都是它的输出字节，mock 掉就测不到东西了。
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
// 出站挂载模拟需要与 runner 完全同一份锚点判定逻辑，直接加载真实实现。
const { appendToolResultTailBlock } = loader.loadModule(
  "src/lib/chat/context/contextTailBlock.ts",
);

const RUN_ID = "run-bus";
const BASE_SYSTEM_PROMPT = "base system prompt";

function noOp() {}

function busMessage(seq, bodyMarkdown, overrides = {}) {
  return {
    id: seq,
    parentConversationId: "conversation-bus",
    seq,
    senderId: overrides.senderId ?? "agent-x",
    recipientId: overrides.recipientId ?? "parent",
    channel: overrides.channel ?? "direct",
    subject: overrides.subject,
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

function toolResult(round, overrides = {}) {
  return {
    role: "toolResult",
    toolCallId: `call-${round}`,
    toolName: overrides.toolName ?? "Read",
    content: [{ type: "text", text: `result ${round}` }],
    details: overrides.details ?? {},
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

/** 可变的 bus 存储：测试用例在轮次之间往里投递消息，模拟子 agent 送信。 */
function createBusStore(initialMessages = []) {
  let messages = [...initialMessages];
  // -1 表示不注入失败；否则先放过 N 次读取，第 N+1 次抛错。
  let readsBeforeFailure = -1;
  const calls = [];
  return {
    deliver(...next) {
      messages = [...messages, ...next];
    },
    /** 放过 skip 次读取后让下一次读取抛错，用来精确命中压缩边界的那次重新冻结。 */
    failReadAfter(skip) {
      readsBeforeFailure = skip;
    },
    calls,
    store: {
      async ready() {},
      listIdentities: () => [],
      latestRunsByAgent: () => new Map(),
      async listBusMessages(parentId) {
        calls.push(parentId);
        if (readsBeforeFailure === 0) {
          readsBeforeFailure = -1;
          throw new Error("bus store read failed");
        }
        if (readsBeforeFailure > 0) readsBeforeFailure -= 1;
        return messages.map((message) => ({ ...message }));
      },
    },
  };
}

function createHarness({ busMessages, compactDuringRun } = {}) {
  let current = conversationState.createConversationStateFromContext({
    systemPrompt: BASE_SYSTEM_PROMPT,
    messages: [],
  });
  const bus = createBusStore(busMessages);

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
    bus,
    systemPrompts,
    requestMessages,
    overrides: [],
    /** 每轮出站请求实际发出的消息列表（含 runner 挂载的累积尾部块）。 */
    outboundRequests: [],
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
      subagentStore: bus.store,
      getMcpSettings: () => ({ servers: [], selected: [] }),
      sessionId: "session-1",
      taskStateStore: {
        runId: RUN_ID,
        getState: () => current.meta.taskList,
        async commitState() {},
      },
      conversationId: "conversation-bus",
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

/**
 * 工具循环。`beforeRound[n]` 在第 n 轮的 onBeforeNextTurn 之前执行，
 * 用来模拟“子 agent 在这一轮投递了消息”。
 *
 * 严格模拟 agentRunner 的运行时状态与尾部投递累积器，这是本组用例的关键保真点：
 * - stateMessages 对应 agent.state.messages，永不包含尾部块；
 * - accumulated 对应 accumulatedWireTailText：带 wireTailText 的 override 追加
 *   （\n\n 连接），不带的（压缩/重冻结分支）清空；
 * - 每轮出站请求 = stateMessages 加上（若有累积）经 appendToolResultTailBlock
 *   挂到安全锚点的尾部块，记录进 harness.outboundRequests 供断言。
 */
function toolRounds(harness, { rounds = 2, beforeRound = {}, anchorOverrides = {} } = {}) {
  return async (params) => {
    let stateMessages = [];
    let emitted = [];
    let accumulated = "";
    const recordOutbound = (round) => {
      const outbound = accumulated
        ? appendToolResultTailBlock(stateMessages.slice(), accumulated)
        : stateMessages;
      harness.outboundRequests.push({ round, messages: outbound });
    };
    for (let round = 1; round <= rounds; round += 1) {
      recordOutbound(round);
      const assistant = toolCallAssistant(round);
      const result = toolResult(round, anchorOverrides[round] ?? {});
      params.onTurnStart?.(round);
      params.onToolCall?.(assistant.content[0], round);
      params.onToolResult?.(assistant.content[0], result, round);
      params.onAssistantMessage?.(assistant, round);
      emitted = [...emitted, assistant, result];
      stateMessages = [...stateMessages, assistant, result];

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
        // applyTurnContextOverride：wireTailText 只进累积器；运行时消息列表换成
        // override 的消息列表（不含尾部块）。
        if (override.wireTailText) {
          accumulated = accumulated
            ? `${accumulated}\n\n${override.wireTailText}`
            : override.wireTailText;
        } else {
          accumulated = "";
        }
        stateMessages = override.context.messages.slice();
        emitted = override.emittedMessages.slice();
      }
    }
    recordOutbound(rounds + 1);
    params.onTurnStart?.(rounds + 1);
    params.onAssistantMessage?.(finalAssistant, rounds + 1);
    return {
      assistant: finalAssistant,
      messages: [...stateMessages, finalAssistant],
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

function tailTexts(messages) {
  return messages.flatMap((message) =>
    message.role === "toolResult" && Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "text").map((block) => block.text)
      : [],
  );
}

// ---------------------------------------------------------------------------
// ① 无新增消息：不产生任何额外内容

test("run 内没有新增 bus 消息时不产生任何额外内容", async () => {
  const harness = createHarness({ busMessages: [busMessage(1, "delivered before the run")] });
  await runWithScenario(toolRounds(harness), harness.params);

  assert.deepEqual(
    harness.overrides,
    [null, null],
    "没有新增消息时 onBeforeNextTurn 必须交回 null，不得交回续跑上下文",
  );

  // run 起始的快照仍在 system 段里，且全程未变。
  const unique = new Set(harness.systemPrompts.map((entry) => entry.systemPrompt));
  assert.equal(unique.size, 1, `systemPrompt 在 run 内发生了漂移：${[...unique].join("\n---\n")}`);
  assert.match([...unique][0], /## LiveAgent Message Bus/);
  assert.match([...unique][0], /delivered before the run/);

  // 消息尾部没有任何增量块。
  for (const entry of harness.requestMessages) {
    assert.ok(
      !tailTexts(entry.messages).some((text) => text.includes("new messages")),
      `${entry.label} 出现了不该有的增量块`,
    );
  }
});

// ---------------------------------------------------------------------------
// ② 有新增消息：systemPrompt 字节不变，增量当轮经 wireTailText 送达

test("子 agent 投递后 systemPrompt 字节不变，增量当轮经 wireTailText 送达", async () => {
  const harness = createHarness({ busMessages: [busMessage(1, "delivered before the run")] });
  await runWithScenario(
    toolRounds(harness, {
      beforeRound: { 1: () => harness.bus.deliver(busMessage(2, "arrived mid run")) },
    }),
    harness.params,
  );

  const unique = new Set(harness.systemPrompts.map((entry) => entry.systemPrompt));
  assert.equal(
    unique.size,
    1,
    `增量投递不得改写 systemPrompt：${JSON.stringify(harness.systemPrompts, null, 2)}`,
  );
  assert.ok(
    ![...unique][0].includes("arrived mid run"),
    "run 内新到的消息不得被塞回 systemPrompt",
  );

  const continuation = harness.overrides[0];
  assert.ok(continuation?.context, "有新增消息时必须交回续跑上下文");
  assert.ok(continuation.wireTailText, "增量必须经 wireTailText 交给 runner");
  assert.match(continuation.wireTailText, /^## LiveAgent Message Bus \(new messages\)/);
  assert.match(continuation.wireTailText, /arrived mid run/);
  // 增量只走线上：override 的消息列表本身不得包含它，防止泄漏进持久化与记忆抽取。
  assert.ok(
    !tailTexts(continuation.context.messages).some((text) => text.includes("arrived mid run")),
    "增量块不得写进 override 的消息列表",
  );
  assert.equal(
    continuation.context.systemPrompt,
    [...unique][0],
    "续跑上下文的 systemPrompt 必须与冻结值逐字节一致",
  );

  // 下一轮出站请求必须挂上这份增量，且只挂一份。
  const nextOutbound = harness.outboundRequests.find((entry) => entry.round === 2);
  assert.ok(nextOutbound, "第 2 轮必须发出出站请求");
  const attached = tailTexts(nextOutbound.messages).filter((text) =>
    text.includes("arrived mid run"),
  );
  assert.equal(attached.length, 1, "增量块必须挂到下一轮出站请求上，且只挂一份");
});

// ---------------------------------------------------------------------------
// ③ 已挂上的增量在后续轮原样重放（关键回退防线）

test("已投递的增量块在后续轮原样重放且不重复投递", async () => {
  const harness = createHarness({ busMessages: [busMessage(1, "before the run")] });
  await runWithScenario(
    toolRounds(harness, {
      rounds: 3,
      beforeRound: { 1: () => harness.bus.deliver(busMessage(2, "arrived mid run")) },
    }),
    harness.params,
  );

  const roundOne = harness.overrides[0];
  assert.ok(roundOne?.wireTailText, "第 1 轮必须经 wireTailText 交回增量");
  const block = roundOne.wireTailText;
  assert.match(block, /arrived mid run/);

  // 第 2、3 轮没有新增消息 → 不再交回 override，游标不重复投递。
  assert.deepEqual(harness.overrides.slice(1), [null, null]);

  // 但累积器让增量块留在后续每轮的出站请求上，且字节完全一致、只有一份。
  const laterOutbound = harness.outboundRequests.filter((entry) => entry.round >= 2);
  assert.ok(laterOutbound.length >= 3, `期望至少 3 次后续出站请求，实际 ${laterOutbound.length}`);
  for (const entry of laterOutbound) {
    const replayed = tailTexts(entry.messages).filter((text) => text.includes("arrived mid run"));
    assert.equal(replayed.length, 1, `第 ${entry.round} 轮增量块必须原样重放且不得重复挂载`);
    assert.equal(replayed[0], block, "重放的字节必须与首次投递完全一致");
  }
});

// ---------------------------------------------------------------------------
// ④ 没有安全锚点时不推进游标，下一轮重试

test("尾部只有 display-image 工具结果时不投递，下一轮补投且不丢消息", async () => {
  const harness = createHarness();
  await runWithScenario(
    toolRounds(harness, {
      rounds: 2,
      // 第 1 轮的工具结果是 display-image：净化会整体替换 content，不能当锚点。
      anchorOverrides: { 1: { toolName: "Image", details: { kind: "display_image" } } },
      beforeRound: { 1: () => harness.bus.deliver(busMessage(1, "must not be lost")) },
    }),
    harness.params,
  );

  assert.equal(harness.overrides[0], null, "没有安全锚点时不得交回续跑上下文");

  const secondRound = harness.overrides[1];
  assert.ok(secondRound?.wireTailText, "下一轮出现安全锚点后必须经 wireTailText 补投");
  assert.match(secondRound.wireTailText, /must not be lost/);
  assert.ok(
    !tailTexts(secondRound.context.messages).some((text) => text.includes("must not be lost")),
    "补投的增量同样只走线上，不得写进 override 的消息列表",
  );

  // 补投后的出站请求必须挂上这条消息，且只挂一份。
  const finalOutbound = harness.outboundRequests.find((entry) => entry.round === 3);
  assert.ok(finalOutbound, "补投后的一轮必须发出出站请求");
  const attached = tailTexts(finalOutbound.messages).filter((text) =>
    text.includes("must not be lost"),
  );
  assert.equal(attached.length, 1, "游标未推进，消息在下一轮原样补投");
});

// ---------------------------------------------------------------------------
// ⑤ 压缩边界重新冻结快照与游标

test("run 内压缩后 bus 快照重新冻结，增量不重复投递", async () => {
  let compactionsLeft = 1;
  const harness = createHarness({
    compactDuringRun: () =>
      compactionsLeft-- > 0
        ? {
            context: { systemPrompt: BASE_SYSTEM_PROMPT, messages: [] },
            shouldDisableProtection: false,
          }
        : { context: null, shouldDisableProtection: false },
  });

  await runWithScenario(
    toolRounds(harness, {
      rounds: 2,
      beforeRound: { 1: () => harness.bus.deliver(busMessage(1, "arrived before compaction")) },
    }),
    harness.params,
  );

  // 第 1 轮压缩：续跑上下文的 systemPrompt 必须带上重新冻结的快照。
  const continuation = harness.overrides[0];
  assert.ok(continuation?.context);
  assert.match(continuation.context.systemPrompt, /## LiveAgent Message Bus/);
  assert.match(continuation.context.systemPrompt, /arrived before compaction/);
  assert.deepEqual(continuation.emittedMessages, [], "压缩分支交回的 emittedMessages 必须清空");

  // run 起始时 bus 为空，快照段当时并不存在 —— 证明快照确实在压缩边界重算过。
  const preSend = harness.systemPrompts.find((entry) => entry.label === "pre-send");
  assert.equal(preSend.systemPrompt, BASE_SYSTEM_PROMPT);

  // 游标一并重置：第 2 轮不得把同一条消息再投递一次。
  assert.equal(harness.overrides[1], null, "已进入快照的消息不得再以增量形式重复投递");
});

// ---------------------------------------------------------------------------
// ⑥ 压缩边界重新冻结时读失败：游标退回快照覆盖的位置，消息不丢

test("压缩边界重新冻结读失败时游标退回，增量下一轮补投", async () => {
  let compactionsLeft = 1;
  const harness = createHarness({
    compactDuringRun: () =>
      compactionsLeft-- > 0
        ? {
            context: { systemPrompt: BASE_SYSTEM_PROMPT, messages: [] },
            shouldDisableProtection: false,
          }
        : { context: null, shouldDisableProtection: false },
  });

  await runWithScenario(
    toolRounds(harness, {
      rounds: 2,
      beforeRound: {
        1: () => {
          harness.bus.deliver(busMessage(1, "must survive the failed refreeze"));
          // 放过本轮渲染增量的那次读取，让压缩之后的重新冻结读失败。
          harness.bus.failReadAfter(1);
        },
      },
    }),
    harness.params,
  );

  // 前置条件：重新冻结失败 → 快照没能带上这条消息，而压缩分支不带 wireTailText，
  // runner 累积器随之清空——挂着它的尾部投递就此消失。
  const roundOne = harness.overrides[0];
  assert.ok(roundOne?.context, "第 1 轮压缩后必须交回续跑上下文");
  assert.ok(
    !roundOne.context.systemPrompt.includes("must survive the failed refreeze"),
    "读失败时快照不该凭空带上这条消息",
  );
  assert.equal(roundOne.wireTailText, undefined, "压缩分支不得携带 wireTailText");
  assert.deepEqual(roundOne.context.messages, [], "压缩已截断历史");

  const roundTwo = harness.overrides[1];
  assert.ok(roundTwo?.wireTailText, "游标必须退回到快照覆盖的位置，下一轮经 wireTailText 补投");
  const occurrences =
    roundTwo.wireTailText.split("must survive the failed refreeze").length - 1;
  assert.equal(occurrences, 1, "消息必须原样补投，且只投一份");

  // 补投后的出站请求必须挂上这条消息，且只挂一份。
  const finalOutbound = harness.outboundRequests.find((entry) => entry.round === 3);
  assert.ok(finalOutbound, "补投后的一轮必须发出出站请求");
  const attached = tailTexts(finalOutbound.messages).filter((text) =>
    text.includes("must survive the failed refreeze"),
  );
  assert.equal(attached.length, 1, "补投的消息必须挂到出站请求上，且只挂一份");
});
