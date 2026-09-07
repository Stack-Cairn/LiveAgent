import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const realOpenAIResponses = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js",
    import.meta.url,
  ).href
);
const loader = createTsModuleLoader({
  mocks: {
    "@earendil-works/pi-ai/api/openai-responses": {
      stream: realOpenAIResponses.stream,
    },
  },
});
const deepseek = loader.loadModule("src/lib/providers/deepSeekNative.ts");
const payloadCompat = loader.loadModule(
  "src/lib/providers/runtime/deepSeekResponsesPayload.ts",
);
const { createModelFromConfig } = loader.loadModule(
  "src/lib/providers/runtime/modelFactory.ts",
);
const { finalizeProviderStreamOptions } = loader.loadModule(
  "src/lib/providers/runtime/payloadPipeline.ts",
);
const { streamSimpleByApi } = loader.loadModule(
  "src/lib/providers/runtime/streamByApi.ts",
);

function createModel(overrides = {}) {
  return {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    api: deepseek.DEEPSEEK_RESPONSES_API,
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    input: ["text"],
    reasoning: true,
    thinkingLevelMap: { off: "none", low: "low", high: "high", max: "max" },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsDeveloperRole: true,
      supportsLongCacheRetention: false,
      supportsStrictMode: false,
    },
    ...overrides,
  };
}

function createContext(overrides = {}) {
  return {
    systemPrompt: "You are precise.",
    messages: [{ role: "user", content: "Find current release news.", timestamp: 1 }],
    ...overrides,
  };
}

function assistant({
  model = "deepseek-v4-flash",
  content,
  state,
  provider = "deepseek",
  api = deepseek.DEEPSEEK_RESPONSES_API,
  stopReason = "stop",
  timestamp = 2,
}) {
  return {
    role: "assistant",
    content,
    api,
    provider,
    model,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp,
    ...(state ? { deepSeekResponseState: { output: state } } : {}),
  };
}

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function responseFromEvents(events, init = {}) {
  return new Response(events.map(sse).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
    ...init,
  });
}

async function consume(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

function completedSearchResponseEvents({ includeFunctionCall = true, terminalOutput = true } = {}) {
  const reasoning = {
    type: "reasoning",
    id: "rs_1",
    status: "completed",
    summary: [],
    content: [{ type: "reasoning_text", text: "Check current sources." }],
  };
  const search = {
    type: "web_search_call",
    id: "ws_1",
    status: "completed",
    action: {
      type: "search",
      query: "DeepSeek V4 release",
      sources: [{ url: "https://api-docs.deepseek.com/news", title: "DeepSeek News" }],
    },
  };
  const message = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: "The current V4 models support server-side search.",
        annotations: [
          {
            type: "url_citation",
            url: "https://api-docs.deepseek.com/guides/responses_api",
            title: "Responses API",
            start_index: 0,
            end_index: 7,
          },
        ],
      },
    ],
  };
  const functionCall = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "lookup_local",
    arguments: '{"key":"release"}',
    status: "completed",
  };
  const output = includeFunctionCall
    ? [reasoning, search, message, functionCall]
    : [reasoning, search, message];
  const events = [{ type: "response.created", response: { id: "resp_1" } }];
  for (const [outputIndex, item] of output.entries()) {
    events.push(
      { type: "response.output_item.added", output_index: outputIndex, item },
      { type: "response.output_item.done", output_index: outputIndex, item },
    );
  }
  events.push({
    type: "response.completed",
    response: {
      id: "resp_1",
      model: "deepseek-v4-flash",
      status: "completed",
      ...(terminalOutput ? { output } : {}),
      usage: {
        input_tokens: 18,
        output_tokens: 12,
        total_tokens: 30,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 4 },
      },
    },
  });
  return { events, output };
}

