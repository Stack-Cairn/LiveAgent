import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const registry = loader.loadModule("@liveagent/ui/lib/providers/registry/index.ts");
const probe = loader.loadModule("@liveagent/ui/pages/settings/providerProbe.ts");

test("registry exposes exactly four chat protocols with families and labels", () => {
  assert.deepEqual(registry.PROVIDER_CHAT_PROTOCOLS, [
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "google-generative-ai",
  ]);
  assert.equal(registry.PROVIDER_PROTOCOL_FAMILY["openai-responses"], "openai");
  assert.equal(registry.PROVIDER_PROTOCOL_FAMILY["openai-completions"], "openai");
  assert.equal(registry.isProviderChatProtocol("deepseek-responses"), false);
  for (const protocol of registry.PROVIDER_CHAT_PROTOCOLS) {
    assert.ok(registry.PROVIDER_CHAT_PROTOCOL_LABELS[protocol]);
  }
});

test("dialects are coerced per protocol and inferred from official hosts", () => {
  assert.equal(registry.coerceDialectForProtocol("anthropic-messages", "xai"), "generic");
  assert.equal(registry.coerceDialectForProtocol("openai-responses", "xai"), "xai");
  assert.equal(registry.inferDialectFromBaseUrl("openai-responses", "https://api.x.ai/v1"), "xai");
  assert.equal(
    registry.inferDialectFromBaseUrl("openai-completions", "https://api.deepseek.com"),
    "deepseek",
  );
  assert.equal(
    registry.inferDialectFromBaseUrl("anthropic-messages", "https://api.openai.com/v1"),
    undefined,
  );
  assert.equal(registry.inferDialectFromBaseUrl("openai-completions", "not a url"), undefined);
});

test("protocol auth headers follow the protocol profile and endpoint overrides", () => {
  assert.deepEqual(registry.buildProtocolAuthHeaders("anthropic-messages", "sk"), {
    "x-api-key": "sk",
    "anthropic-version": "2023-06-01",
  });
  assert.deepEqual(registry.buildProtocolAuthHeaders("openai-completions", "sk"), {
    Authorization: "Bearer sk",
  });
  assert.deepEqual(
    registry.buildProtocolAuthHeaders("openai-completions", "sk", { headerName: "api-key", prefix: "" }),
    { "api-key": "sk" },
  );
  assert.deepEqual(registry.mergeHeaderLayers({ "User-Agent": "a" }, { "user-agent": "b" }), {
    "user-agent": "b",
  });
});

test("model families drive grouping and protocol preference", () => {
  assert.equal(registry.resolveModelGroup("claude-sonnet-4"), "claude");
  assert.equal(registry.resolveModelGroup("anthropic/claude-sonnet-4"), "claude");
  assert.equal(registry.resolveModelGroup("gpt-5-mini"), "gpt");
  assert.equal(registry.resolveModelGroup("o4-mini"), "gpt");
  assert.equal(registry.resolveModelGroup("grok-4"), "grok");
  assert.equal(registry.resolveModelGroup("deepseek-v4-pro"), "deepseek");
  assert.equal(registry.resolveModelGroup("glm-5"), "glm");
  assert.equal(registry.resolveModelGroup("my-finetune"), "other");
  assert.deepEqual(registry.resolveModelFamily("claude-opus-4").prefer, [
    "anthropic-messages",
    "openai-completions",
  ]);
  assert.equal(registry.resolveModelFamily("grok-4").dialect, "xai");
});

