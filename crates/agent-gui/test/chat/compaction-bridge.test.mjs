import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import { createAgentToolCall, createSubagentHarness } from "../subagents/harness.mjs";

const SUMMARY_TEXT = `## Goal\nFix src/app.ts\n## Current State\n${"detail ".repeat(60)}`;
// 摘要降级梯由 compaction-summarize.test 覆盖；这里只关心 checkpoint 与 bridge 的落地。
const loader = createTsModuleLoader({
  mocks: {
    [path.join(
      path.resolve(fileURLToPath(new URL("../..", import.meta.url))),
      "src/lib/chat/compaction/summarize.ts",
    )]: {
      createCompactionAbortError: () => Object.assign(new Error("aborted"), { name: "AbortError" }),
      summarize: async ({ providerId, model }) => ({
        ok: {
          summaryText: SUMMARY_TEXT,
          promptVersion: "summary-v4",
          providerId,
          model,
          usage: { inputTokens: 5_000, outputTokens: 300, cacheReadTokens: 0 },
        },
      }),
    },
  },
});
const bridge = loader.loadModule("src/lib/chat/compaction/bridge.ts");
const checkpoint = loader.loadModule("src/lib/chat/compaction/checkpoint.ts");
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const { estimateMessageTokens, deriveContextTokens } = loader.loadModule(
  "src/lib/chat/compaction/tokenLedger.ts",
);
const { CompactionController } = loader.loadModule("src/lib/chat/compaction/controller.ts");
const cancellationModule = loader.loadModule("src/lib/chat/conversation/turnCancellation.ts");
const { buildPreparedContext } = loader.loadModule(
  "src/pages/chat/runtime/conversationContextBuilders.ts",
);
const { getFirstUserMessageText } = loader.loadModule("src/lib/chat/page/chatPageHelpers.ts");
const {
  buildMessageBusUpdateMessage,
  buildSubagentContext,
  buildSubagentContinuationMessage,
  resolveSubagentRetainedUserText,
} = loader.loadModule("src/lib/subagents/prompts.ts");

const {
  attachCheckpointBridge,
  estimateCheckpointBridgeTokens,
  isCheckpointBridgeMessage,
  isCheckpointBridgeText,
  renderCheckpointBridgeText,
} = bridge;
const { selectRetainedUserMessages } = checkpoint;
const { RETAINED_USER_MESSAGES_MAX_TOKENS } = loader.loadModule(
  "src/lib/chat/compaction/policy.ts",
);

function usage(totalTokens) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function user(content, timestamp, extra = {}) {
  return { role: "user", content, timestamp, ...extra };
}

function assistant(text, timestamp, extra = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-real",
    stopReason: "stop",
    usage: usage(1000),
    timestamp,
    ...extra,
  };
}

function checkpointMessage(text, timestamp, extra = {}) {
  return assistant(text, timestamp, {
    api: "liveagent-compaction",
    provider: "liveagent",
    model: "summary",
    responseId: `summary-${timestamp}`,
    usage: usage(0),
    ...extra,
  });
}

function summary(overrides = {}) {
  return {
    role: "summary",
    id: "summary-1",
    timestamp: 100,
    content: "Goal: ship the bridge",
    ...overrides,
    summaryMeta: {
      format: "plain-text-v1",
      strategy: "cumulative-checkpoint",
      coversThroughMessageId: "m-9",
      coveredMessageCount: 9,
      generatedBy: { providerId: "anthropic", model: "claude" },
      ...overrides.summaryMeta,
    },
  };
}

// 压缩一次后再追加消息：新 segment 带 summary（含保留原话与账本）。
function compactedState(afterMessages, checkpointExtra = {}) {
  const base = conversationState.createConversationStateFromContext({
    systemPrompt: "Base prompt",
    messages: [
      user("first request", 1, { id: "u-1" }),
      assistant("done", 2, {
        content: [{ type: "toolCall", id: "t1", name: "Write", arguments: { path: "a.ts" } }],
      }),
    ],
  });
  const compacted = conversationState.applyCompactionCheckpoint(
    base,
    checkpointMessage("Earlier work summarized", 3, checkpointExtra),
  );
  return conversationState.appendMessagesToConversation(compacted, afterMessages);
}

