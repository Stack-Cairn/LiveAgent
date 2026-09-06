import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

let readHistory;
const env = await createDomTestEnv({
  mocks: {
    "../../../lib/chat/history/chatHistory": {
      getChatHistoryWindow: (options) => readHistory(options.id),
      buildConversationStateFromWindow: (record) => record.state,
    },
  },
});
const { React, act, createRoot } = env;
const { useConversationHistoryActions } = env.loadModule(
  "src/pages/chat/history/useConversationHistoryActions.ts",
);
const { useWorkspaceProjects } = env.loadModule("src/pages/chat/workspace/useWorkspaceProjects.ts");
const { createSidebarStore } = env.loadModule("@liveagent/ui/lib/sidebar/store.ts");
const { createConversationOpenController } = env.loadModule(
  "@liveagent/ui/lib/sidebar/openController.ts",
);
const { createConversationStateFromContext } = env.loadModule(
  "src/lib/chat/conversation/conversationState.ts",
);
const { getDefaultSettings } = env.loadModule("src/lib/settings/index.ts");
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
  readHistory = (id) => new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
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
  const currentId = ref("a");
  const cache = ref(new Map());
  const cursors = ref(new Map());
  const sequence = ref(0);
  let visibleState = createConversationStateFromContext({
    messages: [],
    systemPrompt: "",
    tools: [],
  });
  let api, history, setCurrentSettings;
  let settingsWrites = 0,
    resets = 0,
    draftsSaved = 0;
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
  const controller = createConversationOpenController({
    openInitial: (id, request) => history.openInitial(id, request),
    onStateChange: () => {},
  });
  function Host() {
    const [value, setValue] = React.useState(settings);
    settings = value;
    setCurrentSettings = setValue;
    api = useWorkspaceProjects({
      settings: value,
      setSettings: (update) => {
        settingsWrites++;
        setValue(update);
      },
      sidebarStore: store,
      isAgentMode: value.system.executionMode !== "text",
      workdir: "/repo/a",
      t: (key) => key,
      setErrorMessage: () => {},
      setActiveView: () => {},
      setRightDockOpen: () => {},
      startNewConversationActionRef: ref(() => assert.fail("search created a conversation")),
      prepareComposerForConversationChangeActionRef: ref(() =>
        assert.fail("workspace started a conversation"),
      ),
    });
    history = useConversationHistoryActions({
      conversationState: visibleState,
      currentConversationIdRef: currentId,
      conversationRuntimeCacheRef: cache,
      conversationPersistenceCursorRef: cursors,
      conversationLoadSequenceRef: sequence,
      sidebarStore: store,
      titleJobRef: ref(null),
      t: (key) => key,
      isConversationRunning: () => false,
      buildRuntimeEntryFromVisibleState: () => ({
        state: visibleState,
        sessionId: currentId.current,
        createdAt: 1,
        workdir: "/repo/a",
        isSending: false,
      }),
      syncVisibleConversationRuntime: (_id, entry) => {
        visibleState = entry.state;
      },
      resetVisibleTransientState: () => {
        resets++;
      },
      setCurrentConversationId: (id) => {
        currentId.current = id;
      },
      resolveConversationSelectedModel: () => undefined,
      setErrorMessage: () => {},
      deleteConversationArtifacts: () => {},
      hydration: { markHydrating() {}, clearHydrating() {}, markFailed() {} },
    });
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Host));
  });
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
    cache,
    cursors,
    controller,
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
      return resets;
    },
    get draftsSaved() {
      return draftsSaved;
    },
    drafts,
    select: async (id, source = "search") =>
      act(async () =>
        controller.open(
          id,
          source === "search"
            ? {
                source,
                beforeCommit: (conversation) => {
                  api.activateSearchConversationWorkspace(conversation.cwd);
                  store.upsertLocal(conversation, { reveal: true });
                  draftsSaved++;
                },
              }
            : undefined,
        ),
      ),
    complete: async (id, cwd) =>
      act(async () => {
        pending
          .get(id)
          .resolve({
            conversation: summary(id, cwd),
            activeSegment: { segmentIndex: 0, segmentId: "s" },
            state: createConversationStateFromContext({
              messages: [],
              systemPrompt: "",
              tools: [],
            }),
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

test("desktop commits authoritative workspace and retains a result beyond the first page", async (t) => {
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

test("desktop same-workspace search performs no settings write", async (t) => {
  const h = await harness(t);
  await h.select("other-a");
  await h.complete("other-a", "/repo/a");
  assert.equal(h.writes, 0);
  assert.equal(h.id, "other-a");
});

test("desktop slow B cannot override C and failure leaves the previous navigation intact", async (t) => {
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

test("desktop cancellation prevents workspace, transcript and composer commits", async (t) => {
  const h = await harness(t);
  await h.select("b");
  h.controller.cancel();
  await h.complete("b", "/repo/b");
  assert.equal(h.id, "a");
  assert.equal(h.writes, 0);
  assert.equal(h.resets, 0);
  assert.equal(h.draftsSaved, 0);
});

test("desktop empty authoritative cwd clears stale scope and project highlight", async (t) => {
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

for (const gesture of ["click", "Enter"]) {
  test("persisted search result forwards search navigation intent using " + gesture, async () => {
    let searches = 0;
    const domEnv = await createDomTestEnv({
      mocks: {
        "@liveagent/ui/components/IconSet": Object.fromEntries(
          ["Clock3", "Loader2", "MessageSquareText", "Pin", "Search"].map((key) => [
            key,
            () => null,
          ]),
        ),
        "@liveagent/ui/components/ui/dialog": Object.fromEntries(
          ["Dialog", "DialogContent", "DialogDescription", "DialogTitle"].map((key) => [
            key,
            ({ children }) => React.createElement("div", null, children),
          ]),
        ),
        "@liveagent/ui/components/ui/input": {
          Input: (props) => React.createElement("input", props),
        },
        "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key, locale: "en" }) },
        "@liveagent/ui/lib/chat/conversationSearch": {
          searchPersistedConversations: async () => {
            searches++;
            return [{ id: "b", title: "result in B", cwd: "/repo/b", updatedAt: 1 }];
          },
        },
      },
    });
    const { ConversationSearchDialog } = domEnv.loadModule(
      "@liveagent/ui/components/chat/ConversationSearchDialog.tsx",
    );
    HTMLElement.prototype.scrollIntoView = () => {};
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container),
      calls = [];
    try {
      await act(async () =>
        root.render(
          React.createElement(ConversationSearchDialog, {
            open: true,
            conversations: [],
            currentWorkdir: "/repo/a",
            onOpenChange() {},
            onSelectConversation: (id, options) => calls.push({ id, options }),
          }),
        ),
      );
      const input = container.querySelector("input");
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
          input,
          "needle",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
      assert.equal(searches, 1);
      await act(async () => {
        if (gesture === "click") container.querySelector('[role="option"]').click();
        else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      assert.deepEqual(calls, [{ id: "b", options: { source: "search" } }]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      domEnv.cleanup();
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    }
  });
}

test("desktop text mode supports unscoped history and cross-workspace navigation", async (t) => {
  const h = await harness(t, { mode: "text" });
  await h.select("text");
  await h.complete("text", undefined);
  assert.equal(h.store.getSnapshot().scopeKey, "cwd-empty");
  await h.select("b");
  await h.complete("b", "/repo/b");
  assert.equal(h.store.getSnapshot().scopeKey, "cwd:/repo/b");
  assert.equal(h.api.activeWorkspaceProjectPath, "/repo/b");
});

test("desktop archived or missing directories remain readable without clearing the missing marker", async (t) => {
  const h = await harness(t, { archived: ["/repo/b"], missing: ["/repo/b"] });
  await h.select("b");
  await h.complete("b", "/repo/b");
  assert.equal(h.api.activeWorkspaceProjectPath, "/repo/b");
  assert.ok(h.settings.system.missingWorkspaceProjectPaths.includes("/repo/b"));
  assert.ok(!h.settings.system.archivedWorkspaceProjectPaths.includes("/repo/b"));
});

test("desktop preserves live runtime updates while refreshing cached history metadata", async (t) => {
  const h = await harness(t);
  h.cache.current.set("b", {
    state: { marker: "before" },
    isSending: true,
    sessionId: "b",
    createdAt: 1,
    workdir: "/stale",
  });
  await h.select("b");
  const live = {
    state: { marker: "new streaming token" },
    isSending: true,
    sessionId: "b",
    createdAt: 1,
    workdir: "/stale",
  };
  h.cache.current.set("b", live);
  await h.complete("b", "/repo/b");
  assert.equal(h.cache.current.get("b").state, live.state);
  assert.equal(h.cache.current.get("b").workdir, "/repo/b");
});

test("desktop ordinary conversation selection does not activate another workspace", async (t) => {
  const h = await harness(t);
  await h.select("b", "sidebar");
  await h.complete("b", "/repo/b");
  assert.equal(h.id, "b");
  assert.equal(h.api.activeWorkspaceProjectPath, "/repo/a");
  assert.equal(h.writes, 0);
});

test("desktop workspace selection and mode changes release the search-only scope", async (t) => {
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

test("desktop retry after failure uses the newest result and repeated selection avoids settings writes", async (t) => {
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

test("desktop search scope can be cleared before creating a text-mode draft", async (t) => {
  const h = await harness(t, { mode: "text" });
  await h.select("b");
  await h.complete("b", "/repo/b");
  await act(async () => h.api.clearSearchConversationWorkspace());
  assert.equal(h.store.getSnapshot().scopeKey, "cwd-empty");
});
