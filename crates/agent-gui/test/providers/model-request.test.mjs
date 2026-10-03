import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// ============================================================================
// 请求配方（P1 抽取）回归网：主循环每个实际尝试的目标都经 onRequestPrepared
// 交出配方；用「配方 + 现取传输」经 shapeRequestContext / finalizeRequest 重放，
// 得到的 llm.stream 入参必须与那一轮真实发出的逐字段相等（只有 finalize 每次
// 新建的 onPayload 闭包与工具的非线上字段例外），onPayload 链落到线上的请求体
// 也必须逐字节一致。配方本身绝不携带凭证、baseUrl、代理 / 自定义头、pi-agent-core
// 的 loop 配置或任何闭包。
// ============================================================================

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);

const importPiAi = (rel) =>
  import(new URL(`../../node_modules/@earendil-works/pi-ai/dist/${rel}`, import.meta.url).href);
const piAiEventStream = await importPiAi("utils/event-stream.js");
const realAnthropic = await importPiAi("api/anthropic-messages.js");
const realCompletions = await importPiAi("api/openai-completions.js");
const realResponses = await importPiAi("api/openai-responses.js");
const realGoogle = await importPiAi("api/google-generative-ai.js");

const PROXY_SERVER_INFO = { baseUrl: "http://127.0.0.1:18080", token: "proxy-token-secret" };
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const HOSTED_SEARCH_PROBE_HEADER = "x-liveagent-hosted-search-probe";
const CUSTOM_HEADER_SECRET = "relay-channel-secret";
const RECIPE_OPTION_KEYS = new Set([
  "reasoning",
  "thinkingBudgets",
  "maxTokens",
  "temperature",
  "samplingParams",
  "toolChoice",
  "cacheRetention",
  "sessionId",
  "metadata",
  "deepSeekThinking",
  "workdir",
]);

const tauriMock = {
  "@tauri-apps/api/core": {
    async invoke(command) {
      if (command === "proxy_get_server_info") return PROXY_SERVER_INFO;
      throw new Error(`unexpected tauri invoke: ${command}`);
    },
  },
};

// 主循环：真实装配链（prepareProviderRequest → createModelFromConfig → finalize），
// 只在 streamByApi 针孔截获 llm.stream 的入参并回放假流。
const streamCalls = [];
const streamQueue = [];
const loader = createTsModuleLoader({
  mocks: {
    ...tauriMock,
    [abs("src/lib/providers/runtime/streamByApi.ts")]: {
      streamSimpleByApi(model, context, options) {
        streamCalls.push({ model, context, options });
        const next = streamQueue.shift();
        if (!next) throw new Error("no fake stream queued");
        return next();
      },
    },
    [abs("src/lib/system/powerActivity.ts")]: {
      withPowerActivity: (_scope, _reason, run) => run(),
    },
  },
});
const { runAssistantWithTools } = loader.loadModule("src/lib/chat/runner/agentRunner.ts");
const { completeAssistantMessage, streamAssistantMessage } = loader.loadModule(
  "src/lib/providers/runtime/textOnlyRuntime.ts",
);
const { finalizeRequest, prepareTransport, shapeRequestContext } = loader.loadModule(
  "src/lib/providers/runtime/modelRequest.ts",
);
const { resetFailoverBreakers } = loader.loadModule(
  "src/lib/providers/runtime/providerFailover.ts",
);

// 线上字节：真实 pi-ai 协议实现，onPayload 链尾截获请求体后中断，网络零触碰。
const wireLoader = createTsModuleLoader({
  mocks: {
    "@earendil-works/pi-ai/api/anthropic-messages": { stream: realAnthropic.stream },
    "@earendil-works/pi-ai/api/openai-completions": { stream: realCompletions.stream },
    "@earendil-works/pi-ai/api/openai-responses": { stream: realResponses.stream },
    "@earendil-works/pi-ai/api/google-generative-ai": { stream: realGoogle.stream },
  },
});
const { streamSimpleByApi: wireStreamSimpleByApi } = wireLoader.loadModule(
  "src/lib/providers/runtime/streamByApi.ts",
);

