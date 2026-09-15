import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");

const PROVIDERS = [
  {
    id: "provider-a",
    name: "Provider A",
    type: "claude_code",
    baseUrl: "https://a.example.com",
    apiKey: "key-a",
    models: [
      { id: "model-1", contextWindow: 200000, maxOutputToken: 8192 },
      { id: "model-2", contextWindow: 200000, maxOutputToken: 8192 },
    ],
    activeModels: ["model-1", "model-2"],
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
    useSystemProxy: false,
  },
  {
    id: "provider-a2",
    name: "Provider A2",
    type: "claude_code",
    baseUrl: "https://a2.example.com",
    apiKey: "key-a2",
    models: [{ id: "model-1", contextWindow: 200000, maxOutputToken: 8192 }],
    activeModels: ["model-1"],
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
    useSystemProxy: false,
  },
  {
    id: "provider-b",
    name: "Provider B",
    type: "codex",
    baseUrl: "https://b.example.com",
    apiKey: "key-b",
    models: [{ id: "model-3", contextWindow: 128000, maxOutputToken: 8192 }],
    activeModels: ["model-3"],
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
    useSystemProxy: false,
  },
  {
    id: "provider-d",
    name: "Provider D",
    type: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "key-d",
    models: [{ id: "deepseek-chat", contextWindow: 1_000_000, maxOutputToken: 384_000 }],
    activeModels: ["deepseek-chat"],
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
    useSystemProxy: false,
  },
];

const DEFAULT_VENDOR_FAILOVER = {
  enabled: false,
  queue: [],
  maxSwitches: 3,
  failureThreshold: 4,
  cooldownSeconds: 60,
};

test("model failover defaults are off with an empty queue for every family", () => {
  const normalized = settings.normalizeModelFailoverSettings({}, PROVIDERS);
  assert.deepEqual(normalized, {
    anthropic: DEFAULT_VENDOR_FAILOVER,
    openai: DEFAULT_VENDOR_FAILOVER,
    gemini: DEFAULT_VENDOR_FAILOVER,
  });
});

test("failover credential readiness accepts GUI keys and WebUI redacted-key markers", () => {
  assert.equal(
    settings.hasProviderFailoverConfiguration({
      baseUrl: "https://provider.example.com",
      apiKey: "secret",
    }),
    true,
  );
  assert.equal(
    settings.hasProviderFailoverConfiguration({
      baseUrl: "https://provider.example.com",
      apiKey: "",
      apiKeyConfigured: true,
    }),
    true,
  );
  assert.equal(
    settings.hasProviderFailoverConfiguration({
      baseUrl: "https://provider.example.com",
      apiKey: "",
    }),
    false,
  );
  assert.equal(
    settings.hasProviderFailoverConfiguration({
      baseUrl: "",
      apiKey: "secret",
    }),
    false,
  );
});

test("queue entries are validated against same-family providers, deduped, and capped", () => {
  const normalized = settings.normalizeModelFailoverSettings(
    {
      anthropic: {
        enabled: true,
        queue: [
          "provider-a",
          "provider-a", // duplicate
          "missing-provider", // no provider
          "provider-b", // cross-vendor (codex)
          "provider-a2",
          42, // not a string or legacy object
        ],
      },
    },
    PROVIDERS,
  );
  assert.equal(normalized.anthropic.enabled, true);
  // The OpenAI-family provider must never appear in the Anthropic queue.
  assert.deepEqual(normalized.anthropic.queue, ["provider-a", "provider-a2"]);
  assert.deepEqual(normalized.openai, DEFAULT_VENDOR_FAILOVER);
});