test("presets merge models.dev facts with the overlay", () => {
  const deepseek = registry.findProviderPreset("deepseek");
  assert.ok(deepseek);
  assert.equal(deepseek.native, true);
  assert.equal(deepseek.defaultChatProtocol, "openai-completions");
  assert.equal(deepseek.endpoints["openai-completions"].baseUrl, "https://api.deepseek.com");
  assert.equal(
    deepseek.endpoints["anthropic-messages"].baseUrl,
    "https://api.deepseek.com/anthropic",
  );
  assert.ok(deepseek.catalogModels.length > 0);
  assert.deepEqual(registry.matchPresetModelRule(deepseek, "deepseek-chat").chatProtocols, [
    "openai-completions",
  ]);
  assert.equal(registry.matchPresetModelRule(deepseek, "deepseek-v4-pro"), undefined);

  const openrouter = registry.findProviderPreset("openrouter");
  assert.equal(
    registry.matchPresetModelRule(openrouter, "anthropic/claude-sonnet-4").chatProtocols[0],
    "anthropic-messages",
  );

  const relay = registry.findProviderPreset("new-api");
  assert.equal(
    registry.expandPresetBaseUrl(relay.endpoints["google-generative-ai"].baseUrl, "https://relay.example/v1"),
    "https://relay.example/v1beta",
  );
  assert.equal(registry.expandPresetBaseUrl("{origin}", ""), "");

  const ollama = registry.findProviderPreset("ollama");
  assert.equal(ollama.authOptional, true);
  assert.equal(ollama.endpoints["openai-completions"].quirks.supportsDeveloperRole, false);

  // 自定义渠道不在目录里展示，但可以按 id 找到。
  assert.equal(registry.listProviderPresets().some((preset) => preset.id === "custom"), false);
  assert.ok(registry.findProviderPreset("custom"));
});

test("legacy type mapping is symmetric for native channels", () => {
  assert.equal(registry.presetIdForLegacyType("claude_code"), "anthropic");
  assert.equal(registry.presetIdForLegacyType("codex"), "openai");
  assert.equal(registry.presetIdForLegacyType("weird"), "custom");
  assert.equal(
    registry.legacyTypeForPreset(registry.findProviderPreset("zhipu"), "openai-completions"),
    "codex",
  );
  assert.equal(
    registry.legacyTypeForPreset(registry.findProviderPreset("zhipu"), "anthropic-messages"),
    "claude_code",
  );
  assert.equal(
    registry.legacyTypeForPreset(registry.findProviderPreset("xai"), "openai-responses"),
    "xai",
  );
});

test("endpoint candidates expand preset templates and custom roots", () => {
  const relay = registry.findProviderPreset("new-api");
  const candidates = probe.buildEndpointCandidates({ preset: relay, origin: "https://relay.example" });
  assert.deepEqual(
    candidates.map((candidate) => [candidate.protocol, candidate.baseUrl]),
    [
      ["anthropic-messages", "https://relay.example"],
      ["openai-completions", "https://relay.example/v1"],
      ["openai-responses", "https://relay.example/v1"],
      ["google-generative-ai", "https://relay.example/v1beta"],
    ],
  );

  const custom = probe.buildEndpointCandidates({
    preset: registry.findProviderPreset("custom"),
    baseUrl: "https://mine.example/v1",
  });
  assert.equal(custom.length, 4);
  assert.equal(custom.find((c) => c.protocol === "anthropic-messages").baseUrl, "https://mine.example");
  assert.equal(custom.find((c) => c.protocol === "openai-completions").baseUrl, "https://mine.example/v1");
  assert.equal(custom.find((c) => c.protocol === "google-generative-ai").baseUrl, "https://mine.example/v1beta");
});

