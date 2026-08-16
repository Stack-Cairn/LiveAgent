import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  DEEPSEEK_CHAT_COMPLETIONS_API,
  normalizeDeepSeekBaseUrl,
  serializeDeepSeekMessages,
  serializeDeepSeekRequest,
  streamDeepSeekNative,
} = loader.loadModule("src/lib/providers/deepSeekNative.ts");
const { createModelFromConfig } = loader.loadModule("src/lib/providers/runtime/modelFactory.ts");
const { streamSimpleByApi } = loader.loadModule("src/lib/providers/runtime/streamByApi.ts");

function createModel(overrides = {}) {
  return {
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    api: DEEPSEEK_CHAT_COMPLETIONS_API,
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    input: ["text"],
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

function createContext(overrides = {}) {
  return {
    systemPrompt: "You are precise.",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }],
    ...overrides,
  };
}

function sseData(payload) {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

function responseFromBytes(parts, init = {}) {
  const { headers, ...responseInit } = init;
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
    {
      status: 200,
      ...responseInit,
      headers: { "Content-Type": "text/event-stream", ...headers },
    },
  );
}

function responseFromSse(parts, init = {}) {
  const encoder = new TextEncoder();
  return responseFromBytes(parts.map((part) => encoder.encode(part)), init);
}

async function consume(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

async function runStream({ model = createModel(), context = createContext(), fetch, ...options }) {
  return consume(
    streamDeepSeekNative(model, context, {
      apiKey: "sk-test",
      fetch,
      ...options,
    }),
  );
}

test("DeepSeek request serialization preserves native message and tool semantics", () => {
  const context = createContext({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: " second" },
        ],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "inspect" },
          { type: "text", text: "calling" },
          { type: "toolCall", id: "call-1", name: "lookup", arguments: { q: "value" } },
        ],
        api: DEEPSEEK_CHAT_COMPLETIONS_API,
        provider: "deepseek",
        model: "deepseek-chat",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "lookup",
        content: [],
        isError: false,
        timestamp: 3,
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "private plain-turn reasoning" }],
        api: DEEPSEEK_CHAT_COMPLETIONS_API,
        provider: "deepseek",
        model: "deepseek-chat",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 4,
      },
    ],
    tools: [
      {
        name: "lookup",
        description: "Look up a value",
        parameters: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
      },
    ],
  });

  assert.deepEqual(serializeDeepSeekMessages(context), [
    { role: "system", content: "You are precise." },
    { role: "user", content: "first second" },
    {
      role: "assistant",
      content: "calling",
      reasoning_content: "inspect",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "lookup", arguments: '{"q":"value"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call-1", content: "(no output)" },
    { role: "assistant", content: "" },
  ]);

  const request = serializeDeepSeekRequest(createModel(), context, {
    reasoning: "xhigh",
    maxTokens: 20_000,
    temperature: 0.25,
    toolChoice: { type: "tool", name: "lookup" },
  });
  assert.deepEqual(request.thinking, { type: "enabled" });
  assert.equal(request.reasoning_effort, "max");
  assert.equal(request.max_tokens, 8_192);
  assert.equal(request.temperature, 0.25);
  assert.deepEqual(request.tool_choice, {
    type: "function",
    function: { name: "lookup" },
  });
  assert.equal(request.tools?.[0].function.name, "lookup");
  assert.equal("prompt_cache_key" in request, false);
  assert.equal("cache_control" in request, false);
});

