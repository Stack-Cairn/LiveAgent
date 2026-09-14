import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");

test("provider routing normalization keeps valid routes and drops unknown protocols", () => {
  const provider = settings.normalizeCustomProvider({
    id: "gateway",
    type: "codex",
    baseUrl: " https://gateway.example/v1 ",
    requestFormat: "openai-completions",
    defaultChatProtocol: "google-generative-ai",
    endpointConfigs: {
      "anthropic-messages": { baseUrl: " https://gateway.example/anthropic/v1/ " },
      "unknown-wire": { baseUrl: "https://bad.example/v1" },
      "openai-responses": { baseUrl: "   " },
    },
    models: [
      { id: "claude-proxy", chatProtocol: "anthropic-messages" },
      { id: "unknown", chatProtocol: "invented-wire" },
    ],
  });

  assert.equal(provider.defaultChatProtocol, "google-generative-ai");
  assert.deepEqual(provider.endpointConfigs, {
    "anthropic-messages": { baseUrl: "https://gateway.example/anthropic/v1" },
  });
  assert.equal(provider.models[0].chatProtocol, "anthropic-messages");
  assert.deepEqual(provider.models[0].chatProtocols, ["anthropic-messages"]);
  assert.equal(provider.models[1].chatProtocol, undefined);
  // 新实例默认凭据与旧字段同步。
  assert.equal(provider.credentials.length, 1);
  assert.equal(provider.credentials[0].apiKey, provider.apiKey);
  assert.equal(provider.presetId, "openai");
});

test("legacy deepseek-responses protocol rewrites to Responses + deepseek dialect", () => {
  const provider = settings.normalizeCustomProvider({
    id: "ds",
    type: "codex",
    baseUrl: "https://relay.example/v1",
    defaultChatProtocol: "deepseek-responses",
    endpointConfigs: { "deepseek-responses": { baseUrl: "https://relay.example/ds" } },
    models: [{ id: "deepseek-v4-pro", chatProtocol: "deepseek-responses" }],
  });
  assert.equal(provider.defaultChatProtocol, "openai-responses");
  assert.equal(provider.dialect, "deepseek");
  assert.equal(provider.endpointConfigs["openai-responses"].baseUrl, "https://relay.example/ds");
  assert.equal(provider.endpointConfigs["openai-responses"].dialect, "deepseek");
  assert.deepEqual(provider.models[0].chatProtocols, ["openai-responses"]);
  const route = settings.resolveProviderChatRoute(provider, "deepseek-v4-pro");
  assert.equal(route.protocol, "openai-responses");
  assert.equal(route.dialect, "deepseek");
  assert.equal(route.adapterProviderId, "deepseek");
});

test("route precedence is model > provider > legacy and resolves adapter families", () => {
  const provider = settings.normalizeCustomProvider({
    id: "gateway",
    type: "codex",
    baseUrl: "https://gateway.example/v1",
    isFullUrl: true,
    requestFormat: "openai-completions",
    defaultChatProtocol: "google-generative-ai",
    endpointConfigs: {
      "anthropic-messages": { baseUrl: "https://gateway.example/anthropic/v1" },
    },
    models: [
      { id: "claude-proxy", chatProtocol: "anthropic-messages" },
      { id: "gemini-proxy" },
    ],
  });

  const claudeRoute = settings.resolveProviderChatRoute(provider, "claude-proxy");
  assert.equal(claudeRoute.protocol, "anthropic-messages");
  assert.equal(claudeRoute.protocolSource, "model");
  assert.equal(claudeRoute.family, "anthropic");
  assert.equal(claudeRoute.dialect, "generic");
  assert.equal(claudeRoute.adapterProviderId, "claude_code");
  assert.equal(claudeRoute.baseUrl, "https://gateway.example/anthropic/v1");
  assert.equal(claudeRoute.isFullUrl, false);
  assert.equal(claudeRoute.wireModelId, "claude-proxy");
  assert.equal(claudeRoute.credentialId, provider.credentials[0].id);

  // gemini-proxy has no explicit protocol: the family table prefers Gemini,
  // and the provider default endpoint serves it.
  const geminiRoute = settings.resolveProviderChatRoute(provider, "gemini-proxy");
  assert.equal(geminiRoute.protocol, "google-generative-ai");
  assert.equal(geminiRoute.protocolSource, "family");
  assert.equal(geminiRoute.adapterProviderId, "gemini");
  assert.equal(geminiRoute.baseUrl, "https://gateway.example/v1");
  assert.equal(geminiRoute.isFullUrl, false);

  const legacy = settings.normalizeCustomProvider({
    id: "legacy",
    type: "codex",
    baseUrl: "https://gateway.example/v1",
    requestFormat: "openai-completions",
    models: ["chat-model"],
  });
  const legacyRoute = settings.resolveProviderChatRoute(legacy, "chat-model");
  assert.equal(legacyRoute.protocol, "openai-completions");
  // 未知家族偏好 Completions，且它正是该供应商唯一可用的接口。
  assert.equal(legacyRoute.protocolSource, "family");
  assert.equal(legacyRoute.dialect, "openai");
  assert.equal(legacyRoute.adapterProviderId, "codex");
  assert.equal(legacyRoute.baseUrl, "https://gateway.example/v1");
  assert.equal(legacyRoute.isFullUrl, false);
  assert.equal(legacyRoute.requestFormat, "openai-completions");
});