async function captureWirePayload({ model, context, options }) {
  let captured;
  const stream = wireStreamSimpleByApi(model, context, {
    ...options,
    signal: undefined,
    streamRetry: { disabled: true },
    onPayload: async (payload, payloadModel) => {
      captured = options.onPayload
        ? ((await options.onPayload(payload, payloadModel)) ?? payload)
        : payload;
      throw new Error("__capture_stop__");
    },
  });
  await stream.result().catch(() => undefined);
  assert.ok(captured, `expected a wire payload for ${model.id}`);
  return JSON.parse(JSON.stringify(captured));
}

function assistantMessage(content, stopReason, errorMessage) {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "claude_code",
    model: "fake",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 1,
  };
}

function fakeStream(events) {
  const stream = piAiEventStream.createAssistantMessageEventStream();
  for (const event of events) stream.push(event);
  return stream;
}

const textStream = (text) => () => {
  const message = assistantMessage([{ type: "text", text }], "stop");
  return fakeStream([
    { type: "start", partial: message },
    { type: "text_delta", contentIndex: 0, delta: text, partial: message },
    { type: "done", reason: "stop", message },
  ]);
};

const toolCallStream = (toolCall) => () => {
  const message = assistantMessage([toolCall], "toolUse");
  return fakeStream([
    { type: "start", partial: message },
    { type: "toolcall_start", contentIndex: 0, partial: message },
    { type: "toolcall_end", contentIndex: 0, toolCall, partial: message },
    { type: "done", reason: "toolUse", message },
  ]);
};

const uncommittedErrorStream = (errorMessage) => () => {
  const message = assistantMessage([], "error", errorMessage);
  return fakeStream([
    { type: "start", partial: message },
    { type: "error", reason: "error", error: message },
  ]);
};

