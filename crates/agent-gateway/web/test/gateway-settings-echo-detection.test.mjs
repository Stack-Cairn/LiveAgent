// Regressions for ack-support detection in the WebUI settings echo guard.
// Harness mirrors gateway-settings-echo.test.mjs: real useGatewaySettingsSync hook,
// real settings/sync modules, JSDOM + React act, only transport and storage mocked.
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

function withSystem(settings, patch) {
  return settingsModule.normalizeSettings({
    ...settings,
    system: { ...settings.system, ...patch },
  });
}

const initial = withMode(settingsModule.normalizeSettings({}), "ask", false);

function snapshot(settings, acks) {
  const payload = structuredClone(syncModule.buildGatewaySettingsSyncPayload(settings));
  if (acks !== undefined) payload.appliedClientSeqs = acks;
  return payload;
}

async function harness(t, options = {}) {
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
      return structuredClone(nextGetSettings);
    },
    async updateSettings(payload) {
      updates.push(structuredClone(payload));
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
  const state = { current: null };
  function Probe() {
    state.current = useGatewaySettingsSync({ token: "token", api, activeAgentId: "agent" });
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
    state,
    get settings() {
      return state.current.settings;
    },
    mode() {
      return `${state.current.settings.system.commandSafetyMode}/${state.current.settings.chatRuntimeControls.planModeEnabled}`;
    },
    async update(updater) {
      await act(async () => {
        state.current.setSettings(updater);
      });
      await flush();
    },
    async set(mode, plan) {
      await this.update((prev) => withMode(prev, mode, plan));
    },
    async push(payload) {
      assert.ok(settingsListener, "settings subscription is live");
      await act(async () => settingsListener(structuredClone(payload)));
      await flush();
    },
    async disconnect() {
      assert.ok(connectionListener, "connection subscription is live");
      await act(async () => connectionListener(false));
    },
    async connect() {
      assert.ok(connectionListener, "connection subscription is live");
      await act(async () => connectionListener(true));
      await flush();
    },
    async tickAll() {
      await act(async () =>
        t.mock.timers.tick(hookModule.SETTINGS_ECHO_ACK_TIMEOUT_MS + hookModule.SETTINGS_ECHO_SETTLE_MS),
      );
      await flush();
    },
    flush,
  };
}

// Reconnect resets the guard to "no ack support" until getSettings answers. A Shift+Tab in
// that round trip is sent without syncClient (so the desktop can never ack it) and no ack
// timer is armed; when the getSettings answer then carries appliedClientSeqs the hook
// switches to ack mode, which also disables the settle replay. Nothing releases the field.
test("a field saved while ack support is being re-detected after reconnect is not held forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t);
  const reconnectGet = deferred();
  h.api.getSettings = () => reconnectGet.promise.then((payload) => structuredClone(payload));

  await h.disconnect();
  await h.connect(); // getSettings for recalibration is now in flight
  await h.set("autoEdit", false);
  assert.equal(h.updates.at(-1).syncClient, undefined, "update in the detection window has no marker");

  // getSettings was answered by the desktop before it saw the edit.
  reconnectGet.resolve(snapshot(initial, {}));
  await h.flush();
  // Desktop handles the marker-less update and publishes; nothing to ack for this tab.
  await h.push(snapshot(withMode(initial, "autoEdit", false), {}));
  assert.equal(h.mode(), "autoEdit/false");

  // Later the desktop user switches the permission mode on the desktop.
  await h.push(snapshot(withMode(initial, "always", false), {}));
  await h.tickAll();
  await h.push(snapshot(withMode(initial, "always", false), {}));
  assert.equal(
    h.mode(),
    "always/false",
    "after the edit is applied and every echo timer has run, desktop changes must reach the WebUI",
  );
});

// Same hole without a reconnect: the WebUI opened while the desktop was offline (or before
// its first push), so it starts without ack support. The first desktop push after an edit
// carries appliedClientSeqs and flips the hook into ack mode with the edit still pending.
// The stuck whole-block `system` then becomes the base of the next local edit, which sends
// a stale sibling field back and overwrites the desktop's newer value (the original bug).
test("switching from no-ack to ack mode with a pending field does not revert desktop siblings on the next edit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t, { acks: undefined });
  await h.set("autoEdit", false);
  assert.equal(h.updates.at(-1).syncClient, undefined);

  // Desktop (now reporting acks) publishes the applied edit.
  const applied = withMode(initial, "autoEdit", false);
  await h.push(snapshot(applied, {}));
  // Desktop then changes a sibling field inside `system`.
  const desktopNewer = withSystem(applied, { executionMode: "text" });
  await h.push(snapshot(desktopNewer, {}));
  await h.tickAll();
  await h.push(snapshot(desktopNewer, {}));

  // The next local Shift+Tab sends the whole system block.
  await h.set("always", false);
  const last = h.updates.at(-1);
  assert.equal(last.system.commandSafetyMode, "always");
  assert.equal(
    last.system.executionMode,
    "text",
    "the next system update must not overwrite the desktop's newer executionMode",
  );
});
