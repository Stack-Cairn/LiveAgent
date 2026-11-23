// The K-brain relay has no home for UI preferences and refuses them; its settings
// snapshot declares them browser-local. Real useGatewaySettingsSync hook, JSDOM +
// React act, only transport and storage mocked (as in gateway-settings-echo-detection).
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

const initial = settingsModule.normalizeSettings({ locale: "en-US", theme: "light" });

/** What the Go relay accepts: backend-owned fields only (settingsUpdateForKBrain). */
const RELAY_FIELDS = new Set([
  "selectedModel",
  "customProviders",
  "deleteProviders",
  "providerApiKeyUpdates",
  "providerUsageQuerySecretUpdates",
  "computer",
  "aiApproval",
  "mcp",
  "skills",
  "agents",
  "projectPrompts",
  "kbrainMemory",
  "kbrainMemoryOrganizer",
  "kbrainWebSearch",
]);

function desktopSnapshot(settings) {
  return structuredClone(syncModule.buildGatewaySettingsSyncPayload(settings));
}

/** Mirrors relayBrowserLocalSettings in internal/kbrain/settings.go. */
const RELAY_BROWSER_LOCAL = ["locale", "theme", "system", "customSettings"];

function relaySnapshot(settings, browserLocalSettings = RELAY_BROWSER_LOCAL) {
  const payload = desktopSnapshot(settings);
  for (const field of RELAY_BROWSER_LOCAL) delete payload[field];
  payload.browserLocalSettings = browserLocalSettings;
  return payload;
}

async function harness(t, { getSettings, rejectUnsupported = true, syncScreenMaxMs }) {
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
  const originalConsoleError = console.error;
  console.error = () => {};
  cleanups.push(() => {
    console.error = originalConsoleError;
  });

  const updates = [];
  const persisted = [];
  const api = {
    subscribeSettings: () => () => {},
    subscribeConnection: () => () => {},
    async getSettings() {
      return typeof getSettings === "function" ? getSettings() : structuredClone(getSettings);
    },
    async updateSettings(payload) {
      updates.push(structuredClone(payload));
      const unsupported = Object.keys(payload).find((key) => !RELAY_FIELDS.has(key));
      if (rejectUnsupported && unsupported) {
        throw new Error(
          `unsupported Gateway settings field "${unsupported}": non-provider settings persistence is unavailable`,
        );
      }
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
        persistWebSettings(settings) {
          persisted.push(structuredClone(settings));
        },
      },
    },
  });
  const { useGatewaySettingsSync } = loader.loadModule("src/app/hooks/useGatewaySettingsSync.ts");
  const state = { current: null };
  function Probe() {
    state.current = useGatewaySettingsSync({
      token: "token",
      api,
      activeAgentId: "agent",
      syncScreenMaxMs,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };
  await act(async () => root.render(React.createElement(Probe)));
  await flush();
  return {
    updates,
    persisted,
    get current() {
      return state.current;
    },
    async update(updater) {
      await act(async () => state.current.setSettings(updater));
      await flush();
    },
  };
}

test("relay: switching the language stays in the browser and says so", async (t) => {
  const h = await harness(t, { getSettings: relaySnapshot(initial) });
  assert.equal(h.current.settingsSyncReady, true);

  await h.update((prev) => ({ ...prev, locale: "zh-CN" }));
  assert.deepEqual(h.updates, [], "no save is sent that the relay must refuse");
  assert.deepEqual(h.current.settingsSaveState, { status: "savedOnDevice" });
  assert.equal(h.current.settings.locale, "zh-CN");
  assert.equal(h.persisted.at(-1).locale, "zh-CN", "the choice is kept in browser storage");

  await h.update((prev) => ({ ...prev, locale: "en-US", theme: "dark" }));
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.current.settingsSaveState, { status: "savedOnDevice" });
  assert.equal(h.persisted.at(-1).locale, "en-US");
  assert.equal(h.persisted.at(-1).theme, "dark");
});