test("failover families follow enabled endpoints only", () => {
  // 家族表只有一份：设置层的旧名是同一个数组。
  assert.equal(settings.PROVIDER_FAILOVER_FAMILIES, settings.PROVIDER_PROTOCOL_FAMILIES);

  // 无显式端点：默认 / 旧推导接口视为启用。
  assert.deepEqual(settings.providerFailoverFamilies({ type: "claude_code" }), ["anthropic"]);
  assert.deepEqual(
    settings.providerFailoverFamilies({ type: "codex", requestFormat: "openai-completions" }),
    ["openai"],
  );
  assert.deepEqual(
    settings.providerFailoverFamilies({ type: "codex", defaultChatProtocol: "google-generative-ai" }),
    ["gemini"],
  );

  // 默认接口的显式端点被关闭：它的家族不再算进去，只剩其它已启用端点的家族。
  assert.deepEqual(
    settings.providerFailoverFamilies({
      type: "codex",
      defaultChatProtocol: "openai-responses",
      endpointConfigs: {
        "openai-responses": { baseUrl: "https://relay.example/v1", enabled: false },
        "anthropic-messages": { baseUrl: "https://relay.example" },
      },
    }),
    ["anthropic"],
  );
  // 默认接口家族在前，其余按接口固定顺序；Completions 与 Responses 合并为一个家族。
  assert.deepEqual(
    settings.providerFailoverFamilies({
      type: "codex",
      defaultChatProtocol: "google-generative-ai",
      endpointConfigs: {
        "anthropic-messages": { baseUrl: "https://relay.example" },
        "openai-completions": { baseUrl: "https://relay.example/v1" },
        "openai-responses": { baseUrl: "https://relay.example/v1" },
        "google-generative-ai": { baseUrl: "https://relay.example/v1beta" },
      },
    }),
    ["gemini", "anthropic", "openai"],
  );
  // 全部关闭 → 不属于任何家族，故障转移队列里的这个条目会被丢弃。
  const dark = {
    id: "dark",
    name: "Dark",
    type: "claude_code",
    baseUrl: "https://relay.example",
    apiKey: "k",
    defaultChatProtocol: "anthropic-messages",
    endpointConfigs: { "anthropic-messages": { baseUrl: "https://relay.example", enabled: false } },
    models: [{ id: "model-1", contextWindow: 200000, maxOutputToken: 8192 }],
    activeModels: ["model-1"],
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
    useSystemProxy: false,
  };
  assert.deepEqual(settings.providerFailoverFamilies(dark), []);
  const normalized = settings.normalizeModelFailoverSettings(
    { anthropic: { enabled: true, queue: ["dark", "provider-a2"] } },
    [...PROVIDERS, dark],
  );
  assert.deepEqual(normalized.anthropic.queue, ["provider-a2"]);
});

test("cross-family queue entries are always dropped", () => {
  const normalized = settings.normalizeModelFailoverSettings(
    {
      openai: {
        enabled: true,
        queue: ["provider-a", "provider-b"],
      },
    },
    PROVIDERS,
  );
  assert.deepEqual(normalized.openai.queue, ["provider-b"]);
});

test("DeepSeek and Codex providers share the OpenAI family queue", () => {
  const normalized = settings.normalizeModelFailoverSettings(
    {
      openai: {
        enabled: true,
        queue: ["provider-a", "provider-d", "provider-b"],
      },
    },
    PROVIDERS,
  );

  assert.equal(normalized.openai.enabled, true);
  assert.deepEqual(normalized.openai.queue, ["provider-d", "provider-b"]);
});

test("legacy per-vendor shapes merge into family queues in order", () => {
  const normalized = settings.normalizeModelFailoverSettings(
    {
      codex: { enabled: true, queue: ["provider-b"], maxSwitches: 2 },
      deepseek: { enabled: false, queue: ["provider-d"], maxSwitches: 7 },
      claude_code: { enabled: true, queue: ["provider-a2"] },
    },
    PROVIDERS,
  );
  assert.deepEqual(normalized.openai.queue, ["provider-b", "provider-d"]);
  assert.equal(normalized.openai.enabled, true);
  // Knobs come from the first legacy group of the family.
  assert.equal(normalized.openai.maxSwitches, 2);
  assert.deepEqual(normalized.anthropic.queue, ["provider-a2"]);
  assert.deepEqual(normalized.gemini, DEFAULT_VENDOR_FAILOVER);
});

test("legacy model-entry queues collapse to deduped provider ids", () => {
  const normalized = settings.normalizeModelFailoverSettings(
    {
      anthropic: {
        enabled: true,
        queue: [
          { customProviderId: "provider-a", model: "model-1" },
          { customProviderId: "provider-a", model: "model-2" }, // same provider → dedup
          { customProviderId: "provider-a2", model: "model-1" },
          { customProviderId: "provider-b", model: "model-3" }, // cross-vendor
        ],
      },
    },
    PROVIDERS,
  );
  assert.deepEqual(normalized.anthropic.queue, ["provider-a", "provider-a2"]);
});