test("auto configuration keeps only usable endpoints and merges models per key", () => {
  const preset = registry.findProviderPreset("new-api");
  const candidates = probe.buildEndpointCandidates({ preset, origin: "https://relay.example" });
  const probeResult = {
    at: 1000,
    credentials: [
      {
        credentialId: "k1",
        endpoints: [
          { protocol: "anthropic-messages", baseUrl: "https://relay.example", status: "ok", latencyMs: 10, models: [{ id: "claude-sonnet-4", contextWindow: 200000, maxOutputToken: 8192 }] },
          { protocol: "openai-completions", baseUrl: "https://relay.example/v1", status: "ok", latencyMs: 12, models: [{ id: "gpt-5", contextWindow: 128000, maxOutputToken: 8192 }, { id: "glm-5", contextWindow: 128000, maxOutputToken: 8192 }] },
          { protocol: "openai-responses", baseUrl: "https://relay.example/v1", status: "ok", latencyMs: 12, models: [{ id: "gpt-5", contextWindow: 128000, maxOutputToken: 8192 }] },
          { protocol: "google-generative-ai", baseUrl: "https://relay.example/v1beta", status: "missing", error: "404", models: [] },
        ],
      },
      {
        credentialId: "k2",
        endpoints: [
          { protocol: "anthropic-messages", baseUrl: "https://relay.example", status: "unauthorized", error: "401", models: [] },
          { protocol: "openai-completions", baseUrl: "https://relay.example/v1", status: "ok", latencyMs: 9, models: [{ id: "deepseek-v4-pro", contextWindow: 128000, maxOutputToken: 8192 }] },
          { protocol: "openai-responses", baseUrl: "https://relay.example/v1", status: "ok", latencyMs: 9, models: [] },
          { protocol: "google-generative-ai", baseUrl: "https://relay.example/v1beta", status: "missing", error: "404", models: [] },
        ],
      },
    ],
  };
  const credentials = [
    { id: "k1", label: "main", apiKey: "a", enabled: true },
    { id: "k2", label: "backup", apiKey: "b", enabled: true },
  ];
  const auto = probe.buildAutoConfiguration({ preset, candidates, probe: probeResult, credentials });
  assert.equal(auto.usable, true);
  assert.deepEqual(Object.keys(auto.endpointConfigs).sort(), [
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
  ]);
  assert.equal(auto.endpointConfigs["anthropic-messages"].lastProbe.status, "ok");
  assert.equal(auto.defaultChatProtocol, "openai-completions");
  assert.deepEqual(
    auto.models.map((model) => model.id),
    ["claude-sonnet-4", "deepseek-v4-pro", "glm-5", "gpt-5"],
  );
  assert.equal(auto.models.find((m) => m.id === "gpt-5").group, "gpt");
  assert.equal(auto.models.every((m) => m.source === "auto"), true);
  assert.deepEqual(auto.credentials[0].lastModels.models, ["claude-sonnet-4", "glm-5", "gpt-5"]);
  assert.deepEqual(auto.credentials[1].lastModels.models, ["deepseek-v4-pro"]);
  assert.equal(auto.credentials[0].modelScope.mode, "auto");

  // 摘要分组：按家族，附推荐接口。
  const groups = probe.groupProbeModels(auto.models, ["anthropic-messages", "openai-completions", "openai-responses"], preset);
  assert.deepEqual(groups.map((g) => [g.key, g.protocol]), [
    ["claude", "anthropic-messages"],
    ["deepseek", "openai-completions"],
    ["glm", "openai-completions"],
    ["gpt", "openai-responses"],
  ]);

  // 拒绝一个接口与一个分组。
  const trimmed = probe.buildAutoConfiguration({
    preset,
    candidates,
    probe: probeResult,
    credentials,
    rejectedProtocols: new Set(["openai-responses"]),
    rejectedGroups: new Set(["glm"]),
  });
  assert.equal(trimmed.endpointConfigs["openai-responses"].enabled, false);
  assert.equal(trimmed.models.some((m) => m.id === "glm-5"), false);
});

test("probe errors classify by HTTP status", () => {
  const utils = loader.loadModule("@liveagent/ui/pages/settings/providerUtils.ts");
  assert.equal(probe.classifyProbeError(new utils.ProviderModelsFetchError("nope", 404)).status, "missing");
  assert.equal(probe.classifyProbeError(new utils.ProviderModelsFetchError("nope", 401)).status, "unauthorized");
  assert.equal(probe.classifyProbeError(new utils.ProviderModelsFetchError("boom", 500)).status, "unknown");
  assert.equal(probe.classifyProbeError(new Error("network")).status, "unknown");
  assert.equal(utils.extractHttpStatusFromMessage("HTTP 401 Unauthorized"), 401);
  assert.equal(utils.extractHttpStatusFromMessage("upstream said 404 not found"), 404);
  assert.equal(utils.extractHttpStatusFromMessage("timeout"), null);
});
