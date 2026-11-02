import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { createRoot } from "react-dom/client";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const base = createWebModuleLoader({ rootDir });
const settingsModule = base.loadModule("src/lib/settings");
const syncModule = base.loadModule("@liveagent/ui/lib/settings/sync.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function withMode(settings, mode, plan = settings.chatRuntimeControls.planModeEnabled) {
  return settingsModule.normalizeSettings({
    ...settings,
    system: { ...settings.system, commandSafetyMode: mode },
    chatRuntimeControls: { ...settings.chatRuntimeControls, planModeEnabled: plan },
  });
}

const initial = withMode(settingsModule.normalizeSettings({}), "ask", false);

function snapshot(settings, acks, version) {
  const payload = structuredClone(syncModule.buildGatewaySettingsSyncPayload(settings));
  if (acks !== undefined) payload.appliedClientSeqs = acks;
  if (version !== undefined) payload.settingsSyncVersion = version;
  return payload;
}

async function harness(t, options = {}) {
  const { updateSettings } = options;
  const acks = Object.hasOwn(options, "acks") ? options.acks : {};
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node"]) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
    cleanups.push(() =>
      original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key],
    );
  }
  const originalAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  cleanups.push(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
  });

  const updates = [];
  const getSettingsCalls = [];
  let settingsListener = null;
  let connectionListener = null;
  let nextGetSettings = snapshot(initial, acks);
  const api = {
    subscribeSettings(listener) {
      settingsListener = listener;
      return () => {
        settingsListener = null;
      };
    },
    subscribeConnection(listener) {
      connectionListener = listener;
      return () => {
        connectionListener = null;
      };
    },
    async getSettings() {
      getSettingsCalls.push(nextGetSettings);
      return structuredClone(nextGetSettings);
    },
    async updateSettings(payload) {
      updates.push(structuredClone(payload));
      if (updateSettings) return updateSettings(payload);
    },
  };

  const loader = createWebModuleLoader({
    rootDir,
    mocks: {
      react: React,
      "react/jsx-runtime": jsxRuntime,
      "@liveagent/ui/lib/automation/index": {
        initAutomation: async () => undefined,
        feedCronSnapshot() {},
        feedHooksSnapshot() {},
      },
      "@liveagent/ui/lib/models/useThinkingLive": { useCatalogLiveVersion: () => 0 },
      "@liveagent/ui/lib/monacoNls": { setPreferredMonacoNlsLocale() {} },
      "@liveagent/ui/lib/shared/fontFamily": {
        ...base.loadModule("@liveagent/ui/lib/shared/fontFamily.ts"),
        applyFontFamilies() {},
      },
      "@/lib/storage": { loadToken: () => "token" },
      "@/lib/stt/webSttSettingsService": {
        webSttSettingsService: {
          get: async () => {
            throw new Error("stt unavailable in test");
          },
        },
      },
      "@/lib/webSettings": {
        loadWebSettings: () => structuredClone(initial),
        persistWebSettings() {},
      },
    },
  });
  const hookModule = loader.loadModule("src/app/hooks/useGatewaySettingsSync.ts");
  const { useGatewaySettingsSync } = hookModule;
  const state = { current: null, modes: [] };
  function Probe() {
    const result = useGatewaySettingsSync({ token: "token", api, activeAgentId: "agent" });
    state.current = result;
    const mode = `${result.settings.system.commandSafetyMode}/${result.settings.chatRuntimeControls.planModeEnabled}`;
    if (state.modes.at(-1) !== mode) state.modes.push(mode);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  await act(async () => root.render(React.createElement(Probe)));
  await act(async () => {
    await Promise.resolve();
  });

  const flush = async () => {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };
  return {
    sync: hookModule,
    api,
    updates,
    getSettingsCalls,
    state,
    get settings() {
      return state.current.settings;
    },
    mode() {
      return `${state.current.settings.system.commandSafetyMode}/${state.current.settings.chatRuntimeControls.planModeEnabled}`;
    },
    async set(mode, plan) {
      await act(async () => {
        state.current.setSettings((prev) => withMode(prev, mode, plan));
      });
      await flush();
    },
    async push(payload) {
      assert.ok(settingsListener, "settings subscription is live");
      await act(async () => settingsListener(structuredClone(payload)));
      await flush();
    },
    async reconnect() {
      assert.ok(connectionListener, "connection subscription is live");
      await act(async () => connectionListener(false));
      await act(async () => connectionListener(true));
      await flush();
    },
    setNextGetSettings(payload) {
      nextGetSettings = payload;
    },
    flush,
    clientId() {
      return updates.find((update) => update.syncClient)?.syncClient.id;
    },
  };
}

