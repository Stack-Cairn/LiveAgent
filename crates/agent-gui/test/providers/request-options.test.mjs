import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const providers = loader.loadModule("src/lib/providers/llm.ts");
const proxy = loader.loadModule("src/lib/providers/proxy.ts");
const customHeaderHelpers = loader.loadModule("src/lib/providers/customHeaders.ts");
const providerUtils = loader.loadModule("src/pages/settings/providerUtils.ts");

function createMockAssistantStream() {
  return {
    async *[Symbol.asyncIterator]() {},
    async result() {
      return {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "deepseek-v4-flash",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "stop",
        timestamp: 1,
      };
    },
  };
}

function createDeepSeekAnthropicModel(id = "deepseek-v4-flash") {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function loadProvidersWithCapturedAnthropicStream() {
  const state = {};
  const localLoader = createTsModuleLoader({
    mocks: {
      "@earendil-works/pi-ai/api/anthropic-messages": {
        stream(model, context, options) {
          state.captured = { model, context, options };
          return createMockAssistantStream();
        },
      },
    },
  });
  return {
    localProviders: localLoader.loadModule("src/lib/providers/llm.ts"),
    state,
  };
}

test("llm facade preserves provider runtime exports", () => {
  const expectedFunctionExports = [
    "assistantMessageToText",
    "attachAnthropicAutomaticCaching",
    "attachCodexResponsesStorage",
    "attachPayloadDebugLogging",
    "attachProviderNativeWebSearch",
    "buildAnthropicAuthHeaders",
    "buildGeminiAuthHeaders",
    "buildOpenAIAuthHeaders",
    "buildProviderRequestHeaders",
    "buildProviderRequestMetadata",
    "isValidCustomHeaderKey",
    "prepareProviderRequest",
    "createProviderRuntimeConfig",
    "completeAssistantMessage",
    "composePayloadMiddlewares",
    "createModelFromConfig",
    "createStreamingTextReconciler",
    "finalizeProviderStreamOptions",
    "normalizeErrorMessage",
    "parseModelValue",
    "providerSupportsNativeWebSearch",
    "resolveProviderCacheRetention",
    "streamAssistantMessage",
    "streamSimpleByApi",
    "toModelValue",
    "toSimpleStreamReasoning",
  ];

  for (const exportName of expectedFunctionExports) {
    assert.equal(typeof providers[exportName], "function", `${exportName} should be exported`);
  }
});

test("proxy base URL builder validates upstream URLs and carries origin separately", () => {
  assert.deepEqual(
    proxy.buildProxyBaseUrl("codex", "https://api.openai.com/v1/responses", "http://127.0.0.1:18080/"),
    {
      baseUrl: "http://127.0.0.1:18080/proxy/codex/v1/responses",
      upstreamOrigin: "https://api.openai.com",
    },
  );

  assert.throws(
    () => proxy.buildProxyBaseUrl("codex", "https://user:pass@example.com/v1", "http://proxy"),
    /embedded username or password/,
  );
  assert.throws(
    () => proxy.buildProxyBaseUrl("codex", "https://example.com/v1?x=1", "http://proxy"),
    /query parameters or fragments/,
  );
  assert.throws(
    () => proxy.buildProxyBaseUrl("codex", "not-a-url", "http://proxy"),
    /absolute URL/,
  );
});

test("image proxy URL builder encodes the source URL", () => {
  assert.equal(
    proxy.buildImageProxyUrl("https://example.com/path/photo.png?size=large#view", "http://127.0.0.1:18080/"),
    "http://127.0.0.1:18080/image-proxy?url=https%3A%2F%2Fexample.com%2Fpath%2Fphoto.png%3Fsize%3Dlarge%23view",
  );
  assert.throws(
    () => proxy.buildImageProxyUrl("file:///tmp/photo.png", "http://proxy"),
    /http:\/\/ or https:\/\//,
  );
  assert.throws(
    () => proxy.buildImageProxyUrl("https://user:pass@example.com/photo.png", "http://proxy"),
    /embedded username or password/,
  );
});

test("provider request helpers normalize auth, metadata, errors, and model values", () => {
  assert.deepEqual(providers.buildAnthropicAuthHeaders("secret"), {
    "x-api-key": "secret",
  });
  assert.deepEqual(providers.buildOpenAIAuthHeaders("secret"), {
    Authorization: "Bearer secret",
  });
  assert.deepEqual(providers.buildGeminiAuthHeaders("secret"), {
    "x-goog-api-key": "secret",
  });
  assert.deepEqual(
    providers.buildProviderRequestHeaders("claude_code", "secret", "conversation-1"),
    {
      "x-api-key": "secret",
      "x-app": "cli",
      "Content-Type": "application/json",
      "X-Stainless-OS": "MacOS",
      "X-Stainless-Arch": "arm64",
      "X-Stainless-Lang": "js",
      "anthropic-version": "2023-06-01",
      "X-Stainless-Runtime": "node",
      "X-Stainless-Timeout": "600",
      "x-stainless-retry-count": "0",
      "X-Stainless-Package-Version": "0.74.0",
      "X-Stainless-Runtime-Version": "v22.19.0",
      "anthropic-dangerous-direct-browser-access": "true",
    },
  );
  assert.deepEqual(
    providers.buildProviderRequestHeaders("claude_code", "sk-ant-oat01-test", "conversation-1"),
    {},
  );
  assert.deepEqual(providers.buildProviderRequestHeaders("codex", "secret", "conversation-1"), {
    Authorization: "Bearer secret",
    session_id: "conversation-1",
    conversation_id: "conversation-1",
  });
  // Responses 格式显式指定时保持 Codex CLI 的会话身份头。
  assert.deepEqual(
    providers.buildProviderRequestHeaders("codex", "secret", "conversation-1", "openai-responses"),
    {
      Authorization: "Bearer secret",
      session_id: "conversation-1",
      conversation_id: "conversation-1",
    },
  );
  // 标准 Chat Completions 是无状态协议：只带 Authorization，
  // 不带 session_id/conversation_id。
  assert.deepEqual(
    providers.buildProviderRequestHeaders(
      "codex",
      "secret",
      "conversation-1",
      "openai-completions",
    ),
    {
      Authorization: "Bearer secret",
    },
  );
  assert.deepEqual(providers.buildProviderRequestHeaders("gemini", "secret", "conversation-1"), {
    "x-goog-api-key": "secret",
  });
  // xai：Bearer，不带 Codex CLI 的 session 头。
  assert.deepEqual(providers.buildProviderRequestHeaders("xai", "secret", "conversation-1"), {
    Authorization: "Bearer secret",
  });
  const generatedCodexHeaders = providers.buildProviderRequestHeaders("codex", "secret");
  assert.match(generatedCodexHeaders.session_id, /^[0-9a-f-]{36}$/i);
  assert.equal(generatedCodexHeaders.conversation_id, generatedCodexHeaders.session_id);
  assert.equal(providers.toSimpleStreamReasoning("off"), undefined);
  assert.equal(providers.toSimpleStreamReasoning("high"), "high");
  assert.equal(providers.toSimpleStreamReasoning("max"), "max");
  assert.deepEqual(providers.buildProviderRequestMetadata("claude_code", " session-1 "), {
    user_id: "session-1",
  });
  assert.equal(providers.buildProviderRequestMetadata("codex", "session-1"), undefined);
  assert.equal(
    providers.providerSupportsNativeWebSearch("codex", "openai-responses"),
    true,
  );
  assert.equal(
    providers.providerSupportsNativeWebSearch("claude_code", "anthropic-messages"),
    true,
  );
  assert.equal(
    providers.providerSupportsNativeWebSearch("gemini", "google-generative-ai"),
    true,
  );
  assert.equal(
    providers.providerSupportsNativeWebSearch("codex", "openai-completions"),
    false,
  );
  assert.equal(
    providers.providerSupportsNativeWebSearch("codex", "openai-completions", {
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o-search-preview",
    }),
    true,
  );
  assert.equal(
    providers.providerSupportsNativeWebSearch("codex", "openai-completions", {
      baseUrl: "https://api.example.test/v1",
      modelId: "gpt-4o-search-preview",
    }),
    true,
  );
  assert.equal(
    providers.providerSupportsNativeWebSearch("codex", "openai-completions", {
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o",
    }),
    false,
  );
  assert.equal(providers.toModelValue("provider", "model::with::separator"), "provider::model::with::separator");
  assert.deepEqual(providers.parseModelValue("provider::model::with::separator"), {
    customProviderId: "provider",
    model: "model::with::separator",
  });
  assert.equal(providers.parseModelValue("bad"), null);
  assert.equal(
    providers.normalizeErrorMessage('prefix {"error":{"message":"nested failure"}}'),
    "nested failure",
  );
});

test("provider-specific custom header suggestions include standard model headers", () => {
  const anthropicPresets = customHeaderHelpers.getCustomHeaderKeyPresets("claude_code");
  assert.ok(!anthropicPresets.includes("User-Agent"));
  assert.ok(anthropicPresets.includes("Content-Type"));
  assert.ok(anthropicPresets.includes("anthropic-version"));
  assert.ok(anthropicPresets.includes("X-Stainless-Runtime-Version"));
  assert.ok(anthropicPresets.includes("anthropic-dangerous-direct-browser-access"));
  assert.ok(!anthropicPresets.includes("anthropic-beta"));
  assert.ok(!anthropicPresets.includes("session_id"));

  const codexPresets = customHeaderHelpers.getCustomHeaderKeyPresets("codex");
  assert.ok(!codexPresets.includes("User-Agent"));
  assert.ok(codexPresets.includes("session_id"));
  assert.ok(codexPresets.includes("conversation_id"));
  assert.ok(!codexPresets.includes("anthropic-version"));

  const xaiPresets = customHeaderHelpers.getCustomHeaderKeyPresets("xai");
  assert.ok(!xaiPresets.includes("User-Agent"));
  assert.ok(!xaiPresets.includes("session_id"));
  assert.ok(!xaiPresets.includes("anthropic-version"));
});

function decodeUpstreamHeaderOverrides(encoded) {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

test("upstream override channel carries every non-auth header for the local proxy hop", () => {
  // 这些头名里 user-agent 会被 WebView 的 fetch 静默丢弃，靠覆盖包才能送达上游。
  const encoded = proxy.encodeUpstreamHeaderOverrides({
    "user-agent": "custom-agent/1.0",
    "CONTENT-TYPE": "application/custom+json",
    Cookie: "session=abc",
    "X-Request-ID": "trace-1",
    Authorization: "Bearer secret",
    "x-api-key": "secret",
    "x-goog-api-key": "secret",
    "x-liveagent-proxy-token": "internal",
  });

  assert.deepEqual(decodeUpstreamHeaderOverrides(encoded), {
    "user-agent": "custom-agent/1.0",
    "CONTENT-TYPE": "application/custom+json",
    Cookie: "session=abc",
    "X-Request-ID": "trace-1",
  });
});

test("upstream override channel stays empty when there is nothing to override", () => {
  assert.equal(proxy.encodeUpstreamHeaderOverrides({}), undefined);
  assert.equal(
    proxy.encodeUpstreamHeaderOverrides({ Authorization: "Bearer secret" }),
    undefined,
  );
});

test("upstream override channel rejects oversized custom header sets", () => {
  assert.throws(
    () => proxy.encodeUpstreamHeaderOverrides({ "X-Big": "v".repeat(9 * 1024) }),
    /too large/i,
  );
});

test("anthropic-beta never enters the upstream override package", () => {
  // 覆盖包在 prepareProxyRequest 时刻构建，早于长上下文中间件算出 anthropic-beta；
  // 它是保留头（用户填不进来），因此绝不会回头压掉中间件的 beta 串。
  const base = providers.buildProviderRequestHeaders("claude_code", "secret");
  const merged = customHeaderHelpers.mergeCustomHeaders(base, [
    { key: "anthropic-beta", value: "hijacked" },
  ]);
  const overrides = decodeUpstreamHeaderOverrides(proxy.encodeUpstreamHeaderOverrides(merged));
  assert.ok(
    !Object.keys(overrides).some((key) => key.toLowerCase() === "anthropic-beta"),
    "anthropic-beta must stay owned by attachAnthropicLongContextBeta",
  );
});

test("gemini models use native google api metadata", () => {
  const model = providers.createModelFromConfig(
    "gemini",
    "gemini-3.5-flash",
    "http://127.0.0.1:18080/proxy/gemini",
    undefined,
    { id: "gemini-3.5-flash", contextWindow: 123_456, maxOutputToken: 7_890 },
  );

  assert.equal(model.api, "google-generative-ai");
  assert.equal(model.provider, "google");
  assert.equal(model.baseUrl, "http://127.0.0.1:18080/proxy/gemini/v1beta");
  assert.equal(model.contextWindow, 123_456);
  assert.equal(model.maxTokens, 7_890);
  assert.deepEqual(model.input, ["text", "image"]);
});

test("custom Codex Responses models prefer native image-capable input metadata", () => {
  const model = providers.createModelFromConfig(
    "codex",
    "custom-responses-model",
    "https://api.openai.com/v1",
    "openai-responses",
  );

  assert.equal(model.api, "openai-responses");
  assert.deepEqual(model.input, ["text", "image"]);
});

test("third-party Codex Responses models use the system role compatibility mode", () => {
  const custom = providers.createModelFromConfig(
    "codex",
    "custom-responses-model",
    "https://relay.example.test/v1",
    "openai-responses",
  );
  const known = providers.createModelFromConfig(
    "codex",
    "gpt-5",
    "https://relay.example.test/v1",
    "openai-responses",
  );
  const proxiedOfficial = providers.createModelFromConfig(
    "codex",
    "gpt-5",
    "http://127.0.0.1:18080/proxy/codex/v1",
    "openai-responses",
    undefined,
    "https://api.openai.com/v1",
  );

  assert.equal(custom.compat.supportsDeveloperRole, false);
  assert.equal(known.compat.supportsDeveloperRole, false);
  assert.notEqual(proxiedOfficial.compat?.supportsDeveloperRole, false);
});

test("custom Codex models append v1 to bare and prefixed base URLs", () => {
  const bare = providers.createModelFromConfig(
    "codex",
    "custom-responses-model",
    "https://api.openai.com",
    "openai-responses",
  );
  const prefixed = providers.createModelFromConfig(
    "codex",
    "custom-responses-model",
    "https://openrouter.ai/api",
    "openai-responses",
  );
  const proxied = providers.createModelFromConfig(
    "codex",
    "custom-chat-model",
    "http://127.0.0.1:18080/proxy/codex",
    "openai-completions",
    undefined,
    "https://api.openai.com",
  );

  assert.equal(bare.baseUrl, "https://api.openai.com/v1");
  assert.equal(prefixed.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(proxied.baseUrl, "http://127.0.0.1:18080/proxy/codex/v1");
});

test("custom Codex Chat Completions models keep text-only input metadata", () => {
  const model = providers.createModelFromConfig(
    "codex",
    "custom-chat-model",
    "https://api.openai.com/v1",
    "openai-completions",
  );

  assert.equal(model.api, "openai-completions");
  assert.deepEqual(model.input, ["text"]);
});

test("custom Codex Chat Completions GPT vision models infer image input metadata", () => {
  const model = providers.createModelFromConfig(
    "codex",
    "gpt-5.5",
    "https://api.openai.com/v1",
    "openai-completions",
  );

  assert.equal(model.api, "openai-completions");
  assert.deepEqual(model.input, ["text", "image"]);
});

test("custom Codex Chat Completions search preview models stay text-only", () => {
  const model = providers.createModelFromConfig(
    "codex",
    "gpt-4o-search-preview",
    "https://api.openai.com/v1",
    "openai-completions",
  );

  assert.equal(model.api, "openai-completions");
  assert.deepEqual(model.input, ["text"]);
});

test("custom Codex Chat Completions models infer reasoning-capable IDs", () => {
  const model = providers.createModelFromConfig(
    "codex",
    "deepseek-v4-flash",
    "https://api.example.test/v1",
    "openai-completions",
  );

  assert.equal(model.api, "openai-completions");
  assert.equal(model.reasoning, true);
  assert.equal(model.compat.supportsDeveloperRole, false);
  assert.equal(model.compat.supportsStore, false);
});

test("custom Codex Chat Completions models behind proxy use upstream compat detection", () => {
  const model = providers.createModelFromConfig(
    "codex",
    "deepseek-v4-flash",
    "http://127.0.0.1:18080/proxy/codex/v1",
    "openai-completions",
    undefined,
    "https://www.packyapi.com/v1",
  );

  assert.equal(model.api, "openai-completions");
  assert.equal(model.compat.supportsDeveloperRole, false);
  assert.equal(model.compat.supportsStore, false);
});

test("official OpenAI Chat Completions models behind proxy keep native compat", () => {
  const model = providers.createModelFromConfig(
    "codex",
    "gpt-5.5",
    "http://127.0.0.1:18080/proxy/codex/v1",
    "openai-completions",
    undefined,
    "https://api.openai.com/v1",
  );

  assert.equal(model.api, "openai-completions");
  assert.equal(model.compat, undefined);
});

test("Codex Chat Completions streams forward reasoning effort", async () => {
  let captured;
  const localLoader = createTsModuleLoader({
    mocks: {
      "@earendil-works/pi-ai/api/openai-completions": {
        stream(model, context, options) {
          captured = { model, context, options };
          return createMockAssistantStream();
        },
      },
    },
  });
  const localProviders = localLoader.loadModule("src/lib/providers/llm.ts");
  const model = localProviders.createModelFromConfig(
    "codex",
    "deepseek-v4-flash",
    "https://api.example.test/v1",
    "openai-completions",
  );

  const result = localProviders.streamSimpleByApi(
    model,
    {
      // toolChoice 只在请求真正携带 tools 时下发（无工具下发会被严格
      // OpenAI 兼容端点 400），透传断言需要一个非空 tools。
      tools: [{ name: "echo", description: "Echo tool", parameters: { type: "object" } }],
      messages: [],
    },
    { reasoning: "high", toolChoice: "auto" },
  );

  assert.equal(typeof result.result, "function");
  await result.result();
  assert.equal(captured.options.reasoningEffort, "high");
  assert.equal(captured.options.toolChoice, "auto");
});

test("DeepSeek OpenAI payload adapter maps reasoning=max to reasoning_effort=max (regression)", async () => {
  let captured;
  const localLoader = createTsModuleLoader({
    mocks: {
      "@earendil-works/pi-ai/api/openai-completions": {
        stream(model, context, options) {
          captured = { model, context, options };
          return createMockAssistantStream();
        },
      },
    },
  });
  const localProviders = localLoader.loadModule("src/lib/providers/llm.ts");
  const model = localProviders.createModelFromConfig(
    "codex",
    "deepseek-v4-pro",
    "https://api.deepseek.com",
    "openai-completions",
  );

  const result = localProviders.streamSimpleByApi(
    model,
    { messages: [] },
    { reasoning: "max", toolChoice: "auto" },
  );
  assert.equal(typeof result.result, "function");
  assert.equal(typeof captured.options.onPayload, "function");
  assert.equal(
    captured.options.reasoningEffort,
    "max",
    "clampOpenAIReasoningEffort should preserve max for deepseek-v4-pro",
  );

  const adapted = await captured.options.onPayload(
    {
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Read", arguments: "{}" },
            },
          ],
        },
      ],
    },
    model,
  );

  assert.deepEqual(adapted.thinking, { type: "enabled" });
  assert.equal(
    adapted.reasoning_effort,
    "max",
    "wire reasoning_effort should be max when UI selects max",
  );
  assert.equal(adapted.messages[0].reasoning_content, "");
});

