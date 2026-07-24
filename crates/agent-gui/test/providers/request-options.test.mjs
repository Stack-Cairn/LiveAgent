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
    "mergeCustomHeaders",
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
      "User-Agent": "claude-cli/2.1.71 (external, cli)",
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
    "User-Agent": "codex_cli_rs/0.72.0 (Ubuntu 24.4.0; x86_64) WindowsTerminal",
    session_id: "conversation-1",
    conversation_id: "conversation-1",
  });
  // Responses 格式显式指定时保持 Codex CLI 身份头。
  assert.deepEqual(
    providers.buildProviderRequestHeaders("codex", "secret", "conversation-1", "openai-responses"),
    {
      Authorization: "Bearer secret",
      "User-Agent": "codex_cli_rs/0.72.0 (Ubuntu 24.4.0; x86_64) WindowsTerminal",
      session_id: "conversation-1",
      conversation_id: "conversation-1",
    },
  );
  // 标准 Chat Completions 是无状态协议：只带 Authorization，
  // 不带 codex_cli_rs UA 与 session_id/conversation_id。
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
  // xai：Bearer + grok CLI 身份 UA，不带 Codex CLI 的 session 头。
  assert.deepEqual(providers.buildProviderRequestHeaders("xai", "secret", "conversation-1"), {
    Authorization: "Bearer secret",
    "User-Agent": "grok-shell/0.2.110 (linux; x86_64)",
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
  assert.ok(anthropicPresets.includes("User-Agent"));
  assert.ok(anthropicPresets.includes("Content-Type"));
  assert.ok(anthropicPresets.includes("anthropic-version"));
  assert.ok(anthropicPresets.includes("X-Stainless-Runtime-Version"));
  assert.ok(anthropicPresets.includes("anthropic-dangerous-direct-browser-access"));
  assert.ok(!anthropicPresets.includes("anthropic-beta"));
  assert.ok(!anthropicPresets.includes("session_id"));

  const codexPresets = customHeaderHelpers.getCustomHeaderKeyPresets("codex");
  assert.ok(codexPresets.includes("User-Agent"));
  assert.ok(codexPresets.includes("session_id"));
  assert.ok(codexPresets.includes("conversation_id"));
  assert.ok(!codexPresets.includes("anthropic-version"));

  const xaiPresets = customHeaderHelpers.getCustomHeaderKeyPresets("xai");
  assert.ok(xaiPresets.includes("User-Agent"));
  assert.ok(!xaiPresets.includes("session_id"));
  assert.ok(!xaiPresets.includes("anthropic-version"));
});

test("local proxy preserves explicit user-agent and content-type values for the upstream hop", () => {
  assert.deepEqual(
    proxy.buildUpstreamHeaderOverrideHeaders({
      "user-agent": "custom-agent/1.0",
      "CONTENT-TYPE": "application/custom+json",
    }),
    {
      "x-liveagent-upstream-user-agent": "custom-agent/1.0",
      "x-liveagent-upstream-content-type": "application/custom+json",
    },
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

test("DeepSeek Codex models force Chat Completions compat", () => {
  const model = providers.createModelFromConfig(
    "codex",
    "deepseek-v4-pro",
    "https://api.deepseek.com",
    "openai-responses",
  );

  assert.equal(model.api, "openai-completions");
  assert.equal(model.reasoning, true);
  assert.equal(model.compat.thinkingFormat, "deepseek");
  assert.equal(model.compat.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(model.compat.supportsStrictMode, false);
  assert.equal(model.compat.maxTokensField, "max_tokens");
  assert.equal(model.thinkingLevelMap.minimal, "high");
  assert.equal(model.thinkingLevelMap.xhigh, "max");
});

test("DeepSeek OpenAI payload adapter injects thinking and reasoning_content", async () => {
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
    "openai-responses",
  );

  const result = localProviders.streamSimpleByApi(
    model,
    { messages: [] },
    { reasoning: "minimal", toolChoice: "auto" },
  );
  assert.equal(typeof result.result, "function");
  assert.equal(typeof captured.options.onPayload, "function");

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
  assert.equal(adapted.reasoning_effort, "high");
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
    providers.mergeCustomHeaders(base, [
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
    providers.mergeCustomHeaders(base, [
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
    providers.mergeCustomHeaders({}, [
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
});

test("custom provider headers accept undefined and empty arrays", () => {
  const base = { Accept: "application/json" };
  assert.deepEqual(providers.mergeCustomHeaders(base, undefined), base);
  assert.deepEqual(providers.mergeCustomHeaders(base, []), base);
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
