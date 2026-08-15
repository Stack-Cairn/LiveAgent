import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const llmModulePath = path.join(rootDir, "src/lib/providers/llm.ts");
const proxyModulePath = "@liveagent/ui/lib/providers/proxy";
const powerActivityModulePath = path.join(rootDir, "src/lib/system/powerActivity.ts");

const streamQueue = [];
const streamSideEffects = [];
const observedStreamContexts = [];
const HOSTED_SEARCH_PROBE_HEADER = "x-liveagent-hosted-search-probe";

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createAssistant(content, stopReason = "stop", extra = {}) {
  return {
    role: "assistant",
    content,
    api: extra.api ?? "openai-responses",
    provider: extra.provider ?? "openai",
    model: extra.model ?? "gpt-5",
    usage: extra.usage ?? createUsage(),
    stopReason,
    errorMessage: extra.errorMessage,
    timestamp: extra.timestamp ?? Date.now(),
  };
}

function createTextAssistant(text, stopReason = "stop", extra = {}) {
  return createAssistant([{ type: "text", text }], stopReason, extra);
}

function createToolUseAssistant(toolCall, extra = {}) {
  return createAssistant([toolCall], "toolUse", extra);
}

function createToolCall(id, name, args = {}) {
  return {
    type: "toolCall",
    id,
    name,
    arguments: args,
  };
}

function createToolResult(toolCall, text = "ok") {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details: { ok: true },
    isError: false,
    timestamp: Date.now(),
  };
}

function createToolEventRecorder() {
  const toolCalls = [];
  const toolExecutionStarts = [];
  const toolResults = [];
  return {
    handlers: {
      onToolCall: (toolCall) => {
        toolCalls.push(toolCall);
      },
      onToolExecutionStart: (toolCall) => {
        toolExecutionStarts.push(toolCall);
      },
      onToolResult: (toolCall) => {
        toolResults.push(toolCall);
      },
    },
    assertSilent() {
      assert.deepEqual(toolCalls.map((call) => call.name), []);
      assert.deepEqual(toolExecutionStarts.map((call) => call.name), []);
      assert.deepEqual(toolResults.map((call) => call.name), []);
    },
  };
}

function createStreamForAssistant(assistant) {
  const events = [
    {
      type: "start",
      partial: {
        ...assistant,
        content: [],
      },
    },
  ];

  const partialContent = [];
  assistant.content.forEach((block, contentIndex) => {
    partialContent[contentIndex] = block;
    const partial = {
      ...assistant,
      content: partialContent.slice(),
    };
    if (block.type === "text") {
      events.push({
        type: "text_delta",
        contentIndex,
        delta: block.text,
        partial,
      });
      events.push({
        type: "text_end",
        contentIndex,
        content: block.text,
        partial,
      });
      return;
    }
    if (block.type === "thinking") {
      events.push({
        type: "thinking_delta",
        contentIndex,
        delta: block.thinking,
        partial,
      });
      return;
    }
    if (block.type === "toolCall") {
      events.push({
        type: "toolcall_start",
        contentIndex,
        partial,
      });
      events.push({
        type: "toolcall_end",
        contentIndex,
        toolCall: block,
        partial,
      });
    }
  });

  events.push({
    type: assistant.stopReason === "error" || assistant.stopReason === "aborted" ? "error" : "done",
    message: assistant,
  });

  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    async result() {
      return assistant;
    },
  };
}

function createQueuedStream(events, finalMessage) {
  return {
    __stream: true,
    stream: {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
        }
      },
      async result() {
        return finalMessage;
      },
    },
  };
}

function createToolCallDeltaStream(finalToolCall, partialToolCalls, extra = {}) {
  const assistant = createAssistant([finalToolCall], "toolUse", extra);
  const startToolCall = partialToolCalls[0] ?? {
    ...finalToolCall,
    arguments: {},
  };
  const events = [
    {
      type: "start",
      partial: {
        ...assistant,
        content: [],
      },
    },
    {
      type: "toolcall_start",
      contentIndex: 0,
      partial: {
        ...assistant,
        content: [startToolCall],
      },
    },
    ...partialToolCalls.map((toolCall) => ({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: JSON.stringify(toolCall.arguments ?? {}),
      partial: {
        ...assistant,
        content: [toolCall],
      },
    })),
    {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: finalToolCall,
      partial: {
        ...assistant,
        content: [finalToolCall],
      },
    },
    {
      type: "done",
      reason: "toolUse",
      message: assistant,
    },
  ];

  return createQueuedStream(events, assistant);
}

const llmMock = {
  buildProviderRequestMetadata(_providerId, sessionId) {
    return sessionId ? { sessionId } : undefined;
  },
  buildAnthropicAuthHeaders(apiKey) {
    return {
      "x-api-key": apiKey,
    };
  },
  buildOpenAIAuthHeaders(apiKey) {
    return {
      Authorization: `Bearer ${apiKey}`,
    };
  },
  async prepareProviderRequest(_providerId, runtime) {
    return {
      baseUrl: runtime.baseUrl.trim(),
      headers: { Authorization: `Bearer ${runtime.apiKey}`, "x-liveagent-test": "1" },
    };
  },
  createModelFromConfig(providerId, modelId, baseUrl) {
    const api = providerId === "claude_code" ? "anthropic-messages" : "openai-responses";
    return {
      id: modelId,
      name: modelId,
      api,
      provider: providerId === "codex" ? "openai" : "anthropic",
      baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    };
  },
  finalizeProviderStreamOptions({ options }) {
    return options;
  },
  normalizeErrorMessage(value, fallback = "Request failed") {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  },
  resolveProviderCacheRetention(_providerId, _enabled, override) {
    return override ?? "none";
  },
  describeAnthropicCacheShape(providerId, baseUrl, cacheRetention) {
    // 与真实实现同构的最小桩:只有 claude_code + 非 none 才谈得上断点策略,
    // 官方域名走顶层自动断点,其余(代理)退回显式断点。
    if (providerId !== "claude_code" || !cacheRetention || cacheRetention === "none") {
      return { cacheRetention: cacheRetention ?? "", breakpointStrategy: "none" };
    }
    const official = baseUrl.trim().toLowerCase().includes("api.anthropic.com");
    return {
      cacheRetention,
      ttl: cacheRetention === "long" && official ? "1h" : "",
      breakpointStrategy: official ? "anthropic-top-level" : "anthropic-explicit",
    };
  },
  describeCodexCacheShape(providerId, baseUrl, configuredMode, modelApi, sessionId, cacheRetention) {
    // 与真实实现同构的最小桩:codex 之外恒 none;codex 按「显式配置 → responses
    // API → 官方域名」解析 hint 模式,sessionId 截断到 64 字符作 cacheKey。
    if (providerId !== "codex" || cacheRetention === "none") {
      return { cacheRetention: cacheRetention ?? "", breakpointStrategy: "none" };
    }
    const mode =
      configuredMode && configuredMode !== "auto"
        ? configuredMode
        : modelApi === "openai-responses" || baseUrl.toLowerCase().includes("api.openai.com")
          ? "openai-key"
          : "none";
    return {
      cacheRetention: cacheRetention ?? "",
      breakpointStrategy: mode === "none" ? "none" : `codex-${mode}`,
      cacheKey: mode === "openai-key" && sessionId ? String(sessionId).slice(0, 64) : "",
    };
  },
  describeProviderCacheShape(params) {
    // 与真实实现同构的最小桩:providers 层统一分发,codex 走 codex 描述,
    // 其余走 anthropic 描述。runner 侧只面对这一个入口。
    if (params.providerId === "codex") {
      return llmMock.describeCodexCacheShape(
        params.providerId,
        params.baseUrl,
        params.promptCacheHintMode,
        params.modelApi === "openai-responses" || params.modelApi === "openai-completions"
          ? params.modelApi
          : undefined,
        params.sessionId,
        params.cacheRetention,
      );
    }
    return llmMock.describeAnthropicCacheShape(
      params.providerId,
      params.baseUrl,
      params.cacheRetention,
    );
  },
  toSimpleStreamReasoning(value) {
    return value && value !== "off" ? value : undefined;
  },
  createStreamingTextReconciler() {
    const emittedTextByKey = new Map();
    return {
      appendDelta(key, delta) {
        if (!delta) return "";
        emittedTextByKey.set(key, `${emittedTextByKey.get(key) ?? ""}${delta}`);
        return delta;
      },
      reconcileFinalText(key, finalText) {
        const previous = emittedTextByKey.get(key) ?? "";
        emittedTextByKey.set(key, finalText);
        if (!previous) return finalText;
        return finalText.startsWith(previous) ? finalText.slice(previous.length) : "";
      },
    };
  },
  streamSimpleByApi(_model, context, options) {
    observedStreamContexts.push(context);
    const queued = streamQueue.shift();
    if (!queued) {
      throw new Error("No fake stream response queued");
    }
    const beforeStream = streamSideEffects.shift()?.(options);
    const stream = queued.__stream ? queued.stream : createStreamForAssistant(queued);
    return {
      async *[Symbol.asyncIterator]() {
        await beforeStream;
        yield* stream;
      },
      async result() {
        await beforeStream;
        return stream.result();
      },
    };
  },
};

