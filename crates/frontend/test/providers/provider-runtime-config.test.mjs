import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createProviderRuntimeConfig } = loader.loadModule(
  "src/lib/providers/runtime/providerRuntimeConfig.ts",
);
const settings = loader.loadModule("src/lib/settings/index.ts");
const { getDefaultCliIdentitySettings } = loader.loadModule(
  "src/lib/providers/cliIdentityCore.ts",
);

function createProvider(overrides = {}) {
  return {
    id: "provider-1",
    name: "Relay",
    type: "claude_code",
    baseUrl: "https://relay.example/v1",
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
    getDefaultCliIdentitySettings(),
  );

  assert.equal(runtime.baseUrl, "https://relay.example/v1");
  assert.equal(runtime.apiKey, "test-key");
  // 全局身份补出的 User-Agent 排在自定义头之前，原有自定义头一并保留。
  assert.deepEqual(runtime.customHeaders, [
    { key: "User-Agent", value: "claude-cli/2.1.71 (external, cli)" },
    { key: "X-Trace-Id", value: "abc" },
  ]);
  assert.equal(runtime.promptCachingEnabled, true);
  assert.equal(runtime.promptCacheRetention, "long");
  assert.equal(runtime.useSystemProxy, true);
  assert.equal(runtime.nativeWebSearchEnabled, true);

  for (const field of [
    "baseUrl",
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

test("createProviderRuntimeConfig gates reasoning on model support", () => {
  const thinkingOff = createProviderRuntimeConfig(
    createProvider(),
    "claude-sonnet-4-6",
    {
      ...settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
      thinkingEnabled: false,
    },
    getDefaultCliIdentitySettings(),
  );
  assert.equal(thinkingOff.reasoning, "off");

  // 不支持思考的模型一律拿到 undefined，绝不下发无效档位（Cron / 记忆整理
  // 以前绕过工厂手搓 runtime，正是会踩到这里）。
  const unsupported = createProviderRuntimeConfig(
    createProvider({ type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }),
    "gemini-embedding-001",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
    getDefaultCliIdentitySettings(),
  );
  assert.equal(unsupported.reasoning, undefined);
});