test("DeepSeek Anthropic streamSimpleByApi strips aborted tool calls before conversion", () => {
  const { localProviders, state } = loadProvidersWithCapturedAnthropicStream();
  const model = createDeepSeekAnthropicModel();
  const call = {
    type: "toolCall",
    id: "call_00_nLOhBvpTvol41FPkbuXA2605",
    name: "web_search",
    arguments: { query: "weibo-like-someone" },
  };

  const result = localProviders.streamSimpleByApi(
    model,
    {
      messages: [
        { role: "user", content: "search", timestamp: 1 },
        {
          role: "assistant",
          api: "anthropic-messages",
          provider: "anthropic",
          model: "deepseek-v4-flash",
          content: [{ type: "text", text: "Searching" }, call],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: "aborted",
          timestamp: 2,
        },
      ],
    },
    {},
  );

  assert.equal(typeof result.result, "function");
  assert.deepEqual(
    state.captured.context.messages[1].content.map((block) => block.type),
    ["text"],
  );
  assert.equal(state.captured.context.messages[1].stopReason, "stop");
});

test("DeepSeek Anthropic streamSimpleByApi preserves structured tool payload blocks", async () => {
  const { localProviders, state } = loadProvidersWithCapturedAnthropicStream();
  const model = createDeepSeekAnthropicModel();

  const result = localProviders.streamSimpleByApi(model, { messages: [] }, {});
  assert.equal(typeof result.result, "function");
  assert.equal(typeof state.captured.options.onPayload, "function");

  const repaired = await state.captured.options.onPayload(
    {
      messages: [
        { role: "user", content: "search" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Searching" },
            {
              type: "tool_use",
              id: "call_00_uZnge7Q4VzkEWduraWXP2609",
              name: "Read",
              input: { path: "README.md" },
            },
          ],
        },
        { role: "user", content: "continue" },
      ],
    },
    model,
  );

  assert.deepEqual(
    repaired.messages[1].content.map((block) => block.type),
    ["thinking", "text", "tool_use"],
  );
  assert.deepEqual(repaired.thinking, { type: "disabled" });
  assert.equal(repaired.messages[1].content[0].signature, "");
  assert.equal(repaired.messages[1].content[2].id, "call_00_uZnge7Q4VzkEWduraWXP2609");
  assert.deepEqual(repaired.messages[2], {
    role: "user",
    content: "continue",
  });
  assert.equal(
    repaired.messages.some((message) =>
      message.content?.some?.(
        (block) => block.type === "tool_use" || block.type === "tool_result",
      ),
    ),
    true,
  );
});