test("DeepSeek formal provider normalizes onto the native Responses API", () => {
  assert.equal(deepseek.DEEPSEEK_RESPONSES_API, "deepseek-responses");
  assert.equal(
    deepseek.normalizeDeepSeekResponsesBaseUrl("https://api.deepseek.com/v1/chat/completions/"),
    "https://api.deepseek.com",
  );
  assert.equal(
    deepseek.normalizeDeepSeekResponsesBaseUrl("https://api.deepseek.com/v1/responses"),
    "https://api.deepseek.com",
  );
  assert.equal(
    deepseek.normalizeDeepSeekResponsesBaseUrl("https://api.deepseek.com"),
    "https://api.deepseek.com",
  );
  assert.equal(
    deepseek.normalizeDeepSeekResponsesBaseUrl("https://relay.example.test"),
    "https://relay.example.test/v1",
  );
  assert.equal(
    deepseek.normalizeDeepSeekResponsesBaseUrl("https://relay.example.test/deepseek"),
    "https://relay.example.test/deepseek/v1",
  );
  assert.equal(
    deepseek.normalizeDeepSeekResponsesBaseUrl("https://relay.example.test/deepseek/v1"),
    "https://relay.example.test/deepseek/v1",
  );
  assert.equal(
    deepseek.normalizeDeepSeekResponsesBaseUrl(
      "https://relay.example.test/deepseek/v1/chat/completions",
    ),
    "https://relay.example.test/deepseek/v1",
  );
  assert.equal(
    deepseek.normalizeDeepSeekResponsesEndpoint("https://relay.example.test"),
    "https://relay.example.test/v1/responses",
  );
  assert.equal(
    deepseek.normalizeDeepSeekResponsesEndpoint(
      "https://relay.example.test/deepseek/v1/chat/completions",
    ),
    "https://relay.example.test/deepseek/v1/responses",
  );
  assert.equal(
    deepseek.normalizeDeepSeekResponsesBaseUrl("http://127.0.0.1:18080/proxy/deepseek", {
      officialHost: true,
    }),
    "http://127.0.0.1:18080/proxy/deepseek",
  );
  assert.equal(
    deepseek.normalizeDeepSeekResponsesBaseUrl("http://127.0.0.1:18080/proxy/deepseek", {
      officialHost: false,
    }),
    "http://127.0.0.1:18080/proxy/deepseek/v1",
  );

  const model = createModelFromConfig(
    "deepseek",
    "deepseek-v4-pro",
    "https://api.deepseek.com/v1/chat/completions/",
    "openai-completions",
  );
  assert.equal(model.api, deepseek.DEEPSEEK_RESPONSES_API);
  assert.equal(model.provider, "deepseek");
  assert.equal(model.baseUrl, "https://api.deepseek.com");
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.compat.supportsStrictMode, false);

  const officialViaProxy = createModelFromConfig(
    "deepseek",
    "deepseek-v4-flash",
    "http://127.0.0.1:18080/proxy/deepseek",
    "deepseek-responses",
    undefined,
    "https://api.deepseek.com",
  );
  assert.equal(officialViaProxy.baseUrl, "http://127.0.0.1:18080/proxy/deepseek");

  const relayViaProxy = createModelFromConfig(
    "deepseek",
    "deepseek-v4-flash",
    "http://127.0.0.1:18080/proxy/deepseek",
    "deepseek-responses",
    undefined,
    "https://relay.example.test",
  );
  assert.equal(relayViaProxy.baseUrl, "http://127.0.0.1:18080/proxy/deepseek/v1");

  const relayBare = createModelFromConfig(
    "deepseek",
    "deepseek-v4-flash",
    "https://relay.example.test",
  );
  assert.equal(relayBare.baseUrl, "https://relay.example.test/v1");

  const codex = createModelFromConfig(
    "codex",
    "deepseek-v4-flash",
    "https://relay.example.test/v1",
    "openai-completions",
  );
  assert.equal(codex.api, "openai-completions");
  assert.equal(codex.provider, "openai");

  const claude = createModelFromConfig(
    "claude_code",
    "deepseek-v4-flash",
    "https://api.deepseek.com/anthropic",
  );
  assert.equal(claude.api, "anthropic-messages");
  assert.equal(claude.provider, "anthropic");
});

