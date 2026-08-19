import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const presentation = loader.loadModule("@liveagent/ui/pages/settings/ProviderPresentation.tsx");
const gatewayTypes = loader.loadModule("src/pages/chat/gateway/gatewayBridgeTypes.ts");
const importLoader = createTsModuleLoader({
  mocks: {
    "../../src-tauri/icons/custom/ccswitch.png": { default: "ccswitch.png" },
    "../../src-tauri/icons/custom/cherrystudio.png": { default: "cherrystudio.png" },
  },
});
const providerImports = importLoader.loadModule("src/agent-ui-adapters/providerSettings.tsx");

test("provider settings render DeepSeek as the fifth provider tab", () => {
  assert.deepEqual(presentation.PROVIDER_TABS, [
    "claude_code",
    "codex",
    "gemini",
    "xai",
    "deepseek",
  ]);
  assert.equal(presentation.getProviderLabel("deepseek"), "DeepSeek");
});

test("desktop gateway bridge accepts DeepSeek and still rejects unknown provider types", () => {
  assert.equal(gatewayTypes.normalizeGatewayProviderType(" deepseek "), "deepseek");
  assert.equal(gatewayTypes.normalizeGatewayProviderType("openai"), null);
  assert.equal(gatewayTypes.normalizeGatewayProviderType("grok"), null);
});

test("CC Switch imports DeepSeek with native search enabled", () => {
  const provider = providerImports.providerFromCcs(
    {
      sourceId: "deepseek-official",
      appType: "deepseek",
      providerType: "deepseek",
      name: "DeepSeek Official",
      baseUrl: "https://api.deepseek.com",
      isFullUrl: false,
      apiKey: "sk-test",
      requestFormat: "openai-completions",
      models: ["deepseek-v4-flash"],
    },
    new Set(),
  );

  assert.equal(provider.type, "deepseek");
  assert.equal(provider.requestFormat, undefined);
  assert.equal(provider.promptCachingEnabled, false);
  assert.equal(provider.nativeWebSearchEnabled, true);
  assert.deepEqual(provider.activeModels, ["deepseek-v4-flash"]);
});

test("Cherry DeepSeek imports disable cache but preserve explicit native-search preferences", () => {
  const item = {
    sourceId: "deepseek-source::deepseek-chat",
    sourceVersion: "2.x",
    sourceProviderType: "deepseek-chat-completions",
    providerType: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-test",
    apiKeyCount: 1,
    requestFormat: "openai-completions",
    enabled: true,
    importable: true,
    reason: "",
    warning: "",
    excludedModelCount: 0,
  };
  const provider = providerImports.providerFromCherry(item, [item], {
    id: "cherry-studio-deepseek-source-deepseek-chat",
    name: "Existing",
    type: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "old-key",
    models: [],
    activeModels: [],
    promptCachingEnabled: true,
    nativeWebSearchEnabled: true,
  });

  assert.equal(provider.type, "deepseek");
  assert.equal(provider.requestFormat, undefined);
  assert.equal(provider.promptCachingEnabled, false);
  assert.equal(provider.nativeWebSearchEnabled, true);
});
