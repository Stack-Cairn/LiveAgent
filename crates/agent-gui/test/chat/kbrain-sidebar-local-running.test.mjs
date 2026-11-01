import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// LA-4: K-brain lists a session only once its first message is saved, so a turn started
// on the desktop that waits for an approval had no row in the Gateway's list and a
// WebUI could neither open it nor answer the approval. The desktop now publishes its
// running conversation until K-brain lists it.

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("publication timed out");
}

function fixture() {
  let configuration;
  let healthy = false;
  const published = [];
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  globalThis.setInterval = () => 123;
  globalThis.clearInterval = () => {};
  const loader = createTsModuleLoader({
    mocks: {
      "@liveagent/app/shims/tauriCore": {
        invoke: async (command, args) => {
          if (command === "gateway_status") return { online: true, agentId: "agent", sessionId: "session" };
          published.push(args.input);
          return { accepted: true, needsResync: false };
        },
      },
      "./client": { createKBrainClient: () => ({}) },
      "./history": {
        summaryForSession: (session, id) => ({ id, title: session.title, sessionId: session.id, createdAt: 1, updatedAt: 2, providerId: "fixture", model: "test", messageCount: 2 }),
      },
      "./sessionSync": {
        createKBrainSessionSync: (options) => {
          configuration = options;
          return { isHealthy: () => healthy, restart: () => {}, acquire: () => () => {}, getSnapshot: () => undefined, waitForRevision: async () => {} };
        },
      },
      "./sessionSyncState": { setKBrainMutationSync: () => {} },
    },
  });
  const mapping = loader.loadModule("src/lib/kbrain/mapping.ts");
  const { kBrainSidebarSync } = loader.loadModule("src/lib/kbrain/sidebarSync.ts");
  const stop = kBrainSidebarSync.subscribe(() => {});
  return {
    kBrainSidebarSync,
    mapping,
    published,
    get configuration() { return configuration; },
    start() {
      healthy = true;
      configuration.onSnapshot({ epoch: "e", revision: "1", sessions: new Map([["listed", { id: "listed", title: "old chat" }]]), workdirs: [] });
      configuration.onHealth(true);
    },
    stop() {
      stop();
      globalThis.setInterval = originalInterval;
      globalThis.clearInterval = originalClear;
    },
  };
}

const running = { id: "local-run", title: "新对话", isPending: true, providerId: "fixture", model: "test", createdAt: 5, updatedAt: 6 };
// K-brain rows get generated local ids; name them by title, the running row by its id.
const ids = (result) =>
  result.items.map((item) => (item.id === "local-run" ? "local-run" : item.title === "old chat" ? "listed" : item.id)).sort();
const lastUpsert = (published, id) =>
  published.filter((p) => p.kind === "event" && p.event?.kind === "upsert" && p.event.conversationId === id).at(-1);

test("a running desktop conversation K-brain has not listed is published and listed for the Gateway", async () => {
  const f = fixture();
  try {
    f.start();
    await until(() => f.published.some((p) => p.kind === "snapshot"));
    f.kBrainSidebarSync.markRunning(running);
    await until(() => lastUpsert(f.published, "local-run"));
    assert.deepEqual(ids(f.kBrainSidebarSync.list(1, 50, { kind: "all" })), ["listed", "local-run"]);
    // An unlisted change for the session (K-brain has not saved its first message) keeps it.
    f.mapping.setKBrainSessionId("local-run", "backend-run");
    f.configuration.onChanges({ epoch: "e", revision: "2", changes: [{ kind: "upsert", id: "backend-run", listed: false, session: { id: "backend-run", title: "x" } }], workdirs: [] });
    assert.deepEqual(ids(f.kBrainSidebarSync.list(1, 50, { kind: "all" })), ["listed", "local-run"]);
  } finally {
    f.stop();
  }
});