test("DeepSeek Anthropic streamSimpleByApi preserves completed multi-tool history", () => {
  const { localProviders, state } = loadProvidersWithCapturedAnthropicStream();
  const model = createDeepSeekAnthropicModel();
  const bashA = {
    type: "toolCall",
    id: "call_00_ktXYHUFf9l425bsRQ5nv0526",
    name: "Bash",
    arguments: { command: "curl -s https://example.test/a" },
  };
  const bashB = {
    type: "toolCall",
    id: "call_01_ioRsTy54g6ycIuCEuFY52808",
    name: "Bash",
    arguments: { command: "curl -s https://example.test/b" },
  };

  const result = localProviders.streamSimpleByApi(
    model,
    {
      messages: [
        { role: "user", content: "search", timestamp: 1 },
        {
          role: "assistant",
          api: "anthropic-messages",
          provider: "anthropic",
          model: "deepseek-v4-flash",
          content: [
            { type: "thinking", thinking: "Need more data", thinkingSignature: "sig-a" },
            { type: "text", text: "I will fetch more files." },
            bashA,
            bashB,
          ],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: bashA.id,
          toolName: "Bash",
          content: [{ type: "text", text: "result a" }],
          isError: false,
          timestamp: 3,
        },
        {
          role: "toolResult",
          toolCallId: bashB.id,
          toolName: "Bash",
          content: [{ type: "text", text: "result b" }],
          isError: false,
          timestamp: 4,
        },
        { role: "user", content: "continue", timestamp: 5 },
      ],
    },
    {},
  );

  assert.equal(typeof result.result, "function");
  assert.equal(
    state.captured.context.messages.some((message) => message.role === "toolResult"),
    true,
  );
  assert.equal(
    state.captured.context.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some((block) => block.type === "toolCall"),
    ),
    true,
  );
  assert.equal(state.captured.context.messages[1].stopReason, "toolUse");
  assert.equal(state.captured.context.messages[2].toolCallId, bashA.id);
  assert.equal(state.captured.context.messages[3].toolCallId, bashB.id);
});

