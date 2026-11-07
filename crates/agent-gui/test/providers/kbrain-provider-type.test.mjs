import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// The desktop app and the WebUI must resolve a K-brain provider's type with the
// same rule. The cases are shared with the gateway's Go test
// (internal/kbrain/settings_contract_test.go) so all three stay in step.
const cases = JSON.parse(
  readFileSync(
    new URL("../../../agent-gateway/internal/kbrain/testdata/provider_type_cases.json", import.meta.url),
    "utf8",
  ),
);

const loader = createTsModuleLoader();
const capabilities = loader.loadModule("@liveagent/ui/lib/providers/providerCapabilities.ts");
const settings = loader.loadModule("@liveagent/ui/lib/settings/index.ts");
const providerSettings = loader.loadModule("src/lib/kbrain/providerSettings.ts");

function kBrainProvider(type, api) {
  return {
    id: "handwritten",
    name: "Hand-written",
    type,
    api,
    baseUrl: "http://127.0.0.1:47561/v1",
    models: [{ id: "local-model", name: "local-model" }],
  };
}

test("resolveKBrainProviderType matches the shared provider type cases", () => {
  assert.ok(cases.length > 0);
  for (const { type, api, want } of cases) {
    assert.equal(
      capabilities.resolveKBrainProviderType({ type, api }),
      want,
      `type=${JSON.stringify(type)} api=${JSON.stringify(api)}`,
    );
  }
});

test("desktop and synced-settings normalization agree on K-brain provider types", () => {
  for (const { type, api, want } of cases) {
    if (!api) continue;
    const raw = kBrainProvider(type, api);
    const desktop = providerSettings.customProviderFromKBrain(raw);
    const synced = settings.normalizeCustomProvider(raw);
    const label = `type=${JSON.stringify(type)} api=${JSON.stringify(api)}`;
    assert.equal(desktop.type, want, label);
    assert.equal(synced.type, want, label);
    assert.equal(synced.requestFormat, desktop.requestFormat, label);
  }
});

test("a type-less openai-completions provider resolves to codex with completions", () => {
  const raw = kBrainProvider(undefined, "openai-completions");
  const desktop = providerSettings.customProviderFromKBrain(raw);
  const synced = settings.normalizeCustomProvider(raw);
  assert.equal(desktop.type, "codex");
  assert.equal(desktop.requestFormat, "openai-completions");
  assert.equal(synced.type, "codex");
  assert.equal(synced.requestFormat, "openai-completions");
});

test("resolveKBrainRequestFormat keeps an explicit format", () => {
  assert.equal(
    capabilities.resolveKBrainRequestFormat({ requestFormat: "openai-responses", api: "openai-completions" }),
    "openai-responses",
  );
  assert.equal(capabilities.resolveKBrainRequestFormat({ api: "openai-completions" }), "openai-completions");
  assert.equal(capabilities.resolveKBrainRequestFormat({ api: "openai-responses" }), undefined);
});

test("plain LiveAgent provider entries without api keep the legacy default", () => {
  const plain = settings.normalizeCustomProvider({ id: "plain", name: "Plain", baseUrl: "https://example.test" });
  assert.equal(plain.type, "claude_code");
});
