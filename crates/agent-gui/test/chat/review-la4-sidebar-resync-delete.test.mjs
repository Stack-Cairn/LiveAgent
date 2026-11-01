import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";


// Review LA-4 round 3: onChanges now drops the running row on an authoritative delete.
// The same delete can also arrive through a resync snapshot (sessionSync collects catch-up
// deletes into snapshot.deletedSessionIds after a reconnect or a failed mutation confirm);
// onSnapshot clears the mapping for those ids but leaves the running row in place.
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


for (const finishFirst of [false, true]) {
  const when = finishFirst ? "during the finished-turn grace window" : "while its turn is still running";
  test(`review-la4: a never-listed conversation deleted ${when} and delivered by a resync snapshot leaves the list and is deleted on the Gateway`, async () => {
    const f = fixture();
    const originalSetTimeout = globalThis.setTimeout;
    try {
      f.start();
      await until(() => f.published.some((p) => p.kind === "snapshot"));
      f.kBrainSidebarSync.markRunning(pending);
      f.mapping.setKBrainSessionId("local-run", "backend-run");
      await until(() => eventsFor(f.published, "local-run").some((p) => p.event.kind === "upsert"));
      if (finishFirst) {
        globalThis.setTimeout = (callback, ms) => (ms >= 1000 ? 0 : originalSetTimeout(callback, ms));
        try {
          f.kBrainSidebarSync.clearRunning("local-run");
        } finally {
          globalThis.setTimeout = originalSetTimeout;
        }
      }
      const before = f.published.length;
      // Resync (same epoch) whose catch-up saw the delete of the never-listed session.
      f.configuration.onSnapshot({
        epoch: "e",
        revision: "3",
        sessions: new Map([["listed", { id: "listed", title: "old chat" }]]),
        workdirs: [],
        deletedSessionIds: ["backend-run"],
      });
      await until(() => f.published.slice(before).some((p) => p.kind === "status"), "post-resync publication");
      assert.equal(f.mapping.getKBrainSessionId("local-run"), undefined, "the delete was applied to the mapping");
      const row = f.kBrainSidebarSync.list(1, 50, { kind: "all" }).items.find((item) => item.id === "local-run");
      const lastSnapshot = f.published.slice(before).filter((p) => p.kind === "snapshot").at(-1);
      const republished = (lastSnapshot?.conversations ?? []).some((c) => c.id === "local-run");
      assert.deepEqual(
        { listed: row !== undefined, republished },
        { listed: false, republished: false },
        `row ${JSON.stringify(row && { title: row.title, isPending: row.isPending })}`,
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      f.stop();
    }
  });
}