test("gemini model base URL normalizes full generate endpoints", () => {
  const model = providers.createModelFromConfig(
    "gemini",
    "gemini-2.5-pro",
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
  );

  assert.equal(model.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
});

test("gemini model list normalization uses models array metadata", () => {
  const models = providerUtils.normalizeFetchedModels(
    [
      {
        name: "models/gemini-3.5-flash",
        inputTokenLimit: 1_048_576,
        outputTokenLimit: 65_536,
        supportedGenerationMethods: ["generateContent", "countTokens"],
      },
      {
        name: "models/text-embedding-004",
        supportedGenerationMethods: ["embedContent"],
      },
      {
        name: "models/gemini-3.5-flash",
        supportedGenerationMethods: ["generateContent"],
      },
    ],
    "gemini",
  );

  assert.deepEqual(models, [
    {
      id: "gemini-3.5-flash",
      contextWindow: 1_048_576,
      maxOutputToken: 65_536,
    },
  ]);
});

test("payload middleware composer preserves previous-hook-first order", async () => {
  const makeTraceMiddleware = (name) => (options) => {
    const previousOnPayload = options.onPayload;
    return {
      ...options,
      onPayload: async (payload, model) => {
        let nextPayload = payload;
        if (previousOnPayload) {
          const overridden = await previousOnPayload(nextPayload, model);
          if (overridden !== undefined) {
            nextPayload = overridden;
          }
        }
        return {
          ...nextPayload,
          trace: [...(nextPayload.trace ?? []), name],
        };
      },
    };
  };
  const composed = providers.composePayloadMiddlewares([
    makeTraceMiddleware("first"),
    makeTraceMiddleware("second"),
  ]);

  const options = composed(
    {
      onPayload: async (payload) => ({
        ...payload,
        trace: [...(payload.trace ?? []), "base"],
      }),
    },
    {
      providerId: "codex",
      baseUrl: "https://api.openai.com/v1",
      options: {},
    },
  );
  const payload = await options.onPayload(
    { input: "hello" },
    { api: "openai-responses", provider: "openai", id: "gpt-5" },
  );

  assert.deepEqual(payload.trace, ["base", "first", "second"]);
});

test("codex responses payloads always opt into upstream storage after previous payload hooks", async () => {
  const options = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    options: {
      onPayload: async (payload) => ({ ...payload, previousHook: true }),
    },
  });

  const nextPayload = await options.onPayload(
    { input: "hello" },
    { api: "openai-responses", provider: "openai", id: "gpt-5" },
  );

  assert.deepEqual(nextPayload, {
    input: "hello",
    previousHook: true,
    store: true,
  });
});