test("DeepSeek model factory is independent from Codex and Claude protocol selection", () => {
  const deepseek = createModelFromConfig(
    "deepseek",
    "deepseek-reasoner",
    "https://api.deepseek.com/v1/chat/completions/",
    "openai-responses",
  );
  assert.equal(deepseek.api, DEEPSEEK_CHAT_COMPLETIONS_API);
  assert.equal(deepseek.provider, "deepseek");
  assert.equal(deepseek.baseUrl, "https://api.deepseek.com/v1/chat/completions");
  assert.deepEqual(deepseek.input, ["text"]);
  assert.equal(deepseek.deepSeekThinkingAlwaysOn, true);

  const codex = createModelFromConfig(
    "codex",
    "deepseek-chat",
    "https://api.deepseek.com/v1/chat/completions",
    "openai-completions",
  );
  assert.equal(codex.api, "openai-completions");
  assert.equal(codex.provider, "openai");
  assert.equal(codex.deepSeekThinkingAlwaysOn, undefined);

  const claude = createModelFromConfig(
    "claude_code",
    "deepseek-chat",
    "https://api.deepseek.com/anthropic",
  );
  assert.equal(claude.api, "anthropic-messages");
  assert.equal(claude.provider, "anthropic");
  assert.equal(claude.deepSeekThinkingAlwaysOn, undefined);
});

test("streamSimpleByApi dispatches the formal DeepSeek API to the native stream", async () => {
  const model = createModelFromConfig(
    "deepseek",
    "deepseek-chat",
    "https://api.deepseek.com/v1",
  );
  const urls = [];
  const stream = streamSimpleByApi(model, createContext(), {
    apiKey: "sk-test",
    streamRetry: { disabled: true },
    fetch: async (url) => {
      urls.push(String(url));
      return responseFromSse([
        sseData({ choices: [{ delta: { content: "native" }, finish_reason: "stop" }] }),
        sseData("[DONE]"),
      ]);
    },
  });

  const { result } = await consume(stream);

  assert.deepEqual(urls, ["https://api.deepseek.com/v1/chat/completions"]);
  assert.equal(result.content[0].text, "native");
  assert.equal(result.provider, "deepseek");
  assert.equal(result.api, DEEPSEEK_CHAT_COMPLETIONS_API);
});

test("DeepSeek thinking mapping supports disabled, high, max, and always-on models", () => {
  const context = createContext();
  assert.deepEqual(serializeDeepSeekRequest(createModel(), context, {}).thinking, {
    type: "disabled",
  });

  const high = serializeDeepSeekRequest(createModel(), context, { reasoning: "low" });
  assert.deepEqual(high.thinking, { type: "enabled" });
  assert.equal(high.reasoning_effort, "high");

  const max = serializeDeepSeekRequest(createModel(), context, { reasoning: "max" });
  assert.deepEqual(max.thinking, { type: "enabled" });
  assert.equal(max.reasoning_effort, "max");

  const alwaysOn = serializeDeepSeekRequest(
    createModel({ id: "deepseek-reasoner", deepSeekThinkingAlwaysOn: true }),
    context,
    {},
  );
  assert.deepEqual(alwaysOn.thinking, { type: "enabled" });
  assert.equal(alwaysOn.reasoning_effort, "high");

  const explicitlyDisabled = serializeDeepSeekRequest(
    createModel({ id: "deepseek-reasoner", deepSeekThinkingAlwaysOn: true }),
    context,
    { reasoning: "max", deepSeekThinking: "disabled" },
  );
  assert.deepEqual(explicitlyDisabled.thinking, { type: "disabled" });
  assert.equal(explicitlyDisabled.reasoning_effort, undefined);

  assert.equal(
    serializeDeepSeekRequest(createModel(), { ...context, tools: [] }, { toolChoice: "any" })
      .tool_choice,
    undefined,
  );
  assert.equal(
    serializeDeepSeekRequest(
      createModel(),
      {
        ...context,
        tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
      },
      { toolChoice: "any" },
    ).tool_choice,
    "required",
  );
});

test("DeepSeek serialization rejects images instead of silently dropping them", () => {
  assert.throws(
    () =>
      serializeDeepSeekMessages(
        createContext({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "describe" },
                { type: "image", data: "AAAA", mimeType: "image/png" },
              ],
              timestamp: 1,
            },
          ],
        }),
      ),
    /does not support image content/,
  );
});

test("DeepSeek native stream rejects images before fetch", async () => {
  let fetchCalled = false;
  const { events, result } = await runStream({
    context: createContext({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
          timestamp: 1,
        },
      ],
    }),
    fetch: async () => {
      fetchCalled = true;
      throw new Error("fetch must not run for image content");
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(events.at(-1).type, "error");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /does not support image content/);
});

