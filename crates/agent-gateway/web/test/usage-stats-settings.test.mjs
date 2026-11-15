import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

// Settings → 用量统计 on the WebUI: the shared page reads K-brain's usage through the
// Gateway (usage.stats) and gets the same answer shape as the desktop adapter.
function load(client) {
  const loader = createWebModuleLoader({
    rootDir: fileURLToPath(new URL("../", import.meta.url)),
    mocks: {
      "../lib/gatewaySocket": { getGatewayWebSocketClient: () => client },
      "../lib/storage": { loadToken: () => "fixture" },
      "../pages/settings/DevicesSection": { DevicesSection: () => null },
      "@liveagent/ui/components/IconSet": { MonitorSmartphone: () => null },
      "@liveagent/ui/lib/resourceHost": { configureResourceHostCapabilities() {}, nativeResourceHostCapabilities: {} },
    },
  });
  return loader.loadModule("src/agent-ui-adapters/settingsExtension.tsx").settingsHostAdapter.kbrain;
}

test("the WebUI adapter asks the Gateway for usage with only days and time zone", async () => {
  const calls = [];
  const kbrain = load({
    usageStats: async (query) => {
      calls.push(query);
      return { available: true, stats: { totals: { total: 5 } } };
    },
  });
  assert.equal(typeof kbrain.getUsageStats, "function", "the page is registered on the WebUI");
  assert.deepEqual(await kbrain.getUsageStats({ days: 371, timezone: "Europe/Berlin", extra: 1 }), {
    available: true,
    stats: { totals: { total: 5 } },
  });
  assert.deepEqual(calls, [{ days: 371, timezone: "Europe/Berlin" }]);
});

test("an unsupported K-brain and an old desktop reach the page differently", async () => {
  assert.deepEqual(await load({ usageStats: async () => ({ available: false }) }).getUsageStats({ days: 371, timezone: "UTC" }), { available: false });
  const old = load({ usageStats: async () => { throw new Error("desktop app does not support usage statistics; update LiveAgent on the desktop"); } });
  await assert.rejects(old.getUsageStats({ days: 371, timezone: "UTC" }), /update LiveAgent on the desktop/);
});
