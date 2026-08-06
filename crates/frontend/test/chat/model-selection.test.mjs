import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const modelSelection = loader.loadModule("src/pages/chat/runtime/modelSelection.ts");

function provider(overrides = {}) {
  const id = overrides.id ?? "provider-1";
  const type = overrides.type ?? "codex";
  const models = overrides.models ?? ["gpt-5"];
  const activeModels = overrides.activeModels ?? models;
  return {
    id,
    name: id,
    type,
    baseUrl: overrides.baseUrl ?? "https://api.example.com/v1",
    apiKey: "key",
    models,
    activeModels,
    requestFormat: type === "codex" ? "openai-responses" : undefined,
  };
}

function appSettings(customProviders, selectedModel) {
  return settings.normalizeSettings({
    customProviders,
    selectedModel,
  });
}

test("local chat model selection resolves only an enabled selected model", () => {
  const app = appSettings(
    [provider({ id: "openai-main", models: ["gpt-5", "gpt-5-mini"] })],
    { customProviderId: "openai-main", model: "gpt-5" },
  );

  const resolved = modelSelection.resolveEffectiveChatModelSelection({ settings: app });

  assert.equal(resolved.provider.id, "openai-main");
  assert.equal(resolved.providerId, "codex");
  assert.equal(resolved.model, "gpt-5");
  assert.deepEqual(resolved.selectedModel, {
    customProviderId: "openai-main",
    model: "gpt-5",
  });
});

test("conversation selection wins over the global default", () => {
  const app = appSettings(
    [
      provider({ id: "openai-main", models: ["gpt-5"] }),
      provider({ id: "anthropic-main", type: "claude_code", models: ["claude-fable-5"] }),
    ],
    { customProviderId: "openai-main", model: "gpt-5" },
  );

  const resolved = modelSelection.resolveEffectiveChatModelSelection({
    settings: app,
    conversationSelectedModel: { customProviderId: "anthropic-main", model: "claude-fable-5" },
  });

  assert.equal(resolved.provider.id, "anthropic-main");
  assert.equal(resolved.providerId, "claude_code");
  assert.deepEqual(resolved.selectedModel, {
    customProviderId: "anthropic-main",
    model: "claude-fable-5",
  });
});

test("invalid conversation selection throws like an invalid default", () => {
  const app = appSettings([provider({ id: "openai-main", models: ["gpt-5"] })], {
    customProviderId: "openai-main",
    model: "gpt-5",
  });

  assert.throws(
    () =>
      modelSelection.resolveEffectiveChatModelSelection({
        settings: app,
        conversationSelectedModel: { customProviderId: "missing", model: "gpt-5" },
      }),
    /供应商不存在/,
  );
});

test("resolveActiveModelSelection prefers the conversation selection", () => {
  const app = appSettings([provider({ id: "openai-main", models: ["gpt-5"] })], {
    customProviderId: "openai-main",
    model: "gpt-5",
  });
  const conversationSelection = { customProviderId: "other", model: "m" };

  assert.equal(
    modelSelection.resolveActiveModelSelection(app, conversationSelection),
    conversationSelection,
  );
  assert.deepEqual(modelSelection.resolveActiveModelSelection(app, undefined), {
    customProviderId: "openai-main",
    model: "gpt-5",
  });
});

test("history persistence prefers the latest runtime selection over the turn-start model", () => {
  const turnSelectedModel = { customProviderId: "openai-main", model: "gpt-5" };
  const runtimeSelectedModel = {
    customProviderId: "anthropic-main",
    model: "claude-fable-5",
  };

  assert.equal(
    modelSelection.resolvePersistedConversationModelSelection({
      runtimeSelectedModel,
      turnSelectedModel,
    }),
    runtimeSelectedModel,
  );
  assert.equal(
    modelSelection.resolvePersistedConversationModelSelection({ turnSelectedModel }),
    turnSelectedModel,
  );
});

test("selected model json round-trips and rejects malformed payloads", () => {
  assert.equal(
    settings.serializeSelectedModelJson({ customProviderId: "p1", model: "m1" }),
    '{"customProviderId":"p1","model":"m1"}',
  );
  assert.deepEqual(settings.parseSelectedModelJson('{"customProviderId":"p1","model":"m1"}'), {
    customProviderId: "p1",
    model: "m1",
  });
  assert.equal(settings.parseSelectedModelJson(undefined), undefined);
  assert.equal(settings.parseSelectedModelJson("not-json"), undefined);
  assert.equal(settings.parseSelectedModelJson('{"model":"m1"}'), undefined);
  assert.equal(settings.serializeSelectedModelJson(undefined), undefined);
});