const READ_TOOL = {
  name: "Read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};

function runtime(overrides) {
  return {
    apiKey: `sk-secret-${overrides.baseUrl.length}`,
    reasoning: "high",
    customHeaders: [{ key: "X-Relay-Channel", value: CUSTOM_HEADER_SECRET }],
    ...overrides,
  };
}

/** 工具只按线上字段比较：实发的是 AgentTool（带 label / execute），配方只留线上字段。 */
function withWireTools(context) {
  if (!context.tools) return context;
  return {
    ...context,
    tools: context.tools.map(({ name, description, parameters, constrainedSampling }) => ({
      name,
      description,
      parameters,
      ...(constrainedSampling === undefined ? {} : { constrainedSampling }),
    })),
  };
}

/** 配方卫生：只含白名单选项，无凭证 / 头 / 回调 / loop 配置，工具不带闭包。 */
function assertRecipeHygiene(recipe, runtimes) {
  for (const key of Object.keys(recipe.options)) {
    assert.ok(RECIPE_OPTION_KEYS.has(key), `recipe option ${key} is outside the whitelist`);
  }
  for (const value of [
    ...Object.values(recipe),
    ...Object.values(recipe.options),
    ...(recipe.tools ?? []).flatMap((tool) => Object.values(tool)),
  ]) {
    assert.notEqual(typeof value, "function");
  }
  for (const tool of recipe.tools ?? []) {
    for (const key of Object.keys(tool)) {
      assert.ok(
        ["name", "description", "parameters", "constrainedSampling"].includes(key),
        `recipe tool ${tool.name} carries non-wire field ${key}`,
      );
    }
  }
  for (const key of [
    "apiKey",
    "baseUrl",
    "headers",
    "signal",
    "streamRetry",
    "onPayload",
    "transport",
    "model",
    "beforeToolCall",
    "afterToolCall",
    "prepareNextTurn",
    "convertToLlm",
    "getSteeringMessages",
  ]) {
    assert.equal(key in recipe, false, `recipe must not carry ${key}`);
    assert.equal(key in recipe.options, false, `recipe options must not carry ${key}`);
  }
  const serialized = JSON.stringify(recipe);
  for (const secret of [
    ...runtimes.map((entry) => entry.apiKey),
    CUSTOM_HEADER_SECRET,
    PROXY_SERVER_INFO.token,
    HOSTED_SEARCH_PROBE_HEADER,
  ]) {
    assert.equal(serialized.includes(secret), false, `recipe leaks ${secret}`);
  }
}

/** 用配方 + 现取传输重放，与真实发出的那次逐字段 / 逐字节比对。 */
async function assertReplayMatches(call, recipe, targetRuntime) {
  const transport = await prepareTransport(recipe.providerId, recipe.modelId, targetRuntime, {
    sessionId: recipe.options.sessionId,
  });
  const probe = call.options.headers[HOSTED_SEARCH_PROBE_HEADER];
  const context = shapeRequestContext(recipe, [...recipe.messages]);
  const replay = finalizeRequest(recipe, context, transport, {
    signal: call.options.signal,
    streamRetry: call.options.streamRetry,
    headers: probe ? { [HOSTED_SEARCH_PROBE_HEADER]: probe } : undefined,
  });

  assert.equal(recipe.api, call.model.api);
  assert.deepEqual(replay.model, call.model);
  assert.deepEqual(replay.context, withWireTools(call.context));
  const { onPayload: replayOnPayload, ...replayOptions } = replay.options;
  const { onPayload: callOnPayload, ...callOptions } = call.options;
  assert.deepEqual(replayOptions, callOptions);
  assert.equal(typeof replayOnPayload, typeof callOnPayload);
  const wire = await captureWirePayload(call);
  assert.deepEqual(await captureWirePayload(replay), wire);
  return wire;
}

function resetCapture(...streams) {
  resetFailoverBreakers();
  streamCalls.length = 0;
  streamQueue.length = 0;
  streamQueue.push(...streams);
}

async function runAgent({ providerId, model, runtime: primaryRuntime, failover, extra = {} }) {
  const recipes = [];
  await runAssistantWithTools({
    providerId,
    model,
    runtime: primaryRuntime,
    failover,
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Read a.txt", timestamp: 1 }],
      tools: [READ_TOOL],
    },
    workdir: "/tmp/liveagent-model-request",
    sessionId: SESSION_ID,
    tools: [READ_TOOL],
    async executeToolCall(toolCall) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "file body" }],
        isError: false,
        timestamp: 2,
      };
    },
    onTextDelta() {},
    onRequestPrepared: (recipe) => recipes.push(recipe),
    ...extra,
  });
  return recipes;
}

const AGENT_CASES = [
  {
    name: "anthropic-messages（官方端点 + 自定义头 + 1h 缓存）",
    providerId: "claude_code",
    model: "claude-sonnet-4-6",
    runtime: runtime({
      baseUrl: "https://api.anthropic.com/v1",
      promptCachingEnabled: true,
      promptCacheRetention: "long",
    }),
  },
  {
    name: "openai-responses（原生搜索开启 + 探针头）",
    providerId: "codex",
    model: "gpt-5.2-codex",
    runtime: runtime({ baseUrl: "https://api.openai.com/v1", nativeWebSearchEnabled: true }),
    nativeWebSearch: true,
  },
  {
    name: "openai-completions（中转）",
    providerId: "codex",
    model: "gpt-5.2",
    runtime: runtime({
      baseUrl: "https://relay.example.com/v1",
      requestFormat: "openai-completions",
    }),
  },
  {
    name: "google-generative-ai（官方端点）",
    providerId: "gemini",
    model: "gemini-3-pro-preview",
    runtime: runtime({ baseUrl: "https://generativelanguage.googleapis.com" }),
  },
];