test("provider native web search injection is opt-in", async () => {
  const codexOptions = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    options: {},
  });
  const codexPayload = await codexOptions.onPayload(
    { input: "hello" },
    { api: "openai-responses", provider: "openai", id: "gpt-5" },
  );
  assert.equal(codexPayload.store, true);
  assert.equal(codexPayload.tools, undefined);

  const anthropicOptions = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://api.anthropic.com/v1",
    options: {},
  });
  assert.equal(anthropicOptions.onPayload, undefined);

  // Gemini always carries the thought-signature guard, so the hook exists;
  // opting out of native web search must leave the payload untouched.
  const geminiOptions = providers.finalizeProviderStreamOptions({
    providerId: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    options: {},
  });
  const geminiPayload = {
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    config: { tools: [{ functionDeclarations: [{ name: "Bash" }] }] },
  };
  const geminiResult = await geminiOptions.onPayload(geminiPayload, {
    api: "google-generative-ai",
    provider: "google",
    id: "gemini-3-pro-preview",
  });
  assert.equal(geminiResult, geminiPayload);
});

test("provider payload finalization enables native web search for hosted search providers", async () => {
  const codexOptions = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    nativeWebSearch: true,
    options: {},
  });
  const codexPayload = await codexOptions.onPayload(
    { input: "hello" },
    { api: "openai-responses", provider: "openai", id: "gpt-5" },
  );
  assert.equal(codexPayload.store, true);
  assert.deepEqual(codexPayload.tools, [{ type: "web_search" }]);

  const codexChatOptions = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    nativeWebSearch: true,
    options: {},
  });
  const codexChatPayload = await codexChatOptions.onPayload(
    { messages: [{ role: "user", content: "hello" }] },
    { api: "openai-completions", provider: "openai", id: "gpt-4o-search-preview" },
  );
  assert.deepEqual(codexChatPayload.web_search_options, {
    search_context_size: "medium",
  });
  assert.equal(codexChatPayload.tools, undefined);

  const codexChatCompatiblePayload = await codexChatOptions.onPayload(
    { messages: [{ role: "user", content: "hello" }] },
    { api: "openai-completions", provider: "openai", id: "deepseek-v4-flash" },
  );
  assert.equal(codexChatCompatiblePayload.web_search_options, undefined);

  const compatibleCodexChatOptions = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.example.test/v1",
    nativeWebSearch: true,
    options: {},
  });
  const compatibleCodexChatPayload = await compatibleCodexChatOptions.onPayload(
    { messages: [{ role: "user", content: "hello" }] },
    { api: "openai-completions", provider: "openai", id: "deepseek-v4-flash" },
  );
  assert.deepEqual(compatibleCodexChatPayload.tools, [
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current information when the answer needs recent or external context.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The web search query.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
  ]);
  assert.equal(compatibleCodexChatPayload.web_search_options, undefined);

  const anthropicOptions = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://api.anthropic.com/v1",
    nativeWebSearch: true,
    options: {},
  });
  const anthropicPayload = await anthropicOptions.onPayload(
    { messages: [{ role: "user", content: "hello" }] },
    { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet" },
  );
  assert.deepEqual(anthropicPayload.tools, [
    { type: "web_search_20250305", name: "web_search" },
  ]);

  // Modern Anthropic models get the paired web_fetch server tool alongside
  // web_search; legacy/unknown catalog entries (above) keep search-only.
  const anthropicModernPayload = await anthropicOptions.onPayload(
    { messages: [{ role: "user", content: "hello" }] },
    {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-sonnet-5",
      compat: { forceAdaptiveThinking: true },
    },
  );
  assert.deepEqual(anthropicModernPayload.tools, [
    { type: "web_search_20260318", name: "web_search" },
    {
      type: "web_fetch_20260318",
      name: "web_fetch",
      max_uses: 10,
      max_content_tokens: 50_000,
    },
  ]);

  const geminiOptions = providers.finalizeProviderStreamOptions({
    providerId: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    nativeWebSearch: true,
    options: {},
  });
  const geminiPayload = await geminiOptions.onPayload(
    { contents: [], config: {} },
    { api: "google-generative-ai", provider: "google", id: "gemini-3.5-pro" },
  );
  assert.deepEqual(geminiPayload.config.tools, [{ googleSearch: {} }]);
});

