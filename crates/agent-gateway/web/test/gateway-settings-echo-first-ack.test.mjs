// Regression: a snapshot read before this tab's first ack must not revert the edit.
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

function snapshot(settings, acks, version) {
  const payload = structuredClone(syncModule.buildGatewaySettingsSyncPayload(settings));
  if (acks !== undefined) payload.appliedClientSeqs = acks;
  if (version !== undefined) payload.settingsSyncVersion = version;
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
  // Each agent is a different desktop with its own settings and its own ack table.
  const agentSnapshots = new Map();
  const agentState = { id: "agent-a" };
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
      return structuredClone(agentSnapshots.get(agentState.id) ?? nextGetSettings);
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
    state.current = useGatewaySettingsSync({ token: "token", api, activeAgentId: agentState.id });
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
    agentSnapshots,
    async switchAgent(id) {
      agentState.id = id;
      await act(async () => root.render(React.createElement(Probe)));
      await flush();
    },
    clientId() {
      return updates.find((update) => update.syncClient)?.syncClient.id;
    },
    flush,
  };
}

// Rust takes the ack table before reading the cache (settings_read_mark) on the
// reconcile / refresh_settings_sync_from_db / SSH paths. When such a read starts before
// this tab's first marked update is recorded, the table has no entry for this tab, so the
// stale-snapshot rule (ack < highest seen) cannot fire and the snapshot is applied after
// the ack already released the field. Every newly opened tab's first edit is a "first"
// update (the id is per page load), and so is the first edit after a desktop restart:
// that restart drops the desktop<->Gateway link, not the WebUI socket, so the hook's
// reconnect reset does not run. Nothing re-publishes afterwards, so the revert stays.
test("a snapshot read before this tab's first ack does not revert the acknowledged edit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t);
  // Plan mode lives in chatRuntimeControls, a UI-only field Rust takes from its cache
  // (UI_ONLY_SETTINGS_SYNC_FIELDS), so a cache read from before the edit is stale for it.
  await h.set("ask", true);
  const id = h.clientId();
  assert.equal(typeof id, "string");

  // Front-end publish of the applied edit, ack recorded for this tab.
  await h.push(
    snapshot(withMode(initial, "ask", true), { [id]: { seq: 1 } }, { epoch: "d1", generation: 3 }),
  );
  assert.equal(h.mode(), "ask/true");

  // A refresh that read the cache and the table before ack 1 was recorded; another tab's
  // entry shows the table itself was not empty.
  // Its cache read came before that publish's store, so its generation is older.
  await h.push(snapshot(initial, { "other-tab": { seq: 4 } }, { epoch: "d1", generation: 2 }));
  await h.tickAll();
  assert.equal(h.mode(), "ask/true", "the acknowledged edit must not be reverted");
});
