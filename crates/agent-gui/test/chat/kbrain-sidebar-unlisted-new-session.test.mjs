import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// K-brain reports a session as `listed: false` until its first message is
// persisted (summaryListed requires count > 0). A brand-new conversation is
// already mapped and shown as a local pending row at that point; the unlisted
// change must not delete it, or the row vanishes once the user switches away.

function session(id, title, messageCount) {
  return {
    id,
    title,
    cwd: "/repo/a",
    model: { provider: "fixture", model: "test" },
    created_at: "2026-10-29T00:00:00Z",
    updated_at: "2026-10-29T00:00:01Z",
    message_count: messageCount,
  };
}

function loadSidebarSync() {
  let configuration;
  let healthy = false;
  const loader = createTsModuleLoader({
    mocks: {
      "@liveagent/app/shims/tauriCore": {
        invoke: async (command) => {
          if (command === "gateway_status")
            return { online: true, agentId: "agent", sessionId: "session" };
          return { accepted: true, needsResync: false };
        },
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
  return {
    kBrainSidebarSync,
    mapping,
    get configuration() {
      return configuration;
    },
    setHealthy(value) {
      healthy = value;
    },
  };
}

test("an unlisted change for a never-listed new session keeps its pending sidebar row", () => {
  const fixture = loadSidebarSync();
  const events = [];
  const stop = fixture.kBrainSidebarSync.subscribe((event) => events.push(event));
  try {
    fixture.setHealthy(true);
    fixture.configuration.onSnapshot({
      epoch: "epoch",
      revision: "1",
      sessions: new Map([["existing", session("existing", "Existing", 2)]]),
      workdirs: [{ cwd: "/repo/a", count: 1, updated_at: "2026-10-29T00:00:01Z" }],
    });
    // The desktop binds the local conversation to the backend session when
    // the first run starts, before any message is persisted.
    fixture.mapping.setKBrainSessionId("local-new", "fresh");
    events.length = 0;

    fixture.configuration.onChanges({
      epoch: "epoch",
      revision: "2",
      changes: [
        { id: "fresh", revision: "2", kind: "upsert", listed: false, session: session("fresh", "", 0) },
      ],
      workdirs: [{ cwd: "/repo/a", count: 1, updated_at: "2026-10-29T00:00:01Z" }],
    });
    assert.deepEqual(
      events.filter((event) => event.kind !== "workdirs"),
      [],
      "a session that was never listed has no sidebar row to delete",
    );
    assert.equal(fixture.mapping.getKBrainConversationId("fresh"), "local-new");

    fixture.configuration.onChanges({
      epoch: "epoch",
      revision: "3",
      changes: [
        {
          id: "fresh",
          revision: "3",
          kind: "upsert",
          listed: true,
          session: session("fresh", "First prompt", 1),
        },
      ],
      workdirs: [{ cwd: "/repo/a", count: 2, updated_at: "2026-10-29T00:00:01Z" }],
    });
    assert.deepEqual(
      events.filter((event) => event.kind !== "workdirs").map((event) => [event.kind, event.conversationId]),
      [["upsert", "local-new"]],
    );
  } finally {
    stop();
  }
});

test("a previously listed session that becomes unlisted is still deleted", () => {
  const fixture = loadSidebarSync();
  const events = [];
  const stop = fixture.kBrainSidebarSync.subscribe((event) => events.push(event));
  try {
    fixture.setHealthy(true);
    fixture.configuration.onSnapshot({
      epoch: "epoch",
      revision: "1",
      sessions: new Map([["archived", session("archived", "Archived later", 3)]]),
      workdirs: [{ cwd: "/repo/a", count: 1, updated_at: "2026-10-29T00:00:01Z" }],
    });
    const alias = fixture.mapping.getKBrainConversationId("archived");
    events.length = 0;

    fixture.configuration.onChanges({
      epoch: "epoch",
      revision: "2",
      changes: [
        { id: "archived", revision: "2", kind: "upsert", listed: false, session: session("archived", "Archived later", 3) },
      ],
      workdirs: [],
    });
    assert.deepEqual(
      events.filter((event) => event.kind !== "workdirs").map((event) => [event.kind, event.conversationId]),
      [["delete", alias]],
    );
  } finally {
    stop();
  }
});
