import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("incremental publication timed out");
}

function session(id, title, cwd = "/repo/a") {
  return {
    id,
    title,
    cwd,
    model: { provider: "fixture", model: "test" },
    created_at: "2026-10-28T00:00:00Z",
    updated_at: "2026-10-28T00:00:01Z",
    message_count: 1,
  };
}

function summaryForSession(value, id) {
  return {
    id,
    title: value.title,
    cwd: value.cwd,
    sessionId: value.id,
    createdAt: Date.parse(value.created_at),
    updatedAt: Date.parse(value.updated_at),
    providerId: "fixture",
    model: "test",
    messageCount: value.message_count,
    isPinned: value.pinned,
    isShared: value.shared,
  };
}

test("incremental K-brain changes publish row events, preserve hidden aliases, and update workdirs", async () => {
  let configuration;
  let healthy = false;
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@liveagent/app/shims/tauriCore": {
        invoke: async (command, args) => {
          if (command === "gateway_status")
            return { online: true, agentId: "agent", sessionId: "session" };
          calls.push(args.input);
          return { accepted: true, needsResync: false };
        },
      },
      "./client": { createKBrainClient: () => ({}) },
      "./history": { summaryForSession },
      "./sessionSync": {
        createKBrainSessionSync: (options) => {
          configuration = options;
          return {
            isHealthy: () => healthy,
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
  const events = [];
  const stop = kBrainSidebarSync.subscribe((event) => events.push(event));
  try {
    healthy = true;
    configuration.onSnapshot({
      epoch: "epoch",
      revision: "1",
      sessions: new Map([
        ["visible", session("visible", "Visible", "/repo/a")],
        ["hidden", session("hidden", "Hidden", "/repo/b")],
      ]),
      workdirs: [
        { cwd: "/repo/a", count: 1, updated_at: "2026-10-28T00:00:01Z" },
        { cwd: "/repo/b", count: 1, updated_at: "2026-10-28T00:00:01Z" },
      ],
    });
    configuration.onHealth(true);
    await until(() => calls.some((input) => input.kind === "snapshot"));

    const hiddenAlias = mapping.getKBrainConversationId("hidden");
    const visibleAlias = mapping.getKBrainConversationId("visible");
    assert.ok(hiddenAlias);
    assert.ok(visibleAlias);
    events.length = 0;
    calls.length = 0;

    configuration.onChanges({
      epoch: "epoch",
      revision: "4",
      changes: [
        {
          id: "visible",
          revision: "2",
          kind: "upsert",
          listed: true,
          session: session("visible", "Renamed", "/repo/c"),
        },
        {
          id: "hidden",
          revision: "3",
          kind: "upsert",
          listed: false,
          session: session("hidden", "Hidden", "/repo/b"),
        },
      ],
      workdirs: [{ cwd: "/repo/c", count: 1, updated_at: "2026-10-28T00:00:01Z" }],
    });
    await until(() => calls.some((input) => input.kind === "event"));
    assert.deepEqual(
      events.map((event) => [event.kind, event.conversationId, event.conversation?.title]),
      [
        ["upsert", visibleAlias, "Renamed"],
        ["delete", hiddenAlias, undefined],
        ["workdirs", undefined, undefined],
      ],
    );
    assert.equal(mapping.getKBrainConversationId("hidden"), hiddenAlias);
    assert.equal(kBrainSidebarSync.list(1, 20, { kind: "all" }).items.length, 1);
    assert.deepEqual(kBrainSidebarSync.workdirs(), [
      { path: "/repo/c", conversationCount: 1, updatedAt: 1793145601000 },
    ]);
    assert.equal(calls.some((input) => input.kind === "snapshot"), false);

    events.length = 0;
    calls.length = 0;
    configuration.onChanges({
      epoch: "epoch",
      revision: "5",
      changes: [{ id: "visible", revision: "5", kind: "delete" }],
      workdirs: [],
    });
    await until(() => calls.some((input) => input.kind === "event"));
    assert.deepEqual(events.map((event) => [event.kind, event.conversationId]), [
      ["delete", visibleAlias],
      ["workdirs", undefined],
    ]);
    assert.equal(mapping.getKBrainConversationId("visible"), undefined);
    assert.deepEqual(kBrainSidebarSync.list(1, 20, { kind: "all" }).items, []);
    assert.deepEqual(kBrainSidebarSync.workdirs(), []);
  } finally {
    stop();
  }
});

function createIncrementalFixture() {
  let configuration;
  let healthy = false;
  let online = true;
  let rejectNextEvent = false;
  let gatewayStatusGate;
  let conversionCount = 0;
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@liveagent/app/shims/tauriCore": {
        invoke: async (command, args) => {
          if (command === "gateway_status") {
            const gate = gatewayStatusGate;
            gatewayStatusGate = undefined;
            await gate;
            return { online, agentId: "agent", sessionId: "session" };
          }
          const input = args.input;
          calls.push(input);
          if (rejectNextEvent && input.kind === "event") {
            rejectNextEvent = false;
            return { accepted: false, needsResync: true };
          }
          return { accepted: true, needsResync: false };
        },
      },
      "./client": { createKBrainClient: () => ({}) },
      "./history": {
        summaryForSession(value, id) {
          conversionCount += 1;
          return summaryForSession(value, id);
        },
      },
      "./sessionSync": {
        createKBrainSessionSync: (options) => {
          configuration = options;
          return {
            isHealthy: () => healthy,
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
  const { kBrainSidebarSync: sync } = loader.loadModule("src/lib/kbrain/sidebarSync.ts");
  const { createSidebarStore } = loader.loadModule("@liveagent/ui/lib/sidebar/store.ts");
  const events = [];
  const stop = sync.subscribe((event) => events.push(event));
  const mapping = loader.loadModule("src/lib/kbrain/mapping.ts");
  const backend = {
    listConversations: async (...args) => sync.list(...args),
    listPinnedConversations: async () => sync.pinned(),
    listWorkdirs: async () => sync.workdirs(),
    subscribeEvents: sync.subscribe,
    getReconcileIntervalMs: () => null,
    renameConversation: async (id, title) => ({ ...sync.list(1, 1000, { kind: "all" }).items.find((item) => item.id === id), title }),
    setConversationPinned: async () => { throw new Error("unexpected pin"); },
    setConversationCwd: async () => { throw new Error("unexpected move"); },
    deleteConversation: async () => { throw new Error("unexpected delete"); },
  };
  return {
    sync,
    mapping,
    events,
    calls,
    backend,
    createSidebarStore,
    stop,
    setOnline(value) { online = value; },
    rejectNextEvent() { rejectNextEvent = true; },
    holdNextGatewayStatus() {
      let release;
      gatewayStatusGate = new Promise((resolve) => { release = resolve; });
      return () => release();
    },
    get conversionCount() { return conversionCount; },
    snapshot(sessions, workdirs) {
      healthy = true;
      configuration.onSnapshot({ epoch: "e", revision: "0", sessions: new Map(sessions.map((item) => [item.id, item])), workdirs });
      configuration.onHealth(true);
    },
    change(changes, workdirs, revision = "1") {
      configuration.onChanges({ epoch: "e", revision, changes, workdirs });
    },
  };
}

const workdirs = (cwd, count) => count > 0 ? [{ cwd, count, updated_at: "2026-10-28T00:00:01Z" }] : [];
const upsert = (value, revision = "1", listed = true) => ({ id: value.id, revision, kind: "upsert", listed, session: value });

test("a 250-row baseline converts only changed rows and callbacks read the new authority", async (t) => {
  const fixture = createIncrementalFixture();
  t.after(fixture.stop);
  const initial = Array.from({ length: 250 }, (_, index) => session(`large-${String(index).padStart(3, "0")}`, `Title ${index}`));
  fixture.snapshot(initial, workdirs("/repo/a", 250));
  await until(() => fixture.calls.some((input) => input.kind === "status" && input.available));
  const original = new Map(fixture.sync.list(1, 500, { kind: "all" }).items.map((item) => [item.sessionId, item]));
  assert.equal(fixture.conversionCount, 250);
  fixture.events.length = 0;
  const callbackReads = [];
  const stopReads = fixture.sync.subscribe((event) => {
    if (event.kind === "reset") return;
    callbackReads.push({
      event,
      items: fixture.sync.list(1, 500, { kind: "all" }).items,
      workdirs: fixture.sync.workdirs(),
    });
  });
  t.after(stopReads);
  fixture.change([
    upsert({ ...initial[125], title: "Changed", cwd: "/repo/b" }),
    { id: initial[249].id, revision: "2", kind: "delete" },
  ], [
    ...workdirs("/repo/a", 248),
    ...workdirs("/repo/b", 1),
  ], "2");
  assert.equal(fixture.conversionCount, 251);
  assert.equal(fixture.events.some((event) => event.kind === "reset"), false);
  const after = fixture.sync.list(1, 500, { kind: "all" }).items;
  assert.equal(after.length, 249);
  for (const item of after) {
    if (item.sessionId === initial[125].id) assert.notEqual(item, original.get(item.sessionId));
    else assert.equal(item, original.get(item.sessionId));
  }
  assert.equal(callbackReads.length, 3);
  for (const read of callbackReads) {
    assert.equal(read.items.length, 249);
    assert.equal(read.items.find((item) => item.sessionId === initial[125].id).title, "Changed");
    assert.equal(read.items.some((item) => item.sessionId === initial[249].id), false);
    assert.deepEqual(read.workdirs.map((item) => [item.path, item.conversationCount]), [["/repo/a", 248], ["/repo/b", 1]]);
  }
});

test("a rejected incremental handoff recovers with the latest complete authority", async (t) => {
  const fixture = createIncrementalFixture();
  t.after(fixture.stop);
  const first = session("recover-first", "First");
  const removed = session("recover-removed", "Removed");
  fixture.snapshot([first, removed], workdirs("/repo/a", 2));
  await until(() => fixture.calls.some((input) => input.kind === "status" && input.available));
  fixture.calls.length = 0;
  fixture.rejectNextEvent();
  fixture.change([upsert({ ...first, title: "Latest" })], workdirs("/repo/a", 2));
  await until(() => fixture.calls.some((input) => input.kind === "event"));
  fixture.change([{ id: removed.id, revision: "2", kind: "delete" }], workdirs("/repo/a", 1), "2");
  await until(() => fixture.calls.some((input) => input.kind === "snapshot"));
  const snapshot = fixture.calls.find((input) => input.kind === "snapshot");
  assert.deepEqual(snapshot.conversations.map((item) => [item.sessionId, item.title]), [[first.id, "Latest"]]);
  assert.deepEqual(snapshot.workdirs.map((item) => [item.path, item.conversationCount]), [["/repo/a", 1]]);
  assert.equal(fixture.mapping.getKBrainConversationId(removed.id), undefined);
});

test("a Gateway snapshot keeps conversations and workdirs at the same publication cut", async (t) => {
  const fixture = createIncrementalFixture();
  t.after(fixture.stop);
  const release = fixture.holdNextGatewayStatus();
  const first = session("cut-first", "First");
  const added = session("cut-added", "Added", "/repo/b");
  fixture.snapshot([first], workdirs("/repo/a", 1));
  fixture.change([upsert(added)], [...workdirs("/repo/a", 1), ...workdirs("/repo/b", 1)]);
  release();
  await until(() => fixture.calls.some((input) => input.kind === "snapshot"));
  const snapshot = fixture.calls.find((input) => input.kind === "snapshot");
  assert.deepEqual(snapshot.conversations.map((item) => item.sessionId), [first.id]);
  assert.deepEqual(snapshot.workdirs.map((item) => [item.path, item.conversationCount]), [["/repo/a", 1]]);
  await until(() => fixture.calls.some((input) => input.kind === "event" && input.event.conversation?.sessionId === added.id));
});

for (const action of ["unpin", "clear cwd"]) {
  test(`incremental summaries can ${action} through the shared store`, async (t) => {
    const fixture = createIncrementalFixture();
    t.after(fixture.stop);
    const store = fixture.createSidebarStore(fixture.backend);
    t.after(() => store.stop());
    store.setScope({ kind: "all" });
    store.start();
    await sleep(0);
    const item = { ...session(`metadata-${action}`, "Metadata"), pinned: true };
    fixture.snapshot([item], workdirs("/repo/a", 1));
    const id = fixture.mapping.getKBrainConversationId(item.id);
    assert.equal(store.peek(id).isPinned, true);
    if (action === "unpin") {
      fixture.change([upsert({ ...item, pinned: undefined })], workdirs("/repo/a", 1));
      assert.equal(store.peek(id).isPinned === true, false, "omitted pinned=false is an authoritative unpin");
    } else {
      fixture.change([upsert({ ...item, cwd: undefined })], []);
      assert.equal(store.peek(id).cwd ?? "", "", "an authoritative missing cwd removes the previous workdir");
    }
  });
}

for (const action of ["rename", "delete", "delete first page"]) {
 test(`an incremental ${action} keeps the authoritative count and loaded prefix`, async (t) => {
  const fixture = createIncrementalFixture();
  t.after(fixture.stop);
  const store = fixture.createSidebarStore(fixture.backend, { pageSize: 50 });
  t.after(() => store.stop());
  store.setScope({ kind: "all" });
  store.start();
  await sleep(0);
  const initial = Array.from({ length: 250 }, (_, index) => session(`page-${String(index).padStart(3, "0")}`, `Page ${index}`));
  fixture.snapshot(initial, workdirs("/repo/a", 250));
  assert.equal(store.getSnapshot().conversations.length, 50);
  assert.equal(store.getSnapshot().totalCount, 250);
  const visibleIds = new Set(store.getSnapshot().conversations.map((item) => item.sessionId));
  const target = initial.find((item) => visibleIds.has(item.id) === (action === "delete first page"));
  if (action === "rename") {
    fixture.change([upsert({ ...target, title: "Renamed outside page" })], workdirs("/repo/a", 250));
    assert.equal(store.getSnapshot().totalCount, 250, "updating an existing row cannot add a conversation");
    assert.equal(store.getSnapshot().conversations.length, 50, "an unchanged sort position keeps the loaded prefix bounded");
  } else {
    fixture.change([{ id: target.id, revision: "2", kind: "delete" }], workdirs("/repo/a", 249), "2");
    assert.equal(store.getSnapshot().totalCount, 249, "deleting any cached row reduces the authoritative total");
    assert.equal(store.getSnapshot().conversations.length, 50, "a cached successor fills a deleted row in the loaded prefix");
  }
 });
}

test("incremental move, pin, and deletion keep expanded workspace counts current", async (t) => {
  const fixture = createIncrementalFixture();
  t.after(fixture.stop);
  const store = fixture.createSidebarStore(fixture.backend);
  t.after(() => store.stop());
  store.setScope({ kind: "all" });
  store.start();
  await sleep(0);
  const initial = Array.from({ length: 12 }, (_, index) => session(`workspace-${index}`, `Workspace ${index}`));
  const other = session("workspace-other", "Other", "/repo/b");
  fixture.snapshot([...initial, other], [...workdirs("/repo/a", 12), ...workdirs("/repo/b", 1)]);
  const otherAlias = fixture.mapping.getKBrainConversationId(other.id);
  await store.loadWorkspaceHistory("/repo/a");
  await store.loadWorkspaceHistory("/repo/b");
  assert.equal(store.getSnapshot().workspaceHistory.get("/repo/a").totalCount, 12);
  assert.equal(store.getSnapshot().workspaceHistory.get("/repo/a").hasMore, true);
  fixture.change([
    upsert({ ...initial[0], cwd: "/repo/b" }),
    upsert({ ...initial[1], pinned: true }, "2"),
    { id: other.id, revision: "3", kind: "delete" },
  ], [...workdirs("/repo/a", 11), ...workdirs("/repo/b", 1)], "3");
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.workspaceHistory.get("/repo/a").totalCount, 11);
  assert.equal(snapshot.workspaceHistory.get("/repo/a").hasMore, false, "one pinned row leaves exactly ten unpinned rows");
  assert.equal(snapshot.workspaceHistory.get("/repo/b").totalCount, 1);
  assert.equal(snapshot.byId.get(fixture.mapping.getKBrainConversationId(initial[0].id)).cwd, "/repo/b");
  assert.equal(snapshot.byId.has(otherAlias), false);
});

test("an incremental remote rename stays behind the optimistic overlay until failure", async (t) => {
  const fixture = createIncrementalFixture();
  t.after(fixture.stop);
  let rejectRename;
  fixture.backend.renameConversation = () => new Promise((_, reject) => { rejectRename = reject; });
  const store = fixture.createSidebarStore(fixture.backend);
  t.after(() => store.stop());
  store.setScope({ kind: "all" });
  store.start();
  await sleep(0);
  const initial = session("optimistic-increment", "Before");
  fixture.snapshot([initial], workdirs("/repo/a", 1));
  const id = fixture.mapping.getKBrainConversationId(initial.id);
  const rename = store.rename(id, "Local pending");
  fixture.change([upsert({ ...initial, title: "Remote latest" })], workdirs("/repo/a", 1));
  assert.equal(store.peek(id).title, "Local pending");
  rejectRename(new Error("mutation rejected"));
  assert.equal(await rename, false);
  assert.equal(store.peek(id).title, "Remote latest");
  assert.equal(store.getSnapshot().mutationErrors.get(id), "renameFailed");
});

test("incremental authority wins over a first page requested before the change", async (t) => {
  const fixture = createIncrementalFixture();
  t.after(fixture.stop);
  const store = fixture.createSidebarStore(fixture.backend);
  t.after(() => store.stop());
  store.setScope({ kind: "all" });
  store.start();
  await sleep(0);
  const initial = session("stale-list-increment", "Before");
  fixture.snapshot([initial], workdirs("/repo/a", 1));
  const stalePage = fixture.sync.list(1, 50, { kind: "all" });
  let finish;
  fixture.backend.listConversations = () => new Promise((resolve) => { finish = resolve; });
  const refresh = store.refresh();
  const id = fixture.mapping.getKBrainConversationId(initial.id);
  fixture.change([upsert({ ...initial, title: "After" })], workdirs("/repo/a", 1));
  assert.equal(store.peek(id).title, "After");
  finish(stalePage);
  await refresh;
  assert.equal(store.peek(id).title, "After", "a delayed read must not roll the applied cursor back");
});

test("an authoritative increment preserves an active position lock and releases it at expiry", async (t) => {
  const fixture = createIncrementalFixture();
  t.after(fixture.stop);
  let now = 0;
  const store = fixture.createSidebarStore(fixture.backend, { now: () => now, positionLockMs: 1000 });
  t.after(() => store.stop());
  store.setScope({ kind: "all" });
  store.start();
  await sleep(0);
  const initial = session("position-increment", "Before");
  fixture.snapshot([initial], workdirs("/repo/a", 1));
  const id = fixture.mapping.getKBrainConversationId(initial.id);
  assert.equal(await store.rename(id, "Local confirmed"), true);
  const originalTime = store.peek(id).updatedAt;
  const newer = { ...initial, title: "Remote metadata", updated_at: "2026-10-28T00:00:30Z" };
  fixture.change([upsert(newer)], workdirs("/repo/a", 1));
  assert.equal(store.peek(id).title, "Remote metadata");
  assert.equal(store.peek(id).updatedAt, originalTime);
  now = 1001;
  fixture.change([upsert({ ...newer, updated_at: "2026-10-28T00:00:31Z" }, "2")], workdirs("/repo/a", 1), "2");
  assert.equal(store.peek(id).updatedAt, Date.parse("2026-10-28T00:00:31Z"));
});

for (const outcome of ["success", "failure"]) {
  test(`an off-page local rename preserves pagination during ${outcome}`, async (t) => {
    const fixture = createIncrementalFixture();
    t.after(fixture.stop);
    let finish;
    fixture.backend.renameConversation = () => new Promise((resolve, reject) => {
      finish = { resolve, reject };
    });
    const store = fixture.createSidebarStore(fixture.backend, { pageSize: 50 });
    t.after(() => store.stop());
    store.setScope({ kind: "all" });
    store.start();
    await sleep(0);
    const initial = Array.from({ length: 250 }, (_, index) => session(`local-page-${index}`, `Page ${index}`));
    fixture.snapshot(initial, workdirs("/repo/a", 250));
    const visible = new Set(store.getSnapshot().conversations.map((item) => item.sessionId));
    const target = initial.find((item) => !visible.has(item.id));
    const id = fixture.mapping.getKBrainConversationId(target.id);
    const mutation = store.rename(id, "Local rename");
    const whilePending = store.getSnapshot();
    fixture.change([upsert({ ...target, title: "Remote latest" })], workdirs("/repo/a", 250));
    if (outcome === "success") finish.resolve({ ...summaryForSession(target, id), title: "Local rename" });
    else finish.reject(new Error("expected rename failure"));
    assert.equal(await mutation, outcome === "success");
    assert.equal(whilePending.totalCount, 250, "an optimistic update does not add a persisted row");
    assert.equal(whilePending.conversations.length, 50, "the optimistic overlay respects the loaded prefix");
    assert.equal(store.getSnapshot().totalCount, 250);
    assert.equal(store.getSnapshot().conversations.length, 50);
    assert.equal(store.peek(id).title, outcome === "success" ? "Local rename" : "Remote latest");
  });
}

test("legacy deletion budget invalidates pending workspace reads before dropping tombstones", async (t) => {
  const fixture = createIncrementalFixture();
  t.after(fixture.stop);
  let emit;
  const backend = {
    ...fixture.backend,
    subscribeEvents: (listener) => {
      emit = listener;
      return () => {};
    },
  };
  const store = fixture.createSidebarStore(backend);
  t.after(() => store.stop());
  store.setScope({ kind: "all" });
  store.start();
  await sleep(0);
  const initial = session("legacy-deleted", "Legacy");
  fixture.snapshot([initial], workdirs("/repo/a", 1));
  const row = fixture.sync.list(1, 10, { kind: "all" }).items[0];
  const uncachedGhost = { ...row, id: "legacy-uncached-ghost" };
  emit({ kind: "reset", conversations: [row], workdirs: fixture.sync.workdirs() });
  let resolveWorkspace;
  backend.listConversations = () => new Promise((resolve) => { resolveWorkspace = resolve; });
  const pending = store.loadWorkspaceHistory("/repo/a");
  assert.equal(store.getSnapshot().workspaceHistory.get("/repo/a").loading, true);
  emit({ kind: "delete", conversationId: uncachedGhost.id });
  for (let index = 0; index < 2048; index += 1) {
    emit({ kind: "delete", conversationId: `legacy-tombstone-${index}` });
  }
  assert.equal(store.getSnapshot().workspaceHistory.get("/repo/a").loading, false);
  resolveWorkspace({ items: [row, uncachedGhost], totalCount: 2 });
  await pending;
  assert.equal(store.peek(uncachedGhost.id), undefined, "dropping old tombstones cannot permit the superseded read to revive a row");
});