test("DeepSeek streams official Responses SSE without DONE and preserves search output", async () => {
  const model = createModel();
  const context = createContext({
    tools: [
      {
        name: "lookup_local",
        description: "Look up local metadata",
        parameters: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
        },
      },
    ],
  });
  const { events: wireEvents, output } = completedSearchResponseEvents();
  const calls = [];
  const responses = [];
  const options = finalizeProviderStreamOptions({
    providerId: "deepseek",
    baseUrl: model.baseUrl,
    model,
    context,
    nativeWebSearch: true,
    options: {
      apiKey: "sk-test",
      reasoning: "high",
      maxTokens: 4_096,
      toolChoice: "auto",
      streamRetry: { disabled: true },
      onResponse(response) {
        responses.push(response);
      },
      async fetch(url, init) {
        calls.push({
          url: String(url),
          init,
          payload: JSON.parse(String(init.body)),
        });
        return responseFromEvents(wireEvents);
      },
    },
  });

  const { events, result } = await consume(streamSimpleByApi(model, context, options));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/responses");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer sk-test");
  assert.equal(calls[0].payload.model, "deepseek-v4-flash");
  assert.equal(calls[0].payload.stream, true);
  assert.equal(calls[0].payload.max_output_tokens, 4_096);
  assert.deepEqual(calls[0].payload.reasoning, { effort: "high" });
  assert.deepEqual(
    calls[0].payload.tools.map((tool) => tool.type),
    ["function", "web_search"],
  );
  for (const unsupported of [
    "store",
    "include",
    "prompt_cache_key",
    "prompt_cache_retention",
    "prompt_cache_options",
    "stream_options",
  ]) {
    assert.equal(unsupported in calls[0].payload, false, unsupported);
  }
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 200);
  assert.equal(events.at(-1).type, "done");
  assert.equal(result.stopReason, "toolUse");
  assert.equal(result.responseId, "resp_1");
  assert.deepEqual(
    result.content.map((block) => block.type),
    ["thinking", "text", "toolCall"],
  );
  assert.equal(result.content[1].text, "The current V4 models support server-side search.");
  assert.deepEqual(result.content[2].arguments, { key: "release" });
  assert.deepEqual(result.deepSeekResponseState, { output });
  assert.deepEqual(result.usage, {
    input: 15,
    output: 12,
    cacheRead: 3,
    cacheWrite: 0,
    reasoning: 4,
    totalTokens: 30,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("DeepSeek disabled thinking sends official Responses effort none", async () => {
  const model = createModelFromConfig(
    "deepseek",
    "deepseek-v4-flash",
    "https://api.deepseek.com",
  );
  const calls = [];
  const options = finalizeProviderStreamOptions({
    providerId: "deepseek",
    baseUrl: model.baseUrl,
    model,
    context: createContext(),
    options: {
      apiKey: "sk-test",
      deepSeekThinking: "disabled",
      streamRetry: { disabled: true },
      async fetch(_url, init) {
        calls.push(JSON.parse(String(init.body)));
        return responseFromEvents(
          completedSearchResponseEvents({ includeFunctionCall: false }).events,
        );
      },
    },
  });

  await consume(streamSimpleByApi(model, createContext(), options));

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].reasoning, { effort: "none" });

  // Agent path never sets deepSeekThinking; off is just a missing reasoning
  // level. Responses still defaults to thinking=high unless effort is none.
  calls.length = 0;
  const agentOptions = finalizeProviderStreamOptions({
    providerId: "deepseek",
    baseUrl: model.baseUrl,
    model,
    context: createContext(),
    options: {
      apiKey: "sk-test",
      streamRetry: { disabled: true },
      async fetch(_url, init) {
        calls.push(JSON.parse(String(init.body)));
        return responseFromEvents(
          completedSearchResponseEvents({ includeFunctionCall: false }).events,
        );
      },
    },
  });
  await consume(streamSimpleByApi(model, createContext(), agentOptions));
  assert.deepEqual(calls[0].reasoning, { effort: "none" });
});

test("DeepSeek search capture falls back to ordered output-item events", async () => {
  const model = createModel();
  const context = createContext();
  const { events, output } = completedSearchResponseEvents({
    includeFunctionCall: false,
    terminalOutput: false,
  });
  const stream = deepseek.streamDeepSeekResponses(model, context, {
    apiKey: "sk-test",
    streamRetry: { disabled: true },
    fetch: async () => responseFromEvents(events),
  });
  const { result } = await consume(stream);

  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.deepSeekResponseState, { output });
});