for (const scenario of AGENT_CASES) {
  test(`agent 配方重放与实发请求一致：${scenario.name}，含尾部投递轮`, async () => {
    const toolCall = {
      type: "toolCall",
      id: "call_read_1",
      name: "Read",
      arguments: { path: "a.txt" },
    };
    resetCapture(toolCallStream(toolCall), textStream("done"));
    const tailText = "<system-reminder>memory delta</system-reminder>";

    const recipes = await runAgent({
      ...scenario,
      extra: {
        nativeWebSearch: scenario.nativeWebSearch,
        onBeforeNextTurn: async ({ runtimeContext, emittedMessages }) => ({
          context: runtimeContext,
          emittedMessages,
          wireTailText: tailText,
        }),
      },
    });

    assert.equal(streamCalls.length, 2);
    assert.equal(recipes.length, 2);
    assert.equal(recipes[0].shape, "agent");
    assert.equal(recipes[0].wireTail.length, 0);
    assert.deepEqual(recipes[1].wireTail, [{ anchorToolCallId: "call_read_1", text: tailText }]);
    // 尾部投递只在出站请求：配方 messages 不含它，实发 context 含它。
    assert.equal(JSON.stringify(recipes[1].messages).includes(tailText), false);
    assert.equal(JSON.stringify(streamCalls[1].context.messages).includes(tailText), true);
    assert.equal(
      Boolean(streamCalls[0].options.headers[HOSTED_SEARCH_PROBE_HEADER]),
      Boolean(scenario.nativeWebSearch),
    );

    const wires = [];
    for (const [index, recipe] of recipes.entries()) {
      assertRecipeHygiene(recipe, [scenario.runtime]);
      wires.push(await assertReplayMatches(streamCalls[index], recipe, scenario.runtime));
    }
    // 捕获非空转：尾部投递与原生搜索注入都真实落到了线上请求体。
    assert.equal(JSON.stringify(wires[0]).includes(tailText), false);
    assert.equal(JSON.stringify(wires[1]).includes(tailText), true);
    assert.equal(
      JSON.stringify(wires[0]).includes('"web_search"'),
      Boolean(scenario.nativeWebSearch),
    );
  });
}

test("agent failover：逐候选各记一份配方，最后一份即接管的目标，且各自可重放", async () => {
  const primaryRuntime = runtime({ baseUrl: "https://relay.example.com/anthropic" });
  const fallbackRuntime = runtime({
    baseUrl: "https://api.openai.com/v1",
    nativeWebSearchEnabled: true,
  });
  resetCapture(uncommittedErrorStream("502 upstream unavailable"), textStream("fallback answer"));

  const recipes = await runAgent({
    providerId: "claude_code",
    model: "claude-sonnet-4-6",
    runtime: primaryRuntime,
    failover: {
      config: { maxSwitches: 3, failureThreshold: 3, cooldownSeconds: 60 },
      primary: {
        selectedModel: { customProviderId: "p-relay", model: "claude-sonnet-4-6" },
        label: "relay · claude-sonnet-4-6",
      },
      fallbacks: [
        {
          selectedModel: { customProviderId: "p-openai", model: "gpt-5.2-codex" },
          providerId: "codex",
          model: "gpt-5.2-codex",
          label: "openai · gpt-5.2-codex",
          runtime: fallbackRuntime,
        },
      ],
    },
    extra: { nativeWebSearch: true },
  });

  assert.equal(streamCalls.length, 2);
  assert.deepEqual(
    recipes.map((recipe) => [recipe.providerId, recipe.modelId, recipe.api]),
    [
      ["claude_code", "claude-sonnet-4-6", "anthropic-messages"],
      ["codex", "gpt-5.2-codex", "openai-responses"],
    ],
  );
  // 同一轮的两个候选共用同一份 messages 引用与成形输入，只有目标相关字段不同。
  assert.equal(recipes[0].messages, recipes[1].messages);
  assert.equal(recipes[0].systemPrompt, recipes[1].systemPrompt);
  for (const [index, recipe] of recipes.entries()) {
    assertRecipeHygiene(recipe, [primaryRuntime, fallbackRuntime]);
    await assertReplayMatches(
      streamCalls[index],
      recipe,
      index === 0 ? primaryRuntime : fallbackRuntime,
    );
  }
});

