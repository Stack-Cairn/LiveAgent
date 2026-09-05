import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "CustomEvent",
]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false });
const loader = createWebModuleLoader({
  mocks: {
    react: React,
    "@/lib/historyParser": { parseHistoryMessagesJsonAsync: async (value) => JSON.parse(value) },
  },
});
const { useGatewayWorkspaceProjects } = loader.loadModule(
  "src/app/hooks/useGatewayWorkspaceProjects.ts",
);
const { createOpenConversationInitial } = loader.loadModule(
  "src/app/gatewayHistoryWindowActions.ts",
);
const { createGatewayConversationActions } = loader.loadModule(
  "src/app/gatewayConversationActions.ts",
);
const { createSidebarStore } = loader.loadModule("@liveagent/ui/lib/sidebar/store.ts");
const { createConversationOpenController } = loader.loadModule(
  "@liveagent/ui/lib/sidebar/openController.ts",
);
const { getDefaultSettings } = loader.loadModule("src/lib/settings/index.ts");
const ref = (current) => ({ current });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const summary = (id, cwd, updatedAt = 1) => ({
  id,
  cwd,
  title: id,
  providerId: "p",
  model: "m",
  createdAt: 1,
  updatedAt,
});

async function harness(t, { mode = "tools", archived = [], missing = [] } = {}) {
  const pending = new Map();
  const transport = {
    getHistory: (id) => new Promise((resolve, reject) => pending.set(id, { resolve, reject })),
  };
  const store = createSidebarStore(
    {
      listConversations: async (_page, _size, scope) => ({
        items: [summary("recent", scope.kind === "workdir" ? scope.cwd : undefined, 100)],
        totalCount: 30,
      }),
      listWorkdirs: async () => [],
      subscribeEvents: () => () => {},
    },
    { pageSize: 1 },
  );
  const currentId = ref("a"),
    selectedId = ref("a"),
    sequence = ref(0),
    revision = ref(0);
  const workdirs = ref(new Map([["a", "/repo/a"]]));
  let setCurrentSettings;
  let api,
    actions,
    selectedHistory = { conversation_id: "a" },
    settingsWrites = 0,
    draftsSaved = 0,
    restored = 0;
  const drafts = new Map([["a", "keep this draft"]]);
  const defaults = getDefaultSettings();
  let settings = {
    ...defaults,
    system: {
      ...defaults.system,
      workdir: "/repo/a",
      executionMode: mode,
      workspaceProjects: ["a", "b", "c"].map((id) => ({
        id,
        path: "/repo/" + id,
        name: id,
        kind: "manual",
        createdAt: 1,
        updatedAt: 1,
      })),
      activeWorkspaceProjectId: "a",
      archivedWorkspaceProjectPaths: archived,
      missingWorkspaceProjectPaths: missing,
    },
  };
  const common = {
    api: transport,
    conversationIdRef: currentId,
    conversationWorkdirsRef: workdirs,
    getDisplayedConversationId: () => currentId.current,
    historyLoadSequenceRef: sequence,
    historyWindowStatesRef: ref(new Map()),
    invalidateHistoryLoad: () => ++sequence.current,
    localeErrorMessage: "open failed",
    markVisibleConversationRevision: () => ++revision.current,
    pendingDisplayedConversationAutoBottomRef: ref(null),
    protectedConversationRef: ref("a"),
    selectedHistoryIdRef: selectedId,
    setChatError() {},
    setConversationId: (id) => {
      currentId.current = id;
    },
    setSelectedHistory: (detail) => {
      selectedHistory = detail;
    },
    setSelectedHistoryId: (id) => {
      selectedId.current = id;
    },
    transcriptStoreRegistry: { peek: () => undefined, get: () => ({ applyHistorySnapshot() {} }) },
    visibleConversationRevisionRef: revision,
  };
  const openInitial = createOpenConversationInitial(common);
  const controller = createConversationOpenController({ openInitial, onStateChange() {} });
  function Host() {
    const [value, setValue] = React.useState(settings);
    settings = value;
    setCurrentSettings = setValue;
    api = useGatewayWorkspaceProjects({
      api: transport,
      displayedConversationWorkdirRef: ref("/repo/a"),
      settings: value,
      setSettings: (update) => {
        settingsWrites++;
        setValue(update);
      },
      sidebarStore: store,
      sidebarWorkdirs: [],
      setActiveView() {},
      setRightDockOpen() {},
      setSidebarOpen() {},
      startNewConversationRef: ref(() => assert.fail("search created a conversation")),
    });
    actions = createGatewayConversationActions({
      ...common,
      activateSearchConversationWorkspace: api.activateSearchConversationWorkspace,
      setActiveView() {},
      setSidebarOpen() {},
      getVisibleComposerConversationId: () => currentId.current,
      prepareComposerForConversationChange: () => {
        draftsSaved++;
      },
      openController: controller,
      sidebarStore: store,
      restoreCachedComposerDraft: () => {
        restored++;
      },
      isLocalDraftConversationId: () => false,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(React.createElement(Host)));
  await act(async () => {
    store.start();
    await tick();
  });
  t.after(async () => {
    controller.cancel();
    store.stop();
    await act(async () => root.unmount());
  });
  return {
    store,
    controller,
    workdirs,
    get api() {
      return api;
    },
    get settings() {
      return settings;
    },
    get id() {
      return currentId.current;
    },
    get writes() {
      return settingsWrites;
    },
    get resets() {
      return restored;
    },
    get draftsSaved() {
      return draftsSaved;
    },
    get selectedHistory() {
      return selectedHistory;
    },
    drafts,
    select: async (id, source = "search") =>
      act(async () =>
        actions.handleSidebarSelectConversation(id, source === "search" ? { source } : undefined),
      ),
    complete: async (id, cwd) =>
      act(async () => {
        pending
          .get(id)
          .resolve({
            conversation_id: id,
            conversation: { id, cwd, title: id, created_at: 1, updated_at: 1 },
            messages_json: "[]",
            has_more: false,
          });
        await tick();
      }),
    fail: async (id) =>
      act(async () => {
        pending.get(id).reject(new Error("read failed"));
        await tick();
      }),
    setMode: async (executionMode) =>
      act(async () =>
        setCurrentSettings((prev) => ({ ...prev, system: { ...prev.system, executionMode } })),
      ),
  };
}

test("gateway commits authoritative workspace and retains a result beyond the first page", async (t) => {
  const h = await harness(t);
  await act(async () => h.store.upsertLocal(summary("b", "/stale/path")));
  await h.select("b");
  assert.equal(h.id, "a");
  assert.equal(h.api.activeWorkspaceProjectPath, "/repo/a");
  await h.complete("b", "/repo/b");
  assert.equal(h.id, "b");
  assert.equal(h.api.activeWorkspaceProjectPath, "/repo/b");
  assert.equal(h.store.getSnapshot().scopeKey, "cwd:/repo/b");
  await act(async () => h.store.refresh());
  assert.ok(h.store.getSnapshot().conversations.some((item) => item.id === h.id));
  assert.equal(h.drafts.get("a"), "keep this draft");
  assert.equal(h.writes, 1);
  assert.equal(h.draftsSaved, 1);
});

test("gateway same-workspace search performs no settings write", async (t) => {
  const h = await harness(t);
  await h.select("other-a");
  await h.complete("other-a", "/repo/a");
  assert.equal(h.writes, 0);
  assert.equal(h.id, "other-a");
});

test("gateway slow B cannot override C and failure leaves the previous navigation intact", async (t) => {
  const h = await harness(t);
  await h.select("b");
  await h.select("c");
  await h.complete("c", "/repo/c");
  await h.complete("b", "/repo/b");
  assert.equal(h.id, "c");
  assert.equal(h.api.activeWorkspaceProjectPath, "/repo/c");
  await h.select("bad");
  await h.fail("bad");
  assert.equal(h.id, "c");
  assert.equal(h.api.activeWorkspaceProjectPath, "/repo/c");
  assert.equal(h.writes, 1);
  assert.equal(h.resets, 1);
  assert.equal(h.draftsSaved, 1);
});

test("gateway cancellation prevents workspace, transcript and composer commits", async (t) => {
  const h = await harness(t);
  await h.select("b");
  h.controller.cancel();
  await h.complete("b", "/repo/b");
  assert.equal(h.id, "a");
  assert.equal(h.writes, 0);
  assert.equal(h.resets, 0);
  assert.equal(h.draftsSaved, 0);
});

test("gateway empty authoritative cwd clears stale scope and project highlight", async (t) => {
  const h = await harness(t);
  await act(async () => h.store.upsertLocal(summary("text", "/repo/a")));
  await h.select("text");
  await h.complete("text", undefined);
  assert.equal(h.id, "text");
  assert.equal(h.api.activeWorkspaceProject, undefined);
  assert.equal(h.store.getSnapshot().scopeKey, "cwd-empty");
  assert.ok(h.store.getSnapshot().conversations.some((item) => item.id === "text"));
  assert.equal(h.store.peek("text").cwd, undefined);
  assert.equal(h.writes, 0);
  assert.equal(h.api.searchConversationWorkdir, "");
});

test("gateway text mode supports unscoped history and cross-workspace navigation", async (t) => {
  const h = await harness(t, { mode: "text" });
  await h.select("text");
  await h.complete("text", undefined);
  assert.equal(h.store.getSnapshot().scopeKey, "cwd-empty");
  await h.select("b");
  await h.complete("b", "/repo/b");
  assert.equal(h.store.getSnapshot().scopeKey, "cwd:/repo/b");
  assert.equal(h.api.activeWorkspaceProjectPath, "/repo/b");
});

test("gateway archived or missing directories remain readable without clearing the missing marker", async (t) => {
  const h = await harness(t, { archived: ["/repo/b"], missing: ["/repo/b"] });
  await h.select("b");
  await h.complete("b", "/repo/b");
  assert.equal(h.api.activeWorkspaceProjectPath, "/repo/b");
  assert.ok(h.settings.system.missingWorkspaceProjectPaths.includes("/repo/b"));
  assert.ok(!h.settings.system.archivedWorkspaceProjectPaths.includes("/repo/b"));
});

test("gateway ordinary conversation selection does not activate another workspace", async (t) => {
  const h = await harness(t);
  await h.select("b", "sidebar");
  await h.complete("b", "/repo/b");
  assert.equal(h.id, "b");
  assert.equal(h.api.activeWorkspaceProjectPath, "/repo/a");
  assert.equal(h.writes, 0);
});

test("gateway workspace selection and mode changes release the search-only scope", async (t) => {
  const h = await harness(t);
  await h.select("b");
  await h.complete("b", "/repo/b");
  await act(async () => h.api.setActiveWorkspaceProjectId("c"));
  assert.equal(h.api.activeWorkspaceProjectPath, "/repo/c");
  assert.equal(h.store.getSnapshot().scopeKey, "cwd:/repo/c");
  await h.select("text");
  await h.complete("text", undefined);
  await h.setMode("text");
  await h.setMode("tools");
  assert.equal(h.store.getSnapshot().scopeKey, "cwd:/repo/c");
});

test("gateway retry after failure uses the newest result and repeated selection avoids settings writes", async (t) => {
  const h = await harness(t);
  await h.select("b");
  await h.fail("b");
  await h.select("b");
  await h.complete("b", "/repo/b");
  await h.select("b");
  await h.complete("b", "/repo/b");
  assert.equal(h.id, "b");
  assert.equal(h.writes, 1);
  assert.equal(h.drafts.get("a"), "keep this draft");
});

test("gateway search scope can be cleared before creating a text-mode draft", async (t) => {
  const h = await harness(t, { mode: "text" });
  await h.select("b");
  await h.complete("b", "/repo/b");
  await act(async () => h.api.clearSearchConversationWorkspace());
  assert.equal(h.store.getSnapshot().scopeKey, "cwd-empty");
});
