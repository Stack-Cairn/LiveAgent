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

test("model failover defaults are off with an empty queue for every vendor", () => {
  const normalized = settings.normalizeModelFailoverSettings({}, PROVIDERS);
  assert.deepEqual(normalized, {
    claude_code: DEFAULT_VENDOR_FAILOVER,
    codex: DEFAULT_VENDOR_FAILOVER,
    gemini: DEFAULT_VENDOR_FAILOVER,
    xai: DEFAULT_VENDOR_FAILOVER,
    deepseek: DEFAULT_VENDOR_FAILOVER,
  });
});

test("queue entries are validated against same-vendor providers, deduped, and capped", () => {
  const normalized = settings.normalizeModelFailoverSettings(
    {
      claude_code: {
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
  assert.equal(normalized.claude_code.enabled, true);
  // The Codex provider must never appear in the Claude queue.
  assert.deepEqual(normalized.claude_code.queue, ["provider-a", "provider-a2"]);
  assert.deepEqual(normalized.codex, DEFAULT_VENDOR_FAILOVER);
});

test("cross-vendor queue entries are always dropped", () => {
  const normalized = settings.normalizeModelFailoverSettings(
    {
      codex: {
        enabled: true,
        queue: ["provider-a", "provider-b"],
      },
    },
    PROVIDERS,
  );
  assert.deepEqual(normalized.codex.queue, ["provider-b"]);
});

test("DeepSeek failover queues only accept DeepSeek providers", () => {
  const normalized = settings.normalizeModelFailoverSettings(
    {
      deepseek: {
        enabled: true,
        queue: ["provider-a", "provider-d"],
      },
    },
    PROVIDERS,
  );

  assert.equal(normalized.deepseek.enabled, true);
  assert.deepEqual(normalized.deepseek.queue, ["provider-d"]);
});

test("legacy model-entry queues collapse to deduped provider ids", () => {
  const normalized = settings.normalizeModelFailoverSettings(
    {
      claude_code: {
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
  assert.deepEqual(normalized.claude_code.queue, ["provider-a", "provider-a2"]);
});

test("breaker knobs are clamped into their documented ranges", () => {
  const normalized = settings.normalizeModelFailoverSettings(
    { claude_code: { maxSwitches: 99, failureThreshold: 0, cooldownSeconds: "120" } },
    PROVIDERS,
  );
  assert.equal(normalized.claude_code.maxSwitches, 10);
  assert.equal(normalized.claude_code.failureThreshold, 1);
  assert.equal(normalized.claude_code.cooldownSeconds, 120);

  const fallback = settings.normalizeModelFailoverSettings(
    { claude_code: { maxSwitches: "abc", failureThreshold: Number.NaN, cooldownSeconds: null } },
    PROVIDERS,
  );
  assert.equal(fallback.claude_code.maxSwitches, 3);
  assert.equal(fallback.claude_code.failureThreshold, 4);
  assert.equal(fallback.claude_code.cooldownSeconds, 60);
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
  // Each vendor keeps only its own providers from the legacy mixed queue.
  assert.deepEqual(normalized.claude_code.queue, ["provider-a"]);
  assert.deepEqual(normalized.codex.queue, ["provider-b"]);
  assert.equal(normalized.claude_code.enabled, true);
  assert.equal(normalized.codex.enabled, true);
  // Vendors with nothing usable in the legacy queue end up disabled.
  assert.equal(normalized.gemini.enabled, false);
  assert.deepEqual(normalized.gemini.queue, []);
  // Breaker knobs replicate to every vendor.
  assert.equal(normalized.claude_code.maxSwitches, 2);
  assert.equal(normalized.codex.failureThreshold, 5);
  assert.equal(normalized.xai.cooldownSeconds, 30);
});

test("normalizeSettings carries modelFailover and drops stale queue entries", () => {
  const normalized = settings.normalizeSettings({
    customProviders: PROVIDERS,
    modelFailover: {
      codex: {
        enabled: true,
        queue: ["provider-b", "gone"],
        maxSwitches: 2,
        failureThreshold: 5,
        cooldownSeconds: 30,
      },
    },
  });
  assert.equal(normalized.modelFailover.codex.enabled, true);
  assert.deepEqual(normalized.modelFailover.codex.queue, ["provider-b"]);
  assert.equal(normalized.modelFailover.codex.maxSwitches, 2);
  assert.equal(normalized.modelFailover.codex.failureThreshold, 5);
  assert.equal(normalized.modelFailover.codex.cooldownSeconds, 30);
  assert.deepEqual(normalized.modelFailover.claude_code, DEFAULT_VENDOR_FAILOVER);
});

test("updateModelFailover patches one vendor through full normalization", () => {
  const base = settings.normalizeSettings({ customProviders: PROVIDERS });
  const updated = settings.updateModelFailover(base, "claude_code", {
    enabled: true,
    queue: ["provider-a2"],
  });
  assert.equal(updated.modelFailover.claude_code.enabled, true);
  assert.deepEqual(updated.modelFailover.claude_code.queue, ["provider-a2"]);
  // Untouched knobs keep their previous values.
  assert.equal(
    updated.modelFailover.claude_code.maxSwitches,
    base.modelFailover.claude_code.maxSwitches,
  );
  // Other vendors are untouched.
  assert.deepEqual(updated.modelFailover.codex, base.modelFailover.codex);
});
