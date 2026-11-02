import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const providerUtils = createTsModuleLoader().loadModule("@liveagent/ui/pages/settings/providerUtils.ts");

test("provider model discovery helpers contain no frontend upstream request implementation", () => {
  assert.equal(typeof providerUtils.fetchModelsFromApi, "undefined");
  assert.equal(typeof providerUtils.buildProviderModelsUrl, "undefined");
  assert.equal(typeof providerUtils.buildProviderModelsAttempts, "undefined");
  assert.equal(typeof providerUtils.pickProviderModelsFailure, "undefined");
  assert.equal(typeof providerUtils.normalizeProviderModelsBaseUrl, "undefined");
});

test("provider model normalization accepts the backend's normalized model payload", () => {
  const models = providerUtils.normalizeFetchedModels(
    [
      {
        id: "gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        contextWindow: 1_000_000,
        maxOutputToken: 65_536,
        limitsSource: "provider",
        inputModalities: ["text", "image"],
      },
    ],
    "gemini",
  );
  assert.deepEqual(models, [
    {
      id: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      contextWindow: 1_000_000,
      maxOutputToken: 65_536,
      limitsSource: "provider",
      inputModalities: ["text", "image"],
    },
  ]);
});

test("model refresh identity remains sensitive to backend routing and headers", () => {
  const base = providerUtils.buildProviderModelsFetchKey(
    "https://relay.example.com/v1",
    "test-key",
    false,
    true,
    "https://catalog.example.com/models",
    [{ key: "X-Client", value: "one" }],
  );
  assert.notEqual(
    base,
    providerUtils.buildProviderModelsFetchKey(
      "https://relay.example.com/v1",
      "test-key",
      true,
      true,
      "https://catalog.example.com/models",
      [{ key: "X-Client", value: "one" }],
    ),
  );
  assert.notEqual(
    base,
    providerUtils.buildProviderModelsFetchKey(
      "https://relay.example.com/v1",
      "test-key",
      false,
      true,
      "https://catalog.example.com/models",
      [{ key: "X-Client", value: "two" }],
    ),
  );
});