test("DeepSeek Anthropic endpoint enables DSML tool-call stream repair", () => {
  const deepseekOptions = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://api.deepseek.com/anthropic",
    options: {},
    model: {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "deepseek-chat",
    },
  });
  assert.equal(deepseekOptions.deepSeekDsmlToolCallRepair, true);
  assert.equal(deepseekOptions.deepSeekProviderAdapter, true);
  assert.equal(deepseekOptions.deepSeekAnthropicPayloadToolBlockFlattening, undefined);

  const anthropicOptions = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://api.anthropic.com/v1",
    options: {},
    model: {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    },
  });
  assert.equal(anthropicOptions.deepSeekDsmlToolCallRepair, undefined);
});

test("DeepSeek Anthropic payload adapter attaches from base URL even before model is known", async () => {
  const options = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://api.deepseek.com/anthropic",
    options: {},
  });

  assert.equal(options.deepSeekDsmlToolCallRepair, true);
  assert.equal(options.deepSeekProviderAdapter, true);
  const adapted = await options.onPayload(
    {
      messages: [
        { role: "user", content: "search" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Searching" },
            {
              type: "tool_use",
              id: "call_00_nLOhBvpTvol41FPkbuXA2605",
              name: "Read",
              input: { path: "README.md" },
            },
          ],
        },
        { role: "user", content: "continue" },
      ],
    },
    { api: "anthropic-messages", provider: "anthropic", id: "deepseek-v4-flash" },
  );

  assert.deepEqual(
    adapted.messages[1].content.map((block) => block.type),
    ["thinking", "text", "tool_use"],
  );
  assert.deepEqual(adapted.thinking, { type: "disabled" });
  assert.equal(adapted.messages[1].content[2].id, "call_00_nLOhBvpTvol41FPkbuXA2605");
  assert.equal(
    adapted.messages.some((message) =>
      message.content?.some?.(
        (block) => block.type === "tool_use" || block.type === "tool_result",
      ),
    ),
    true,
  );
});

test("DeepSeek Anthropic payload adapter preserves mixed tool_use and tool_result blocks", async () => {
  const options = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://api.deepseek.com/anthropic",
    options: {},
    model: {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "deepseek-v4-flash",
    },
  });

  const adapted = await options.onPayload(
    {
      messages: [
        { role: "user", content: "search" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Searching" },
            {
              type: "tool_use",
              id: "dsml-tool-call-023b41c5",
              name: "builtin_web_search",
              input: { additionalContext: "first query" },
            },
            {
              type: "tool_use",
              id: "call-read-1",
              name: "Read",
              input: { path: "README.md" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "continue" },
            {
              type: "tool_result",
              tool_use_id: "dsml-tool-call-68ce79de",
              content: "late existing result",
            },
            {
              type: "tool_result",
              tool_use_id: "call-read-1",
              content: "read result",
            },
          ],
        },
      ],
    },
    { api: "anthropic-messages", provider: "anthropic", id: "deepseek-chat" },
  );

  assert.deepEqual(
    adapted.messages[1].content.map((block) => block.type),
    ["thinking", "text", "tool_use", "tool_use"],
  );
  assert.equal(adapted.messages[1].content[2].id, "dsml-tool-call-023b41c5");
  assert.deepEqual(
    adapted.messages[2].content.map((block) => block.type),
    ["text", "tool_result", "tool_result"],
  );
  assert.equal(adapted.messages[2].content[2].content, "read result");
  assert.equal(
    adapted.messages.some((message) =>
      message.content?.some?.(
        (block) => block.type === "tool_use" || block.type === "tool_result",
      ),
    ),
    true,
  );
});