test("DeepSeek payload replays complete search output and remaps orphaned tool results", () => {
  const firstOutput = [
    { type: "reasoning", id: "rs_first", content: [] },
    {
      type: "web_search_call",
      id: "ws_first",
      status: "completed",
      action: { query: "first query" },
    },
    {
      type: "message",
      id: "msg_first",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "first answer", annotations: [] }],
    },
    {
      type: "function_call",
      id: "fc_first",
      call_id: "call_first",
      name: "lookup_local",
      arguments: '{"key":"first"}',
    },
  ];
  const secondOutput = [
    { type: "reasoning", id: "rs_second", content: [] },
    {
      type: "web_search_call",
      id: "ws_second",
      status: "completed",
      action: { query: "second query" },
    },
    {
      type: "message",
      id: "msg_second",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "second answer", annotations: [] }],
    },
  ];
  const context = createContext({
    messages: [
      { role: "user", content: "first", timestamp: 1 },
      assistant({
        model: "deepseek-v4-flash",
        content: [
          {
            type: "thinking",
            thinking: "first reasoning",
            thinkingSignature: JSON.stringify(firstOutput[0]),
          },
          { type: "text", text: "first answer" },
          {
            type: "toolCall",
            id: "call_first|fc_first",
            name: "lookup_local",
            arguments: { key: "first" },
          },
        ],
        state: firstOutput,
      }),
      { role: "user", content: "second", timestamp: 3 },
      assistant({
        model: "deepseek-v4-pro",
        timestamp: 4,
        content: [
          {
            type: "thinking",
            thinking: "second reasoning",
            thinkingSignature: JSON.stringify(secondOutput[0]),
          },
          { type: "text", text: "second answer" },
        ],
        state: secondOutput,
      }),
      { role: "user", content: "continue", timestamp: 5 },
    ],
  });
  const generatedInput = [
    { role: "developer", content: "You are precise." },
    { role: "user", content: [{ type: "input_text", text: "first" }] },
    {
      type: "message",
      id: "msg_pi_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "first reasoning", annotations: [] }],
    },
    {
      type: "message",
      id: "msg_pi_1_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "first answer", annotations: [] }],
    },
    {
      type: "function_call",
      call_id: "call_first_fc_first",
      name: "lookup_local",
      arguments: '{"key":"first"}',
    },
    {
      type: "function_call_output",
      call_id: "call_first_fc_first",
      output: "No result provided",
    },
    { role: "user", content: [{ type: "input_text", text: "second" }] },
    secondOutput[0],
    {
      type: "message",
      id: "msg_pi_3",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "second answer", annotations: [] }],
    },
    { role: "user", content: [{ type: "input_text", text: "continue" }] },
  ];

  const normalized = payloadCompat.normalizeDeepSeekResponsesPayload(
    {
      model: "deepseek-v4-pro",
      input: generatedInput,
      previous_response_id: "unsupported",
      conversation: "unsupported",
      store: false,
      background: true,
      metadata: { source: "unsupported" },
      include: ["reasoning.encrypted_content"],
      prompt: { id: "unsupported" },
      truncation: "auto",
      service_tier: "auto",
      safety_identifier: "unsupported",
      prompt_cache_key: "unsupported",
      prompt_cache_retention: "24h",
      prompt_cache_options: { mode: "explicit" },
      context_management: [{ type: "compaction" }],
      stream_options: { include_usage: true },
      reasoning: { effort: "high", summary: "auto" },
    },
    context,
    createModel({ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }),
  );

  assert.deepEqual(normalized.reasoning, { effort: "high" });
  for (const unsupported of [
    "previous_response_id",
    "conversation",
    "store",
    "background",
    "metadata",
    "include",
    "prompt",
    "truncation",
    "service_tier",
    "safety_identifier",
    "prompt_cache_key",
    "prompt_cache_retention",
    "prompt_cache_options",
    "context_management",
    "stream_options",
  ]) {
    assert.equal(unsupported in normalized, false, unsupported);
  }
  assert.deepEqual(normalized.input, [
    generatedInput[0],
    generatedInput[1],
    ...firstOutput,
    { ...generatedInput[5], call_id: "call_first" },
    generatedInput[6],
    ...secondOutput,
    generatedInput[9],
  ]);
});

