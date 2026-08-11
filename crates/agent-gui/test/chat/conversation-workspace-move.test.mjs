import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { moveConversationToWorkspace, moveConversationsToWorkspace } = loader.loadModule(
  "src/pages/chat/sidebar/conversationWorkspaceMove.ts",
);

function createStore(failingIds = []) {
  const failures = new Set(failingIds);
  const cleared = [];
  return {
    cleared,
    clearMutationError(id) {
      cleared.push(id);
    },
    async setCwd(id) {
      return !failures.has(id);
    },
  };
}

test("single workspace move syncs runtime only after persistence succeeds", async () => {
  const store = createStore();
  const synced = [];

  assert.equal(
    await moveConversationToWorkspace(store, "current", "C:/workspace-b", (id, cwd) =>
      synced.push([id, cwd]),
    ),
    true,
  );
  assert.deepEqual(store.cleared, ["current"]);
  assert.deepEqual(synced, [["current", "C:/workspace-b"]]);
});

test("batch workspace move syncs successful runtimes and returns failed ids", async () => {
  const store = createStore(["failed"]);
  const synced = [];

  const failedIds = await moveConversationsToWorkspace(
    store,
    ["current", "failed", "other"],
    "C:/workspace-b",
    (id, cwd) => synced.push([id, cwd]),
  );

  assert.deepEqual(failedIds, ["failed"]);
  assert.deepEqual(store.cleared, ["current", "failed", "other"]);
  assert.deepEqual(synced, [
    ["current", "C:/workspace-b"],
    ["other", "C:/workspace-b"],
  ]);
});
