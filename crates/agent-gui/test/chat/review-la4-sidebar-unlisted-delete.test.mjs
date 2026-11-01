import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";


// Review LA-4 round 2: releaseListedRunning only drops a running row once K-brain lists the
// id. A session K-brain never listed (turn still running, or stopped/finished before the
// first message was listed) can still be deleted: the WebUI shows the overlay row and its
// delete reaches K-brain through deleteKBrainHistory (the mapping exists from run start).
// K-brain then sends an authoritative delete change; the overlay must not keep the row.
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


async function deleteNeverListed(f, { finishFirst }) {
  const originalSetTimeout = globalThis.setTimeout;
  const graceTimers = [];
  f.start();
  await until(() => f.published.some((p) => p.kind === "snapshot"));
  f.kBrainSidebarSync.markRunning(pending);
  f.mapping.setKBrainSessionId("local-run", "backend-run");
  await until(() => eventsFor(f.published, "local-run").some((p) => p.event.kind === "upsert"));
  if (finishFirst) {
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
    assert.equal(graceTimers.length, 1, "grace armed: K-brain had not listed the session");
  }
  const before = f.published.length;
  // The user deletes the row; K-brain confirms with an authoritative delete change.
  f.configuration.onChanges({
    epoch: "e",
    revision: "2",
    changes: [{ kind: "delete", id: "backend-run", listed: false }],
    workdirs: [],
  });
  await until(() => f.published.slice(before).some((p) => p.kind === "status"), "post-delete publication");
  return { before };
}

for (const finishFirst of [true, false]) {
  const when = finishFirst ? "during the finished-turn grace window" : "while its turn is still running";
  test(`review-la4: a never-listed conversation deleted ${when} leaves the desktop list`, async () => {
    const f = fixture();
    try {
      await deleteNeverListed(f, { finishFirst });
      const row = f.kBrainSidebarSync.list(1, 50, { kind: "all" }).items.find((item) => item.id === "local-run");
      assert.equal(row === undefined, true, `deleted conversation still listed: ${JSON.stringify(row && { title: row.title, isPending: row.isPending })}`);
    } finally {
      f.stop();
    }
  });

  test(`review-la4: a never-listed conversation deleted ${when} is deleted on the Gateway`, async () => {
    const f = fixture();
    try {
      const { before } = await deleteNeverListed(f, { finishFirst });
      const after = eventsFor(f.published.slice(before), "local-run").map((p) => p.event.kind);
      assert.deepEqual(after, ["delete"], `Gateway events after the delete: ${JSON.stringify(after)}`);
    } finally {
      f.stop();
    }
  });
}
