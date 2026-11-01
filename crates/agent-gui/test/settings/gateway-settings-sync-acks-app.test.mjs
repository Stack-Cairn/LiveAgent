// Regression: the real App.tsx gateway settings listener and save
// queue, rendered in jsdom. Every child component and backend boundary is mocked; the
// listener, queueSettingsSave, queueSettingsSyncAck and the shared sync module are real.
//
// The CJS test loader turns `import.meta` into `{}`, so App.tsx is loaded from a temp copy
// whose only edits are `import.meta.env.X` -> `undefined`, relative specifiers made
// absolute (resolution, and therefore every mock key below, is unchanged) and runtime
// `import("x")` routed through the loader (vm scripts have no dynamic-import hook).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const srcDir = fileURLToPath(new URL("../../src/", import.meta.url));
const src = (relative) => path.join(srcDir, relative);

function loadableAppCopy() {
  const source = fs.readFileSync(src("App.tsx"), "utf8");
  const patched = source
    .replaceAll(/import\.meta\.env\.[A-Z_]+/g, "undefined")
    // Native separators so resolved paths equal the path.join() mock keys.
    .replaceAll(
      /(from |import\()"\.\/([^"]+)"/g,
      (_, prefix, relative) => `${prefix}${JSON.stringify(path.join(srcDir, relative))}`,
    )
    // vm scripts have no dynamic-import hook; route lazy imports through the loader.
    .replaceAll(/(?<!typeof )\bimport\(("[^"]+")\)/g, "Promise.resolve().then(() => require($1))");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "la-app-settings-acks-"));
  const file = path.join(dir, "App.tsx");
  fs.writeFileSync(file, patched);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function renderApp(t, { persistSettings }) {
  const listeners = new Map();
  const publishes = [];
  const Null = () => null;
  const Pass = ({ children }) => children ?? null;
  let env;
  const mocks = {
    "@liveagent/app/shims/tauriCore": { invoke: async () => undefined },
    "@liveagent/app/shims/tauriEvent": {
      listen: async (name, callback) => {
        listeners.set(name, callback);
        return () => listeners.delete(name);
      },
    },
    "@liveagent/ui/components/AppErrorBoundary": { AppErrorBoundary: Pass },
    "@liveagent/ui/components/IconSet": { Pin: Null },
    "@liveagent/ui/components/ui/confirm-dialog": {
      useConfirmDialog: () => ({ confirm: async () => true, dialog: null }),
    },
    "@liveagent/ui/components/ui/toaster": { Toaster: Null },
    "@liveagent/ui/lib/models/catalogLive": {
      CATALOG_LIVE_DEFAULT_URL: "",
      configureCatalogLiveSources() {},
      getCatalogLiveVersion: () => 0,
      loadCatalogLiveSupplement: async () => undefined,
      startCatalogLiveRefresh: () => () => {},
    },
    "@liveagent/ui/lib/models/thinkingLive": { loadThinkingLiveSupplement: async () => undefined },
    "@liveagent/ui/lib/models/useThinkingLive": { useCatalogLiveVersion: () => 0 },
    "@liveagent/ui/lib/resourceHost": {
      configureResourceHostCapabilities() {},
      kbrainResourceHostCapabilities: {},
    },
    "@liveagent/ui/lib/settings/useSettingsOverlay": {
      useSettingsOverlay: () => ({
        settingsOpen: false,
        overlay: "closed",
        openSettingsOverlay() {},
        closeSettingsOverlay() {},
        handleSettingsOverlayTransitionEnd() {},
      }),
    },
    "@liveagent/ui/lib/automation/index": { initAutomation: async () => undefined },
    "@liveagent/ui/lib/shared/fontFamily": {
      ...createTsModuleLoader().loadModule("@liveagent/ui/lib/shared/fontFamily.ts"),
      applyFontFamilies() {},
    },
    [src("agent-ui-adapters/imageStudio.ts")]: { useDesktopImageStudioHost: () => null },
    [src("agent-ui-adapters/kbrainSettings.ts")]: { settingsHostAdapter: {} },
    [src("agent-ui-adapters/kbrainSkills.ts")]: {
      kbrainSkillsAdapter: {
        list: async () => ({ settings: initial().skills }),
        settings: async () => undefined,
      },
    },
    [src("components/app/AppBootShell.tsx")]: { AppBootShell: Null },
    [src("components/input-context-menu/NativeInputContextMenu.tsx")]: {
      useNativeInputContextMenu: () => ({
        onRootContextMenu() {},
        onRootMouseDownCapture() {},
        menu: null,
      }),
    },
    [src("components/MacOsTitleBarSpacer.tsx")]: { useMacOsAppHeaderHeight() {} },
    [src("components/ReleaseAnnouncementDialog.tsx")]: { ReleaseAnnouncementDialog: Null },
    [src("components/WindowsSettingsHeader.tsx")]: { WindowsSettingsHeader: Null },
    [src("components/WindowsTitleBar.tsx")]: { WindowsTitleBar: Null },
    [src("lib/appUpdates.ts")]: { useAppUpdateController: () => ({ runCheck: async () => {} }) },
    [src("lib/host.ts")]: {
      isKBrainBackendEnabled: () => false,
      isKBrainBrowserHost: () => false,
      isTauriHost: () => true,
      liveAgentRuntimeCapabilities: () => ({ frontendContext: true, gatewayMirror: true }),
    },
    [src("lib/kbrain/HistoryMigrationNoticeBanner.tsx")]: { HistoryMigrationNoticeBanner: Null },
    [src("lib/planning/kbrain.ts")]: { requestPlanning: async () => undefined },
    [src("lib/planning/TimeZoneNoticeBanner.tsx")]: { TimeZoneNoticeBanner: Null },
    [src("lib/providers/runtime/streamRetry.ts")]: { setRetryErrorExtension() {} },
    [src("lib/releaseAnnouncement.ts")]: { useReleaseAnnouncementController: () => ({}) },
    [src("lib/settings/legacyProviderImport.ts")]: {
      clearRejectedLegacyProviders() {},
      dismissRejectedLegacyProviders() {},
      rejectedLegacyProviders: () => [],
      subscribeRejectedLegacyProviders: () => () => {},
    },
    [src("lib/settings/storage.ts")]: {
      loadPersistedSettingsWithDefaults: async () => ({ settings: initial(), defaultWorkdir: "" }),
      persistSettings,
      publishGatewaySettingsSync: async (settings, syncAcks = []) => {
        publishes.push({ settings, syncAcks: structuredClone(syncAcks) });
      },
      reconcileKBrainCatalogMetadata: async () => undefined,
    },
    [src("lib/stt/desktopSttSettingsService.ts")]: { desktopSttSettingsService: {} },
    [src("pages/ChatPage.tsx")]: { ChatPage: Null },
    [src("components/cron/CronPromptRunner.tsx")]: { CronPromptRunner: Null },
    [src("lib/shortcuts/globalShortcuts.ts")]: {
      applyStoredGlobalShortcuts: async () => undefined,
      installAppShortcutListener: () => () => {},
    },
  };
  env = await createDomTestEnv({ mocks });
  globalThis.__LIVEAGENT_APP_VERSION__ = "0.0.0-test";
  const settingsModule = env.loadModule("src/lib/settings/index.ts");
  initialSettings = settingsModule.normalizeSettings({});
  const app = loadableAppCopy();
  const { default: App } = env.loadModule(app.file);
  const container = env.dom.window.document.createElement("div");
  const root = env.createRoot(container);
  t.after(async () => {
    await env.act(async () => root.unmount());
    env.cleanup();
    app.cleanup();
    delete globalThis.__LIVEAGENT_APP_VERSION__;
  });
  await env.act(async () => root.render(env.React.createElement(App)));
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) {
      await env.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };
  await flush();
  assert.ok(listeners.has("gateway:settings-sync"), "App registered the gateway settings listener");
  return {
    settingsModule,
    publishes,
    flush,
    async emit(payload) {
      await env.act(async () => {
        listeners.get("gateway:settings-sync")({ payload: structuredClone(payload) });
      });
    },
  };
}

let initialSettings;
const initial = () => structuredClone(initialSettings);

// WebUI rapid Shift+Tab: seq 1 changes system, seq 2 changes chatRuntimeControls. The desktop
// fails to persist seq 1. The Rust ack table keeps only the highest seq per tab and ignores a
// lower one (tests.rs applied_client_seqs_track_each_tab_independently_and_never_go_backwards:
// `tab-a, 1, "late"` is dropped), so the failure reaches the WebUI only if its ack is
// published before seq 2's ack.
test("a failed save's error ack is published before later acks from the same tab", async (t) => {
  const firstPersist = deferred();
  let persistCalls = 0;
  const h = await renderApp(t, {
    persistSettings: async () => {
      persistCalls += 1;
      if (persistCalls === 1) await firstPersist.promise;
      return {};
    },
  });
  h.publishes.length = 0; // drop the hydration publish

  const base = initial();
  await h.emit({
    system: { ...base.system, commandSafetyMode: "autoEdit" },
    syncClient: { id: "tab-a", seq: 1 },
  });
  await h.emit({
    chatRuntimeControls: { ...base.chatRuntimeControls, planModeEnabled: true },
    syncClient: { id: "tab-a", seq: 2 },
  });
  firstPersist.reject(new Error("disk full"));
  await h.flush();

  const acks = h.publishes.flatMap((publish) => publish.syncAcks);
  assert.deepEqual(
    acks.map((ack) => ack.seq),
    [1, 2],
    `acks must leave in update order, got ${JSON.stringify(acks)}`,
  );
  assert.match(acks[0].error ?? "", /disk full/, "seq 1 carries the persist error");
});
