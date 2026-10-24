import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

function loadAdapter(client) {
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
  return loader.loadModule("src/agent-ui-adapters/settingsExtension.tsx").settingsHostAdapter.kbrain;
}

test("WebUI memory switch travels as kbrainMemory and never touches LiveAgent organizer settings", async () => {
  const organizer = { organizerEnabled: true, organizerMode: "auto" };
  let doc = { customProviders: [], memory: organizer, kbrainMemory: { enabled: true } };
  const updates = [];
  const kbrain = loadAdapter({
    getSettings: async () => doc,
    updateSettings: async (update) => {
      updates.push(update);
      doc = { ...doc, ...update };
    },
  });
  assert.deepEqual((await kbrain.getSettings()).memory, { enabled: true });
  const next = await kbrain.updateSettings({ memory: { enabled: false } });
  assert.deepEqual(updates, [{ kbrainMemory: { enabled: false } }]);
  assert.deepEqual(next.memory, { enabled: false });
  assert.equal(doc.memory, organizer, "LiveAgent organizer settings must stay untouched");
  await kbrain.updateSettings({ aiApproval: { mode: "off" } });
  assert.deepEqual(Object.keys(updates.at(-1)), ["aiApproval"], "other updates gain no memory key");
});

test("WebUI reports no memory switch when the gateway projection has none", async () => {
  const kbrain = loadAdapter({ getSettings: async () => ({ customProviders: [] }), updateSettings: async () => {} });
  assert.equal((await kbrain.getSettings()).memory, undefined);
  assert.equal(kbrain.getCapabilities, undefined, "WebUI cannot reach /v1/health and relies on the document");
});