test("text 配方重放与实发请求一致：failover + 原生搜索探针头只在 finalize 处追加", async () => {
  const primaryRuntime = runtime({
    baseUrl: "https://api.anthropic.com/v1",
    promptCachingEnabled: true,
  });
  const fallbackRuntime = runtime({ baseUrl: "https://generativelanguage.googleapis.com" });
  resetCapture(uncommittedErrorStream("503 overloaded upstream"), textStream("text answer"));
  const recipes = [];

  await streamAssistantMessage({
    providerId: "claude_code",
    model: "claude-sonnet-4-6",
    runtime: primaryRuntime,
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    },
    workdir: "/tmp/liveagent-model-request",
    sessionId: SESSION_ID,
    nativeWebSearch: true,
    onTextDelta() {},
    onRequestPrepared: (recipe) => recipes.push(recipe),
    failover: {
      config: { maxSwitches: 3, failureThreshold: 3, cooldownSeconds: 60 },
      primary: {
        selectedModel: { customProviderId: "p-anthropic", model: "claude-sonnet-4-6" },
        label: "anthropic · claude-sonnet-4-6",
      },
      fallbacks: [
        {
          selectedModel: { customProviderId: "p-gemini", model: "gemini-3-pro-preview" },
          providerId: "gemini",
          model: "gemini-3-pro-preview",
          label: "gemini · gemini-3-pro-preview",
          runtime: fallbackRuntime,
        },
      ],
    },
  });

  assert.equal(streamCalls.length, 2);
  assert.deepEqual(
    recipes.map((recipe) => [recipe.shape, recipe.providerId, recipe.api]),
    [
      ["text", "claude_code", "anthropic-messages"],
      ["text", "gemini", "google-generative-ai"],
    ],
  );
  for (const [index, recipe] of recipes.entries()) {
    assert.ok(streamCalls[index].options.headers[HOSTED_SEARCH_PROBE_HEADER]);
    assertRecipeHygiene(recipe, [primaryRuntime, fallbackRuntime]);
    await assertReplayMatches(
      streamCalls[index],
      recipe,
      index === 0 ? primaryRuntime : fallbackRuntime,
    );
  }
});

// 以上重放两侧都过 finalizeRequest，抓不到它自身的回归（丢字段、展开顺序让配方
// 盖掉凭证 / 头）。以下把 P1 前后不变的实发结果按字面钉死。

/** 实发 options 的数据面：去掉闭包 / 句柄 / 头，undefined 键按 JSON 口径丢弃。 */
function dataOptions(options) {
  const {
    onPayload: _onPayload,
    streamRetry: _streamRetry,
    signal: _signal,
    headers: _headers,
    ...rest
  } = options;
  return JSON.parse(JSON.stringify(rest));
}

