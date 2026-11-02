import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({ rootDir: fileURLToPath(new URL("../", import.meta.url)) });
const { createWebSidebarBackend } = loader.loadModule("src/lib/sidebar/webSidebarBackend.ts");
const { createActivityStore } = loader.loadModule("src/lib/chat/stream/activityStore.ts");
const { createSidebarStore } = loader.loadModule("@liveagent/ui/lib/sidebar/store.ts");

const summary = (title) => ({
  id: "conversation",
  title,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_001,
  message_count: 1,
});

test(
  "a mutation waits for the subscribed projection instead of polling full snapshots",
  { timeout: 4_000 },
  async () => {
    const historyListeners = new Set();
    const syncListeners = new Set();
    let resyncCalls = 0;
    const api = {
      listHistory: async () => ({ conversations: [], total_count: 0, running_conversations: [] }),
      listHistoryWorkdirs: async () => ({ workdirs: [] }),
      renameHistory: async (_id, title) => summary(title),
      pinHistory: async () => summary("old"),
      setHistoryCwd: async () => summary("old"),
      deleteHistory: async () => {},
      subscribeHistory(listener) {
        historyListeners.add(listener);
        return () => historyListeners.delete(listener);
      },
      subscribeHistorySync(listener) {
        syncListeners.add(listener);
        return () => syncListeners.delete(listener);
      },
      async requestHistoryResync() {
        resyncCalls += 1;
        return {
          source_id: "source",
          generation: "generation",
          cut_delivery_seq: 1,
          resync_token: "token",
          conversations: [summary("old")],
          workdirs: [],
        };
      },
      async acknowledgeHistoryResync() {},
      subscribeConnection() {
        return () => {};
      },
      subscribeStatus() {
        return () => {};
      },
    };
    const backend = createWebSidebarBackend({
      api,
      activityStore: createActivityStore(),
      getProtectedConversationIds: () => [],
    });
    const unsubscribe = backend.subscribeEvents(() => {});
    try {
      for (const listener of syncListeners) {
        listener({
          kind: "status",
          status: {
            source_id: "source",
            generation: "generation",
            latest_delivery_seq: 1,
            available: true,
            needs_resync: true,
            resync_token: "token",
          },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      const pending = backend.renameConversation("conversation", "new");
      setTimeout(() => {
        for (const listener of historyListeners) {
          listener({
            kind: "upsert",
            conversation_id: "conversation",
            conversation: summary("new"),
            source_id: "source",
            generation: "generation",
            delivery_seq: 2,
          });
        }
      }, 20);
      const confirmed = await pending;
      assert.equal(confirmed.title, "new");
      assert.ok(resyncCalls <= 1, `one mutation fetched ${resyncCalls} full snapshots`);
    } finally {
      unsubscribe();
    }
  },
);

test(
  "a legacy mutation event cannot reject confirmation before the v2 projection arrives",
  { timeout: 4_000 },
  async () => {
    const historyListeners = new Set();
    const syncListeners = new Set();
    let initialized = false;
    let resyncCalls = 0;
    const api = {
      listHistory: async () => ({
        conversations: [summary("old")],
        total_count: 1,
        running_conversations: [],
      }),
      listHistoryWorkdirs: async () => ({ workdirs: [] }),
      renameHistory: async (_id, title) => summary(title),
      pinHistory: async () => summary("old"),
      setHistoryCwd: async () => summary("old"),
      deleteHistory: async () => {},
      subscribeHistory(listener) {
        historyListeners.add(listener);
        return () => historyListeners.delete(listener);
      },
      subscribeHistorySync(listener) {
        syncListeners.add(listener);
        return () => syncListeners.delete(listener);
      },
      async requestHistoryResync(token) {
        resyncCalls += 1;
        return {
          source_id: "source",
          generation: "generation",
          cut_delivery_seq: initialized ? 1 : 0,
          resync_token: token || "token",
          conversations: [summary("old")],
          workdirs: [],
        };
      },
      async acknowledgeHistoryResync() {},
      subscribeConnection: () => () => {},
      subscribeStatus: () => () => {},
    };
    const backend = createWebSidebarBackend({
      api,
      activityStore: createActivityStore(),
      getProtectedConversationIds: () => [],
      historyMutationConfirmMs: 100,
    });
    const store = createSidebarStore(backend);
    store.setScope({ kind: "all" });
    store.start();
    for (const listener of syncListeners) {
      listener({
        kind: "status",
        status: {
          source_id: "source",
          generation: "generation",
          latest_delivery_seq: 0,
          available: true,
          needs_resync: true,
          resync_token: "initial",
        },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    initialized = true;
    resyncCalls = 0;
    try {
      const pending = store.rename("conversation", "new");
      for (const listener of historyListeners) {
        listener({
          kind: "upsert",
          conversation_id: "conversation",
          conversation: summary("new"),
        });
      }
      setTimeout(() => {
        for (const listener of historyListeners) {
          listener({
            kind: "upsert",
            conversation_id: "conversation",
            conversation: summary("new"),
            source_id: "source",
            generation: "generation",
            delivery_seq: 1,
          });
        }
      }, 20);
      const confirmed = await pending;
      assert.equal(confirmed, true);
      assert.equal(store.getSnapshot().mutationErrors.has("conversation"), false);
      assert.equal(store.getSnapshot().byId.get("conversation")?.title, "new");
      assert.equal(resyncCalls, 0);
    } finally {
      store.stop();
    }
  },
);

test("concurrent mutation confirmations share one authoritative snapshot fallback", async () => {
  const historySyncListeners = new Set();
  let resyncCalls = 0;
  let initialized = false;
  const snapshot = (token) => ({
    source_id: "source",
    generation: "generation",
    cut_delivery_seq: initialized ? 2 : 0,
    resync_token: token || "token",
    conversations: initialized ? [{ ...summary("one"), id: "one" }, { ...summary("two"), id: "two" }] : [],
    workdirs: [],
  });
  const api = {
    listHistory: async () => ({ conversations: [], total_count: 0, running_conversations: [] }),
    listHistoryWorkdirs: async () => ({ workdirs: [] }),
    renameHistory: async (id, title) => ({ ...summary(title), id }),
    pinHistory: async () => summary("old"),
    setHistoryCwd: async () => summary("old"),
    deleteHistory: async () => {},
    subscribeHistory: () => () => {},
    subscribeHistorySync(listener) {
      historySyncListeners.add(listener);
      return () => historySyncListeners.delete(listener);
    },
    async requestHistoryResync(token) {
      resyncCalls += 1;
      return snapshot(token);
    },
    async acknowledgeHistoryResync() {},
    subscribeConnection: () => () => {},
    subscribeStatus: () => () => {},
  };
  const backend = createWebSidebarBackend({
    api,
    activityStore: createActivityStore(),
    getProtectedConversationIds: () => [],
    historyMutationConfirmMs: 5,
  });
  const unsubscribe = backend.subscribeEvents(() => undefined);
  for (const listener of historySyncListeners) {
    listener({
      kind: "status",
      status: {
        source_id: "source",
        generation: "generation",
        latest_delivery_seq: 0,
        available: true,
        needs_resync: true,
        resync_token: "initial",
      },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    resyncCalls = 0;
    initialized = true;
    const [one, two] = await Promise.all([
      backend.renameConversation("one", "one"),
      backend.renameConversation("two", "two"),
    ]);
    assert.equal(one.id, "one");
    assert.equal(two.id, "two");
    assert.equal(resyncCalls, 1);
  } finally {
    unsubscribe();
  }
});

test("a same-timestamp stale snapshot cannot confirm a different mutation value", async () => {
  const syncListeners = new Set();
  let initialized = false;
  const api = {
    listHistory: async () => ({ conversations: [], total_count: 0, running_conversations: [] }),
    listHistoryWorkdirs: async () => ({ workdirs: [] }),
    renameHistory: async () => summary("new"),
    pinHistory: async () => summary("old"),
    setHistoryCwd: async () => summary("old"),
    deleteHistory: async () => {},
    subscribeHistory: () => () => {},
    subscribeHistorySync(listener) {
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    },
    async requestHistoryResync(token) {
      return {
        source_id: "source",
        generation: "generation",
        cut_delivery_seq: initialized ? 2 : 0,
        resync_token: token || "token",
        conversations: initialized ? [summary("old")] : [],
        workdirs: [],
      };
    },
    async acknowledgeHistoryResync() {},
    subscribeConnection: () => () => {},
    subscribeStatus: () => () => {},
  };
  const backend = createWebSidebarBackend({
    api,
    activityStore: createActivityStore(),
    getProtectedConversationIds: () => [],
    historyMutationConfirmMs: 5,
  });
  const unsubscribe = backend.subscribeEvents(() => undefined);
  for (const listener of syncListeners) {
    listener({
      kind: "status",
      status: {
        source_id: "source",
        generation: "generation",
        latest_delivery_seq: 0,
        available: true,
        needs_resync: true,
        resync_token: "initial",
      },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  initialized = true;
  try {
    await assert.rejects(
      backend.renameConversation("conversation", "new"),
      /awaiting synchronization/,
    );
  } finally {
    unsubscribe();
  }
});
