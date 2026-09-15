import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createProviderRuntimeConfig } = loader.loadModule(
  "src/lib/providers/runtime/providerRuntimeConfig.ts",
);
const settings = loader.loadModule("src/lib/settings/index.ts");

function createProvider(overrides = {}) {
  return {
    id: "provider-1",
    name: "Relay",
    type: "claude_code",
    baseUrl: "https://relay.example/v1",
    isFullUrl: true,
    apiKey: "test-key",
    customHeaders: [{ key: "X-Trace-Id", value: "abc" }],
    models: [],
    activeModels: [],
    promptCachingEnabled: true,
    promptCacheRetention: "long",
    useSystemProxy: true,
    ...overrides,
  };
}

// 工厂是 ProviderRuntimeConfig 的唯一构造点，所以“工厂自己漏字段”是唯一还能
// 复现旧 bug 的路径。这里把必须落到 runtime 上的字段逐一锁死。
test("createProviderRuntimeConfig carries every provider transport field", () => {
  const runtime = createProviderRuntimeConfig(
    createProvider(),
    "claude-sonnet-4-6",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );

  assert.equal(runtime.baseUrl, "https://relay.example/v1");
  assert.equal(runtime.isFullUrl, true);
  assert.equal(runtime.apiKey, "test-key");
  // 用户自定义头原样透传，工厂不再注入任何内置身份头。
  assert.deepEqual(runtime.customHeaders, [{ key: "X-Trace-Id", value: "abc" }]);
  assert.equal(runtime.promptCachingEnabled, true);
  assert.equal(runtime.promptCacheRetention, "long");
  assert.equal(runtime.useSystemProxy, true);
  assert.equal(runtime.nativeWebSearchEnabled, true);

  for (const field of [
    "baseUrl",
    "isFullUrl",
    "adapterProviderId",
    "chatProtocol",
    "apiKey",
    "customHeaders",
    "requestFormat",
    "reasoning",
    "promptCachingEnabled",
    "promptCacheRetention",
    "nativeWebSearchEnabled",
    "useSystemProxy",
    "modelConfig",
  ]) {
    assert.ok(field in runtime, `${field} must be present on the runtime config`);
  }
});

test("createProviderRuntimeConfig resolves a model-level protocol and endpoint", () => {
  const runtime = createProviderRuntimeConfig(
    createProvider({
      type: "codex",
      baseUrl: "https://gateway.example/v1",
      isFullUrl: false,
      defaultChatProtocol: "openai-responses",
      endpointConfigs: {
        "anthropic-messages": { baseUrl: "https://gateway.example/anthropic/v1" },
      },
      models: [
        {
          id: "claude-proxy",
          contextWindow: 200_000,
          maxOutputToken: 32_000,
          chatProtocol: "anthropic-messages",
        },
      ],
    }),
    "claude-proxy",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );

  assert.equal(runtime.chatProtocol, "anthropic-messages");
  assert.equal(runtime.adapterProviderId, "claude_code");
  assert.equal(runtime.baseUrl, "https://gateway.example/anthropic/v1");
  assert.equal(runtime.isFullUrl, false);
  assert.equal(runtime.requestFormat, undefined);
});

test("createProviderRuntimeConfig gates reasoning on model support", () => {
  const thinkingOff = createProviderRuntimeConfig(
    createProvider(),
    "claude-sonnet-4-6",
    {
      ...settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
      thinkingEnabled: false,
    },
  );
  assert.equal(thinkingOff.reasoning, "off");

  // 不支持思考的模型一律拿到 undefined，绝不下发无效档位（Cron / 记忆整理
  // 以前绕过工厂手搓 runtime，正是会踩到这里）。
  const unsupported = createProviderRuntimeConfig(
    createProvider({ type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }),
    "gemini-embedding-001",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );
  assert.equal(unsupported.reasoning, undefined);
});

test("createProviderRuntimeConfig resolves model capabilities and input modalities for the runtime", () => {
  const provider = createProvider({
    type: "codex",
    baseUrl: "https://relay.example/v1",
    models: [
      { id: "gpt-5.2", contextWindow: 400000, maxOutputToken: 128000 },
      {
        id: "no-tools",
        contextWindow: 128000,
        maxOutputToken: 32000,
        capabilities: { tools: "unsupported" },
        inputModalities: ["text", "image"],
      },
    ],
    activeModels: ["gpt-5.2", "no-tools"],
  });
  const catalog = createProviderRuntimeConfig(
    provider,
    "gpt-5.2",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );
  assert.deepEqual(catalog.capabilities.tools, { state: "supported", source: "catalog" });
  assert.equal(catalog.inputModalities.source, "catalog");
  assert.ok(catalog.inputModalities.modalities.includes("image"));

  const gated = createProviderRuntimeConfig(
    provider,
    "no-tools",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );
  assert.deepEqual(gated.capabilities.tools, { state: "unsupported", source: "user" });
  assert.deepEqual(gated.inputModalities, { modalities: ["text", "image"], source: "user" });
});
