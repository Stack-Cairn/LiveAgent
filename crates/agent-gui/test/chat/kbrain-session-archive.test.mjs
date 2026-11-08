import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Archived K-brain sessions (capability `session_archive`): the client query, the
// desktop history helpers, the shared sidebar store, the change-feed toggle, the
// remote history actions and the row menu / archived list UI.

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function kbrainSession(id, overrides = {}) {
  return {
    id,
    title: overrides.title ?? id,
    cwd: overrides.cwd ?? "/repo/a",
    model: { provider: "fixture", model: "test" },
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:01Z",
    message_count: overrides.message_count ?? 2,
    ...(overrides.archived === undefined ? {} : { archived: overrides.archived }),
  };
}

function withLocalStorage(t) {
  const original = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    key: (index) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  };
  t.after(() => {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  });
}

test("the K-brain client asks for archived sessions only when told to", async () => {
  const urls = [];
  const { createKBrainClient } = createTsModuleLoader().loadModule("src/lib/kbrain/client.ts");
  const client = createKBrainClient({
    baseUrl: "http://kbrain.test",
    token: "fixture",
    fetch: async (url) => {
      urls.push(new URL(String(url)));
      return new Response(JSON.stringify({ sessions: [kbrainSession("a")], total_count: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  await client.listSessions({ page: 2, pageSize: 30, archived: "only" });
  await client.listSessions({ page: 1, pageSize: 30 });
  assert.equal(urls[0].searchParams.get("archived"), "only");
  assert.equal(urls[0].searchParams.get("page"), "2");
  assert.equal(urls[1].searchParams.has("archived"), false, "the default list keeps excluding archived");
});

function loadHistory(t, fake) {
  withLocalStorage(t);
  const confirmed = [];
  const loader = createTsModuleLoader({
    mocks: {
      "./client": { createKBrainClient: () => fake },
      "./sessionSyncState": {
        confirmKBrainMutation: async (backendId, session) => {
          confirmed.push([backendId, session.archived]);
          return session;
        },
        hasKBrainMutationSync: () => false,
      },
    },
  });
  const connection = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  connection.setKBrainRuntimeConnection({
    baseUrl: "http://kbrain.test",
    token: "fixture",
    protocolVersion: "kbrain.agent.v1",
  });
  t.after(() => connection.clearKBrainRuntimeConnection());
  return {
    history: loader.loadModule("src/lib/kbrain/history.ts"),
    mapping: loader.loadModule("src/lib/kbrain/mapping.ts"),
    confirmed,
  };
}

test("archive support follows the session_archive capability and retries after a failure", async (t) => {
  let capabilities = { session_archive: 1 };
  let healthCalls = 0;
  const fake = {
    getCapabilities: async () => {
      healthCalls += 1;
      if (capabilities instanceof Error) throw capabilities;
      return capabilities;
    },
  };
  const { history } = loadHistory(t, fake);
  assert.equal(await history.supportsKBrainSessionArchive(), true);
  assert.equal(await history.supportsKBrainSessionArchive(), true);
  assert.equal(healthCalls, 1, "the capability is cached for the same backend");

  let offlineCalls = 0;
  const fresh = loadHistory(t, {
    getCapabilities: async () => {
      offlineCalls += 1;
      throw new Error("offline");
    },
  });
  assert.equal(await fresh.history.supportsKBrainSessionArchive(), false);
  assert.equal(await fresh.history.supportsKBrainSessionArchive(), false);
  assert.equal(offlineCalls, 2, "an unreachable backend is asked again instead of cached");

  capabilities = { session_changes: 2 };
  const older = loadHistory(t, fake);
  assert.equal(await older.history.supportsKBrainSessionArchive(), false);
});

test("archived history lists only archived sessions under stable local ids", async (t) => {
  const listCalls = [];
  const fake = {
    listSessions: async (params) => {
      listCalls.push(params);
      return { sessions: [kbrainSession("sess-old", { title: "Old work", archived: true })], total_count: 1 };
    },
  };
  const { history, mapping } = loadHistory(t, fake);
  const page = await history.listKBrainArchivedHistory(1, 30);
  assert.deepEqual(listCalls, [{ page: 1, pageSize: 30, archived: "only" }]);
  assert.equal(page.totalCount, 1);
  const [item] = page.items;
  assert.equal(item.title, "Old work");
  assert.equal(item.isArchived, true);
  assert.equal(mapping.getKBrainSessionId(item.id, "http://kbrain.test"), "sess-old");
  const again = await history.listKBrainArchivedHistory(1, 30);
  assert.equal(again.items[0].id, item.id, "the same session keeps its local id");
});

test("archiving patches the mapped session and rejects a backend that ignores the flag", async (t) => {
  const patches = [];
  let ignore = false;
  const fake = {
    updateSession: async (id, body) => {
      patches.push([id, body]);
      return kbrainSession(id, { archived: ignore ? !body.archived : body.archived });
    },
  };
  const { history, mapping, confirmed } = loadHistory(t, fake);
  mapping.setKBrainSessionId("local-1", "sess-1", "http://kbrain.test");

  await history.setKBrainHistoryArchived("local-1", true);
  await history.setKBrainHistoryArchived("local-1", false);
  assert.deepEqual(patches, [
    ["sess-1", { archived: true }],
    ["sess-1", { archived: false }],
  ]);
  assert.deepEqual(confirmed, [
    ["sess-1", true],
    ["sess-1", false],
  ]);

  ignore = true;
  await assert.rejects(history.setKBrainHistoryArchived("local-1", true), /did not apply the archive change/);
  await assert.rejects(history.setKBrainHistoryArchived("unknown", true), /mapping not found/);
  assert.equal(confirmed.length, 2, "a refused change is never confirmed");
});

function conversation(id, overrides = {}) {
  return {
    id,
    title: overrides.title ?? id,
    providerId: "provider",
    model: "model",
    cwd: overrides.cwd ?? "/tmp/a",
    createdAt: 1,
    updatedAt: overrides.updatedAt ?? 1,
  };
}

function createArchiveBackend({ reconcileMs = null } = {}) {
  const state = {
    rows: [conversation("one", { updatedAt: 20 }), conversation("two", { updatedAt: 10 })],
    archived: [],
    archiveCalls: [],
    archiveError: null,
    listCalls: 0,
  };
  const backend = {
    listConversations: async (page, pageSize) => {
      state.listCalls += 1;
      const start = (page - 1) * pageSize;
      return { items: state.rows.slice(start, start + pageSize), totalCount: state.rows.length };
    },
    listWorkdirs: async () => [],
    renameConversation: async (id, title) => conversation(id, { title }),
    setConversationPinned: async (id) => conversation(id),
    setConversationCwd: async (id, cwd) => conversation(id, { cwd }),
    deleteConversation: async () => {},
    subscribeEvents: () => () => {},
    subscribeConnection: () => () => {},
    getProtectedConversationIds: () => [],
    getReconcileIntervalMs: () => reconcileMs,
    archive: {
      isSupported: async () => true,
      listArchived: async (page, pageSize) => ({
        items: state.archived.slice((page - 1) * pageSize, page * pageSize),
        totalCount: state.archived.length,
      }),
      setArchived: async (id, archived) => {
        state.archiveCalls.push([id, archived]);
        if (state.archiveError) throw new Error(state.archiveError);
        if (archived) {
          state.archived.push(state.rows.find((row) => row.id === id));
          state.rows = state.rows.filter((row) => row.id !== id);
        } else {
          state.rows.push(state.archived.find((row) => row.id === id));
          state.archived = state.archived.filter((row) => row.id !== id);
        }
      },
    },
  };
  return { state, backend };
}

const sidebarStoreLoader = createTsModuleLoader();
const { createSidebarStore } = sidebarStoreLoader.loadModule("@liveagent/ui/lib/sidebar/store.ts");
const ids = (store) => store.getSnapshot().conversations.map((item) => item.id);

test("the sidebar store hides a row while it is archived and restores it on failure", async () => {
  const fake = createArchiveBackend();
  const store = createSidebarStore(fake.backend);
  store.setScope({ kind: "workdir", cwd: "/tmp/a" });
  store.start();
  await tick();
  assert.ok(store.archive, "an archive-capable backend exposes store.archive");
  assert.deepEqual(ids(store), ["one", "two"]);

  const pending = store.archive.setArchived("one", true);
  assert.deepEqual(ids(store), ["two"], "the archived row leaves the list at once");
  assert.equal(await pending, true);
  assert.deepEqual(ids(store), ["two"]);

  fake.state.archiveError = "refused";
  assert.equal(await store.archive.setArchived("two", true), false);
  assert.deepEqual(ids(store), ["two"], "a refused archive puts the row back");
  assert.equal(store.getSnapshot().mutationErrors.get("two"), "archiveFailed");
  store.stop();
});

test("unarchiving reloads a polled list and leaves an event-sourced one to its feed", async () => {
  for (const [reconcileMs, expectReload] of [
    [15_000, true],
    [null, false],
  ]) {
    const fake = createArchiveBackend({ reconcileMs });
    fake.state.archived = [conversation("old", { updatedAt: 30 })];
    const store = createSidebarStore(fake.backend);
    store.setScope({ kind: "workdir", cwd: "/tmp/a" });
    store.start();
    await tick();
    const listed = await store.archive.listArchived(1, 30);
    assert.deepEqual(listed.items.map((item) => item.id), ["old"]);
    const before = fake.state.listCalls;
    assert.equal(await store.archive.setArchived("old", false), true);
    await tick();
    assert.equal(fake.state.listCalls > before, expectReload, `reconcile=${reconcileMs}`);
    if (expectReload) assert.ok(ids(store).includes("old"));
    store.stop();
  }

  const plain = createArchiveBackend();
  delete plain.backend.archive;
  assert.equal(createSidebarStore(plain.backend).archive, undefined);
});

function loadSidebarSync() {
  let configuration;
  const loader = createTsModuleLoader({
    mocks: {
      "@liveagent/app/shims/tauriCore": {
        invoke: async (command) =>
          command === "gateway_status"
            ? { online: true, agentId: "agent", sessionId: "session" }
            : { accepted: true, needsResync: false },
      },
      "./client": { createKBrainClient: () => ({}) },
      "./history": {
        summaryForSession: (value, id) => ({
          id,
          title: value.title,
          cwd: value.cwd,
          sessionId: value.id,
          createdAt: Date.parse(value.created_at),
          updatedAt: Date.parse(value.updated_at),
          providerId: "fixture",
          model: "test",
          messageCount: value.message_count,
        }),
      },
      "./sessionSync": {
        createKBrainSessionSync: (options) => {
          configuration = options;
          return {
            isHealthy: () => true,
            restart() {},
            requestRescan() {},
            acquire: () => () => {},
            getSnapshot: () => undefined,
            waitForRevision: async () => {},
          };
        },
      },
      "./sessionSyncState": { setKBrainMutationSync() {} },
    },
  });
  const { kBrainSidebarSync } = loader.loadModule("src/lib/kbrain/sidebarSync.ts");
  const mapping = loader.loadModule("src/lib/kbrain/mapping.ts");
  return { kBrainSidebarSync, mapping, configuration: () => configuration };
}

test("incremental sync removes an archived session and restores it under the same id", () => {
  const fixture = loadSidebarSync();
  const events = [];
  const stop = fixture.kBrainSidebarSync.subscribe((event) => events.push(event));
  try {
    const configuration = fixture.configuration();
    configuration.onSnapshot({
      epoch: "epoch",
      revision: "1",
      sessions: new Map([["sess-a", kbrainSession("sess-a", { title: "Work" })]]),
      workdirs: [{ cwd: "/repo/a", count: 1, updated_at: "2026-11-01T00:00:01Z" }],
    });
    configuration.onHealth?.(true);
    const alias = fixture.mapping.getKBrainConversationId("sess-a");
    assert.ok(alias);
    events.length = 0;

    const toggle = (revision, archived) =>
      configuration.onChanges({
        epoch: "epoch",
        revision,
        changes: [
          {
            id: "sess-a",
            revision,
            kind: "upsert",
            listed: !archived,
            session: kbrainSession("sess-a", { title: "Work", archived }),
          },
        ],
        workdirs: archived ? [] : [{ cwd: "/repo/a", count: 1, updated_at: "2026-11-01T00:00:01Z" }],
      });
    toggle("2", true);
    toggle("3", false);
    assert.deepEqual(
      events.filter((event) => event.kind !== "workdirs").map((event) => [event.kind, event.conversationId]),
      [
        ["delete", alias],
        ["upsert", alias],
      ],
    );
    assert.equal(fixture.mapping.getKBrainConversationId("sess-a"), alias, "archiving keeps the alias");
  } finally {
    stop();
  }
});

test("remote history actions answer the WebUI archive commands", async () => {
  const calls = [];
  const historyPath = new URL("../../src/lib/chat/history/chatHistory.ts", import.meta.url).pathname;
  const loader = createTsModuleLoader({
    mocks: {
      [historyPath]: {
        supportsChatHistoryArchive: async () => true,
        listArchivedChatHistory: async (page, pageSize) => {
          calls.push(["list", page, pageSize]);
          return { items: [{ id: "old", title: "Old", isArchived: true }], totalCount: 1 };
        },
        setChatHistoryArchived: async (id, archived) => {
          calls.push(["set", id, archived]);
        },
      },
    },
  });
  const { runGatewayHistoryAction: run } = loader.loadModule(
    "src/pages/chat/gateway/gatewayHistoryActions.ts",
  );
  const event = (action, data = {}, conversationId = "") => ({
    kind: "history",
    conversationId,
    action,
    data,
  });
  assert.deepEqual(await run(event("archive_supported")), { supported: true });
  const listed = await run(event("archived_list", { page: 2, pageSize: 10 }));
  assert.equal(listed.items[0].id, "old");
  await run(event("archived_list"));
  assert.deepEqual(await run(event("archive", { archived: true }, "conv-1")), {});
  await run(event("archive", { archived: false }, "conv-1"));
  assert.deepEqual(calls, [
    ["list", 2, 10],
    ["list", 1, 30],
    ["set", "conv-1", true],
    ["set", "conv-1", false],
  ]);
});

const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
    "@liveagent/app/lib/settings": {
      DEFAULT_WORKSPACE_PROJECT_ID: "default",
      workspaceProjectPathKey: (path) => path,
    },
  },
});
const { React, act, createRoot } = env;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { SidebarProvider } = env.loadModule("@liveagent/ui/components/ui/sidebar.tsx");
const { HistoryRow } = env.loadModule("@liveagent/ui/components/chat/ChatHistorySidebarRows.tsx");
const { ArchivedConversationsModal } = env.loadModule(
  "@liveagent/ui/components/chat/ArchivedConversationsModal.tsx",
);

function mount(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function rowElement(overrides) {
  function Harness() {
    const [menuOpen, setMenuOpen] = React.useState(false);
    return React.createElement(HistoryRow, {
      item: { id: "one", title: "Conversation", cwd: "/repo/a", createdAt: 1, updatedAt: 1 },
      isActive: false, isBusy: false, isRunning: false, isDeleteDisabled: false,
      isSelectionMode: false, isInteractionDisabled: false, isMobileMenuLayout: false,
      isPendingDelete: false, menuOpen, menuSide: "right",
      onMenuOpenChange: (_id, open) => setMenuOpen(open),
      onSetPendingDelete() {}, onSelectConversation() {}, onSelectForBulk() {},
      onMoveToWorkspace() {}, onDeleteConversation() {},
      isRenaming: false, renameDraft: "",
      onStartRenaming() {}, onRenameDraftChange() {}, onCommitRename() {}, onCancelRename() {},
      onSetPinned() {}, onEnterSelectionMode() {}, onShareConversation() {},
      moveWorkspaces: [],
      ...overrides,
    });
  }
  return React.createElement(SidebarProvider, null, React.createElement(Harness));
}

const menuItem = (label) =>
  [...document.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent === label);

async function openMenu(row) {
  await act(async () => row.container.querySelector('[aria-label="chat.conversationMore"]').click());
}

test("the row menu offers Archive only when the backend can archive", async () => {
  const without = mount(rowElement({}));
  try {
    await openMenu(without);
    assert.ok(menuItem("chat.conversationDelete"));
    assert.equal(menuItem("chat.conversationArchive"), undefined);
  } finally {
    await without.cleanup();
  }

  const archived = [];
  const row = mount(rowElement({ onSetArchived: (id, value) => archived.push([id, value]) }));
  try {
    await openMenu(row);
    await act(async () => menuItem("chat.conversationArchive").click());
    assert.deepEqual(archived, [["one", true]]);
  } finally {
    await row.cleanup();
  }
});

test("the archived list pages through archived conversations and restores one", async () => {
  const restored = [];
  const listCalls = [];
  let refuse = true;
  const all = [
    { id: "a", title: "Alpha", cwd: "/repo/a", createdAt: 1, updatedAt: 1, isArchived: true },
    { id: "b", title: "", cwd: "/repo/b", createdAt: 1, updatedAt: 1, isArchived: true },
  ];
  const archive = {
    isSupported: async () => true,
    listArchived: async (page, pageSize) => {
      listCalls.push([page, pageSize]);
      return { items: all.slice(page - 1, page), totalCount: all.length };
    },
    setArchived: async (id, value) => {
      restored.push([id, value]);
      return !refuse;
    },
  };
  const view = mount(React.createElement(ArchivedConversationsModal, { archive, onClose() {} }));
  try {
    await act(async () => {
      await tick();
    });
    const rows = () => [...document.querySelectorAll("[data-archived-conversation-id]")];
    assert.deepEqual(rows().map((row) => row.getAttribute("data-archived-conversation-id")), ["a"]);
    const loadMore = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "chat.archivedConversations.loadMore",
    );
    await act(async () => {
      loadMore.click();
      await tick();
    });
    assert.deepEqual(listCalls, [
      [1, 30],
      [2, 30],
    ]);
    assert.deepEqual(rows().map((row) => row.getAttribute("data-archived-conversation-id")), ["a", "b"]);
    assert.match(rows()[1].textContent, /chat\.runNotification\.untitled/);

    const unarchive = (id) =>
      document.querySelector(`[data-archived-conversation-id="${id}"] [data-unarchive-conversation]`);
    await act(async () => {
      unarchive("a").click();
      await tick();
    });
    assert.match(rows()[0].textContent, /chat\.history\.archiveFailed/, "a refused restore stays listed");
    refuse = false;
    await act(async () => {
      unarchive("a").click();
      await tick();
    });
    assert.deepEqual(restored, [
      ["a", false],
      ["a", false],
    ]);
    assert.deepEqual(rows().map((row) => row.getAttribute("data-archived-conversation-id")), ["b"]);
  } finally {
    await view.cleanup();
  }
});
