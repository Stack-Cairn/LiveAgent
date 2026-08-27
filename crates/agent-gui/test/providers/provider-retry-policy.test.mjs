import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

/**
 * PR-2 供应商级重试策略（feat-llm-retry-policy）单元测试：
 *
 * 1. normalizeProviderRetryPolicy 归一化矩阵——非法/缺省一律落 default
 *    （不落字段），custom 的 maxRetries（不含首次请求）钳位 1..10，旧配置
 *    零迁移；
 * 2. createProviderRuntimeConfig 唯一构造点透传 retryPolicy；
 * 3. resolveStreamRetryConfig 三种 mode 的消费方合并语义——缺省时不带
 *    maxAttempts/disabled（等价于反转前的全局默认行为），custom 时把用户
 *    口径的重试次数换算为 withStreamRetry 的总尝试数（+1）；
 * 4. failover 逐候选策略独立：每个候选按各自 runtime 解析出不同的
 *    streamRetry 配置；
 * 5. UI 展示镜像常量与 streamRetry.ts 运行时真源一致（重试数 = 总尝试数-1）。
 */

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const { normalizeProviderRetryPolicy, normalizeCustomProvider } = settings;
const { createProviderRuntimeConfig } = loader.loadModule(
  "src/lib/providers/runtime/providerRuntimeConfig.ts",
);
const { resolveStreamRetryConfig } = loader.loadModule("src/lib/providers/runtime/retryPolicy.ts");
const { DEFAULT_STREAM_RETRY_MAX_ATTEMPTS } = loader.loadModule(
  "src/lib/providers/runtime/streamRetry.ts",
);

// ---------------------------------------------------------------------------
// 1. 归一化矩阵
// ---------------------------------------------------------------------------

