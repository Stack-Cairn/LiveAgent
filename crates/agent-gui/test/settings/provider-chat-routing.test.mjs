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
  assert.equal(provider.models[1].chatProtocol, undefined);
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

  assert.deepEqual(settings.resolveProviderChatRoute(provider, "claude-proxy"), {
    protocol: "anthropic-messages",
    adapterProviderId: "claude_code",
    baseUrl: "https://gateway.example/anthropic/v1",
    isFullUrl: false,
  });
  assert.deepEqual(settings.resolveProviderChatRoute(provider, "gemini-proxy"), {
    protocol: "google-generative-ai",
    adapterProviderId: "gemini",
    baseUrl: "https://gateway.example/v1",
    isFullUrl: false,
  });

  const legacy = settings.normalizeCustomProvider({
    id: "legacy",
    type: "codex",
    baseUrl: "https://gateway.example/v1",
    requestFormat: "openai-completions",
    models: ["chat-model"],
  });
  assert.deepEqual(settings.resolveProviderChatRoute(legacy, "chat-model"), {
    protocol: "openai-completions",
    adapterProviderId: "codex",
    baseUrl: "https://gateway.example/v1",
    isFullUrl: false,
    requestFormat: "openai-completions",
  });
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
  assert.deepEqual(
    settings.resolveProviderChatRoute(
      {
        type: "claude_code",
        baseUrl: "https://api.anthropic.com",
        isFullUrl: false,
      },
      "claude-sonnet",
    ),
    {
      protocol: "anthropic-messages",
      adapterProviderId: "claude_code",
      baseUrl: "https://api.anthropic.com",
      isFullUrl: false,
    },
  );
});