test("agent 实发请求字面钉死：anthropic 官方端点两轮，第二轮强制工具", async () => {
  const scenario = AGENT_CASES[0];
  const toolCall = {
    type: "toolCall",
    id: "call_read_1",
    name: "Read",
    arguments: { path: "a.txt" },
  };
  resetCapture(toolCallStream(toolCall), textStream("done"));
  await runAgent({
    ...scenario,
    extra: {
      resolveToolChoice: (round) => (round === 2 ? { type: "tool", name: "Read" } : undefined),
    },
  });

  assert.equal(streamCalls.length, 2);
  const expectedOptions = (toolChoice) => ({
    reasoning: "high",
    sessionId: SESSION_ID,
    cacheRetention: "long",
    metadata: { user_id: SESSION_ID },
    toolChoice,
    workdir: "/tmp/liveagent-model-request",
    apiKey: scenario.runtime.apiKey,
  });
  assert.deepEqual(dataOptions(streamCalls[0].options), expectedOptions("auto"));
  assert.deepEqual(
    dataOptions(streamCalls[1].options),
    expectedOptions({ type: "tool", name: "Read" }),
  );
  for (const { options } of streamCalls) {
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(options.streamRetry).sort(), ["onRetry", "onRetryRecovered"]);
    assert.equal(typeof options.onPayload, "function");
    assert.equal(options.headers["X-Relay-Channel"], CUSTOM_HEADER_SECRET);
    assert.equal(options.headers["x-liveagent-proxy-token"], PROXY_SERVER_INFO.token);
    assert.equal(HOSTED_SEARCH_PROBE_HEADER in options.headers, false);
  }

  const { system, ...wire } = await captureWirePayload(streamCalls[1]);
  assert.ok(system[0].text.startsWith("Base system prompt\n\n# Tool-Execution Mode"));
  // 思考开启时强制工具在线上降为 auto（既有拦截器行为）。
  assert.deepEqual(wire, {
    model: "claude-sonnet-4-6",
    max_tokens: 128000,
    stream: true,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
    metadata: { user_id: SESSION_ID },
    tool_choice: { type: "auto" },
    cache_control: { type: "ephemeral", ttl: "1h" },
    tools: [
      {
        name: "Read",
        description: "Read a file",
        eager_input_streaming: true,
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: [] },
      },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "Read a.txt" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_read_1", name: "Read", input: { path: "a.txt" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_read_1",
            content: "file body",
            is_error: false,
          },
        ],
      },
    ],
  });
});

test("completeAssistantMessage 实发请求字面钉死（辅助请求不记配方，只复用装配）", async () => {
  const targetRuntime = runtime({
    baseUrl: "https://api.anthropic.com/v1",
    promptCachingEnabled: true,
  });
  resetCapture(textStream("summary"));
  await completeAssistantMessage({
    providerId: "claude_code",
    model: "claude-sonnet-4-6",
    runtime: targetRuntime,
    context: {
      systemPrompt: "Summarize",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    },
    sessionId: SESSION_ID,
  });

  assert.equal(streamCalls.length, 1);
  const [{ options }] = streamCalls;
  assert.deepEqual(dataOptions(options), {
    sessionId: SESSION_ID,
    cacheRetention: "short",
    metadata: { user_id: SESSION_ID },
    reasoning: "high",
    toolChoice: "none",
    apiKey: targetRuntime.apiKey,
  });
  assert.equal(options.signal, undefined);
  assert.equal(options.headers["X-Relay-Channel"], CUSTOM_HEADER_SECRET);

  const { system, ...wire } = await captureWirePayload(streamCalls[0]);
  assert.ok(system[0].text.startsWith("Summarize\n\nImportant Rules:"));
  assert.deepEqual(wire, {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    max_tokens: 128000,
    stream: true,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
    metadata: { user_id: SESSION_ID },
    tool_choice: { type: "none" },
    cache_control: { type: "ephemeral" },
  });
});

test("finalizeRequest 只合并 extra 中有定义的键，不抹掉配方选项与传输头", async () => {
  const targetRuntime = runtime({ baseUrl: "https://relay.example.com/v1" });
  const transport = await prepareTransport("codex", "gpt-5.2", targetRuntime, {
    sessionId: SESSION_ID,
  });
  const recipe = {
    providerId: "codex",
    modelId: "gpt-5.2",
    api: transport.model.api,
    shape: "text",
    systemPrompt: "sys",
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
    options: { toolChoice: "auto", sessionId: SESSION_ID },
    recordedAt: 1,
  };

  const context = shapeRequestContext(recipe, [...recipe.messages]);
  const { options } = finalizeRequest(recipe, context, transport, {
    signal: undefined,
    streamRetry: undefined,
    headers: undefined,
  });

  assert.equal(options.toolChoice, "auto");
  assert.equal("signal" in options, false);
  assert.equal("streamRetry" in options, false);
  assert.equal(options.apiKey, targetRuntime.apiKey);
  assert.deepEqual(options.headers, transport.headers);
});