function requestContext(state, options = {}) {
  return conversationState.buildRequestContext(state, { ...options, includeCheckpointBridge: true });
}

function firstText(message) {
  return typeof message.content === "string" ? message.content : message.content[0].text;
}

function assertNoConsecutiveUsers(messages) {
  for (let index = 1; index < messages.length; index += 1) {
    assert.ok(
      !(messages[index - 1].role === "user" && messages[index].role === "user"),
      `consecutive user messages at ${index}`,
    );
  }
}

// —— 渲染 ——

test("bridge text is byte-stable and memoized per summary object", () => {
  const stored = summary({
    retainedUserMessages: [{ id: "u-1", timestamp: Date.UTC(2026, 0, 2), text: "keep tabs" }],
    summaryMeta: { fileLedger: { readFiles: ["src/a.ts"], modifiedFiles: [] } },
  });
  const text = renderCheckpointBridgeText(stored);
  assert.equal(renderCheckpointBridgeText(stored), text);
  // 同内容的另一份 summary（如重开会话读回）渲染出完全相同的字节。
  assert.equal(renderCheckpointBridgeText(structuredClone(stored)), text);
  assert.match(text, /^<context_checkpoint>\n/);
  assert.match(text, /<summary>\nGoal: ship the bridge\n<\/summary>/);
  assert.match(
    text,
    /<user_messages>\n<user_message time="2026-01-02T00:00:00\.000Z">keep tabs<\/user_message>\n<\/user_messages>/,
  );
  assert.match(text, /<files>\n### Files touched[^]*Read: "src\/a\.ts"\n<\/files>/);
  assert.match(text, /<\/context_checkpoint>\nIf a newer user request follows this checkpoint/);

  // 单独成条与合入首条两种形态都按身份复用，TokenLedger 的 WeakMap 估算随之命中。
  const standalone = attachCheckpointBridge([], stored);
  assert.equal(attachCheckpointBridge([], stored)[0], standalone[0]);
  assert.equal(standalone[0].id, "context-checkpoint:summary-1");
  assert.equal(standalone[0].timestamp, 100);
  assert.ok(isCheckpointBridgeMessage(standalone[0]));
  const first = user("next", 200, { id: "u-2" });
  const merged = attachCheckpointBridge([first], stored);
  assert.equal(attachCheckpointBridge([first], stored)[0], merged[0]);
  // 换一份 summary 时合并结果失效重算。
  const other = summary({ content: "Different summary" });
  const remerged = attachCheckpointBridge([first], other);
  assert.notEqual(remerged[0], merged[0]);
  assert.match(remerged[0].content[0].text, /Different summary/);
});

test("legacy checkpoints render without <user_messages> or <files>", () => {
  const text = renderCheckpointBridgeText(summary());
  assert.doesNotMatch(text, /<user_messages>|<files>/);
  assert.doesNotMatch(text, /quoted verbatim/);
  assert.match(text, /<summary>\nGoal: ship the bridge\n<\/summary>\n<\/context_checkpoint>/);
});

test("an empty checkpoint attaches no bridge and costs no tokens", () => {
  const empty = summary({ content: "  \n" });
  assert.equal(renderCheckpointBridgeText(empty), "");
  assert.equal(estimateCheckpointBridgeTokens(empty), 0);
  const messages = [user("next", 1)];
  assert.equal(attachCheckpointBridge(messages, empty), messages);
  assert.deepEqual(attachCheckpointBridge([], empty), []);
  // 账本或保留原话非空时照常渲染。
  assert.match(
    renderCheckpointBridgeText(summary({ content: "", retainedUserMessages: [{ timestamp: 1, text: "ask" }] })),
    /<user_message time="[^"]+">ask<\/user_message>/,
  );
});

