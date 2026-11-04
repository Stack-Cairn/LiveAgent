import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  createUnreadConversationStore,
  diffRunAttention,
  resolveRunAttention,
  runAttentionBadgeCount,
} = loader.loadModule("src/lib/notifications/runAttention.ts");

function state({ running = [], approvals = [], questions = [] } = {}) {
  return {
    running: new Set(running),
    approvals: new Set(approvals),
    questions: new Set(questions),
  };
}

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
    data,
  };
}

test("diff reports finished runs and newly blocked conversations", () => {
  const events = diffRunAttention(
    state({ running: ["a", "b"], approvals: ["c"] }),
    state({ running: ["b"], approvals: ["c", "d"], questions: ["e"] }),
  );
  assert.deepEqual(events, [
    { kind: "approval", conversationId: "d" },
    { kind: "question", conversationId: "e" },
    { kind: "completed", conversationId: "a" },
  ]);
});

test("diff prefers the approval when a conversation blocks on both", () => {
  const events = diffRunAttention(state(), state({ approvals: ["x"], questions: ["x"] }));
  assert.deepEqual(events, [{ kind: "approval", conversationId: "x" }]);
});

test("diff is quiet when nothing transitions", () => {
  assert.deepEqual(
    diffRunAttention(state({ running: ["a"], questions: ["q"] }), state({ running: ["a"], questions: ["q"] })),
    [],
  );
});

test("the conversation in front of the user needs nothing", () => {
  assert.deepEqual(
    resolveRunAttention(
      { kind: "completed", conversationId: "a" },
      { visibleConversationId: "a", windowFocused: true },
    ),
    { markUnread: false, notify: false },
  );
});

test("a reply finishing in another conversation marks unread without a banner", () => {
  assert.deepEqual(
    resolveRunAttention(
      { kind: "completed", conversationId: "a" },
      { visibleConversationId: "b", windowFocused: true },
    ),
    { markUnread: true, notify: false },
  );
});

test("a backgrounded window gets a banner; the visible conversation is not marked unread", () => {
  assert.deepEqual(
    resolveRunAttention(
      { kind: "completed", conversationId: "a" },
      { visibleConversationId: "a", windowFocused: false },
    ),
    { markUnread: false, notify: true },
  );
  assert.deepEqual(
    resolveRunAttention(
      { kind: "approval", conversationId: "a" },
      { visibleConversationId: "b", windowFocused: false },
    ),
    { markUnread: false, notify: true },
  );
});

test("badge counts each conversation once across unread and blocked sets", () => {
  assert.equal(
    runAttentionBadgeCount(new Set(["a", "b"]), new Set(["b", "c"]), new Set(["c", "d"])),
    4,
  );
});

test("unread store marks, clears, notifies and persists", () => {
  const storage = memoryStorage();
  const store = createUnreadConversationStore(storage);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });
  store.mark("a");
  store.mark("a");
  store.mark("b");
  assert.deepEqual([...store.getSnapshot()], ["a", "b"]);
  assert.equal(notifications, 2);
  store.clear("a");
  store.clear("missing");
  assert.deepEqual([...store.getSnapshot()], ["b"]);
  assert.equal(notifications, 3);
  unsubscribe();

  const reloaded = createUnreadConversationStore(storage);
  assert.deepEqual([...reloaded.getSnapshot()], ["b"]);
});

test("unread store tolerates corrupt storage and caps its size", () => {
  const corrupt = createUnreadConversationStore(
    memoryStorage({ "liveagent.unread-conversations.v1": "{not json" }),
  );
  assert.equal(corrupt.getSnapshot().size, 0);

  const store = createUnreadConversationStore(memoryStorage());
  for (let index = 0; index < 205; index += 1) store.mark(`c${index}`);
  assert.equal(store.getSnapshot().size, 200);
  assert.equal(store.getSnapshot().has("c0"), false);
  assert.equal(store.getSnapshot().has("c204"), true);
});