test("normalizeProviderRetryPolicy: default/非法输入一律返回 undefined（不落字段）", () => {
  for (const input of [
    undefined,
    null,
    {},
    "off",
    42,
    { mode: "default" },
    { mode: "always" },
    { mode: "custom" },
    { mode: "custom", maxRetries: "3" },
    { mode: "custom", maxRetries: Number.NaN },
    { mode: "custom", maxRetries: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal(
      normalizeProviderRetryPolicy(input),
      undefined,
      `input ${JSON.stringify(input)} must normalize to undefined`,
    );
  }
});

test("normalizeProviderRetryPolicy: off 与 custom 的合法形态", () => {
  assert.deepEqual(normalizeProviderRetryPolicy({ mode: "off" }), { mode: "off" });
  assert.deepEqual(normalizeProviderRetryPolicy({ mode: "off", maxRetries: 5 }), { mode: "off" });
  assert.deepEqual(normalizeProviderRetryPolicy({ mode: "custom", maxRetries: 3 }), {
    mode: "custom",
    maxRetries: 3,
  });
});

test("normalizeProviderRetryPolicy: custom maxRetries 钳位 1..10 且取整", () => {
  assert.deepEqual(normalizeProviderRetryPolicy({ mode: "custom", maxRetries: 0 }), {
    mode: "custom",
    maxRetries: 1,
  });
  assert.deepEqual(normalizeProviderRetryPolicy({ mode: "custom", maxRetries: -5 }), {
    mode: "custom",
    maxRetries: 1,
  });
  assert.deepEqual(normalizeProviderRetryPolicy({ mode: "custom", maxRetries: 99 }), {
    mode: "custom",
    maxRetries: 10,
  });
  assert.deepEqual(normalizeProviderRetryPolicy({ mode: "custom", maxRetries: 2.6 }), {
    mode: "custom",
    maxRetries: 3,
  });
});

test("normalizeCustomProvider: 旧配置（无 retryPolicy）零迁移——归一化结果不含该字段", () => {
  const provider = normalizeCustomProvider({
    id: "legacy-1",
    name: "Legacy",
    type: "claude_code",
    baseUrl: "https://relay.example/v1",
    apiKey: "k",
    models: [],
    activeModels: [],
  });
  assert.ok(!("retryPolicy" in provider), "legacy provider must not gain a retryPolicy field");
});

test("normalizeCustomProvider: 配置了 retryPolicy 时原样保留", () => {
  const provider = normalizeCustomProvider({
    id: "p-1",
    name: "P",
    type: "claude_code",
    baseUrl: "https://relay.example/v1",
    apiKey: "k",
    models: [],
    activeModels: [],
    retryPolicy: { mode: "custom", maxRetries: 2 },
  });
  assert.deepEqual(provider.retryPolicy, { mode: "custom", maxRetries: 2 });

  const offProvider = normalizeCustomProvider({
    id: "p-2",
    name: "P2",
    type: "claude_code",
    baseUrl: "https://relay.example/v1",
    apiKey: "k",
    models: [],
    activeModels: [],
    retryPolicy: { mode: "off" },
  });
  assert.deepEqual(offProvider.retryPolicy, { mode: "off" });
});

// ---------------------------------------------------------------------------
// 2. 唯一构造点透传
// ---------------------------------------------------------------------------

function createProvider(overrides = {}) {
  return {
    id: "provider-1",
    name: "Relay",
    type: "claude_code",
    baseUrl: "https://relay.example/v1",
    isFullUrl: true,
    apiKey: "test-key",
    models: [],
    activeModels: [],
    promptCachingEnabled: true,
    useSystemProxy: false,
    ...overrides,
  };
}

test("createProviderRuntimeConfig: retryPolicy 经唯一构造点透传", () => {
  const runtime = createProviderRuntimeConfig(
    createProvider({ retryPolicy: { mode: "custom", maxRetries: 2 } }),
    "claude-sonnet-4-6",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );
  assert.deepEqual(runtime.retryPolicy, { mode: "custom", maxRetries: 2 });
});

test("createProviderRuntimeConfig: 未配置 retryPolicy 时 runtime 不含该字段", () => {
  const runtime = createProviderRuntimeConfig(
    createProvider(),
    "claude-sonnet-4-6",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );
  assert.ok(!("retryPolicy" in runtime), "unset policy must not appear on the runtime config");
});

// ---------------------------------------------------------------------------
// 3. 消费方合并语义
// ---------------------------------------------------------------------------

test("resolveStreamRetryConfig: default（缺省）返回空对象——withStreamRetry 落全局默认", () => {
  assert.deepEqual(resolveStreamRetryConfig(undefined), {});
});

test("resolveStreamRetryConfig: off 返回 disabled:true", () => {
  assert.deepEqual(resolveStreamRetryConfig({ mode: "off" }), { disabled: true });
});

test("resolveStreamRetryConfig: custom 把重试次数换算为总尝试数（maxRetries+1）", () => {
  assert.deepEqual(resolveStreamRetryConfig({ mode: "custom", maxRetries: 2 }), {
    maxAttempts: 3,
  });
  assert.deepEqual(resolveStreamRetryConfig({ mode: "custom", maxRetries: 1 }), {
    maxAttempts: 2,
  });
});

test("resolveStreamRetryConfig: 与消费方回调展开合并后互不覆盖", () => {
  const onRetry = () => {};
  const onRetryRecovered = () => {};
  const merged = {
    ...resolveStreamRetryConfig({ mode: "custom", maxRetries: 4 }),
    onRetry,
    onRetryRecovered,
  };
  assert.equal(merged.maxAttempts, 5);
  assert.equal(merged.onRetry, onRetry);
  assert.equal(merged.onRetryRecovered, onRetryRecovered);
  assert.ok(!("disabled" in merged));

  const mergedDefault = { ...resolveStreamRetryConfig(undefined), onRetry, onRetryRecovered };
  assert.deepEqual(Object.keys(mergedDefault).sort(), ["onRetry", "onRetryRecovered"]);
});

// ---------------------------------------------------------------------------
// 4. failover 逐候选策略独立
// ---------------------------------------------------------------------------

test("failover 候选按各自 runtime 解析出独立的重试配置", () => {
  const primary = createProviderRuntimeConfig(
    createProvider({ id: "primary", retryPolicy: { mode: "custom", maxRetries: 2 } }),
    "claude-sonnet-4-6",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );
  const fallbackOff = createProviderRuntimeConfig(
    createProvider({ id: "fallback-off", retryPolicy: { mode: "off" } }),
    "claude-sonnet-4-6",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );
  const fallbackDefault = createProviderRuntimeConfig(
    createProvider({ id: "fallback-default" }),
    "claude-sonnet-4-6",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );

  assert.deepEqual(resolveStreamRetryConfig(primary.retryPolicy), { maxAttempts: 3 });
  assert.deepEqual(resolveStreamRetryConfig(fallbackOff.retryPolicy), { disabled: true });
  assert.deepEqual(resolveStreamRetryConfig(fallbackDefault.retryPolicy), {});
});

// ---------------------------------------------------------------------------
// 5. UI 展示镜像常量与运行时真源一致
// ---------------------------------------------------------------------------

test("PROVIDER_RETRY_DEFAULT_MAX_RETRIES 与 DEFAULT_STREAM_RETRY_MAX_ATTEMPTS-1 一致", () => {
  assert.equal(settings.PROVIDER_RETRY_DEFAULT_MAX_RETRIES, DEFAULT_STREAM_RETRY_MAX_ATTEMPTS - 1);
});