test("relay: backend fields changed together with the language are still sent", async (t) => {
  const h = await harness(t, { getSettings: relaySnapshot(initial) });
  await h.update((prev) => ({
    ...prev,
    locale: "zh-CN",
    skills: { ...prev.skills, enabled: !prev.skills.enabled },
  }));
  assert.equal(h.updates.length, 1);
  assert.ok(h.updates[0].skills, "the backend field reaches the relay");
  assert.equal(Object.hasOwn(h.updates[0], "locale"), false);
  assert.deepEqual(
    h.current.settingsSaveState,
    { status: "savedOnDevice" },
    "the language part of the save lives only in this browser",
  );
});

test("relay: a field the relay genuinely refuses still shows the save failure", async (t) => {
  const h = await harness(t, { getSettings: relaySnapshot(initial) });
  await h.update((prev) => ({
    ...prev,
    chatRuntimeControls: {
      ...prev.chatRuntimeControls,
      planModeEnabled: !prev.chatRuntimeControls.planModeEnabled,
    },
  }));
  assert.equal(h.updates.length, 1);
  assert.equal(h.current.settingsSaveState.status, "error");
  assert.match(h.current.settingsSaveState.message, /chatRuntimeControls/);
});

test("relay: execution and project settings stay in the browser instead of failing", async (t) => {
  // These used to be sent as `system` and refused ("unsupported Gateway settings
  // field"), so the change only lived until the next snapshot.
  const h = await harness(t, { getSettings: relaySnapshot(initial) });
  await h.update((prev) => ({
    ...prev,
    system: { ...prev.system, commandSafetyMode: "autoEdit", workdir: "/srv/project" },
  }));
  assert.deepEqual(h.updates, [], "no save is sent that the relay must refuse");
  assert.deepEqual(h.current.settingsSaveState, { status: "savedOnDevice" });
  assert.equal(h.current.settings.system.workdir, "/srv/project");
  assert.equal(h.persisted.at(-1).system.commandSafetyMode, "autoEdit");
});

test("relay: appearance preferences stay in the browser instead of failing", async (t) => {
  const h = await harness(t, { getSettings: relaySnapshot(initial) });
  await h.update((prev) => ({
    ...prev,
    customSettings: { ...prev.customSettings, promptClarifyEnabled: !prev.customSettings.promptClarifyEnabled },
  }));
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.current.settingsSaveState, { status: "savedOnDevice" });
  assert.equal(
    h.persisted.at(-1).customSettings.promptClarifyEnabled,
    !initial.customSettings.promptClarifyEnabled,
  );
});

test("desktop: execution settings keep syncing when the target persists them", async (t) => {
  const h = await harness(t, { getSettings: desktopSnapshot(initial), rejectUnsupported: false });
  await h.update((prev) => ({ ...prev, system: { ...prev.system, workdir: "/srv/project" } }));
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].system.workdir, "/srv/project");
  assert.deepEqual(h.current.settingsSaveState, { status: "saved" });
});

test("a target can only declare display preferences browser-local", async (t) => {
  const h = await harness(t, {
    getSettings: relaySnapshot(initial, ["skills", "locale"]),
    rejectUnsupported: false,
  });
  await h.update((prev) => ({
    ...prev,
    theme: "dark",
    skills: { ...prev.skills, enabled: !prev.skills.enabled },
  }));
  assert.equal(h.updates.length, 1);
  assert.ok(h.updates[0].skills, "backend fields are never dropped from saves");
  assert.equal(h.updates[0].theme, "dark", "theme was not declared, so it is still sent");
});

test("desktop: the language keeps syncing when the target persists it", async (t) => {
  const h = await harness(t, { getSettings: desktopSnapshot(initial), rejectUnsupported: false });
  await h.update((prev) => ({ ...prev, locale: "zh-CN" }));
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].locale, "zh-CN");
  assert.deepEqual(h.current.settingsSaveState, { status: "saved" });
});

test("a target that never answers the settings request does not hold the sync screen", async (t) => {
  // An offline or stalled target used to keep "Syncing desktop settings" up
  // until settings.get timed out (about 14 s on a fresh browser).
  const h = await harness(t, { getSettings: () => new Promise(() => {}), syncScreenMaxMs: 40 });
  assert.equal(h.current.settingsSyncReady, false);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await h.update((prev) => prev);
  assert.equal(h.current.settingsSyncReady, true);
  assert.equal(h.current.settingsSyncError, null, "a slow target is not reported as a failure");
});