test("K-brain's row replaces the running one once listed, and clearing an ended turn removes it", async () => {
  const f = fixture();
  try {
    f.start();
    await until(() => f.published.some((p) => p.kind === "snapshot"));
    f.kBrainSidebarSync.markRunning(running);
    f.kBrainSidebarSync.markRunning({ ...running, id: "aborted-run" });
    await until(() => lastUpsert(f.published, "aborted-run"));
    f.mapping.setKBrainSessionId("local-run", "backend-run");
    f.configuration.onChanges({ epoch: "e", revision: "2", changes: [{ kind: "upsert", id: "backend-run", listed: true, session: { id: "backend-run", title: "Node 乘法" } }], workdirs: [] });
    const listed = f.kBrainSidebarSync.list(1, 50, { kind: "all" }).items.find((item) => item.id === "local-run");
    assert.equal(listed?.title, "Node 乘法", "K-brain's summary wins");
    assert.equal(listed?.isPending, undefined);
    // Clearing a conversation K-brain lists does not remove K-brain's row.
    f.kBrainSidebarSync.clearRunning("local-run");
    assert.deepEqual(ids(f.kBrainSidebarSync.list(1, 50, { kind: "all" })).filter((id) => id !== "aborted-run"), ["listed", "local-run"]);
  } finally {
    f.stop();
  }
});

// K-brain lists the session a moment after the turn ends. Dropping the row at turn end
// published a delete in between, and a WebUI showing that conversation went back home.
test("a finished turn keeps its row until K-brain lists it, then K-brain's row stays", async () => {
  const f = fixture();
  try {
    f.start();
    await until(() => f.published.some((p) => p.kind === "snapshot"));
    f.kBrainSidebarSync.markRunning(running);
    await until(() => lastUpsert(f.published, "local-run"));
    f.kBrainSidebarSync.clearRunning("local-run");
    await tick();
    await tick();
    const deleted = () => f.published.some((p) => p.kind === "event" && p.event?.kind === "delete" && p.event.conversationId === "local-run");
    assert.equal(deleted(), false, "no delete right after the turn ends");
    assert.deepEqual(ids(f.kBrainSidebarSync.list(1, 50, { kind: "all" })), ["listed", "local-run"]);
    f.mapping.setKBrainSessionId("local-run", "backend-run");
    f.configuration.onChanges({ epoch: "e", revision: "2", changes: [{ kind: "upsert", id: "backend-run", listed: true, session: { id: "backend-run", title: "Node 乘法" } }], workdirs: [] });
    await tick();
    assert.equal(deleted(), false, "K-brain's row replaces it without a delete");
    assert.equal(f.kBrainSidebarSync.list(1, 50, { kind: "all" }).items.find((item) => item.id === "local-run")?.title, "Node 乘法");
  } finally {
    f.stop();
  }
});

test("a finished turn K-brain never lists is removed after a grace period", async () => {
  const f = fixture();
  const originalSetTimeout = globalThis.setTimeout;
  const timers = [];
  try {
    f.start();
    await until(() => f.published.some((p) => p.kind === "snapshot"));
    f.kBrainSidebarSync.markRunning({ ...running, id: "never-saved" });
    await until(() => lastUpsert(f.published, "never-saved"));
    globalThis.setTimeout = (callback, ms) => {
      if (ms >= 1000) {
        timers.push(callback);
        return 0;
      }
      return originalSetTimeout(callback, ms);
    };
    f.kBrainSidebarSync.clearRunning("never-saved");
    globalThis.setTimeout = originalSetTimeout;
    assert.equal(timers.length, 1, "a grace timer is armed");
    assert.deepEqual(ids(f.kBrainSidebarSync.list(1, 50, { kind: "all" })), ["listed", "never-saved"]);
    timers[0]();
    await until(() => f.published.some((p) => p.kind === "event" && p.event?.kind === "delete" && p.event.conversationId === "never-saved"));
    assert.deepEqual(ids(f.kBrainSidebarSync.list(1, 50, { kind: "all" })), ["listed"]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    f.stop();
  }
});

test("a snapshot taken while the turn runs still carries the running conversation", async () => {
  const f = fixture();
  try {
    f.start();
    await until(() => f.published.some((p) => p.kind === "snapshot"));
    f.kBrainSidebarSync.markRunning(running);
    // A backend epoch change forces a full snapshot.
    f.configuration.onHealth(false);
    f.configuration.onSnapshot({ epoch: "e2", revision: "0", sessions: new Map([["listed", { id: "listed", title: "old chat" }]]), workdirs: [] });
    f.configuration.onHealth(true);
    await until(() => f.published.filter((p) => p.kind === "snapshot").length >= 2);
    const snapshot = f.published.filter((p) => p.kind === "snapshot").at(-1);
    assert.deepEqual(ids({ items: snapshot.conversations }), ["listed", "local-run"]);
  } finally {
    f.stop();
  }
});