test("provider native web search avoids unsupported OpenAI minimal reasoning", async () => {
  const options = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    nativeWebSearch: true,
    options: {},
  });
  const payload = await options.onPayload(
    { input: "hello", reasoning: { effort: "minimal" } },
    { api: "openai-responses", provider: "openai", id: "gpt-5" },
  );
  assert.deepEqual(payload.reasoning, { effort: "low" });
  assert.deepEqual(payload.tools, [{ type: "web_search" }]);

  const newerModelPayload = await options.onPayload(
    { input: "hello", reasoning: { effort: "minimal" } },
    { api: "openai-responses", provider: "openai", id: "gpt-5.5" },
  );
  assert.deepEqual(newerModelPayload.reasoning, { effort: "minimal" });
  assert.deepEqual(newerModelPayload.tools, [{ type: "web_search" }]);
});

test("provider native web search injection preserves existing search tools", async () => {
  const codexOptions = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    nativeWebSearch: true,
    options: {},
  });
  const codexPayload = await codexOptions.onPayload(
    { tools: [{ type: "web_search_2025_08_26" }] },
    { api: "openai-responses", provider: "openai", id: "gpt-5" },
  );
  assert.deepEqual(codexPayload.tools, [{ type: "web_search_2025_08_26" }]);

  const compatibleCodexChatOptions = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.example.test/v1",
    nativeWebSearch: true,
    options: {},
  });
  const compatibleCodexChatPayload = await compatibleCodexChatOptions.onPayload(
    { tools: [{ type: "function", function: { name: "web_search" } }] },
    { api: "openai-completions", provider: "openai", id: "deepseek-v4-flash" },
  );
  assert.deepEqual(compatibleCodexChatPayload.tools, [
    { type: "function", function: { name: "web_search" } },
  ]);

  const anthropicOptions = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://api.anthropic.com/v1",
    nativeWebSearch: true,
    options: {},
  });
  const anthropicPayload = await anthropicOptions.onPayload(
    { tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }] },
    { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet" },
  );
  assert.deepEqual(anthropicPayload.tools, [
    { type: "web_search_20260209", name: "web_search", max_uses: 2 },
  ]);

  const geminiOptions = providers.finalizeProviderStreamOptions({
    providerId: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    nativeWebSearch: true,
    options: {},
  });
  const geminiPayload = await geminiOptions.onPayload(
    { config: { tools: [{ googleSearch: { searchTypes: ["WEB_SEARCH"] } }] } },
    { api: "google-generative-ai", provider: "google", id: "gemini-3.5-pro" },
  );
  assert.deepEqual(geminiPayload.config.tools, [
    { googleSearch: { searchTypes: ["WEB_SEARCH"] } },
  ]);
});

test("anthropic automatic caching uses top-level cache control for Anthropic origin", async () => {
  const options = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://api.anthropic.com/v1",
    options: {
      cacheRetention: "long",
    },
  });

  const payload = await options.onPayload(
    {
      messages: [{ role: "user", content: "hello" }],
    },
    { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet" },
  );

  assert.deepEqual(payload.cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(payload.messages, [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]);
});

test("anthropic-compatible proxies get an explicit cache breakpoint on the last cacheable block", async () => {
  const options = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://proxy.example.com/anthropic",
    options: {
      cacheRetention: "short",
    },
  });

  const payload = await options.onPayload(
    {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private", cache_control: { type: "old" } },
            { type: "text", text: "visible" },
          ],
        },
      ],
    },
    { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet" },
  );

  assert.equal(payload.cache_control, undefined);
  assert.equal(payload.messages[0].content[0].cache_control, undefined);
  assert.deepEqual(payload.messages[0].content[1].cache_control, { type: "ephemeral" });
});

test("streaming text reconciler emits only missing final text suffixes", () => {
  const reconciler = providers.createStreamingTextReconciler();
  assert.equal(reconciler.appendDelta("round-1", "hel"), "hel");
  assert.equal(reconciler.appendDelta("round-1", "lo"), "lo");
  assert.equal(reconciler.reconcileFinalText("round-1", "hello world"), " world");
  assert.equal(reconciler.reconcileFinalText("round-1", "different"), "");
  assert.equal(reconciler.reconcileFinalText("round-2", "new"), "new");
});

test("custom provider headers merge without mutating the base headers", () => {
  const base = { Accept: "application/json", "X-Tenant": "old" };
  assert.deepEqual(
    customHeaderHelpers.mergeCustomHeaders(base, [
      { key: "X-Tenant", value: "new" },
      { key: "X-Request-ID", value: "request-123" },
    ]),
    { Accept: "application/json", "X-Tenant": "new", "X-Request-ID": "request-123" },
  );
  assert.deepEqual(base, { Accept: "application/json", "X-Tenant": "old" });
});

test("custom provider headers override model defaults but not credential or protocol headers", () => {
  const base = {
    Authorization: "Bearer real",
    "x-api-key": "real-api-key",
    "x-goog-api-key": "real-google-key",
    "anthropic-beta": "context-1m-2025-08-07",
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
    Host: "api.example.com",
    "Content-Length": "42",
  };
  assert.deepEqual(
    customHeaderHelpers.mergeCustomHeaders(base, [
      { key: "authorization", value: "Bearer attacker" },
      { key: "X-API-KEY", value: "attacker" },
      { key: "X-GOOG-API-KEY", value: "attacker" },
      { key: "Anthropic-Beta", value: "custom-beta" },
      { key: "Anthropic-Version", value: "attacker" },
      { key: "content-type", value: "text/plain" },
      { key: "host", value: "attacker.example" },
      { key: "content-length", value: "0" },
    ]),
    {
      Authorization: "Bearer real",
      "x-api-key": "real-api-key",
      "x-goog-api-key": "real-google-key",
      "anthropic-beta": "context-1m-2025-08-07",
      "Anthropic-Version": "attacker",
      "content-type": "text/plain",
      Host: "api.example.com",
      "Content-Length": "42",
    },
  );
});