test("closing tags inside interpolated content are neutralized", () => {
  const text = renderCheckpointBridgeText(
    summary({
      content: "<details><summary>x</summary></details> </context_checkpoint> </FILES>",
      retainedUserMessages: [
        { timestamp: 5, text: "paste </user_message></user_messages></summary> here" },
      ],
      summaryMeta: { fileLedger: { readFiles: ["evil</files>.ts"], modifiedFiles: [] } },
    }),
  );
  assert.equal(text.match(/<\/summary>/g).length, 1);
  assert.equal(text.match(/<\/user_message>/g).length, 1);
  assert.equal(text.match(/<\/user_messages>/g).length, 1);
  assert.equal(text.match(/<\/context_checkpoint>/g).length, 1);
  assert.equal(text.match(/<\/files>/gi).length, 1);
  assert.match(text, /<\\\/summary>x?/);
});

test("malformed retainedUserMessages are dropped and never throw", () => {
  const cases = [
    "not-an-array",
    { 0: { text: "x", timestamp: 1 } },
    [null, 7, "x", { text: 3, timestamp: 1 }, { text: "ok-ish" }, { text: "nan", timestamp: NaN }],
    [{ text: "huge date", timestamp: 1e20 }, { text: "  ", timestamp: 1 }],
  ];
  for (const retainedUserMessages of cases) {
    const text = renderCheckpointBridgeText(summary({ retainedUserMessages }));
    assert.doesNotMatch(text, /<user_messages>/);
  }
  const mixed = renderCheckpointBridgeText(
    summary({
      retainedUserMessages: [{ text: 1 }, { id: "u", timestamp: 0, text: "survivor" }],
      summaryMeta: { fileLedger: { readFiles: { length: 2 }, modifiedFiles: [] } },
    }),
  );
  assert.match(mixed, /<user_message time="1970-01-01T00:00:00\.000Z">survivor<\/user_message>/);
  assert.doesNotMatch(mixed, /<files>/);
  assert.doesNotThrow(() =>
    renderCheckpointBridgeText({ role: "summary", id: "s", timestamp: 1, content: undefined }),
  );
});

test("bridge token estimate matches the ledger estimate of the standalone message", () => {
  const stored = summary({ retainedUserMessages: [{ timestamp: 1, text: "中文原话" }] });
  const [standalone] = attachCheckpointBridge([], stored);
  assert.equal(estimateCheckpointBridgeTokens(stored), estimateMessageTokens(standalone));
});

// —— 请求组装 ——