test("breaker knobs are clamped into their documented ranges", () => {
  const normalized = settings.normalizeModelFailoverSettings(
    { anthropic: { maxSwitches: 99, failureThreshold: 0, cooldownSeconds: "120" } },
    PROVIDERS,
  );
  assert.equal(normalized.anthropic.maxSwitches, 10);
  assert.equal(normalized.anthropic.failureThreshold, 1);
  assert.equal(normalized.anthropic.cooldownSeconds, 120);

  const fallback = settings.normalizeModelFailoverSettings(
    { anthropic: { maxSwitches: "abc", failureThreshold: Number.NaN, cooldownSeconds: null } },
    PROVIDERS,
  );
  assert.equal(fallback.anthropic.maxSwitches, 3);
  assert.equal(fallback.anthropic.failureThreshold, 4);
  assert.equal(fallback.anthropic.cooldownSeconds, 60);
});

test("legacy flat config migrates into per-vendor configs split by provider type", () => {
  const normalized = settings.normalizeModelFailoverSettings(
    {
      enabled: true,
      queue: [
        { customProviderId: "provider-a", model: "model-1" }, // claude
        { customProviderId: "provider-b", model: "model-3" }, // codex
      ],
      maxSwitches: 2,
      failureThreshold: 5,
      cooldownSeconds: 30,
    },
    PROVIDERS,
  );
  // Each family keeps only its own providers from the legacy mixed queue.
  assert.deepEqual(normalized.anthropic.queue, ["provider-a"]);
  assert.deepEqual(normalized.openai.queue, ["provider-b"]);
  assert.equal(normalized.anthropic.enabled, true);
  assert.equal(normalized.openai.enabled, true);
  // Families with nothing usable in the legacy queue end up disabled.
  assert.equal(normalized.gemini.enabled, false);
  assert.deepEqual(normalized.gemini.queue, []);
  // Breaker knobs replicate to every family.
  assert.equal(normalized.anthropic.maxSwitches, 2);
  assert.equal(normalized.openai.failureThreshold, 5);
  assert.equal(normalized.gemini.cooldownSeconds, 30);
});

test("normalizeSettings carries modelFailover and drops stale queue entries", () => {
  const normalized = settings.normalizeSettings({
    customProviders: PROVIDERS,
    modelFailover: {
      openai: {
        enabled: true,
        queue: ["provider-b", "gone"],
        maxSwitches: 2,
        failureThreshold: 5,
        cooldownSeconds: 30,
      },
    },
  });
  assert.equal(normalized.modelFailover.openai.enabled, true);
  assert.deepEqual(normalized.modelFailover.openai.queue, ["provider-b"]);
  assert.equal(normalized.modelFailover.openai.maxSwitches, 2);
  assert.equal(normalized.modelFailover.openai.failureThreshold, 5);
  assert.equal(normalized.modelFailover.openai.cooldownSeconds, 30);
  assert.deepEqual(normalized.modelFailover.anthropic, DEFAULT_VENDOR_FAILOVER);
});

test("updateModelFailover patches one family through full normalization", () => {
  const base = settings.normalizeSettings({ customProviders: PROVIDERS });
  const updated = settings.updateModelFailover(base, "anthropic", {
    enabled: true,
    queue: ["provider-a2"],
  });
  assert.equal(updated.modelFailover.anthropic.enabled, true);
  assert.deepEqual(updated.modelFailover.anthropic.queue, ["provider-a2"]);
  // Untouched knobs keep their previous values.
  assert.equal(
    updated.modelFailover.anthropic.maxSwitches,
    base.modelFailover.anthropic.maxSwitches,
  );
  // Other families are untouched.
  assert.deepEqual(updated.modelFailover.openai, base.modelFailover.openai);
});

test("legacy per-vendor shapes still migrate when the ambiguous gemini key is present", () => {
  const normalized = settings.normalizeModelFailoverSettings(
    {
      claude_code: { enabled: true, queue: ["provider-a2"], maxSwitches: 5 },
      codex: { enabled: false, queue: ["provider-b"], maxSwitches: 2 },
      gemini: { ...DEFAULT_VENDOR_FAILOVER },
      xai: { ...DEFAULT_VENDOR_FAILOVER },
      deepseek: { enabled: true, queue: ["provider-d"], maxSwitches: 7, failureThreshold: 3, cooldownSeconds: 120 },
    },
    PROVIDERS,
  );
  assert.deepEqual(normalized.anthropic.queue, ["provider-a2"]);
  assert.equal(normalized.anthropic.maxSwitches, 5);
  // openai family: codex (disabled) + deepseek (enabled) → knobs from the enabled group.
  assert.deepEqual(normalized.openai.queue, ["provider-b", "provider-d"]);
  assert.equal(normalized.openai.enabled, true);
  assert.equal(normalized.openai.maxSwitches, 7);
  assert.equal(normalized.openai.cooldownSeconds, 120);
});