test("an echo of an earlier local save never rolls back a later local save", async (t) => {
  const h = await harness(t);
  await h.set("autoEdit", false);
  await h.set("autoEdit", true);
  assert.deepEqual(
    h.updates.map((update) => update.syncClient?.seq),
    [1, 2],
    "desktop-capable snapshots make every update carry a per-tab sequence",
  );
  const id = h.clientId();
  assert.equal(typeof id, "string");

  await h.push(snapshot(withMode(initial, "autoEdit", false), { [id]: { seq: 1 } }));
  assert.equal(h.mode(), "autoEdit/true", "seq 1 echo must not undo seq 2");

  await h.push(snapshot(withMode(initial, "autoEdit", true), { [id]: { seq: 2 } }));
  assert.equal(h.mode(), "autoEdit/true");

  await h.push(snapshot(withMode(initial, "always", false), { [id]: { seq: 2 } }));
  assert.equal(h.mode(), "always/false", "after the last ack, other devices' changes apply");
});

test("rapid Shift+Tab cycling that revisits a value keeps the final state through every echo", async (t) => {
  const h = await harness(t);
  const cycle = [
    ["autoEdit", false],
    ["autoEdit", true],
    ["ask", true],
    ["ask", false],
    ["autoEdit", false],
    ["autoEdit", true],
  ];
  for (const [mode, plan] of cycle) await h.set(mode, plan);
  const id = h.clientId();
  const before = h.state.modes.length;
  for (const [index, [mode, plan]] of cycle.entries()) {
    await h.push(snapshot(withMode(initial, mode, plan), { [id]: { seq: index + 1 } }));
    assert.equal(h.mode(), "autoEdit/true", `echo ${index + 1} must not surface an older state`);
  }
  assert.equal(h.state.modes.length, before, "no intermediate state was rendered");
});

test("another tab's acknowledgements never release this tab's pending fields", async (t) => {
  const h = await harness(t);
  await h.set("autoEdit", false);
  await h.set("autoEdit", true);
  const id = h.clientId();
  await h.push(snapshot(withMode(initial, "ask", false), { other: { seq: 9 } }));
  assert.equal(h.mode(), "autoEdit/true");
  await h.push(
    snapshot(withMode(initial, "autoEdit", false), { other: { seq: 9 }, [id]: { seq: 1 } }),
  );
  assert.equal(h.mode(), "autoEdit/true", "seq 1 releases system but not chatRuntimeControls");
});

test("unrelated fields from other devices apply while local fields are pending", async (t) => {
  const h = await harness(t);
  await h.set("autoEdit", true);
  const id = h.clientId();
  const foreign = settingsModule.normalizeSettings({ ...withMode(initial, "ask", false), theme: "dark" });
  await h.push(snapshot(foreign, { [id]: { seq: 0 } }));
  assert.equal(h.settings.theme, "dark");
  assert.equal(h.mode(), "autoEdit/true");
});

test("a failed desktop save acknowledgement releases the field and reports the error", async (t) => {
  const h = await harness(t);
  await h.set("autoEdit", true);
  const id = h.clientId();
  // The desktop keeps the value in memory after a failed write and publishes it.
  await h.push(snapshot(withMode(initial, "autoEdit", true), { [id]: { seq: 1, error: "disk full" } }));
  assert.equal(h.mode(), "autoEdit/true");
  assert.equal(h.state.current.settingsSaveState.status, "error");
  assert.match(h.state.current.settingsSaveState.message, /disk full/);
  await h.push(snapshot(withMode(initial, "always", false), { [id]: { seq: 1, error: "disk full" } }));
  assert.equal(h.mode(), "always/false", "the field is released, later desktop changes apply");
});

test("a snapshot read from an older desktop cache than one already applied is dropped", async (t) => {
  const h = await harness(t);
  await h.set("autoEdit", false);
  await h.set("autoEdit", true);
  const id = h.clientId();
  await h.push(
    snapshot(withMode(initial, "autoEdit", true), { [id]: { seq: 2 } }, { epoch: "d1", generation: 5 }),
  );
  const stale = settingsModule.normalizeSettings({ ...withMode(initial, "ask", false), theme: "dark" });
  // e.g. a reconcile that read the cache before the publish above and sent afterwards
  await h.push(snapshot(stale, { [id]: { seq: 2 } }, { epoch: "d1", generation: 4 }));
  assert.equal(h.mode(), "autoEdit/true");
  assert.notEqual(h.settings.theme, "dark", "nothing from a snapshot older than the applied one");
  await h.push(snapshot(stale, { [id]: { seq: 2 } }, { epoch: "d1", generation: 6 }));
  assert.equal(h.mode(), "ask/false", "newer generations still apply");
});