const loader = createTsModuleLoader({
  mocks: {
    [llmModulePath]: llmMock,
    [proxyModulePath]: {
      async prepareProxyRequest(_providerId, baseUrl) {
        return { baseUrl, headers: { "x-liveagent-test": "1" } };
      },
    },
    [powerActivityModulePath]: {
      async withPowerActivity(_scope, _reason, run) {
        return run();
      },
    },
  },
});

const { runAssistantWithTools } = loader.loadModule("src/lib/chat/runner/agentRunner.ts");
const { createSubagentScheduler } = loader.loadModule("src/lib/subagents/scheduler.ts");

function resetFakeStreams(...assistants) {
  streamQueue.length = 0;
  streamQueue.push(...assistants);
  streamSideEffects.length = 0;
  observedStreamContexts.length = 0;
}

function queueStreamSideEffect(sideEffect) {
  streamSideEffects.push(sideEffect);
}

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function delayedSseResponse(event) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(encoder.encode(sse(event)));
          controller.close();
        }, 5);
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

function createBaseParams(overrides = {}) {
  const executedToolCalls = [];
  const textDeltas = [];
  return {
    params: {
      providerId: "codex",
      model: "gpt-5",
      runtime: {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        reasoning: "medium",
      },
      context: {
        systemPrompt: "Base system prompt",
        messages: [{ role: "user", content: "Start", timestamp: 1 }],
        tools: [
          {
            name: "Read",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      workdir: "/tmp/liveagent-test",
      sessionId: "session-1",
      tools: [
        {
          name: "Read",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        },
      ],
      async executeToolCall(toolCall) {
        executedToolCalls.push(toolCall);
        return createToolResult(toolCall, `result:${toolCall.name}`);
      },
      onTextDelta(delta) {
        textDeltas.push(delta);
      },
      ...overrides,
    },
    executedToolCalls,
    textDeltas,
  };
}

test("runAssistantWithTools returns terminal stop messages without scheduling a next-turn override", async () => {
  resetFakeStreams(createTextAssistant("done"));
  let beforeNextTurnCalls = 0;
  const { params, textDeltas } = createBaseParams({
    onBeforeNextTurn: async () => {
      beforeNextTurnCalls += 1;
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(beforeNextTurnCalls, 0);
  assert.equal(textDeltas.join(""), "done");
  assert.equal(result.assistant.stopReason, "stop");
  assert.equal(result.emittedMessages.length, 1);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[1].role, "assistant");
});

test("runAssistantWithTools sends tracked deletion rules with a non-empty base prompt", async () => {
  resetFakeStreams(createTextAssistant("done"));
  const tools = [
    {
      name: "Delete",
      description: "Delete a path",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "Bash",
      description: "Run a command",
      parameters: { type: "object", properties: {} },
    },
  ];
  const { params } = createBaseParams({
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Delete tmp.txt", timestamp: 1 }],
      tools,
    },
    tools,
  });

  await runAssistantWithTools(params);

  assert.equal(observedStreamContexts.length, 1);
  const deliveredPrompt = observedStreamContexts[0].systemPrompt;
  assert.match(deliveredPrompt, /^Base system prompt\n\n# Tool-Execution Mode/);
  assert.match(deliveredPrompt, /Every intentional deletion[\s\S]*MUST use Delete/);
  assert.match(deliveredPrompt, /record the path in Edited Files and the file ledger/);
  assert.equal(deliveredPrompt.match(/# Tool-Execution Mode/g)?.length, 1);
});

test("runAssistantWithTools waits for delayed hosted search probe finalization", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  const hostedSearchEvents = [];

  globalThis.fetch = async (_input, init) => {
    fetchCalled = true;
    const probeHeader = new Headers(init?.headers).get(HOSTED_SEARCH_PROBE_HEADER);
    assert.equal(probeHeader?.startsWith("hosted-search-codex-"), true);
    return delayedSseResponse({
      type: "response.output_item.added",
      item: {
        type: "web_search_call",
        id: "search-delayed",
        status: "in_progress",
        action: { query: "delayed hosted search" },
      },
    });
  };

  try {
    resetFakeStreams(createTextAssistant("answer"));
    queueStreamSideEffect((options) =>
      fetch("http://127.0.0.1:18080/proxy/codex/v1/responses", {
        method: "POST",
        headers: options?.headers,
        body: JSON.stringify({ prompt_cache_key: "session-1" }),
      }),
    );
    const { params } = createBaseParams({
      nativeWebSearch: true,
      onHostedSearch: (hostedSearch) => hostedSearchEvents.push(hostedSearch),
    });

    const result = await runAssistantWithTools(params);
    const finalHostedSearch = hostedSearchEvents[hostedSearchEvents.length - 1];
    const assistantHostedSearches = result.assistant.content.filter(
      (block) => block?.type === "hostedSearch",
    );

    assert.equal(fetchCalled, true);
    assert.equal(finalHostedSearch?.id, "search-delayed");
    assert.equal(finalHostedSearch?.status, "completed");
    assert.deepEqual(finalHostedSearch?.queries, ["delayed hosted search"]);
    assert.equal(assistantHostedSearches.length, 1);
    assert.equal(assistantHostedSearches[0].status, "completed");
  } finally {
    await Promise.resolve();
    globalThis.fetch = originalFetch;
  }
});

test("runAssistantWithTools calls onBeforeNextTurn only for toolUse turns with tool results", async () => {
  const toolCall = {
    type: "toolCall",
    id: "call-read",
    name: "Read",
    arguments: { path: "src/App.tsx" },
  };
  resetFakeStreams(
    createToolUseAssistant(toolCall),
    createTextAssistant("final answer"),
  );
  const beforeNextTurnSnapshots = [];
  const { params, executedToolCalls, textDeltas } = createBaseParams({
    onBeforeNextTurn: async (snapshot) => {
      beforeNextTurnSnapshots.push(snapshot);
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].id, toolCall.id);
  assert.equal(beforeNextTurnSnapshots.length, 1);
  assert.equal(beforeNextTurnSnapshots[0].assistant.stopReason, "toolUse");
  assert.equal(beforeNextTurnSnapshots[0].toolResults.length, 1);
  assert.deepEqual(
    beforeNextTurnSnapshots[0].emittedMessages.map((message) => message.role),
    ["assistant", "toolResult"],
  );
  assert.equal(textDeltas.join(""), "final answer");
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools announces execution start before invoking the tool executor", async () => {
  const askToolCall = createToolCall("call-ask-order", "AskUserQuestion", {
    questions: [
      {
        id: "choice",
        prompt: "Choose one",
        options: [{ label: "First" }, { label: "Second" }],
      },
    ],
  });
  const askTool = {
    name: "AskUserQuestion",
    description: "Ask the user",
    parameters: { type: "object", properties: {} },
  };
  const sequence = [];
  resetFakeStreams(createToolUseAssistant(askToolCall), createTextAssistant("done"));
  const { params } = createBaseParams({
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [askTool],
    },
    tools: [askTool],
    onToolCall() {
      sequence.push("tool_call");
    },
    onToolExecutionStart() {
      sequence.push("execution_start");
    },
    async executeToolCall(toolCall) {
      sequence.push("execute");
      return createToolResult(toolCall);
    },
  });

  await runAssistantWithTools(params);

  const executionStartIndex = sequence.indexOf("execution_start");
  const executeIndex = sequence.indexOf("execute");
  assert.ok(sequence.includes("tool_call"));
  assert.ok(executionStartIndex >= 0);
  assert.ok(executeIndex > executionStartIndex);
});

test("AskUserQuestion is pending before the next user-event task after execution start", async () => {
  const askTools = loader.loadModule("src/lib/tools/askUserQuestionTools.ts");
  const bundle = askTools.createAskUserQuestionTools({
    conversationId: "conversation-runner",
    timeoutMs: 200,
  });
  const askTool = bundle.tools.find((tool) => tool.name === "AskUserQuestion");
  assert.ok(askTool);
  const askToolCall = createToolCall("call-ask-next-task", "AskUserQuestion", {
    questions: [
      {
        id: "choice",
        prompt: "Choose one",
        options: [{ label: "First", recommended: true }, { label: "Second" }],
      },
    ],
  });
  resetFakeStreams(createToolUseAssistant(askToolCall), createTextAssistant("done"));

  let resolveAnswerAttempt;
  const answerAttempt = new Promise((resolve) => {
    resolveAnswerAttempt = resolve;
  });
  const { params } = createBaseParams({
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [askTool],
    },
    tools: [askTool],
    executeToolCall: bundle.executeToolCall,
    onToolExecutionStart() {
      // DOM clicks and Gateway deliveries cannot run inside this synchronous callback;
      // the earliest real user event is the next task, after the runner has entered
      // executeToolCall and synchronously populated pendingByToolCallId.
      setImmediate(() => {
        resolveAnswerAttempt(
          askTools.answerAskUserQuestion("call-ask-next-task", [
            { questionId: "choice", selectedLabel: "Second" },
          ]),
        );
      });
    },
  });

  const result = await runAssistantWithTools(params);
  assert.deepEqual(await answerAttempt, { ok: true });
  const toolResult = result.emittedMessages.find(
    (message) => message.role === "toolResult" && message.toolCallId === askToolCall.id,
  );
  assert.ok(toolResult);
  assert.equal(toolResult.details.answers[0].selectedLabel, "Second");
  assert.equal("timedOut" in toolResult.details, false);
});

// Mocked turn tests (agent-turn-cancelled-history.test.mjs) replay this payload
// shape by hand; the assertions here are what keep those replicas honest.
test("runAssistantWithTools reports 1-based monotonic rounds and paired tool results to onBeforeNextTurn", async () => {
  const firstToolCall = createToolCall("call-read-1", "Read", { path: "a.ts" });
  const secondToolCall = createToolCall("call-read-2", "Read", { path: "b.ts" });
  resetFakeStreams(
    createToolUseAssistant(firstToolCall),
    createToolUseAssistant(secondToolCall),
    createTextAssistant("final answer"),
  );
  const beforeNextTurnSnapshots = [];
  const { params } = createBaseParams({
    onBeforeNextTurn: async (snapshot) => {
      beforeNextTurnSnapshots.push(snapshot);
      return null;
    },
  });

  await runAssistantWithTools(params);

  assert.deepEqual(
    beforeNextTurnSnapshots.map((snapshot) => snapshot.round),
    [1, 2],
  );
  assert.deepEqual(
    beforeNextTurnSnapshots.map((snapshot) =>
      snapshot.assistant.content
        .filter((block) => block.type === "toolCall")
        .map((block) => block.id),
    ),
    [[firstToolCall.id], [secondToolCall.id]],
  );
  assert.deepEqual(
    beforeNextTurnSnapshots.map((snapshot) =>
      snapshot.toolResults.map((toolResult) => toolResult.toolCallId),
    ),
    [[firstToolCall.id], [secondToolCall.id]],
  );
});

test("runAssistantWithTools canonicalizes builtin tool call name casing before execution", async () => {
  const lowerCaseWriteCall = createToolCall("call-write", "write", {
    path: "report.html",
    content: "<html></html>",
  });
  const writeTool = {
    name: "Write",
    description: "Write a file",
    parameters: { type: "object", properties: {} },
  };
  resetFakeStreams(createToolUseAssistant(lowerCaseWriteCall), createTextAssistant("done"));
  const toolEvents = createToolEventRecorder();
  const { params, executedToolCalls } = createBaseParams({
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [writeTool],
    },
    tools: [writeTool],
    ...toolEvents.handlers,
  });

  const result = await runAssistantWithTools(params);

  assert.deepEqual(
    observedStreamContexts[0].tools.map((tool) => tool.name),
    ["Write"],
  );
  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].id, lowerCaseWriteCall.id);
  assert.equal(executedToolCalls[0].name, "Write");
  assert.equal(result.emittedMessages[0].role, "assistant");
  assert.equal(result.emittedMessages[0].content.at(-1).name, "Write");
  assert.equal(result.emittedMessages[1].role, "toolResult");
  assert.equal(result.emittedMessages[1].toolName, "Write");
  assert.equal(result.emittedMessages[1].isError, false);
});

test("runAssistantWithTools runs consecutive Agent tool calls in parallel", async () => {
  const agentA = {
    type: "toolCall",
    id: "call-agent-a",
    name: "Agent",
    arguments: { id: "a", prompt: "Ask A" },
  };
  const agentB = {
    type: "toolCall",
    id: "call-agent-b",
    name: "Agent",
    arguments: { id: "b", prompt: "Ask B" },
  };
  resetFakeStreams(
    createAssistant([agentA, agentB], "toolUse"),
    createTextAssistant("final answer"),
  );
  let active = 0;
  let maxActive = 0;
  const statuses = [];
  const { params, executedToolCalls } = createBaseParams({
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [
        {
          name: "Agent",
          description: "Delegate",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    tools: [
      {
        name: "Agent",
        description: "Delegate",
        parameters: { type: "object", properties: {} },
      },
    ],
    async executeToolCall(toolCall) {
      executedToolCalls.push(toolCall);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return createToolResult(toolCall, `result:${toolCall.id}`);
    },
    onToolStatus(status) {
      if (status) statuses.push(status);
    },
    onBeforeNextTurn: async () => null,
  });

  const result = await runAssistantWithTools(params);

  assert.equal(maxActive, 2);
  assert.deepEqual(
    executedToolCalls.map((call) => call.id).sort(),
    ["call-agent-a", "call-agent-b"],
  );
  assert.ok(statuses.some((status) => /并行执行 2 个 Agent 调用/.test(status)));
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools canonicalizes lowercase Agent calls before parallel grouping", async () => {
  const agentA = createToolCall("call-agent-lower-a", "agent", {
    id: "a",
    prompt: "Ask A",
  });
  const agentB = createToolCall("call-agent-lower-b", "agent", {
    id: "b",
    prompt: "Ask B",
  });
  resetFakeStreams(
    createAssistant([agentA, agentB], "toolUse"),
    createTextAssistant("final answer"),
  );
  let active = 0;
  let maxActive = 0;
  const statuses = [];
  const agentTool = {
    name: "Agent",
    description: "Delegate",
    parameters: { type: "object", properties: {} },
  };
  const { params, executedToolCalls } = createBaseParams({
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [agentTool],
    },
    tools: [agentTool],
    async executeToolCall(toolCall) {
      executedToolCalls.push(toolCall);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return createToolResult(toolCall, `result:${toolCall.id}`);
    },
    onToolStatus(status) {
      if (status) statuses.push(status);
    },
    onBeforeNextTurn: async () => null,
  });

  const result = await runAssistantWithTools(params);

  assert.equal(maxActive, 2);
  assert.deepEqual(
    executedToolCalls.map((call) => call.name),
    ["Agent", "Agent"],
  );
  assert.ok(statuses.some((status) => /并行执行 2 个 Agent 调用/.test(status)));
  assert.deepEqual(
    result.emittedMessages[0].content.map((block) => block.name),
    ["Agent", "Agent"],
  );
});

test("runAssistantWithTools propagates one SubagentScheduler across parallel Agent calls", async () => {
  const agentA = {
    type: "toolCall",
    id: "call-agent-a",
    name: "Agent",
    arguments: { agent_spec: "a1/a2/a3" },
  };
  const agentB = {
    type: "toolCall",
    id: "call-agent-b",
    name: "Agent",
    arguments: { agent_spec: "b1/b2/b3" },
  };
  resetFakeStreams(
    createAssistant([agentA, agentB], "toolUse"),
    createTextAssistant("final answer"),
  );

  const subagentScheduler = createSubagentScheduler({
    maxParallelSubagents: 2,
  });
  let activeSubagents = 0;
  let maxActiveSubagents = 0;
  const { params, executedToolCalls } = createBaseParams({
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [
        {
          name: "Agent",
          description: "Delegate",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    tools: [
      {
        name: "Agent",
        description: "Delegate",
        parameters: { type: "object", properties: {} },
      },
    ],
    subagentScheduler,
    async executeToolCall(toolCall, signal, context) {
      executedToolCalls.push(toolCall);
      assert.ok(context?.subagentScheduler);
      await Promise.all(
        [0, 1, 2].map((index) =>
          context.subagentScheduler.runSubagent(async () => {
            activeSubagents += 1;
            maxActiveSubagents = Math.max(maxActiveSubagents, activeSubagents);
            await new Promise((resolve) => setTimeout(resolve, 25 + index));
            activeSubagents -= 1;
          }, signal),
        ),
      );
      return createToolResult(toolCall, `result:${toolCall.id}`);
    },
    onBeforeNextTurn: async () => null,
  });

  const result = await runAssistantWithTools(params);

  assert.equal(maxActiveSubagents, 2);
  assert.deepEqual(
    executedToolCalls.map((call) => call.id).sort(),
    ["call-agent-a", "call-agent-b"],
  );
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools keeps consecutive Bash calls sequential", async () => {
  const bashA = {
    type: "toolCall",
    id: "call-bash-a",
    name: "Bash",
    arguments: { command: "echo a" },
  };
  const bashB = {
    type: "toolCall",
    id: "call-bash-b",
    name: "Bash",
    arguments: { command: "echo b" },
  };
  const bashC = {
    type: "toolCall",
    id: "call-bash-c",
    name: "Bash",
    arguments: { command: "echo c" },
  };
  resetFakeStreams(
    createAssistant([bashA, bashB, bashC], "toolUse"),
    createTextAssistant("final answer"),
  );

  let activeBash = 0;
  let maxActiveBash = 0;
  const statuses = [];
  const { params, executedToolCalls } = createBaseParams({
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [
        {
          name: "Bash",
          description: "Run shell",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    tools: [
      {
        name: "Bash",
        description: "Run shell",
        parameters: { type: "object", properties: {} },
      },
    ],
    subagentScheduler: createSubagentScheduler({
      maxParallelBash: 3,
    }),
    async executeToolCall(toolCall) {
      executedToolCalls.push(toolCall);
      activeBash += 1;
      maxActiveBash = Math.max(maxActiveBash, activeBash);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeBash -= 1;
      return createToolResult(toolCall, `result:${toolCall.id}`);
    },
    onToolStatus(status) {
      if (status) statuses.push(status);
    },
    onBeforeNextTurn: async () => null,
  });

  await runAssistantWithTools(params);

  assert.equal(maxActiveBash, 1);
  assert.deepEqual(
    executedToolCalls.map((call) => call.id),
    ["call-bash-a", "call-bash-b", "call-bash-c"],
  );
  assert.equal(statuses.some((status) => /并行执行 3 个 Bash 命令/.test(status)), false);
});

test("runAssistantWithTools applies turn context overrides without duplicating compacted messages", async () => {
  const toolCall = {
    type: "toolCall",
    id: "call-read",
    name: "Read",
    arguments: { path: "src/App.tsx" },
  };
  resetFakeStreams(
    createToolUseAssistant(toolCall),
    createTextAssistant("after compaction"),
  );
  const compactedContext = {
    systemPrompt: "Compacted system prompt",
    messages: [{ role: "user", content: "Resume from checkpoint", timestamp: 10 }],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
    ],
  };
  const runtimePrompts = [];
  const { params } = createBaseParams({
    onBeforeNextTurn: async (snapshot) => {
      runtimePrompts.push(snapshot.runtimeContext.systemPrompt);
      return {
        context: compactedContext,
        emittedMessages: [],
      };
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(observedStreamContexts.length, 2);
  assert.deepEqual(runtimePrompts, ["Base system prompt"]);
  assert.match(
    observedStreamContexts[1].systemPrompt,
    /^Compacted system prompt\n\n# Tool-Execution Mode/,
  );
  assert.equal(
    observedStreamContexts[1].systemPrompt.match(/# Tool-Execution Mode/g)?.length,
    1,
  );
  assert.deepEqual(
    observedStreamContexts[1].messages.map((message) => message.content),
    ["Resume from checkpoint"],
  );
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant"],
  );
  assert.deepEqual(
    result.messages.map((message) => message.role),
    ["user", "assistant"],
  );
});

test("runAssistantWithTools delivers wireTailText only on the wire, never into agent state", async () => {
  const firstToolCall = createToolCall("call-read-1", "Read", { path: "a.ts" });
  const secondToolCall = createToolCall("call-read-2", "Read", { path: "b.ts" });
  resetFakeStreams(
    createToolUseAssistant(firstToolCall),
    createToolUseAssistant(secondToolCall),
    createTextAssistant("all done"),
  );
  const tailTexts = ["BUS DELTA ROUND 1", "BUS DELTA ROUND 2"];
  let round = 0;
  const { params } = createBaseParams({
    onBeforeNextTurn: async (snapshot) => {
      round += 1;
      return {
        context: snapshot.runtimeContext,
        emittedMessages: snapshot.emittedMessages,
        wireTailText: tailTexts[round - 1],
      };
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(observedStreamContexts.length, 3);
  // 第 1 次请求在任何 override 之前，不含尾部文本。
  assert.equal(JSON.stringify(observedStreamContexts[0].messages).includes("BUS DELTA"), false);

  // 第 2 次请求：尾部文本挂在最后一个工具结果上，且只存在于出站请求。
  const secondWire = observedStreamContexts[1].messages;
  const secondTail = secondWire[secondWire.length - 1];
  assert.equal(secondTail.role, "toolResult");
  assert.deepEqual(
    secondTail.content.map((block) => block.text),
    ["result:Read", "BUS DELTA ROUND 1"],
  );

  // 第 3 次请求：累积重挂——两轮尾部文本按到达顺序拼在同一个块里。
  const thirdWire = observedStreamContexts[2].messages;
  const thirdTail = thirdWire[thirdWire.length - 1];
  assert.equal(thirdTail.role, "toolResult");
  assert.deepEqual(
    thirdTail.content.map((block) => block.text),
    ["result:Read", "BUS DELTA ROUND 1\n\nBUS DELTA ROUND 2"],
  );

  // agent 状态与产出（持久化 / UI / 记忆抽取的输入）不得含尾部文本。
  assert.equal(JSON.stringify(result.messages).includes("BUS DELTA"), false);
  assert.equal(JSON.stringify(result.emittedMessages).includes("BUS DELTA"), false);
});

test("runAssistantWithTools clears accumulated wireTailText when an override omits it", async () => {
  const firstToolCall = createToolCall("call-read-1", "Read", { path: "a.ts" });
  const secondToolCall = createToolCall("call-read-2", "Read", { path: "b.ts" });
  resetFakeStreams(
    createToolUseAssistant(firstToolCall),
    createToolUseAssistant(secondToolCall),
    createTextAssistant("all done"),
  );
  let round = 0;
  const { params } = createBaseParams({
    onBeforeNextTurn: async (snapshot) => {
      round += 1;
      if (round === 1) {
        return {
          context: snapshot.runtimeContext,
          emittedMessages: snapshot.emittedMessages,
          wireTailText: "STALE TAIL",
        };
      }
      // 压缩/重冻结分支不带 wireTailText：旧尾部内容已并入重算后的快照，
      // runner 必须清空累积，否则会重复投递。
      return {
        context: snapshot.runtimeContext,
        emittedMessages: snapshot.emittedMessages,
      };
    },
  });

  await runAssistantWithTools(params);

  assert.equal(observedStreamContexts.length, 3);
  assert.equal(JSON.stringify(observedStreamContexts[1].messages).includes("STALE TAIL"), true);
  assert.equal(
    JSON.stringify(observedStreamContexts[2].messages).includes("STALE TAIL"),
    false,
    "不带 wireTailText 的 override 之后，累积的尾部文本不得再出现在出站请求里",
  );
});

test("runAssistantWithTools preserves seed tool-call recovery as a next-turn path", async () => {
  resetFakeStreams(
    createTextAssistant(`Before
<seed:tool_call>
  <function name="Read">
    <parameter name="path">src/App.tsx</parameter>
  </function>
</seed:tool_call>
After`),
    createTextAssistant("after recovered tool"),
  );
  const beforeNextTurnSnapshots = [];
  const { params, executedToolCalls } = createBaseParams({
    onBeforeNextTurn: async (snapshot) => {
      beforeNextTurnSnapshots.push(snapshot);
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].name, "Read");
  assert.deepEqual(executedToolCalls[0].arguments, { path: "src/App.tsx" });
  assert.equal(beforeNextTurnSnapshots.length, 1);
  assert.equal(beforeNextTurnSnapshots[0].assistant.stopReason, "toolUse");
  assert.equal(beforeNextTurnSnapshots[0].toolResults.length, 1);
  assert.deepEqual(
    beforeNextTurnSnapshots[0].emittedMessages.map((message) => message.role),
    ["assistant", "toolResult"],
  );
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools recovers flattened DeepSeek tool request text as a next-turn path", async () => {
  resetFakeStreams(
    createTextAssistant(
      `Checking before execution.

Historical assistant tool request (read-only context; do not repeat):
tool_call_id: call_00_flattened_read
tool_name: Read
arguments:
{
  "path": "src/App.tsx"
}

This text should not be shown as a raw tool request.`,
      "stop",
      { api: "anthropic-messages", provider: "anthropic", model: "deepseek-chat" },
    ),
    createTextAssistant("after recovered flattened tool"),
  );
  const beforeNextTurnSnapshots = [];
  const { params, executedToolCalls } = createBaseParams({
    onBeforeNextTurn: async (snapshot) => {
      beforeNextTurnSnapshots.push(snapshot);
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].id, "call_00_flattened_read");
  assert.equal(executedToolCalls[0].name, "Read");
  assert.deepEqual(executedToolCalls[0].arguments, { path: "src/App.tsx" });
  assert.equal(beforeNextTurnSnapshots.length, 1);
  assert.equal(beforeNextTurnSnapshots[0].assistant.stopReason, "toolUse");
  assert.equal(beforeNextTurnSnapshots[0].toolResults.length, 1);
  const recoveredAssistantText = result.emittedMessages[0].content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.equal(recoveredAssistantText.includes("tool_call_id"), false);
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools strips repeated historical tool call text without duplicate execution", async () => {
  const grepCall = createToolCall("call_00_native_grep", "Grep", {
    pattern: "express",
    file_pattern: "**/*.js",
    ignore_case: true,
  });
  resetFakeStreams(
    createAssistant(
      [
        {
          type: "text",
          text: `✅ JS 文件 2 个：server.js + public/app.js

## 4️⃣ Grep 文本搜索

Historical tool call (read-only, not repeating):
tool_name: Grep
arguments: {"pattern": "express", "file_pattern": "**/*.js", "ignore_case": true}`,
        },
        grepCall,
      ],
      "toolUse",
      { api: "anthropic-messages", provider: "anthropic", model: "deepseek-chat" },
    ),
    createTextAssistant("after native grep"),
  );
  const beforeNextTurnSnapshots = [];
  const grepTool = {
    name: "Grep",
    description: "Search files",
    parameters: { type: "object", properties: {} },
  };
  const { params, executedToolCalls } = createBaseParams({
    tools: [grepTool],
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [grepTool],
    },
    onBeforeNextTurn: async (snapshot) => {
      beforeNextTurnSnapshots.push(snapshot);
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].id, grepCall.id);
  assert.equal(executedToolCalls[0].name, "Grep");
  assert.equal(beforeNextTurnSnapshots.length, 1);
  const recoveredAssistantText = result.emittedMessages[0].content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.equal(recoveredAssistantText.includes("Historical tool call"), false);
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools dedupes recovered lowercase tool text against canonical structured calls", async () => {
  const writeCall = createToolCall("call_00_native_write", "Write", {
    path: "report.html",
    content: "<html></html>",
  });
  resetFakeStreams(
    createAssistant(
      [
        {
          type: "text",
          text: `Generated the report.

Historical tool call (read-only, not repeating):
tool_name: write
arguments: {"path": "report.html", "content": "<html></html>"}`,
        },
        writeCall,
      ],
      "toolUse",
      { api: "anthropic-messages", provider: "anthropic", model: "deepseek-chat" },
    ),
    createTextAssistant("after native write"),
  );
  const writeTool = {
    name: "Write",
    description: "Write files",
    parameters: { type: "object", properties: {} },
  };
  const { params, executedToolCalls } = createBaseParams({
    tools: [writeTool],
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [writeTool],
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].id, writeCall.id);
  assert.equal(executedToolCalls[0].name, "Write");
  const assistantToolCalls = result.emittedMessages[0].content.filter(
    (block) => block.type === "toolCall",
  );
  assert.deepEqual(
    assistantToolCalls.map((toolCall) => toolCall.id),
    [writeCall.id],
  );
});

test("runAssistantWithTools emits streaming tool call argument deltas before final execution", async () => {
  const finalWriteCall = createToolCall("call_00_streaming_write", "Write", {
    path: "report.html",
    content: "<html>\n<body>Done</body>\n</html>",
  });
  resetFakeStreams(
    createToolCallDeltaStream(finalWriteCall, [
      createToolCall(finalWriteCall.id, "Write", {}),
      createToolCall(finalWriteCall.id, "Write", { path: "report.html" }),
      createToolCall(finalWriteCall.id, "Write", {
        path: "report.html",
        content: "<html>\n<body>",
      }),
    ]),
    createTextAssistant("after streaming write"),
  );
  const writeTool = {
    name: "Write",
    description: "Write files",
    parameters: { type: "object", properties: {} },
  };
  const deltas = [];
  const { params, executedToolCalls } = createBaseParams({
    tools: [writeTool],
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [writeTool],
    },
    onToolCallDelta: (toolCall) => {
      deltas.push({
        id: toolCall.id,
        name: toolCall.name,
        arguments: { ...(toolCall.arguments ?? {}) },
      });
    },
  });

  const result = await runAssistantWithTools(params);

  assert.deepEqual(
    deltas.map((delta) => delta.arguments),
    [{}, { path: "report.html" }, { path: "report.html", content: "<html>\n<body>" }],
  );
  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].id, finalWriteCall.id);
  assert.deepEqual(executedToolCalls[0].arguments, finalWriteCall.arguments);
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

function createRawFragmentToolCallStream(finalToolCall, fragments, options = {}) {
  const assistant = createAssistant([finalToolCall], "toolUse", options.extra ?? {});
  const partialFor = (bufferedArguments) => ({
    ...assistant,
    content: [{ ...finalToolCall, arguments: bufferedArguments }],
  });
  const events = [
    { type: "start", partial: { ...assistant, content: [] } },
    { type: "toolcall_start", contentIndex: 0, partial: partialFor({}) },
    ...fragments.map((fragment) => ({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: fragment,
      partial: partialFor(finalToolCall.arguments),
    })),
    ...(options.omitToolCallEnd
      ? []
      : [
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: finalToolCall,
            partial: { ...assistant, content: [finalToolCall] },
          },
        ]),
    { type: "done", reason: "toolUse", message: assistant },
  ];
  return createQueuedStream(events, assistant);
}

test("runAssistantWithTools executes a content-first streaming Write untouched (009 regression)", async () => {
  // The historical bug: a mid-stream preflight aborted the model while the
  // path argument was still streaming, freezing "test2" as the final path.
  const completeArguments = {
    content: "# New File via Workspace-Relative Path\nCreated at test2/new-write-test.md\n",
    path: "test2/new-write-test.md",
  };
  const finalWriteCall = createToolCall("call_00_content_first_write", "Write", completeArguments);
  const rawJson = JSON.stringify(completeArguments);
  const cut = rawJson.indexOf("test2") + "test2".length;
  resetFakeStreams(
    createRawFragmentToolCallStream(finalWriteCall, [rawJson.slice(0, cut), rawJson.slice(cut)]),
    createTextAssistant("after content-first write"),
  );
  const writeTool = {
    name: "Write",
    description: "Write files",
    parameters: { type: "object", properties: {} },
  };
  const toolResults = [];
  const { params, executedToolCalls } = createBaseParams({
    tools: [writeTool],
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [writeTool],
    },
    onToolResult: (toolCall, toolResult) => {
      toolResults.push({ toolCall, toolResult });
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 1);
  assert.deepEqual(executedToolCalls[0].arguments, completeArguments);
  assert.equal(toolResults.length, 1);
  assert.equal(Boolean(toolResults[0].toolResult.isError), false);
  const assistantToolCall = result.emittedMessages[0].content.find(
    (block) => block.type === "toolCall",
  );
  assert.equal(assistantToolCall.arguments.path, "test2/new-write-test.md");
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools refuses a Write whose argument stream was truncated", async () => {
  // Simulates pi-ai finalizing a half-streamed buffer: the raw fragments stop
  // mid-path and the end-event arguments equal the lenient repair of that
  // same truncated buffer.
  const truncatedBuffer = '{"content": "# Temp File\\n", "path": "test2';
  const truncatedWriteCall = createToolCall("call_00_truncated_write", "Write", {
    content: "# Temp File\n",
    path: "test2",
  });
  resetFakeStreams(
    createRawFragmentToolCallStream(truncatedWriteCall, [
      truncatedBuffer.slice(0, 20),
      truncatedBuffer.slice(20),
    ]),
    createTextAssistant("after truncated write"),
  );
  const writeTool = {
    name: "Write",
    description: "Write files",
    parameters: { type: "object", properties: {} },
  };
  const toolResults = [];
  const { params, executedToolCalls } = createBaseParams({
    tools: [writeTool],
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [writeTool],
    },
    onToolResult: (toolCall, toolResult) => {
      toolResults.push({ toolCall, toolResult });
    },
  });

  await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 0);
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].toolResult.isError, true);
  assert.match(toolResults[0].toolResult.content[0].text, /truncated in transit/);
  assert.match(toolResults[0].toolResult.content[0].text, /re-issue the complete Write call/);
});

test("runAssistantWithTools keeps a truncated Agent call out of its siblings' parallel batch", async () => {
  const agentA = {
    type: "toolCall",
    id: "call-agent-batch-a",
    name: "Agent",
    arguments: { id: "a", prompt: "Ask A" },
  };
  const truncatedBuffer = '{"id": "b", "prompt": "Ask B with a long detailed';
  const agentB = {
    type: "toolCall",
    id: "call-agent-batch-b",
    name: "Agent",
    arguments: { id: "b", prompt: "Ask B with a long detailed" },
  };
  const assistant = createAssistant([agentA, agentB], "toolUse");
  resetFakeStreams(
    createQueuedStream(
      [
        { type: "start", partial: { ...assistant, content: [] } },
        { type: "toolcall_start", contentIndex: 0, partial: assistant },
        {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: JSON.stringify(agentA.arguments),
          partial: assistant,
        },
        { type: "toolcall_end", contentIndex: 0, toolCall: agentA, partial: assistant },
        { type: "toolcall_start", contentIndex: 1, partial: assistant },
        {
          type: "toolcall_delta",
          contentIndex: 1,
          delta: truncatedBuffer.slice(0, 24),
          partial: assistant,
        },
        {
          type: "toolcall_delta",
          contentIndex: 1,
          delta: truncatedBuffer.slice(24),
          partial: assistant,
        },
        { type: "toolcall_end", contentIndex: 1, toolCall: agentB, partial: assistant },
        { type: "done", reason: "toolUse", message: assistant },
      ],
      assistant,
    ),
    createTextAssistant("after batch"),
  );
  const agentTool = {
    name: "Agent",
    description: "Delegate",
    parameters: { type: "object", properties: {} },
  };
  const toolResults = [];
  const { params, executedToolCalls } = createBaseParams({
    tools: [agentTool],
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [agentTool],
    },
    onToolResult: (toolCall, toolResult) => {
      toolResults.push({ toolCall, toolResult });
    },
  });

  await runAssistantWithTools(params);

  // Only the intact call may execute — the truncated sibling must not ride
  // into execution on the batch.
  assert.deepEqual(
    executedToolCalls.map((call) => call.id),
    ["call-agent-batch-a"],
  );
  const refused = toolResults.find((entry) => entry.toolCall.id === "call-agent-batch-b");
  assert.ok(refused);
  assert.equal(refused.toolResult.isError, true);
  assert.match(refused.toolResult.content[0].text, /truncated in transit/);
});

test("runAssistantWithTools rewrites schema-validation errors for truncated calls into the transport teaching", async () => {
  // Truncation cut the stream before `content` started, so the repaired
  // arguments also fail Write's real schema. pi-agent-core validates before
  // beforeToolCall, so the refusal hook never runs — the rewrite pass must
  // still deliver the truthful teaching to the model on the next turn.
  const truncatedBuffer = '{"path": "test2';
  const truncatedWriteCall = createToolCall("call_00_schema_truncated", "Write", {
    path: "test2",
  });
  resetFakeStreams(
    createRawFragmentToolCallStream(truncatedWriteCall, [
      truncatedBuffer.slice(0, 9),
      truncatedBuffer.slice(9),
    ]),
    createTextAssistant("after schema-truncated write"),
  );
  const writeTool = {
    name: "Write",
    description: "Write files",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  };
  const toolResults = [];
  const { params, executedToolCalls } = createBaseParams({
    tools: [writeTool],
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [writeTool],
    },
    onToolResult: (toolCall, toolResult) => {
      toolResults.push({ toolCall, toolResult });
    },
  });

  await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 0);
  // Prove the exercised path: schema validation rejected the call before the
  // beforeToolCall refusal hook could run.
  assert.equal(toolResults.length, 1);
  assert.match(toolResults[0].toolResult.content[0].text, /Validation failed/);
  // The context sent to the model on the follow-up turn must carry the
  // transport teaching, not a schema error blaming the corrupted arguments.
  const followUpContext = observedStreamContexts.at(-1);
  const followUpToolResult = followUpContext.messages.find(
    (message) => message.role === "toolResult" && message.toolCallId === truncatedWriteCall.id,
  );
  assert.ok(followUpToolResult);
  const followUpText = followUpToolResult.content
    .map((block) => (typeof block === "string" ? block : (block.text ?? "")))
    .join("\n");
  assert.match(followUpText, /truncated in transit/);
  assert.doesNotMatch(followUpText, /Validation failed/);
});

test("runAssistantWithTools refuses a tool call salvaged without a toolcall_end", async () => {
  // Simulates the DSML wrapper's recoverable-stream-end salvage: the done
  // message carries a toolCall block whose argument stream never finished.
  const danglingWriteCall = createToolCall("call_00_dangling_write", "Write", {
    path: "/",
    content: "",
  });
  resetFakeStreams(
    createRawFragmentToolCallStream(danglingWriteCall, ['{"path": "/'], {
      omitToolCallEnd: true,
    }),
    createTextAssistant("after dangling write"),
  );
  const writeTool = {
    name: "Write",
    description: "Write files",
    parameters: { type: "object", properties: {} },
  };
  const toolResults = [];
  const { params, executedToolCalls } = createBaseParams({
    tools: [writeTool],
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [writeTool],
    },
    onToolResult: (toolCall, toolResult) => {
      toolResults.push({ toolCall, toolResult });
    },
  });

  await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 0);
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].toolResult.isError, true);
  assert.match(toolResults[0].toolResult.content[0].text, /truncated in transit/);
});

test("runAssistantWithTools strips bare tool_name text without duplicate execution", async () => {
  const grepCall = createToolCall("call_00_native_route_grep", "Grep", {
    pattern: "express|route|api",
    file_pattern: "*.js",
    output_mode: "content",
    ignore_case: true,
  });
  resetFakeStreams(
    createAssistant(
      [
        {
          type: "text",
          text: `继续检查 JS 路由。

tool_name: Grep
arguments:
{
"pattern": "express|route|api",
"file_pattern": "*.js",
"output_mode": "content",
"ignore_case": true
}`,
        },
        grepCall,
      ],
      "toolUse",
      { api: "anthropic-messages", provider: "anthropic", model: "deepseek-chat" },
    ),
    createTextAssistant("after native route grep"),
  );
  const grepTool = {
    name: "Grep",
    description: "Search files",
    parameters: { type: "object", properties: {} },
  };
  const { params, executedToolCalls } = createBaseParams({
    tools: [grepTool],
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [grepTool],
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].id, grepCall.id);
  assert.equal(executedToolCalls[0].name, "Grep");
  const recoveredAssistantText = result.emittedMessages[0].content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.equal(recoveredAssistantText.includes("tool_name: Grep"), false);
  assert.equal(recoveredAssistantText.includes("arguments:"), false);
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools strips malformed historical tool text without guessing execution", async () => {
  const bashCall = createToolCall("call_01_native_bash", "Bash", {
    command: "ls -la tool-test/",
    cwd: ".",
  });
  resetFakeStreams(
    createAssistant(
      [
        {
          type: "text",
          text: `**Edit / Write 正常。** 继续测试 **Bash、MemoryManager 和管道类工具**：

Historical assistant tool request (read-only context; do not repeat):
tool_call_id: call_00_malformed_bash
tool_name: Bash
arguments:
{
  "command": "echo 'Node: $(node --version 2>/dev/null || echo "未安装")'"
}`,
        },
        bashCall,
      ],
      "toolUse",
      { api: "anthropic-messages", provider: "anthropic", model: "deepseek-chat" },
    ),
    createTextAssistant("after native bash"),
  );
  const bashTool = {
    name: "Bash",
    description: "Run shell commands",
    parameters: { type: "object", properties: {} },
  };
  const { params, executedToolCalls } = createBaseParams({
    tools: [bashTool],
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [bashTool],
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].id, bashCall.id);
  assert.equal(executedToolCalls[0].name, "Bash");
  const recoveredAssistantText = result.emittedMessages[0].content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.equal(recoveredAssistantText.includes("Historical assistant tool request"), false);
  assert.equal(recoveredAssistantText.includes("tool_name: Bash"), false);
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools preserves non-DeepSeek bare tool_name text", async () => {
  const grepCall = createToolCall("call_00_native_route_grep", "Grep", {
    pattern: "express|route|api",
    file_pattern: "*.js",
    output_mode: "content",
    ignore_case: true,
  });
  resetFakeStreams(
    createAssistant(
      [
        {
          type: "text",
          text: `继续检查 JS 路由。

tool_name: Grep
arguments:
{
"pattern": "express|route|api",
"file_pattern": "*.js",
"output_mode": "content",
"ignore_case": true
}`,
        },
        grepCall,
      ],
      "toolUse",
      { api: "openai-responses", provider: "openai", model: "gpt-5" },
    ),
    createTextAssistant("after native route grep"),
  );
  const grepTool = {
    name: "Grep",
    description: "Search files",
    parameters: { type: "object", properties: {} },
  };
  const { params, executedToolCalls } = createBaseParams({
    tools: [grepTool],
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [grepTool],
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].id, grepCall.id);
  const assistantText = result.emittedMessages[0].content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.equal(assistantText.includes("tool_name: Grep"), true);
  assert.equal(assistantText.includes("arguments:"), true);
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools recovers DSML text tool calls as a next-turn path", async () => {
  const dsml = "\uFF5C\uFF5CDSML\uFF5C\uFF5C";
  resetFakeStreams(
    createTextAssistant(`Before
<${dsml}tool_calls>
  <${dsml}invoke name="Read">
    <${dsml}parameter name="path" string="true">src/App.tsx</${dsml}parameter>
  </${dsml}invoke>
</${dsml}tool_calls>
After`),
    createTextAssistant("after recovered DSML tool"),
  );
  const beforeNextTurnSnapshots = [];
  const { params, executedToolCalls } = createBaseParams({
    onBeforeNextTurn: async (snapshot) => {
      beforeNextTurnSnapshots.push(snapshot);
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].name, "Read");
  assert.deepEqual(executedToolCalls[0].arguments, { path: "src/App.tsx" });
  assert.equal(beforeNextTurnSnapshots.length, 1);
  assert.equal(beforeNextTurnSnapshots[0].assistant.stopReason, "toolUse");
  assert.equal(beforeNextTurnSnapshots[0].toolResults.length, 1);
  const recoveredAssistantText = result.emittedMessages[0].content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.equal(recoveredAssistantText.includes("DSML"), false);
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools bridges recovered DSML provider web_search without a local executor", async () => {
  const dsml = "\uFF5C\uFF5CDSML\uFF5C\uFF5C";
  resetFakeStreams(
    createTextAssistant(`Searching again
<${dsml}tool_calls>
  <${dsml}invoke name="web_search">
    <${dsml}parameter name="query" string="true">Deno Deploy alternatives temporary domain</${dsml}parameter>
  </${dsml}invoke>
</${dsml}tool_calls>`),
    createTextAssistant("final answer"),
  );
  const beforeNextTurnSnapshots = [];
  const toolEvents = createToolEventRecorder();
  const { params, executedToolCalls } = createBaseParams({
    nativeWebSearch: true,
    ...toolEvents.handlers,
    onBeforeNextTurn: async (snapshot) => {
      beforeNextTurnSnapshots.push(snapshot);
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 0);
  assert.equal(observedStreamContexts[0].tools.some((tool) => tool.name === "web_search"), false);
  toolEvents.assertSilent();
  assert.equal(beforeNextTurnSnapshots.length, 1);
  assert.equal(beforeNextTurnSnapshots[0].toolResults[0].isError, false);
  assert.match(
    beforeNextTurnSnapshots[0].toolResults[0].content[0].text,
    /provider-native web search request/,
  );
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools silently bridges structured DSML web_search tool calls", async () => {
  const webSearchCall = createToolCall("dsml-tool-call-structured-search", "web_search", {
    query: "LiveAgent DeepSeek structured DSML search",
  });
  resetFakeStreams(
    createAssistant(
      [{ type: "text", text: "Searching" }, webSearchCall],
      "toolUse",
      {
        api: "anthropic-messages",
        provider: "anthropic",
        model: "deepseek-chat",
      },
    ),
    createTextAssistant("final answer"),
  );
  const beforeNextTurnSnapshots = [];
  const toolEvents = createToolEventRecorder();
  const { params, executedToolCalls } = createBaseParams({
    providerId: "claude_code",
    model: "deepseek-chat",
    runtime: {
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "test-key",
      requestFormat: "anthropic-messages",
      nativeWebSearchEnabled: true,
    },
    nativeWebSearch: true,
    ...toolEvents.handlers,
    onBeforeNextTurn: async (snapshot) => {
      beforeNextTurnSnapshots.push(snapshot);
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 0);
  assert.equal(observedStreamContexts[0].tools.some((tool) => tool.name === "web_search"), false);
  toolEvents.assertSilent();
  assert.equal(beforeNextTurnSnapshots.length, 1);
  assert.equal(beforeNextTurnSnapshots[0].toolResults[0].toolCallId, webSearchCall.id);
  assert.equal(beforeNextTurnSnapshots[0].toolResults[0].isError, false);
  assert.match(
    beforeNextTurnSnapshots[0].toolResults[0].content[0].text,
    /LiveAgent DeepSeek structured DSML search/,
  );
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools ends the turn when a leaked web_fetch arrives after a completed answer", async () => {
  const webFetchCall = createToolCall("toolu_bdrk_leak_fetch", "web_fetch", {
    url: "https://example.com/article",
  });
  resetFakeStreams(
    createAssistant(
      [{ type: "text", text: "今天长沙的主要新闻整理如下：高温黄色预警，最高气温超35℃。" }, webFetchCall],
      "stop",
      {
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
    ),
  );
  const toolEvents = createToolEventRecorder();
  const { params, executedToolCalls } = createBaseParams({
    providerId: "claude_code",
    model: "claude-sonnet-5",
    runtime: {
      baseUrl: "https://relay.example.test/anthropic",
      apiKey: "test-key",
      requestFormat: "anthropic-messages",
      nativeWebSearchEnabled: true,
    },
    nativeWebSearch: true,
    ...toolEvents.handlers,
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 0);
  toolEvents.assertSilent();
  // The answer was already delivered in the same message; no second model turn.
  assert.equal(observedStreamContexts.length, 1);
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult"],
  );
  assert.equal(result.emittedMessages[1].isError, false);
  assert.match(
    result.emittedMessages[1].content[0].text,
    /did not execute the provider-native web_fetch request/,
  );
});

test("runAssistantWithTools keeps the follow-up turn for leaked web_search without hosted results", async () => {
  const webSearchCall = createToolCall("toolu_bdrk_leak_search", "web_search", {
    query: "changsha news",
  });
  resetFakeStreams(
    createAssistant(
      [{ type: "text", text: "我先联网搜索一下长沙今天的新闻。" }, webSearchCall],
      "stop",
      {
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
    ),
    createTextAssistant("final answer"),
  );
  const { params, executedToolCalls } = createBaseParams({
    providerId: "claude_code",
    model: "claude-sonnet-5",
    runtime: {
      baseUrl: "https://relay.example.test/anthropic",
      apiKey: "test-key",
      requestFormat: "anthropic-messages",
      nativeWebSearchEnabled: true,
    },
    nativeWebSearch: true,
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 0);
  // No hosted-search results were captured in-round, so the model may still be
  // waiting for sources — the follow-up turn must survive.
  assert.equal(observedStreamContexts.length, 2);
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools ends the turn for leaked web_search covered by in-round hosted results", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode(
              sse({
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "server_tool_use",
                  id: "srvtoolu_news",
                  name: "web_search",
                  input: { query: "changsha news" },
                },
              }),
            ),
          );
          controller.enqueue(
            encoder.encode(
              sse({
                type: "content_block_start",
                index: 1,
                content_block: {
                  type: "web_search_tool_result",
                  tool_use_id: "srvtoolu_news",
                  content: [
                    {
                      type: "web_search_result",
                      url: "https://example.com/changsha-news",
                      title: "Changsha News",
                    },
                  ],
                },
              }),
            ),
          );
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream; charset=utf-8" } },
    );

  try {
    const webSearchCall = createToolCall("toolu_bdrk_leak_search_covered", "web_search", {
      query: "changsha news",
    });
    resetFakeStreams(
      createAssistant(
        [
          { type: "text", text: "今天长沙的主要新闻整理如下：高温黄色预警与楼市新政落地。" },
          webSearchCall,
        ],
        "stop",
        {
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-5",
        },
      ),
    );
    // Feed the hosted-search probe before the fake stream yields any event, so
    // the completed search sources are aggregated ahead of tool execution.
    queueStreamSideEffect(async (options) => {
      await fetch("http://127.0.0.1:18080/proxy/claude_code/v1/messages", {
        method: "POST",
        headers: options?.headers,
        body: JSON.stringify({ metadata: { user_id: "session-1" } }),
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    const { params, executedToolCalls } = createBaseParams({
      providerId: "claude_code",
      model: "claude-sonnet-5",
      runtime: {
        baseUrl: "https://relay.example.test/anthropic",
        apiKey: "test-key",
        requestFormat: "anthropic-messages",
        nativeWebSearchEnabled: true,
      },
      nativeWebSearch: true,
    });

    const result = await runAssistantWithTools(params);

    assert.equal(executedToolCalls.length, 0);
    // The relay already executed the search in-band and the model answered
    // after seeing the results — a second model turn would re-answer.
    assert.equal(observedStreamContexts.length, 1);
    assert.deepEqual(
      result.emittedMessages.map((message) => message.role),
      ["assistant", "toolResult"],
    );
    assert.equal(result.emittedMessages[1].isError, false);
    assert.match(result.emittedMessages[1].content[0].text, /example\.com\/changsha-news/);

    // The hosted-search card must still be folded into the persisted assistant
    // message even though the run terminated without a follow-up turn.
    const hostedSearches = result.assistant.content.filter(
      (block) => block?.type === "hostedSearch",
    );
    assert.equal(hostedSearches.length, 1);
    assert.equal(hostedSearches[0].status, "completed");
    assert.deepEqual(
      hostedSearches[0].sources.map((source) => source.url),
      ["https://example.com/changsha-news"],
    );
  } finally {
    await Promise.resolve();
    globalThis.fetch = originalFetch;
  }
});

test("runAssistantWithTools silently bridges leaked provider-native web_fetch tool calls", async () => {
  const webFetchCall = createToolCall("toolu_bdrk_0115gvv1UH91P7VUq87KBrNW", "web_fetch", {
    url: "https://www.weather.com.cn/weather1d/101250101.shtml",
    mode: "truncated",
  });
  resetFakeStreams(
    createAssistant(
      [{ type: "text", text: "Fetching the page" }, webFetchCall],
      "toolUse",
      {
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
    ),
    createTextAssistant("final answer"),
  );
  const beforeNextTurnSnapshots = [];
  const toolEvents = createToolEventRecorder();
  const { params, executedToolCalls } = createBaseParams({
    providerId: "claude_code",
    model: "claude-sonnet-5",
    runtime: {
      baseUrl: "https://relay.example.test/anthropic",
      apiKey: "test-key",
      requestFormat: "anthropic-messages",
      nativeWebSearchEnabled: true,
    },
    nativeWebSearch: true,
    ...toolEvents.handlers,
    onBeforeNextTurn: async (snapshot) => {
      beforeNextTurnSnapshots.push(snapshot);
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 0);
  assert.equal(observedStreamContexts[0].tools.some((tool) => tool.name === "web_fetch"), false);
  assert.equal(observedStreamContexts[0].tools.some((tool) => tool.name === "WebFetch"), false);
  toolEvents.assertSilent();
  assert.equal(beforeNextTurnSnapshots.length, 1);
  const bridgedResult = beforeNextTurnSnapshots[0].toolResults[0];
  assert.equal(bridgedResult.toolCallId, webFetchCall.id);
  assert.equal(bridgedResult.isError, false);
  assert.match(
    bridgedResult.content[0].text,
    /did not execute the provider-native web_fetch request/,
  );
  assert.match(
    bridgedResult.content[0].text,
    /https:\/\/www\.weather\.com\.cn\/weather1d\/101250101\.shtml/,
  );
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools silently bridges Claude Code WebSearch tool calls for DeepSeek", async () => {
  const webSearchCall = createToolCall("call_00_X84be89XQazCll4eRQVm9797", "WebSearch", {
    query: "weibo-like-someone github",
  });
  resetFakeStreams(
    createAssistant(
      [{ type: "text", text: "Searching" }, webSearchCall],
      "toolUse",
      {
        api: "anthropic-messages",
        provider: "anthropic",
        model: "deepseek-v4-flash",
      },
    ),
    createTextAssistant("final answer"),
  );
  const toolEvents = createToolEventRecorder();
  const { params, executedToolCalls } = createBaseParams({
    providerId: "claude_code",
    model: "deepseek-v4-flash",
    runtime: {
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "test-key",
      requestFormat: "anthropic-messages",
      nativeWebSearchEnabled: true,
    },
    nativeWebSearch: true,
    ...toolEvents.handlers,
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 0);
  assert.equal(observedStreamContexts[0].tools.some((tool) => tool.name === "WebSearch"), false);
  toolEvents.assertSilent();
  assert.equal(observedStreamContexts.length, 2);

  const secondTurnMessages = observedStreamContexts[1].messages;
  const assistantIndex = secondTurnMessages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.content.some((block) => block.type === "toolCall" && block.id === webSearchCall.id),
  );
  assert.ok(assistantIndex >= 0);
  assert.equal(secondTurnMessages[assistantIndex + 1].role, "toolResult");
  assert.equal(secondTurnMessages[assistantIndex + 1].toolCallId, webSearchCall.id);
  assert.equal(secondTurnMessages[assistantIndex + 1].isError, false);
  assert.match(
    secondTurnMessages[assistantIndex + 1].content[0].text,
    /provider-native web search request/,
  );
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools bridges recovered DSML builtin_web_search additionalContext", async () => {
  const dsml = "\uFF5C\uFF5CDSML\uFF5C\uFF5C";
  resetFakeStreams(
    createTextAssistant(`Searching
<${dsml}tool_calls>
  <${dsml}invoke name="builtin_web_search">
    <${dsml}parameter name="additionalContext" string="true">DeepSeek Anthropic DSML web search</${dsml}parameter>
  </${dsml}invoke>
</${dsml}tool_calls>`),
    createTextAssistant("final answer"),
  );
  const beforeNextTurnSnapshots = [];
  const toolEvents = createToolEventRecorder();
  const { params, executedToolCalls } = createBaseParams({
    nativeWebSearch: true,
    ...toolEvents.handlers,
    onBeforeNextTurn: async (snapshot) => {
      beforeNextTurnSnapshots.push(snapshot);
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 0);
  toolEvents.assertSilent();
  assert.equal(beforeNextTurnSnapshots.length, 1);
  assert.match(
    beforeNextTurnSnapshots[0].toolResults[0].content[0].text,
    /Requested query: DeepSeek Anthropic DSML web search/,
  );
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools does not run next-turn overrides for length/error/aborted terminal reasons", async () => {
  for (const stopReason of ["length", "error", "aborted"]) {
    resetFakeStreams(
      createTextAssistant(
        stopReason === "length" ? "truncated" : "",
        stopReason,
        stopReason === "error"
          ? { errorMessage: "provider failed" }
          : stopReason === "aborted"
            ? { errorMessage: "Request aborted" }
            : {},
      ),
    );
    let beforeNextTurnCalls = 0;
    const { params } = createBaseParams({
      onBeforeNextTurn: async () => {
        beforeNextTurnCalls += 1;
        return null;
      },
    });

    if (stopReason === "length") {
      const result = await runAssistantWithTools(params);
      assert.equal(result.assistant.stopReason, "length");
    } else {
      await assert.rejects(
        () => runAssistantWithTools(params),
        stopReason === "error" ? /provider failed/ : /Request aborted/,
      );
    }

    assert.equal(beforeNextTurnCalls, 0, `${stopReason} must not schedule onBeforeNextTurn`);
  }
});

test("runAssistantWithTools ignores malformed toolUse turns that have no tool results", async () => {
  resetFakeStreams(createTextAssistant("", "toolUse"));
  let beforeNextTurnCalls = 0;
  const { params } = createBaseParams({
    onBeforeNextTurn: async () => {
      beforeNextTurnCalls += 1;
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(beforeNextTurnCalls, 0);
  assert.equal(result.assistant.stopReason, "toolUse");
});

test("runAssistantWithTools 的前缀归因按 sessionId 隔离,多会话交错不污染基线", async () => {
  // 三次 runner 调用模拟主会话与子代理交错:A → B(system 不同)→ A(与首轮
  // 完全一致)。旧实现的 runner 局部变量在第二次 A 调用时只能报 initial(跨
  // 调用不存续);若改成全局单槽则会拿 B 的快照比出 system 变更。按 sessionId
  // 键控后,A 的第二轮必须是 unchanged。
  const prefixCaptures = [];
  const createCapturingLogger = () => ({
    enabled: true,
    logRequest(payload) {
      prefixCaptures.push(payload.prefixCache);
    },
    logResponse() {},
    logResult() {},
    logError() {},
    async flush() {},
  });

  const runTurn = async (sessionId, systemPrompt) => {
    resetFakeStreams(createTextAssistant("done"));
    const { params } = createBaseParams({
      sessionId,
      debugLogger: createCapturingLogger(),
      context: {
        systemPrompt,
        messages: [{ role: "user", content: "Start", timestamp: 1 }],
        tools: [
          {
            name: "Read",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    });
    await runAssistantWithTools(params);
  };

  await runTurn("interleave-session-a", "Prompt for session A");
  await runTurn("interleave-session-b", "Prompt for session B");
  await runTurn("interleave-session-a", "Prompt for session A");

  assert.equal(prefixCaptures.length, 3);
  assert.equal(prefixCaptures[0].prefixChangeSummary, "initial");
  // B 是自己的首轮,不得拿 A 的快照比出 system 变更。
  assert.equal(prefixCaptures[1].prefixChangeSummary, "initial");
  // A 的第二轮与首轮字节一致:基线跨 runner 调用存续,且未被 B 污染。
  assert.equal(prefixCaptures[2].prefixChangeSummary, "unchanged");
  assert.equal(prefixCaptures[2].prefixChanged, false);
  assert.equal(prefixCaptures[2].prefixHash, prefixCaptures[0].prefixHash);
});
