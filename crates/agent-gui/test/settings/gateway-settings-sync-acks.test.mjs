import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const hostModule = fileURLToPath(new URL("../../src/lib/host.ts", import.meta.url));

test("WebUI sync markers are read strictly before they are acknowledged", async (t) => {
  const env = await createDomTestEnv();
  t.after(() => env.cleanup());
  const { readGatewaySettingsSyncClient } = env.loadModule("@liveagent/ui/lib/settings/sync.ts");
  assert.deepEqual(readGatewaySettingsSyncClient({ syncClient: { id: "tab-a", seq: 4 } }), {
    id: "tab-a",
    seq: 4,
  });
  for (const syncClient of [
    undefined,
    null,
    "tab-a",
    { id: "", seq: 1 },
    { id: "tab-a", seq: 0 },
    { id: "tab-a", seq: 1.5 },
    { id: "tab-a", seq: "1" },
  ]) {
    assert.equal(readGatewaySettingsSyncClient({ syncClient }), null, JSON.stringify(syncClient));
  }
});

test("desktop publishes acks alongside the snapshot only when it has some", async (t) => {
  const calls = [];
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/app/shims/tauriCore": {
        invoke: async (command, args) => {
          calls.push({ command, args });
        },
      },
      [hostModule]: {
        isKBrainBackendEnabled: () => false,
        isKBrainBrowserHost: () => false,
        isTauriHost: () => true,
        liveAgentRuntimeCapabilities: () => ({ frontendContext: true, gatewayMirror: true }),
      },
    },
  });
  t.after(() => env.cleanup());
  const { normalizeSettings } = env.loadModule("src/lib/settings/index.ts");
  const { publishGatewaySettingsSync } = env.loadModule("src/lib/settings/storage.ts");
  const settings = normalizeSettings({});

  await publishGatewaySettingsSync(settings);
  await publishGatewaySettingsSync(settings, [
    { id: "tab-a", seq: 2 },
    { id: "tab-b", seq: 5, error: "disk full" },
  ]);

  assert.deepEqual(
    calls.map(({ command }) => command),
    ["gateway_publish_settings_sync", "gateway_publish_settings_sync"],
  );
  assert.equal(Object.hasOwn(calls[0].args, "syncAcks"), false);
  assert.deepEqual(calls[1].args.syncAcks, [
    { id: "tab-a", seq: 2 },
    { id: "tab-b", seq: 5, error: "disk full" },
  ]);
  assert.equal(Object.hasOwn(calls[1].args.payload, "appliedClientSeqs"), false);
});