test("DeepSeek native stream handles split UTF-8 SSE, tools, usage, hooks, and block order", async () => {
  const body = [
    sseData({
      id: "response-1",
      model: "deepseek-chat-202608",
      choices: [{ delta: { reasoning_content: "思考" }, finish_reason: null }],
    }),
    sseData({ choices: [{ delta: { content: "答案" }, finish_reason: null }] }),
    sseData({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                function: { name: "lookup", arguments: '{"city":"深' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    sseData({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '圳"}' } }] },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 9,
        prompt_cache_hit_tokens: 7,
        completion_tokens_details: { reasoning_tokens: 4 },
      },
    }),
    sseData("[DONE]"),
  ].join("");
  const bytes = new TextEncoder().encode(body);
  const splitAt = bytes.indexOf(new TextEncoder().encode("圳")[0]) + 1;
  const calls = [];
  const responses = [];

  const { events, result } = await runStream({
    model: createModel({
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
      headers: { "X-Model-Header": "model", "X-Remove-Me": "model" },
    }),
    context: createContext({
      tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
    }),
    reasoning: "high",
    headers: {
      "X-Model-Header": "request",
      "X-Remove-Me": null,
      "X-Request-Header": "present",
    },
    onPayload(payload) {
      return { ...payload, temperature: 0.1, hook_marker: true };
    },
    onResponse(response) {
      responses.push(response);
    },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options, payload: JSON.parse(options.body) });
      return responseFromBytes([bytes.slice(0, splitAt), bytes.slice(splitAt)], {
        headers: { "X-DeepSeek-Request-Id": "request-1" },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.get("Authorization"), "Bearer sk-test");
  assert.equal(calls[0].options.headers.get("X-Model-Header"), "request");
  assert.equal(calls[0].options.headers.get("X-Request-Header"), "present");
  assert.equal(calls[0].options.headers.has("X-Remove-Me"), false);
  assert.equal(calls[0].payload.temperature, 0.1);
  assert.equal(calls[0].payload.hook_marker, true);
  assert.deepEqual(responses, [
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-deepseek-request-id": "request-1",
      },
    },
  ]);

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "start",
      "thinking_start",
      "thinking_delta",
      "text_start",
      "text_delta",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "thinking_end",
      "text_end",
      "toolcall_end",
      "done",
    ],
  );
  assert.deepEqual(result.content, [
    { type: "thinking", thinking: "思考" },
    { type: "text", text: "答案" },
    { type: "toolCall", id: "call-1", name: "lookup", arguments: { city: "深圳" } },
  ]);
  assert.equal(result.responseId, "response-1");
  assert.equal(result.responseModel, "deepseek-chat-202608");
  assert.equal(result.stopReason, "toolUse");
  assert.equal(result.rawStopReason, "tool_calls");
  assert.deepEqual(result.usage, {
    input: 13,
    output: 9,
    cacheRead: 7,
    cacheWrite: 0,
    reasoning: 4,
    totalTokens: 29,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("DeepSeek native stream maps length completion and cached-token detail usage", async () => {
  const response = responseFromSse([
    sseData({ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }),
    sseData({
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    }),
    sseData("[DONE]"),
  ]);

  const { result } = await runStream({ fetch: async () => response });

  assert.equal(result.stopReason, "length");
  assert.deepEqual(result.usage, {
    input: 6,
    output: 3,
    cacheRead: 4,
    cacheWrite: 0,
    reasoning: undefined,
    totalTokens: 13,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("DeepSeek native stream reports JSON and plain-text HTTP error details", async () => {
  for (const [response, expected] of [
    [
      new Response(JSON.stringify({ error: { message: "invalid key" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
      /HTTP 401.*invalid key/,
    ],
    [new Response("upstream unavailable", { status: 502 }), /HTTP 502.*upstream unavailable/],
  ]) {
    const { events, result } = await runStream({ fetch: async () => response });
    assert.equal(events.at(-1).type, "error");
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, expected);
  }
});

test("DeepSeek native stream rejects malformed, truncated, empty, and unknown-finish responses", async () => {
  const cases = [
    {
      name: "malformed",
      response: () => responseFromSse([sseData("{not-json"), sseData("[DONE]")]),
      expected: /Malformed DeepSeek SSE payload/,
    },
    {
      name: "truncated",
      response: () =>
        responseFromSse([
          sseData({ choices: [{ delta: { content: "partial" }, finish_reason: null }] }),
        ]),
      expected: /ended without \[DONE\]/,
    },
    {
      name: "empty",
      response: () =>
        responseFromSse([
          sseData({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          sseData("[DONE]"),
        ]),
      expected: /completed response with no content/,
    },
    {
      name: "unknown finish",
      response: () =>
        responseFromSse([
          sseData({ choices: [{ delta: { content: "blocked" }, finish_reason: "content_filter" }] }),
          sseData("[DONE]"),
        ]),
      expected: /unsupported finish reason: content_filter/,
    },
    {
      name: "missing body",
      response: () => new Response(null, { status: 200 }),
      expected: /no response body/,
    },
  ];

  for (const current of cases) {
    const { events, result } = await runStream({ fetch: async () => current.response() });
    assert.equal(events.at(-1).type, "error", current.name);
    assert.equal(result.stopReason, "error", current.name);
    assert.match(result.errorMessage, current.expected, current.name);
  }
});

test("DeepSeek base URL normalization appends /v1 only when no version or endpoint path exists", () => {
  // one-api/new-api 系中转只在 /v1 下服务 API，裸域名路径被前置 SPA 兜底。
  assert.equal(normalizeDeepSeekBaseUrl("https://relay.example.test"), "https://relay.example.test/v1");
  assert.equal(normalizeDeepSeekBaseUrl("https://relay.example.test/"), "https://relay.example.test/v1");
  assert.equal(normalizeDeepSeekBaseUrl("https://api.deepseek.com"), "https://api.deepseek.com/v1");
  assert.equal(
    normalizeDeepSeekBaseUrl("https://relay.example.test/deepseek"),
    "https://relay.example.test/deepseek/v1",
  );
  // 已带版本段或完整端点路径的配置原样保留。
  assert.equal(normalizeDeepSeekBaseUrl("https://relay.example.test/v1"), "https://relay.example.test/v1");
  assert.equal(normalizeDeepSeekBaseUrl("https://relay.example.test/v1beta"), "https://relay.example.test/v1beta");
  assert.equal(
    normalizeDeepSeekBaseUrl("https://relay.example.test/v1/chat/completions/"),
    "https://relay.example.test/v1/chat/completions",
  );
  assert.equal(
    normalizeDeepSeekBaseUrl("https://relay.example.test/api/chat/completions"),
    "https://relay.example.test/api/chat/completions",
  );

  const bareDomainModel = createModelFromConfig("deepseek", "deepseek-chat", "https://relay.example.test");
  assert.equal(bareDomainModel.baseUrl, "https://relay.example.test/v1");
});

test("DeepSeek native stream fails fast on non-SSE 200 responses instead of reporting truncation", async () => {
  // one-api 系中转的前置 SPA 会把未命中路径以 200 + HTML 兜底。
  const { events, result } = await runStream({
    fetch: async () =>
      new Response("<!doctype html>\n<html lang=\"zh\"><head></head></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
  });

  assert.equal(events.at(-1).type, "error");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /returned "text\/html" instead of an SSE stream/);
  assert.match(result.errorMessage, /check that the Base URL/);
  assert.equal(result.errorMessage.includes("ended without"), false);
});

test("DeepSeek native stream maps caller cancellation without AbortSignal.any", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled by user"));
  const originalAny = AbortSignal.any;

  try {
    AbortSignal.any = undefined;
    const { events, result } = await runStream({
      signal: controller.signal,
      fetch: async (_url, options) => {
        options.signal.throwIfAborted();
        throw new Error("fetch should not continue");
      },
    });

    assert.equal(events.at(-1).type, "error");
    assert.equal(result.stopReason, "aborted");
    assert.match(result.errorMessage, /cancelled by user/);
  } finally {
    AbortSignal.any = originalAny;
  }
});
