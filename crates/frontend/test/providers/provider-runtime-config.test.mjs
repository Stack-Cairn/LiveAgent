import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Battle 2: this suite now drives crates/core, the engine that actually ships.
// The frontend copy under src/lib was a duplicate and has been removed.
// crates/core modules that talk to the Rust backend read this at import time.
process.env.LIVEAGENT_BACKEND_PORT ??= "0";
const coreRootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)), "../core");
const coreSrc = (rel) => path.join(coreRootDir, "src", rel);


const loader = createTsModuleLoader();
const { createProviderRuntimeConfig } = loader.loadModule(
  coreSrc("providers/runtime/providerRuntimeConfig.ts"),
);
const settings = loader.loadModule("src/lib/settings/index.ts");
// core 漂移：createProviderRuntimeConfig 新增必填第 4 参 providerIdentities
// （PR #289 之后强制显式传入，防止调用点漏传静默丢头），测试用默认身份。
const { getDefaultCliIdentitySettings } = loader.loadModule(
  coreSrc("providers/cliIdentityCore.ts"),
);
const IDENTITIES = getDefaultCliIdentitySettings();

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
    IDENTITIES,
  );

  assert.equal(runtime.baseUrl, "https://relay.example/v1");
  assert.equal(runtime.apiKey, "test-key");
  // core 漂移：托管 CLI 身份供应商（claude_code 非 OAuth key）会注入 CLI
  // 身份 User-Agent 头，用户自定义头保留在其后；不再是"原样透传"。
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
    IDENTITIES,
  );
  assert.equal(thinkingOff.reasoning, "off");

  // 不支持思考的模型一律拿到 undefined，绝不下发无效档位（Cron / 记忆整理
  // 以前绕过工厂手搓 runtime，正是会踩到这里）。
  const unsupported = createProviderRuntimeConfig(
    createProvider({ type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }),
    "gemini-embedding-001",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
    IDENTITIES,
  );
  assert.equal(unsupported.reasoning, undefined);
});
