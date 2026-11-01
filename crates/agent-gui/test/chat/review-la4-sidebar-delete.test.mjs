import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Review LA-4: a first turn usually ends before K-brain lists its session, so clearRunning
// arms the 60 s grace timer and keeps the pending row in `running`. If K-brain then lists the
// session and the user deletes it (desktop or WebUI) inside that window, the deleted
// conversation must not come back from the overlay.

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(predicate, label = "publication") {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`${label} timed out`);
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
        summaryForSession: (session, id) => ({
          id,
          title: session.title,
          sessionId: session.id,
          createdAt: 1,
          updatedAt: 2,
          providerId: "fixture",
          model: "test",
          messageCount: 2,
        }),
      },
      "./sessionSync": {
        createKBrainSessionSync: (options) => {
          configuration = options;
          return {
            isHealthy: () => healthy,
            restart: () => {},
            acquire: () => () => {},
            getSnapshot: () => undefined,
            waitForRevision: async () => {},
          };
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
    get configuration() {
      return configuration;
    },
    start() {
      healthy = true;
      configuration.onSnapshot({
        epoch: "e",
        revision: "1",
        sessions: new Map([["listed", { id: "listed", title: "old chat" }]]),
        workdirs: [],
      });
      configuration.onHealth(true);
    },
    stop() {
      stop();
      globalThis.setInterval = originalInterval;
      globalThis.clearInterval = originalClear;
    },
  };
}

const pending = {
  id: "local-run",
  title: "新对话",
  isPending: true,
  providerId: "fixture",
  model: "test",
  createdAt: 5,
  updatedAt: 6,
};
const eventsFor = (published, id) =>
  published.filter((p) => p.kind === "event" && p.event?.conversationId === id);

// Runs the real sequence: first turn starts, ends before K-brain lists it (grace armed),
// K-brain lists it, then the user deletes it while the grace timer is still pending.
async function finishedTurnThenDeleted(f) {
  const originalSetTimeout = globalThis.setTimeout;
  const graceTimers = [];
  f.start();
  await until(() => f.published.some((p) => p.kind === "snapshot"));
  f.kBrainSidebarSync.markRunning(pending);
  await until(() => eventsFor(f.published, "local-run").some((p) => p.event.kind === "upsert"));
  globalThis.setTimeout = (callback, ms) => {
    if (ms >= 1000) {
      graceTimers.push(callback);
      return 0;
    }
    return originalSetTimeout(callback, ms);
  };
  try {
    f.kBrainSidebarSync.clearRunning("local-run");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(graceTimers.length, 1, "the turn ended before K-brain listed it: grace armed");
  f.mapping.setKBrainSessionId("local-run", "backend-run");
  f.configuration.onChanges({
    epoch: "e",
    revision: "2",
    changes: [{ kind: "upsert", id: "backend-run", listed: true, session: { id: "backend-run", title: "Node 乘法" } }],
    workdirs: [],
  });
  await until(() =>
    eventsFor(f.published, "local-run").some((p) => p.event.kind === "upsert" && p.event.conversation?.title === "Node 乘法"),
  );
  const before = f.published.length;
  // User deletes the conversation (desktop sidebar or WebUI) inside the 60 s window.
  f.configuration.onChanges({
    epoch: "e",
    revision: "3",
    changes: [{ kind: "delete", id: "backend-run", listed: false }],
    workdirs: [],
  });
  // Let the publication loop drain.
  await until(() => f.published.slice(before).some((p) => p.kind === "status"), "post-delete publication");
  return { before, graceTimers };
}

test("review-la4: a conversation deleted during the finished-turn grace window does not come back in the desktop list", async () => {
  const f = fixture();
  try {
    await finishedTurnThenDeleted(f);
    const row = f.kBrainSidebarSync.list(1, 50, { kind: "all" }).items.find((item) => item.id === "local-run");
    assert.equal(
      row === undefined,
      true,
      `deleted conversation is listed again: ${JSON.stringify(row && { title: row.title, isPending: row.isPending })}`,
    );
  } finally {
    f.stop();
  }
});

test("review-la4: deleting a conversation during the grace window publishes a delete to the Gateway, not the stale pending row", async () => {
  const f = fixture();
  try {
    const { before } = await finishedTurnThenDeleted(f);
    const after = eventsFor(f.published.slice(before), "local-run").map((p) => ({
      kind: p.event.kind,
      title: p.event.conversation?.title,
    }));
    assert.deepEqual(after, [{ kind: "delete", title: undefined }], `Gateway received: ${JSON.stringify(after)}`);
  } finally {
    f.stop();
  }
});