test("a restarted desktop (new epoch) is the truth even for fields still pending here", async (t) => {
  const h = await harness(t);
  await h.set("autoEdit", true);
  const id = h.clientId();
  await h.push(snapshot(withMode(initial, "ask", false), { [id]: { seq: 0 } }, { epoch: "d1", generation: 9 }));
  assert.equal(h.mode(), "autoEdit/true", "still pending on the first desktop process");
  await h.push(snapshot(withMode(initial, "always", false), {}, { epoch: "d2", generation: 1 }));
  assert.equal(h.mode(), "always/false", "generation 1 of a new process is not stale");
  await h.set("ask", true);
  assert.equal(h.updates.at(-1).syncClient.seq, 2);
  await h.push(snapshot(withMode(initial, "ask", true), { [id]: { seq: 2 } }, { epoch: "d2", generation: 2 }));
  await h.push(snapshot(withMode(initial, "autoEdit", false), { [id]: { seq: 2 } }, { epoch: "d2", generation: 3 }));
  assert.equal(h.mode(), "autoEdit/false", "acks from the new process release fields again");
});

test("reconnecting drops pending fields and recalibrates from getSettings", async (t) => {
  const h = await harness(t);
  await h.set("autoEdit", true);
  const id = h.clientId();
  h.setNextGetSettings(snapshot(withMode(initial, "always", false), {}));
  await h.reconnect();
  assert.equal(h.getSettingsCalls.length, 2);
  assert.equal(h.mode(), "always/false");
  await h.push(snapshot(withMode(initial, "ask", true), { [id]: { seq: 0 } }));
  assert.equal(h.mode(), "ask/true", "nothing is held after reconnect");
});

test("a rejected update releases its fields and recalibrates", async (t) => {
  const h = await harness(t, {
    updateSettings: async () => {
      throw new Error("gateway rejected");
    },
  });
  h.setNextGetSettings(snapshot(withMode(initial, "always", false), {}));
  await h.set("autoEdit", true);
  assert.equal(h.mode(), "always/false");
});

test("a desktop that never acknowledges is recalibrated after the ack timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t);
  await h.set("autoEdit", true);
  h.setNextGetSettings(snapshot(withMode(initial, "always", false), {}));
  await act(async () => t.mock.timers.tick(h.sync.SETTINGS_ECHO_ACK_TIMEOUT_MS));
  await h.flush();
  assert.equal(h.mode(), "always/false");
});

test("without desktop acknowledgements, echoes are held until the save chain settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t, { acks: undefined });
  await h.set("autoEdit", false);
  await h.set("autoEdit", true);
  assert.ok(
    h.updates.every((update) => update.syncClient === undefined),
    "old desktops and the K-brain relay reject unknown update fields",
  );
  await h.push(snapshot(withMode(initial, "autoEdit", false)));
  assert.equal(h.mode(), "autoEdit/true");
  await h.push(snapshot(withMode(initial, "autoEdit", true)));
  await act(async () => t.mock.timers.tick(h.sync.SETTINGS_ECHO_SETTLE_MS));
  await h.flush();
  assert.equal(h.mode(), "autoEdit/true", "replaying held echoes ends on the latest snapshot");
  await h.push(snapshot(withMode(initial, "ask", false)));
  assert.equal(h.mode(), "ask/false");
});

test("relay mode with no pushes releases pending fields after the save settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t, { acks: undefined });
  await h.set("autoEdit", true);
  await act(async () => t.mock.timers.tick(h.sync.SETTINGS_ECHO_SETTLE_MS));
  await h.flush();
  await h.push(snapshot(withMode(initial, "always", false)));
  assert.equal(h.mode(), "always/false");
});

test("a held A-mode echo older than a later local edit does not survive the settle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t, { acks: undefined });
  const slow = deferred();
  h.api.updateSettings = async (payload) => {
    h.updates.push(structuredClone(payload));
    if (h.updates.length === 2) await slow.promise;
  };
  await h.set("autoEdit", false);
  await h.set("autoEdit", true);
  await h.push(snapshot(withMode(initial, "autoEdit", false)));
  await act(async () => t.mock.timers.tick(h.sync.SETTINGS_ECHO_SETTLE_MS));
  await h.flush();
  assert.equal(h.mode(), "autoEdit/true", "an in-flight save keeps the chain unsettled");
  slow.resolve();
  await h.flush();
  await h.push(snapshot(withMode(initial, "autoEdit", true)));
  await act(async () => t.mock.timers.tick(h.sync.SETTINGS_ECHO_SETTLE_MS));
  await h.flush();
  assert.equal(h.mode(), "autoEdit/true");
});