test("custom provider headers filter invalid HTTP token keys", () => {
  assert.deepEqual(
    customHeaderHelpers.mergeCustomHeaders({}, [
      { key: "", value: "empty" },
      { key: "Bad Header", value: "space" },
      { key: "Bad:Header", value: "colon" },
      { key: "Bad\nHeader", value: "newline" },
      { key: "X.Valid-Header_1", value: "kept" },
    ]),
    { "X.Valid-Header_1": "kept" },
  );
  assert.equal(providers.isValidCustomHeaderKey("anthropic-beta"), true);
  assert.equal(customHeaderHelpers.isReservedCustomHeaderKey("Anthropic-Beta"), true);
  assert.equal(providers.isValidCustomHeaderKey("X-Request-ID"), true);
  assert.equal(providers.isValidCustomHeaderKey("Bad Header"), false);
  // 本地反代的内部命名空间不可被自定义头注入。
  assert.equal(customHeaderHelpers.isReservedCustomHeaderKey("X-LiveAgent-Proxy-Token"), true);
  assert.equal(customHeaderHelpers.isReservedCustomHeaderKey("x-liveagent-anything"), true);
});

test("custom provider headers reject values fetch() cannot transmit", () => {
  assert.equal(customHeaderHelpers.isValidCustomHeaderValue("plain-ascii/1.0"), true);
  assert.equal(customHeaderHelpers.isValidCustomHeaderValue(""), true);
  assert.equal(customHeaderHelpers.isValidCustomHeaderValue("中文"), false);
  assert.equal(customHeaderHelpers.isValidCustomHeaderValue("a\r\nb"), false);
  assert.deepEqual(
    customHeaderHelpers.mergeCustomHeaders({}, [
      { key: "X-Bad", value: "中文" },
      { key: "X-Injected", value: "a\r\nHost: evil" },
      { key: "X-Good", value: "kept" },
    ]),
    { "X-Good": "kept" },
  );
});

test("custom provider headers accept undefined and empty arrays", () => {
  const base = { Accept: "application/json" };
  assert.deepEqual(customHeaderHelpers.mergeCustomHeaders(base, undefined), base);
  assert.deepEqual(customHeaderHelpers.mergeCustomHeaders(base, []), base);
});

test("resolveProviderCacheRetention maps provider settings and per-request overrides", () => {
  const resolve = providers.resolveProviderCacheRetention;
  assert.equal(resolve("claude_code", true), "short");
  assert.equal(resolve("claude_code", undefined), "short");
  assert.equal(resolve("claude_code", true, undefined, "long"), "long");
  assert.equal(resolve("claude_code", false, undefined, "long"), "none");
  // 请求级 override（压缩/标题等辅助请求）永远优先于供应商偏好。
  assert.equal(resolve("claude_code", true, "none", "long"), "none");
  assert.equal(resolve("codex", undefined), "short");
  assert.equal(resolve("codex", false), "none");
  assert.equal(resolve("codex", true, "none"), "none");
  // long 档位仅对 Anthropic 生效。
  assert.equal(resolve("codex", true, undefined, "long"), "short");
  assert.equal(resolve("gemini", true), undefined);
});

test("codex payloads get a stable prompt_cache_key on relay hosts", async () => {
  const options = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://relay.example/v1",
    options: { sessionId: "conv-1234", cacheRetention: "short" },
  });

  const completionsPayload = await options.onPayload(
    { messages: [] },
    { api: "openai-completions", provider: "openai", id: "relay-model" },
  );
  assert.equal(completionsPayload.prompt_cache_key, "conv-1234");

  const responsesPayload = await options.onPayload(
    { input: "hello" },
    { api: "openai-responses", provider: "openai", id: "relay-model" },
  );
  assert.equal(responsesPayload.prompt_cache_key, "conv-1234");
});

test("codex prompt_cache_key injection respects retention, existing keys, and length", async () => {
  const disabled = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://relay.example/v1",
    options: { sessionId: "conv-1234", cacheRetention: "none" },
  });
  const disabledPayload = await disabled.onPayload(
    { messages: [] },
    { api: "openai-completions", provider: "openai", id: "relay-model" },
  );
  assert.equal(disabledPayload.prompt_cache_key, undefined);

  const preset = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://relay.example/v1",
    options: {
      sessionId: "conv-1234",
      cacheRetention: "short",
      onPayload: async (payload) => ({ ...payload, prompt_cache_key: "explicit-key" }),
    },
  });
  const presetPayload = await preset.onPayload(
    { messages: [] },
    { api: "openai-completions", provider: "openai", id: "relay-model" },
  );
  assert.equal(presetPayload.prompt_cache_key, "explicit-key");

  const clamped = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://relay.example/v1",
    options: { sessionId: "k".repeat(80), cacheRetention: "short" },
  });
  const clampedPayload = await clamped.onPayload(
    { messages: [] },
    { api: "openai-completions", provider: "openai", id: "relay-model" },
  );
  assert.equal(clampedPayload.prompt_cache_key, "k".repeat(64));
});

test("runtime models always carry zero pricing (billing removed)", () => {
  // 计费功能已移除：pi-ai 的 Model.cost 是结构必填字段，构造侧统一喂零价，
  // 目录内外模型一致，usage.cost 恒为 0。
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  const customModel = providers.createModelFromConfig(
    "codex",
    "relay-gpt",
    "https://relay.example/v1",
    undefined,
    { id: "relay-gpt", contextWindow: 128_000, maxOutputToken: 8_192 },
  );
  assert.deepEqual(customModel.cost, zeroCost);

  const knownModel = providers.createModelFromConfig(
    "codex",
    "gpt-5",
    "https://api.openai.com/v1",
    undefined,
    { id: "gpt-5", contextWindow: 400_000, maxOutputToken: 128_000 },
  );
  assert.deepEqual(knownModel.cost, zeroCost);

  const claudeModel = providers.createModelFromConfig(
    "claude_code",
    "claude-sonnet-4-6",
    "https://api.anthropic.com/v1",
    undefined,
    { id: "claude-sonnet-4-6", contextWindow: 1_000_000, maxOutputToken: 128_000 },
  );
  assert.deepEqual(claudeModel.cost, zeroCost);
});
