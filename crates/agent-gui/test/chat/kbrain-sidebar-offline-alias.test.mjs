import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("publication timed out");
}

test("offline authoritative deletion releases its alias and a later full snapshot removes remote state", async () => {
  const values = new Map();
  const previousStorage = globalThis.localStorage;
  const previousInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  globalThis.localStorage = {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
  let heartbeat;
  globalThis.setInterval = (callback) => {
    heartbeat = callback;
    return 123;
  };
  globalThis.clearInterval = () => {};

  let configuration;
  let healthy = true;
  let online = false;
  const publications = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@liveagent/app/shims/tauriCore": {
        invoke: async (command, args) => {
          if (command === "gateway_status")
            return { online, agentId: "agent", sessionId: "gateway-session" };
          publications.push(args.input);
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
          messageCount: 1,
        }),
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
  let stop;
  try {
    const { kBrainSidebarSync } = loader.loadModule("src/lib/kbrain/sidebarSync.ts");
    const mapping = loader.loadModule("src/lib/kbrain/mapping.ts");
    stop = kBrainSidebarSync.subscribe(() => {});
    configuration.onSnapshot({
      epoch: "epoch",
      revision: "1",
      sessions: new Map([
        ["backend-deleted", { id: "backend-deleted", title: "present" }],
        ["backend-hidden", { id: "backend-hidden", title: "hidden later" }],
      ]),
      workdirs: [],
    });
    configuration.onHealth(true);
    await tick();
    assert.ok(mapping.getKBrainConversationId("backend-deleted"));
    const hiddenAlias = mapping.getKBrainConversationId("backend-hidden");
    assert.ok(hiddenAlias);

    configuration.onSnapshot({
      epoch: "epoch",
      revision: "2",
      sessions: new Map(),
      workdirs: [],
      deletedSessionIds: ["backend-deleted"],
    });
    await tick();
    assert.equal(
      mapping.getKBrainConversationId("backend-deleted"),
      undefined,
      "an offline Gateway cannot keep deleted aliases forever",
    );
    assert.equal(
      mapping.getKBrainConversationId("backend-hidden"),
      hiddenAlias,
      "a listed=false projection removal must retain its stable alias",
    );

    online = true;
    heartbeat();
    await until(() => publications.some((item) => item.kind === "snapshot"));
    const snapshot = publications.find((item) => item.kind === "snapshot");
    assert.deepEqual(snapshot.conversations, []);
  } finally {
    stop?.();
    healthy = false;
    globalThis.localStorage = previousStorage;
    globalThis.setInterval = previousInterval;
    globalThis.clearInterval = previousClearInterval;
  }
});
