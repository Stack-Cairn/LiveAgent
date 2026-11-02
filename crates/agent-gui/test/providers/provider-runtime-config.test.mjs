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

  assert.equal(runtime.backend, "kbrain");
  assert.equal(runtime.backendModelProvider, "provider-1");
  assert.equal(runtime.baseUrl, "");
  assert.equal(runtime.isFullUrl, false);
  assert.equal(runtime.apiKey, "");
  assert.equal(runtime.customHeaders, undefined);
  assert.equal(runtime.promptCachingEnabled, true);
  assert.equal(runtime.promptCacheRetention, "long");
  assert.equal(runtime.useSystemProxy, true);
  assert.equal(runtime.nativeWebSearchEnabled, true);

  for (const field of [
    "baseUrl",
    "isFullUrl",
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

for (const [type, requestFormat, supported] of [
  ["codex", "openai-completions", false],
  ["codex", "openai-responses", true],
  ["codex", undefined, true],
  ["gemini", undefined, true],
  ["claude_code", undefined, true],
  ["xai", undefined, true],
  ["deepseek", undefined, false],
]) {
  test(`runtime search gates ${type}/${requestFormat} without rewriting preferences`, () => {
    const provider = Object.freeze(settings.normalizeCustomProvider(createProvider({ type, requestFormat })));
    assert.equal(provider.nativeWebSearchEnabled, true);
    for (const enabled of [true, false]) {
      const controls = Object.freeze({ ...settings.DEFAULT_CHAT_RUNTIME_CONTROLS, nativeWebSearchEnabled: enabled });
      const runtime = createProviderRuntimeConfig(provider, "model", controls);
      assert.equal(runtime.nativeWebSearchEnabled, enabled && supported);
      assert.equal(controls.nativeWebSearchEnabled, enabled);
      assert.equal(provider.nativeWebSearchEnabled, true);
    }
  });
}