test("bridge merges into the first user message without mutating state or adding a user turn", () => {
  const firstUser = user("next question", 10, {
    id: "u-next",
    liveAgentHistoryRef: { segmentIndex: 1, messageIndex: 0 },
  });
  const state = compactedState([firstUser, assistant("answer", 11), user("follow up", 12)]);
  const context = requestContext(state);

  assert.equal(context.systemPrompt, "Base prompt");
  assert.deepEqual(
    context.messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  assertNoConsecutiveUsers(context.messages);
  const merged = context.messages[0];
  assert.equal(merged.id, "u-next");
  assert.equal(merged.timestamp, 10);
  assert.deepEqual(merged.liveAgentHistoryRef, { segmentIndex: 1, messageIndex: 0 });
  assert.match(merged.content[0].text, /^<context_checkpoint>/);
  assert.deepEqual(merged.content[1], { type: "text", text: "next question" });
  // 状态里的原消息不变；同一状态重复构建复用同一对象（字节与身份都稳定）。
  const active = state.segments[state.activeSegmentIndex];
  assert.equal(active.messages[0].content, "next question");
  assert.equal(requestContext(state).messages[0], merged);

  // 块数组内容：bridge 作为前置块，原块原样跟随。
  const arrayState = compactedState([
    user([{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }], 20),
  ]);
  const arrayMessage = requestContext(arrayState).messages[0];
  assert.equal(arrayMessage.content.length, 3);
  assert.match(arrayMessage.content[0].text, /^<context_checkpoint>/);
  assert.equal(arrayMessage.content[2].type, "image");
});

test("bridge stands alone when the segment is empty or starts with an assistant", () => {
  const empty = requestContext(compactedState([]));
  assert.equal(empty.messages.length, 1);
  assert.ok(isCheckpointBridgeMessage(empty.messages[0]));

  const runOn = requestContext(compactedState([assistant("continuing", 10), user("next", 11)]));
  assert.deepEqual(
    runOn.messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  assert.ok(isCheckpointBridgeMessage(runOn.messages[0]));
  assertNoConsecutiveUsers(runOn.messages);
});

test("appending request-context messages to state strips bridges before counting", () => {
  const state = compactedState([]);
  const pending = user("next question", 10, { id: "u-next" });
  const withPending = conversationState.appendMessagesToConversation(state, [pending]);
  const [merged] = requestContext(withPending).messages;
  const [standalone] = requestContext(state).messages;
  const cloned = structuredClone(merged);

  const next = conversationState.appendMessagesToConversation(state, [standalone, merged, cloned]);
  const active = next.segments[next.activeSegmentIndex];
  assert.equal(active.messages.length, 2);
  assert.equal(active.messages[0], pending);
  // 克隆副本反查表认不出，按首块文本剥离（字符串内容回不到字符串形态，语义不变）。
  assert.deepEqual(active.messages[1].content, [{ type: "text", text: "next question" }]);
  assert.equal(next.meta.totalMessageCount, state.meta.totalMessageCount + 2);
  assert.doesNotMatch(JSON.stringify(active.messages), /context_checkpoint/);
  // 只认完整 bridge：恰好以开标签开头的真实用户文本照常落库、照常保留。
  assert.ok(isCheckpointBridgeText(merged.content[0].text));
  const lookalike = user([{ type: "text", text: "<context_checkpoint> pasted from a log" }], 11);
  assert.equal(isCheckpointBridgeText(lookalike.content[0].text), false);
  const kept = conversationState.appendMessagesToConversation(state, [lookalike]);
  assert.equal(kept.segments[kept.activeSegmentIndex].messages[0], lookalike);
  assert.deepEqual(
    selectRetainedUserMessages({ messages: [lookalike], budgetTokens: 1_000 }).map((m) => m.text),
    ["<context_checkpoint> pasted from a log"],
  );
});

test("memory/skill tail blocks stay at the end of the merged first user message", () => {
  const state = compactedState([user("next question", 10, { id: "u-next" })]);
  const context = buildPreparedContext({
    state,
    activeAgentPrompt: "",
    skillsPrompt: "",
    memoryTurnUpdates: new Map([["u-next", "MEMORY DELTA"]]),
  });
  const content = context.messages[0].content;
  assert.match(content[0].text, /^<context_checkpoint>/);
  assert.equal(content[1].text, "next question");
  assert.equal(content.at(-1).text, "MEMORY DELTA");
});

test("title, App-level and memory-extraction contexts never carry the bridge", () => {
  const state = compactedState([user("real question", 10, { id: "u-next" })]);

  // 标题（ChatPage / useSendChatTurn）：buildRequestContext 默认不带 bridge。
  assert.equal(getFirstUserMessageText(conversationState.buildRequestContext(state)), "real question");

  // App 级 context 往返：种回新会话的消息不能含 bridge。
  const appContext = conversationState.buildRequestContext(state);
  assert.doesNotMatch(JSON.stringify(appContext), /context_checkpoint/);
  const reseeded = conversationState.createConversationStateFromContext(appContext);
  assert.doesNotMatch(JSON.stringify(reseeded.segments), /context_checkpoint/);

  // 记忆抽取：发送链路构建器默认带 bridge，显式 opt-out 后不带。
  const prepared = (options) =>
    buildPreparedContext({ state, activeAgentPrompt: "", skillsPrompt: "", ...options });
  assert.match(firstText(prepared({}).messages[0]), /^<context_checkpoint>/);
  const memoryMessages = prepared({ includeCheckpointBridge: false }).messages;
  assert.equal(memoryMessages[0].content, "real question");
  assert.doesNotMatch(JSON.stringify(memoryMessages), /context_checkpoint/);
});

// —— 保留原话 ——

test("selectRetainedUserMessages keeps newest whole messages, clips the first overflow, returns chronological", () => {
  const messages = [
    user("o".repeat(8_000), 1, { id: "old" }),
    user("m".repeat(4_000), 2, { id: "mid" }),
    assistant("ok", 3),
    user("newest", 4, { id: "new" }),
  ];
  // 预算 1_300：newest + mid（~1000+16）放得下，old（~2000）在剩余 ≥256 时截断。
  const retained = selectRetainedUserMessages({ messages, budgetTokens: 1_300 });
  assert.deepEqual(
    retained.map((message) => message.id),
    ["old", "mid", "new"],
  );
  assert.equal(retained[0].truncated, true);
  assert.match(retained[0].text, /^o+\n\[… truncated …\]\no+$/);
  assert.ok(retained[0].text.length < 8_000);
  assert.equal(retained[1].truncated, undefined);
  assert.equal(retained[2].text, "newest");

  // 剩余 <256 时直接停，不截断。
  const tight = selectRetainedUserMessages({ messages, budgetTokens: 1_100 });
  assert.deepEqual(
    tight.map((message) => message.id),
    ["mid", "new"],
  );
  // 预算钳在 [0, 20k]。
  assert.equal(RETAINED_USER_MESSAGES_MAX_TOKENS, 20_000);
  assert.deepEqual(selectRetainedUserMessages({ messages, budgetTokens: -5 }), []);
  const huge = selectRetainedUserMessages({
    messages: [user("x".repeat(200_000), 1, { id: "big" })],
    budgetTokens: 1_000_000,
  });
  assert.equal(huge[0].truncated, true);
});

test("selectRetainedUserMessages pools previous retained messages with dedupe", () => {
  const previous = [
    { id: "p-1", timestamp: 1, text: "earliest ask" },
    { id: "dup", timestamp: 2, text: "clipped…", truncated: true },
    { timestamp: 3, text: "id-less ask" },
    "garbage",
    { text: 42 },
  ];
  const retained = selectRetainedUserMessages({
    previous,
    messages: [
      user("full original text", 2, { id: "dup" }),
      user("id-less ask", 3),
      user("latest", 5, { id: "u-5" }),
    ],
    budgetTokens: 5_000,
  });
  assert.deepEqual(
    retained.map((message) => [message.id, message.text, message.truncated]),
    [
      ["p-1", "earliest ask", undefined],
      ["dup", "full original text", undefined],
      [undefined, "id-less ask", undefined],
      ["u-5", "latest", undefined],
    ],
  );
});

test("selectRetainedUserMessages excludes resume text, bridges, synthetic and non-text noise", () => {
  const stored = summary();
  const [bridgeMessage] = attachCheckpointBridge([], stored);
  const continuation = {
    role: "user",
    content: [{ type: "text", text: "Continue your existing delegated agent session.\nAgent name: x" }],
    timestamp: 3,
  };
  const busRefresh = buildMessageBusUpdateMessage("bus snapshot body");
  // 没有任务标签的旧续跑 / 委派消息与 bus 刷新整条排除，普通消息走默认提取。
  assert.equal(resolveSubagentRetainedUserText(continuation), null);
  assert.equal(resolveSubagentRetainedUserText(busRefresh), null);
  assert.equal(
    resolveSubagentRetainedUserText(user("Delegated agent name: x\nCurrent task:\ndo it\n\n## LiveAgent Message Bus", 1)),
    null,
  );
  assert.equal(resolveSubagentRetainedUserText(user("Please continue", 1)), undefined);
  // bus 刷新靠持久化的合成标签识别，不依赖首行文案。
  const reworded = { ...busRefresh, content: [{ type: "text", text: "Bus update" }] };
  assert.equal(resolveSubagentRetainedUserText(JSON.parse(JSON.stringify(reworded))), null);

  const upload = user("see file\n\nThe user attached the files below to this message.\n- /abs/a.pdf (pdf)", 6, {
    id: "u-up",
    liveAgentDisplayContent: "see file",
    liveAgentAttachments: [
      { relativePath: "a.pdf", absolutePath: "/abs/a.pdf", fileName: "a.pdf", kind: "pdf", sizeBytes: 10 },
    ],
  });
  // 大段粘贴引用只留标签：暂存相对路径脱离 Read 指令不可解析。
  const pasteDisplay = "please fix [Pasted text 1: .liveagent/uploads/p1.txt] thanks";
  const paste = user(`${pasteDisplay}\n\nThe user attached the files below to this message.\n- /abs/p1.txt (text)`, 7.5, {
    id: "u-paste",
    liveAgentDisplayContent: pasteDisplay,
    liveAgentAttachments: [
      {
        relativePath: ".liveagent/uploads/p1.txt",
        absolutePath: "/abs/p1.txt",
        fileName: "p1.txt",
        kind: "text",
        sizeBytes: 10,
        displayMode: "largePaste",
        displayLabel: "Pasted text 1",
      },
      { relativePath: "shot.png", absolutePath: "/abs/shot.png", fileName: "shot.png", kind: "image", sizeBytes: 10 },
    ],
  });
  const retained = selectRetainedUserMessages({
    messages: [
      user(conversationState.INTERNAL_RESUME_MESSAGE_TEXT, 1),
      bridgeMessage,
      continuation,
      busRefresh,
      user([{ type: "text", text: "with picture" }, { type: "image", data: "AAAA", mimeType: "image/png" }], 7),
      upload,
      paste,
      user("real ask", 8),
    ],
    budgetTokens: 5_000,
    resolveText: resolveSubagentRetainedUserText,
  });
  assert.deepEqual(
    retained.map((message) => message.text),
    [
      "with picture\n[image]",
      "see file\n[attachment: a.pdf]",
      "please fix [Pasted text 1] thanks\n[attachment: shot.png]",
      "real ask",
    ],
  );
});

test("subagent delegated and continuation messages retain only their task text", () => {
  const spec = {
    id: "historian",
    prompt: "study era two\n\nkeep notes",
    mode: "readonly",
    allowedOutputPaths: [],
  };
  const identity = {
    name: "Historian",
    agentId: "historian",
    role: "researcher",
    identityPrompt: "You research history.",
  };
  const [initial] = buildSubagentContext({
    spec: { ...spec, prompt: "study era one" },
    identity,
    tools: [],
    messageBusSnapshot: "BUS SNAPSHOT ONE",
    messageBusEnabled: true,
  }).messages;
  const continuation = buildSubagentContinuationMessage({
    spec,
    identity,
    resumedFrom: { id: "run-1", mode: "readonly" },
    messageBusSnapshot: "BUS SNAPSHOT TWO",
    messageBusEnabled: true,
  });
  const retained = selectRetainedUserMessages({
    messages: [initial, assistant("noted", initial.timestamp + 1), continuation],
    budgetTokens: 5_000,
    resolveText: resolveSubagentRetainedUserText,
  });
  assert.deepEqual(
    retained.map((message) => message.text),
    ["study era one", "study era two\n\nkeep notes"],
  );
  assert.doesNotMatch(JSON.stringify(retained), /BUS SNAPSHOT|Delegated agent|Stable id/);
  // 标签随消息 JSON 持久化，读回后依旧生效。
  assert.equal(
    resolveSubagentRetainedUserText(JSON.parse(JSON.stringify(continuation))),
    "study era two\n\nkeep notes",
  );
});

test("clipping never splits a surrogate pair", () => {
  for (let offset = 0; offset < 4; offset += 1) {
    const text = `${"a".repeat(offset)}${"😀".repeat(4_000)}`;
    const [clipped] = selectRetainedUserMessages({
      messages: [user(text, 1, { id: "emoji" })],
      budgetTokens: 400 + offset,
    });
    assert.equal(clipped.truncated, true);
    // 孤立代理项序列化成 \udXXX，Rust serde_json 会拒收整份摘要。
    assert.doesNotMatch(JSON.stringify(clipped.text), /\\ud[89a-f][0-9a-f]{2}/i);
  }
});

// —— controller 落地 ——

function bindController(controller, overrides = {}) {
  const applied = [];
  controller.bindTurn({
    providerId: "anthropic",
    model: "claude-x",
    runtime: {
      baseUrl: "https://example",
      apiKey: "k",
      modelConfig: { contextWindow: 200_000, maxOutputToken: 32_000 },
    },
    cancellation: cancellationModule.createTurnCancellation(),
    sinks: {
      applyState: (state) => applied.push(state),
      applyStateMidRun: (state) => applied.push(state),
      persist: async () => true,
    },
    ...overrides,
  });
  return applied;
}

function bigState(totalTokens = 190_000, systemPrompt = "sys") {
  return conversationState.createConversationStateFromContext({
    systemPrompt,
    messages: [
      user("please fix src/app.ts", 1, { id: "u-1" }),
      user("Continue your existing delegated agent session.\nAgent name: x", 2, { id: "u-2" }),
      user("check src/app.ts again", 3, { id: "u-3" }),
      { ...assistant("working on src/app.ts", 4), usage: usage(totalTokens) },
    ],
  });
}

test("post-tool compaction ends the context with a standalone bridge and retains user messages", async () => {
  const controller = new CompactionController();
  bindController(controller, { resolveRetainedUserText: resolveSubagentRetainedUserText });

  const result = await controller.compact({
    trigger: "post-tool",
    state: bigState(),
    buildContext: requestContext,
  });

  assert.equal(result.outcome, "compacted");
  const context = requestContext(result.state);
  assert.equal(context.systemPrompt, "sys");
  assert.equal(context.messages.length, 1);
  const [bridgeMessage] = context.messages;
  assert.ok(isCheckpointBridgeMessage(bridgeMessage));
  assert.doesNotMatch(JSON.stringify(context), new RegExp(conversationState.INTERNAL_RESUME_MESSAGE_TEXT));
  assert.match(bridgeMessage.content[0].text, /If a newer user request follows this checkpoint/);

  const activeSummary = result.state.segments[result.state.activeSegmentIndex].summary;
  assert.deepEqual(
    activeSummary.retainedUserMessages.map((message) => message.text),
    ["please fix src/app.ts", "check src/app.ts again"],
  );
  assert.match(bridgeMessage.content[0].text, /<user_message time="[^"]+">please fix src\/app\.ts<\/user_message>/);
  // 存在 summary 顶层：降级到旧版本后只读 summaryMeta，不会膨胀。
  assert.equal(activeSummary.summaryMeta.retainedUserMessages, undefined);
  // contextTokensAfter = fixed + 单独成条的 bridge。
  assert.equal(activeSummary.summaryMeta.stats.contextTokensAfter, deriveContextTokens(context));
  assert.equal(
    activeSummary.summaryMeta.stats.contextTokensAfter,
    deriveContextTokens({ systemPrompt: "sys", messages: [] }) + estimateCheckpointBridgeTokens(activeSummary),
  );
});

test("retained budget subtracts fixed overhead so a large prefix keeps the result under soft", async () => {
  const controller = new CompactionController();
  bindController(controller);
  // soft 148k；fixed ≈ 80k 已超过 soft 的一半（74k），保留预算归零。
  const result = await controller.compact({
    trigger: "post-tool",
    state: bigState(150_000, "s".repeat(320_000)),
    buildContext: requestContext,
  });

  assert.equal(result.outcome, "compacted");
  const activeSummary = result.state.segments.at(-1).summary;
  assert.equal(activeSummary.retainedUserMessages, undefined);
  assert.ok(activeSummary.summaryMeta.stats.contextTokensAfter < 148_000);
});

test("pre-send compaction merges the bridge into the pending user message", async () => {
  const controller = new CompactionController();
  const pending = user("next question", 9, { id: "u-pending" });
  const applied = bindController(controller);

  const result = await controller.compact({
    trigger: "pre-send",
    state: conversationState.appendMessagesToConversation(bigState(), [pending]),
    buildContext: requestContext,
    presend: { pendingUserMessage: pending },
  });

  assert.equal(result.outcome, "compacted");
  const nextContext = requestContext(applied.at(-1));
  assert.equal(nextContext.messages.length, 1);
  assert.equal(nextContext.messages[0].id, "u-pending");
  assert.match(nextContext.messages[0].content[0].text, /^<context_checkpoint>/);
  assert.equal(nextContext.messages[0].content[1].text, "next question");
  // 待发送消息不进保留池：它原样落在 N+1。
  const activeSummary = applied.at(-1).segments.at(-1).summary;
  assert.ok(
    activeSummary.retainedUserMessages.every((message) => message.text !== "next question"),
  );
});

// —— 子代理 ——

test("subagent request contexts carry the bridge and narrow synthetic messages in retention", async () => {
  let binding;
  let buildContext;
  const compactionMock = {
    CompactionController: class {
      bindTurn(next) {
        binding = next;
      }
      unbindTurn() {}
      get stats() {
        return { compactionsApplied: 1 };
      }
      noteRequest() {}
      beginRequest() {}
      observeContextMessages() {
        return 0;
      }
      async compact(request) {
        buildContext = request.buildContext;
        if (request.trigger !== "pre-send") return { outcome: "skipped", reason: "below-threshold" };
        return {
          outcome: "compacted",
          state: conversationState.applyCompactionCheckpoint(
            request.state,
            checkpointMessage("Subagent era one summarized", Date.now(), {
              retainedUserMessages: [{ timestamp: 1, text: "study era one" }],
            }),
          ),
        };
      }
      async handleTurnAbort() {
        return false;
      }
    },
    createCompactionControllerRegistry() {
      throw new Error("unused");
    },
  };
  const harness = await createSubagentHarness({ compactionMock });
  await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "historian", prompt: "study era one" }] }, "call-1"),
  );
  await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "historian", prompt: "study era two" }] }, "call-2"),
  );

  const resumed = harness.runnerCalls[1].context;
  // 压缩后的 segment 首条就是续跑消息：bridge 前置合入，不新增 user 轮次。
  assert.equal(resumed.messages.length, 1);
  const [first] = resumed.messages;
  assert.match(first.content[0].text, /^<context_checkpoint>/);
  assert.match(first.content[0].text, /Subagent era one summarized/);
  assert.match(first.content[0].text, /<user_message time="[^"]+">study era one<\/user_message>/);
  assert.match(first.content[1].text, /^Continue your existing delegated agent session\./);
  assert.doesNotMatch(resumed.systemPrompt ?? "", /Subagent era one summarized/);

  // 续跑消息只保留任务原文（标签随合入形态保留）；无标签的旧续跑消息整条排除。
  assert.equal(binding.resolveRetainedUserText(first), "study era two");
  const legacyContinuation = { role: "user", content: [first.content[1]], timestamp: 1 };
  assert.equal(binding.resolveRetainedUserText(legacyContinuation), null);
  assert.equal(binding.resolveRetainedUserText(user("study era two", 1)), undefined);
  // 子代理的压缩估值上下文同样带 bridge（运行中压缩后单独成条）。
  const compacted = conversationState.applyCompactionCheckpoint(
    conversationState.createConversationStateFromContext({
      messages: [user("x", 1), assistant("y", 2)],
    }),
    checkpointMessage("s", 5),
  );
  assert.ok(isCheckpointBridgeMessage(buildContext(compacted).messages[0]));
});
