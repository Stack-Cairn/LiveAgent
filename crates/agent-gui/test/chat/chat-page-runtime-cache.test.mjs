import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const llmModulePath = path.join(rootDir, "src/lib/providers/llm.ts");

const loader = createTsModuleLoader({
  mocks: {
    [llmModulePath]: {
      normalizeErrorMessage(value, fallback = "Request failed") {
        return typeof value === "string" && value.trim() ? value.trim() : fallback;
      },
    },
  },
});

const {
  pruneIdleConversationRuntimeCaches,
  setConversationRuntimeCacheEntry,
  shouldReuseConversationRuntimeCache,
} = loader.loadModule("src/pages/chat/runtime/chatPageRuntime.ts");

function createEntry(id, options = {}) {
  return {
    state: {
      id,
      meta: {
        totalMessageCount: options.messageCount ?? 0,
      },
    },
    compactionStatus: { phase: "idle" },
    isSending: Boolean(options.isSending),
    errorMessage: null,
    hookWarning: null,
    sessionId: `${id}-session`,
    createdAt: 1,
  };
}

function createCursor(id) {
  return {
    activeSegmentIndex: 0,
    activeSegmentId: `${id}-segment`,
  };
}

test("history cache reuse requires a live run or a pending conversation", () => {
  assert.equal(
    shouldReuseConversationRuntimeCache({ isRunning: true, isPending: false }),
    true,
  );
  assert.equal(
    shouldReuseConversationRuntimeCache({ isRunning: false, isPending: true }),
    true,
  );
  assert.equal(
    shouldReuseConversationRuntimeCache({ isRunning: false, isPending: false }),
    false,
  );
});

test("pruneIdleConversationRuntimeCaches evicts oldest idle runtime entries", () => {
  const runtimeCache = new Map();
  const persistenceCursors = new Map();
  for (const id of ["a", "b", "c", "d"]) {
    setConversationRuntimeCacheEntry(runtimeCache, id, createEntry(id));
    persistenceCursors.set(id, createCursor(id));
  }
  const pruned = [];

  const result = pruneIdleConversationRuntimeCaches({
    runtimeCache,
    persistenceCursors,
    maxIdleEntries: 2,
    onPruneConversation: (id) => pruned.push(id),
  });

  assert.deepEqual(result, ["a", "b"]);
  assert.deepEqual(pruned, ["a", "b"]);
  assert.deepEqual([...runtimeCache.keys()], ["c", "d"]);
  assert.deepEqual([...persistenceCursors.keys()], ["c", "d"]);
});

test("pruneIdleConversationRuntimeCaches keeps visible and running conversations", () => {
  const runtimeCache = new Map();
  const persistenceCursors = new Map();
  setConversationRuntimeCacheEntry(runtimeCache, "visible", createEntry("visible"));
  setConversationRuntimeCacheEntry(
    runtimeCache,
    "sending",
    createEntry("sending", { isSending: true }),
  );
  setConversationRuntimeCacheEntry(runtimeCache, "old-idle", createEntry("old-idle"));
  setConversationRuntimeCacheEntry(runtimeCache, "running", createEntry("running"));
  setConversationRuntimeCacheEntry(runtimeCache, "new-idle", createEntry("new-idle"));
  for (const id of runtimeCache.keys()) {
    persistenceCursors.set(id, createCursor(id));
  }

  const result = pruneIdleConversationRuntimeCaches({
    runtimeCache,
    persistenceCursors,
    keepConversationIds: ["visible"],
    isConversationRunning: (id) => id === "running",
    maxIdleEntries: 1,
  });

  assert.deepEqual(result, ["old-idle"]);
  assert.deepEqual(
    [...runtimeCache.keys()],
    ["visible", "sending", "running", "new-idle"],
  );
  assert.deepEqual(
    [...persistenceCursors.keys()],
    ["visible", "sending", "running", "new-idle"],
  );
});

test("setConversationRuntimeCacheEntry refreshes LRU order", () => {
  const runtimeCache = new Map();
  const persistenceCursors = new Map();
  for (const id of ["a", "b", "c"]) {
    setConversationRuntimeCacheEntry(runtimeCache, id, createEntry(id));
    persistenceCursors.set(id, createCursor(id));
  }
  setConversationRuntimeCacheEntry(runtimeCache, "a", createEntry("a", { messageCount: 2 }));

  const result = pruneIdleConversationRuntimeCaches({
    runtimeCache,
    persistenceCursors,
    maxIdleEntries: 2,
  });

  assert.deepEqual(result, ["b"]);
  assert.deepEqual([...runtimeCache.keys()], ["c", "a"]);
  assert.deepEqual([...persistenceCursors.keys()], ["a", "c"]);
});

test("pruneIdleConversationRuntimeCaches removes unprotected cursor-only entries", () => {
  const runtimeCache = new Map();
  const persistenceCursors = new Map([
    ["visible", createCursor("visible")],
    ["stale-a", createCursor("stale-a")],
    ["stale-b", createCursor("stale-b")],
  ]);
  setConversationRuntimeCacheEntry(runtimeCache, "visible", createEntry("visible"));

  const result = pruneIdleConversationRuntimeCaches({
    runtimeCache,
    persistenceCursors,
    keepConversationIds: ["visible"],
  });

  assert.deepEqual(result, ["stale-a", "stale-b"]);
  assert.deepEqual([...runtimeCache.keys()], ["visible"]);
  assert.deepEqual([...persistenceCursors.keys()], ["visible"]);
});