test("disabled endpoints are skipped and the provider default takes over", () => {
  const provider = settings.normalizeCustomProvider({
    id: "relay",
    type: "codex",
    baseUrl: "https://relay.example/v1",
    defaultChatProtocol: "openai-completions",
    endpointConfigs: {
      "anthropic-messages": { baseUrl: "https://relay.example", enabled: false },
    },
    models: [{ id: "claude-sonnet-4" }],
  });
  const route = settings.resolveProviderChatRoute(provider, "claude-sonnet-4");
  assert.equal(route.protocol, "openai-completions");
  assert.equal(route.protocolSource, "family");
  assert.deepEqual(settings.getProviderEnabledProtocols(provider), ["openai-completions"]);
});

test("multi-key providers pick credentials by model scope", () => {
  const provider = settings.normalizeCustomProvider({
    id: "relay",
    type: "claude_code",
    baseUrl: "https://relay.example",
    credentials: [
      { id: "k1", label: "main", apiKey: "sk-1", enabled: true, lastModels: { at: 1, models: ["claude-sonnet-4"] } },
      { id: "k2", label: "backup", apiKey: "sk-2", enabled: true, lastModels: { at: 1, models: ["gpt-5"] } },
    ],
    endpointConfigs: { "openai-responses": { baseUrl: "https://relay.example/v1", credentialId: "k2" } },
    models: [{ id: "claude-sonnet-4" }, { id: "gpt-5" }, { id: "unknown-model" }],
  });
  assert.equal(provider.apiKey, "sk-1");
  const claude = settings.resolveProviderChatRoute(provider, "claude-sonnet-4");
  assert.equal(claude.credentialId, "k1");
  assert.equal(claude.credentialSource, "scope");
  const gpt = settings.resolveProviderChatRoute(provider, "gpt-5");
  assert.equal(gpt.protocol, "openai-responses");
  assert.equal(gpt.credentialId, "k2");
  assert.equal(gpt.credentialSource, "endpoint");
  const unknown = settings.resolveProviderChatRoute(provider, "unknown-model");
  assert.equal(unknown.credentialId, "k1");
  assert.equal(unknown.credentialSource, "fallback");
});

test("xAI keeps its transport identity on the Responses protocol", () => {
  const provider = settings.normalizeCustomProvider({
    id: "grok",
    type: "xai",
    baseUrl: "https://api.x.ai/v1",
    defaultChatProtocol: "openai-responses",
  });
  assert.equal(settings.resolveProviderChatRoute(provider, "grok-4").adapterProviderId, "xai");
});

test("route resolution tolerates a legacy pre-normalization provider snapshot", () => {
  const route = settings.resolveProviderChatRoute(
    {
      type: "claude_code",
      baseUrl: "https://api.anthropic.com",
      isFullUrl: false,
    },
    "claude-sonnet",
  );
  assert.equal(route.protocol, "anthropic-messages");
  assert.equal(route.adapterProviderId, "claude_code");
  assert.equal(route.baseUrl, "https://api.anthropic.com");
  assert.equal(route.isFullUrl, false);
  assert.equal(route.credentialId, "default");
});
