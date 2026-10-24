// Fourth review (2aa05c4e): the WebUI memory switch behind the desktop-owned Gateway.
// Drives the shipped WebUI adapter (agent-gateway/web settingsExtension.tsx) and the shipped
// MemorySwitch. The gateway client stands in for the desktop agent as envelope_handler.rs
// answers: settings.get takes kbrainMemory from the same K-brain settings read as the rest
// of the snapshot, so it either carries the switch or fails as a whole when K-brain cannot
// be read; settings.update with a failed K-brain write is an error response (502).
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../../agent-gateway/test/helpers/load-web-module.mjs";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

function loadWebAdapter(client) {
  const loader = createWebModuleLoader({
    rootDir: fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url)),
    mocks: {
      "../lib/gatewaySocket": { getGatewayWebSocketClient: () => client },
      "../lib/storage": { loadToken: () => "fixture" },
      "../pages/settings/DevicesSection": { DevicesSection: () => null },
      "@liveagent/ui/components/IconSet": { MonitorSmartphone: () => null },
      "@liveagent/ui/lib/resourceHost": {
        configureResourceHostCapabilities() {},
        kbrainResourceHostCapabilities: {},
      },
    },
  });
  return loader.loadModule("src/agent-ui-adapters/settingsExtension.tsx").settingsHostAdapter.kbrain;
}

function desktopAgent() {
  const kbrain = { enabled: true, readFails: false, writeFails: false };
  const updates = [];
  return {
    kbrain,
    updates,
    client: {
      async getSettings() {
        if (kbrain.readFails) throw new Error("K-brain settings request failed: error sending request");
        return {
          customProviders: [],
          memory: { organizerEnabled: true },
          kbrainMemory: { enabled: kbrain.enabled },
        };
      },
      async updateSettings(payload) {
        updates.push(payload);
        if (kbrain.writeFails) throw new Error("save K-brain memory switch failed: error sending request");
        kbrain.enabled = payload.kbrainMemory.enabled;
      },
    },
  };
}

async function mount(adapter) {
  const toasts = [];
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/ui/toast-manager": {
        toast: { error: (m) => toasts.push(m), success() {} },
      },
    },
  });
  const { MemorySwitch } = env.loadModule("@liveagent/ui/pages/settings/memory/MemorySwitch.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  await env.act(async () => root.render(env.React.createElement(MemorySwitch, { kbrain: adapter })));
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) {
      await env.act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
  };
  const toggle = () => host.querySelector('[role="switch"]');
  const dispose = async () => {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  };
  return { env, toasts, settle, toggle, dispose };
}

test("review4: WebUI round trip over the desktop agent sends only kbrainMemory and reads it back", async () => {
  const agent = desktopAgent();
  const m = await mount(loadWebAdapter(agent.client));
  try {
    await m.settle();
    assert.equal(m.toggle().getAttribute("aria-checked"), "true");
    await m.env.act(async () => m.toggle().click());
    await m.settle();
    assert.deepEqual(agent.updates, [{ kbrainMemory: { enabled: false } }]);
    assert.equal(m.toggle().getAttribute("aria-checked"), "false");
    assert.deepEqual(m.toasts, []);
  } finally {
    await m.dispose();
  }
});

// A K-brain read failure behind the desktop agent fails settings.get as a whole, so the
// WebUI keeps the last confirmed state (as on the desktop) instead of hiding the switch.
test("review4: a failed K-brain read behind the desktop agent keeps the switch on screen", async () => {
  const agent = desktopAgent();
  const m = await mount(loadWebAdapter(agent.client));
  try {
    await m.settle();
    assert.equal(m.toggle().getAttribute("aria-checked"), "true");
    agent.kbrain.writeFails = true;
    agent.kbrain.readFails = true;
    await m.env.act(async () => m.toggle().click());
    await m.settle();
    assert.equal(agent.updates.length, 1);
    assert.notEqual(m.toggle(), null, "the row stays after the failed save");
    assert.equal(m.toggle().getAttribute("aria-checked"), "true", "last confirmed state is kept");
    assert.equal(m.toasts.length, 1, "the failed save is reported");

    agent.kbrain.writeFails = false;
    agent.kbrain.readFails = false;
    agent.kbrain.enabled = false;
    await m.env.act(async () => window.dispatchEvent(new Event("kbrain:settings-changed")));
    await m.settle();
    assert.equal(m.toggle().getAttribute("aria-checked"), "false", "a later refresh reads the backend again");
  } finally {
    await m.dispose();
  }
});