test("DeepSeek replay state is provider-scoped and requires a web search call", () => {
  const context = createContext({
    systemPrompt: undefined,
    messages: [
      { role: "user", content: "hello", timestamp: 1 },
      assistant({
        provider: "openai",
        api: "openai-responses",
        content: [{ type: "text", text: "foreign" }],
        state: [{ type: "web_search_call", id: "foreign" }],
      }),
      assistant({
        content: [{ type: "text", text: "no search" }],
        state: [{ type: "message", id: "plain" }],
      }),
    ],
  });
  const input = [
    { role: "user", content: [{ type: "input_text", text: "hello" }] },
    { type: "message", id: "foreign-generated" },
    { type: "message", id: "plain-generated" },
  ];

  const normalized = payloadCompat.normalizeDeepSeekResponsesPayload(
    { input },
    context,
    createModel(),
  );
  assert.deepEqual(normalized.input, input);
});

test("DeepSeek rejects image input before sending a request", async () => {
  let fetchCalled = false;
  const stream = deepseek.streamDeepSeekResponses(
    createModel(),
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
    {
      apiKey: "sk-test",
      fetch: async () => {
        fetchCalled = true;
        throw new Error("fetch should not run");
      },
    },
  );
  const { events, result } = await consume(stream);

  assert.equal(fetchCalled, false);
  assert.equal(events.at(-1).type, "error");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /does not support image input/);
});

test("DeepSeek degrades image tool results to text instead of failing the request", async () => {
  // Regression: a Browser screenshot (or Read on an image) used to throw
  // "does not support image tool results" before fetch, and since the tool
  // result stays in history every later turn failed the same way.
  const screenshotBase64 = "/9j/4AAQSkZJRgABAQAAAQABAAD".repeat(64);
  const calls = [];
  const context = createContext({
    messages: [
      { role: "user", content: "screenshot the page", timestamp: 1 },
      assistant({
        content: [
          {
            type: "toolCall",
            id: "call_shot|browser-1",
            name: "Browser",
            arguments: { action: "screenshot" },
          },
        ],
        stopReason: "toolUse",
      }),
      {
        role: "toolResult",
        toolCallId: "call_shot|browser-1",
        toolName: "Browser",
        content: [
          { type: "text", text: "Page: http://127.0.0.1:8899/\nScreenshot captured (see image below)." },
          { type: "image", data: screenshotBase64, mimeType: "image/jpeg" },
        ],
        details: { kind: "browser", action: "screenshot", hasScreenshot: true },
        isError: false,
        timestamp: 3,
      },
      { role: "user", content: "skip the failing item and continue", timestamp: 4 },
    ],
    tools: [
      {
        name: "Browser",
        description: "browser",
        parameters: { type: "object", properties: {}, additionalProperties: true },
      },
    ],
  });
  const stream = deepseek.streamDeepSeekResponses(createModel(), context, {
    apiKey: "sk-test",
    streamRetry: { disabled: true },
    fetch: async (_url, init) => {
      calls.push(JSON.parse(String(init.body)));
      return responseFromEvents(
        completedSearchResponseEvents({ includeFunctionCall: false }).events,
      );
    },
  });
  const { result } = await consume(stream);

  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(calls.length, 1);
  const wire = JSON.stringify(calls[0]);
  assert.ok(!wire.includes(screenshotBase64), "screenshot bytes must not reach the wire");
  assert.ok(!wire.includes("input_image"), "no image parts may reach the wire");

  const toolOutput = calls[0].input.find((item) => item.type === "function_call_output");
  assert.ok(toolOutput, "tool result must still be sent");
  assert.equal(toolOutput.call_id, "call_shot");
  assert.equal(typeof toolOutput.output, "string");
  assert.match(toolOutput.output, /Screenshot captured/);
  assert.match(toolOutput.output, /1 image omitted from this tool result/);
  assert.match(toolOutput.output, /deepseek-v4-flash.*does not accept image input/);

  // The caller's context is not mutated: the UI keeps rendering the image.
  assert.equal(context.messages[2].content[1].type, "image");
});
