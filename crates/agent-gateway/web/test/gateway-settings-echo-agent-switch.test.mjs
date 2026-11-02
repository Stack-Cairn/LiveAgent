// Regression: each agent is its own desktop with its own ack table.
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

// The tab's sync id and highest seen ack survive an agent switch, but each agent is a
// different desktop with its own ack table. Coming back to a desktop this tab edited
// earlier, that desktop's table holds a lower seq for this id than the one the tab last saw
// from the other desktop, so the stale-snapshot rule drops every snapshot it sends,
// including the switch-time getSettings: the WebUI keeps showing the other agent's
// settings and the next edit sends that agent's whole `system` block to this desktop.
test("switching back to a previously edited agent applies that agent's settings", async (t) => {
  const h = await harness(t);
  const settingsB = withMode(initial, "always", false);
  const settingsA = withMode(initial, "ask", false);

  // Start on agent B and make one acknowledged edit (B's table: id -> 1).
  h.agentSnapshots.set("agent-b", snapshot(settingsB, {}));
  await h.switchAgent("agent-b");
  assert.equal(h.mode(), "always/false");
  await h.set("autoEdit", false);
  const id = h.clientId();
  assert.equal(typeof id, "string");
  const editedB = withMode(initial, "autoEdit", false);
  await h.push(snapshot(editedB, { [id]: { seq: 1 } }));

  // Agent A: two acknowledged edits (A's table: id -> 3).
  h.agentSnapshots.set("agent-a", snapshot(settingsA, {}));
  await h.switchAgent("agent-a");
  assert.equal(h.mode(), "ask/false");
  await h.set("ask", true);
  await h.set("ask", false);
  await h.push(snapshot(settingsA, { [id]: { seq: 3 } }));

  // Back to B: its desktop still reports id -> 1 alongside its own settings.
  h.agentSnapshots.set("agent-b", snapshot(editedB, { [id]: { seq: 1 } }));
  await h.switchAgent("agent-b");
  assert.equal(h.mode(), "autoEdit/false", "agent B's settings must be shown after switching back");
  await h.push(snapshot(withMode(editedB, "always", false), { [id]: { seq: 1 } }));
  assert.equal(h.mode(), "always/false", "agent B's live pushes must apply");
});
