// WebUI: the K-brain web search service travels through the Gateway as `kbrainWebSearch`
// (LiveAgent's own settings have no `webSearch` key), and reading it records the fallback
// state the composer and the send path gate web search on.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

function load(client) {
  const loader = createWebModuleLoader({
    rootDir: fileURLToPath(new URL("../", import.meta.url)),
    mocks: {
      "../lib/gatewaySocket": { getGatewayWebSocketClient: () => client },
      "../lib/storage": { loadToken: () => "fixture" },
      "../pages/settings/DevicesSection": { DevicesSection: () => null },
      "@liveagent/ui/components/IconSet": { MonitorSmartphone: () => null },
      "@liveagent/ui/lib/resourceHost": {
        configureResourceHostCapabilities() {},
        nativeResourceHostCapabilities: {},
      },
    },
  });
  return {
    kbrain: loader.loadModule("src/agent-ui-adapters/settingsExtension.tsx").settingsHostAdapter
      .kbrain,
    fallback: loader.loadModule("@liveagent/ui/lib/providers/webSearchFallback.ts"),
  };
}

const unconfigured = {
  provider: "",
  maxResults: 0,
  apiKeyConfigured: false,
  available: false,
  reason: "web search provider is not configured",
  providers: ["tavily", "brave", "searxng", "bocha", "jina"],
};

test("WebUI web search settings travel as kbrainWebSearch and record the fallback state", async () => {
  let doc = { customProviders: [], kbrainWebSearch: unconfigured };
  const updates = [];
  const { kbrain, fallback } = load({
    getSettings: async () => doc,
    updateSettings: async (update) => {
      updates.push(update);
      if (!update.kbrainWebSearch) return;
      const { apiKey: _key, ...stored } = update.kbrainWebSearch;
      doc = {
        ...doc,
        kbrainWebSearch: {
          ...doc.kbrainWebSearch,
          ...stored,
          apiKeyConfigured: true,
          apiKeySource: "config",
          available: true,
          reason: "",
        },
      };
    },
  });

  const loaded = await kbrain.getSettings();
  assert.deepEqual(loaded.webSearch, unconfigured);
  assert.deepEqual(fallback.getRecordedWebSearchFallbackState(), {
    available: false,
    provider: "",
  });

  const saved = await kbrain.updateSettings({
    webSearch: { provider: "tavily", apiKey: "fixture-key" },
  });
  assert.deepEqual(updates, [{ kbrainWebSearch: { provider: "tavily", apiKey: "fixture-key" } }]);
  assert.equal(saved.webSearch.available, true);
  assert.equal(JSON.stringify(saved).includes("fixture-key"), false, "the key is never read back");
  assert.deepEqual(fallback.getRecordedWebSearchFallbackState(), {
    available: true,
    provider: "tavily",
  });

  await kbrain.updateSettings({ aiApproval: { mode: "off" } });
  assert.deepEqual(Object.keys(updates.at(-1)), ["aiApproval"], "other updates gain no web search key");
});

test("WebUI reports no web search section when the desktop's K-brain has none", async () => {
  const { kbrain, fallback } = load({
    getSettings: async () => ({ customProviders: [] }),
    updateSettings: async () => {},
  });
  const document = await kbrain.getSettings();
  assert.equal("webSearch" in document, false);
  assert.equal(fallback.webSearchFallbackSupported(document), false);
  assert.equal(fallback.getRecordedWebSearchFallbackState(), null);
});
