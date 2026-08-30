import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { commitWorkspaceDropConversation, shouldDeferWorkspaceDropConversationSync } =
  loader.loadModule("@liveagent/ui/lib/workbench/workspaceDropCommit.ts");

const PROJECT = { projectId: "project-main", projectPathKey: "/workspace/main" };
const TARGET = { kind: "pane-edge", paneId: "pane-a", edge: "right" };

function createDeps(overrides = {}) {
  const opened = [];
  const deps = {
    revision: 7,
    target: TARGET,
    project: PROJECT,
    startConversation: async () => "draft-new",
    currentRevision: () => 7,
    conversationMatchesProject: () => true,
    paneIdForConversation: () => null,
    openConversation: (input, target) => {
      opened.push({ input, target });
      return { paneId: "pane-new" };
    },
    ...overrides,
  };
  return { deps, opened };
}

test("workspace drop opens the exact draft at the frozen target", async () => {
  const created = [];
  const { deps, opened } = createDeps({
    onConversationCreated: (conversationId) => created.push(conversationId),
  });
  assert.deepEqual(await commitWorkspaceDropConversation(deps), {
    kind: "opened",
    conversationId: "draft-new",
  });
  assert.deepEqual(opened, [
    {
      input: { conversationId: "draft-new", project: PROJECT },
      target: TARGET,
    },
  ]);
  assert.deepEqual(created, ["draft-new"]);
});

test("pending drop defers sync until its exact draft id is known", () => {
  const pending = { operationId: 4, projectPathKey: "/workspace/main", conversationId: null };
  assert.equal(
    shouldDeferWorkspaceDropConversationSync(pending, "draft-new", "/workspace/main"),
    true,
  );
  pending.conversationId = "draft-new";
  assert.equal(
    shouldDeferWorkspaceDropConversationSync(pending, "draft-new", "/workspace/other"),
    true,
  );
  assert.equal(
    shouldDeferWorkspaceDropConversationSync(pending, "unrelated", "/workspace/main"),
    false,
  );
});

test("directory rejection creates no pane", async () => {
  const { deps, opened } = createDeps({ startConversation: async () => null });
  assert.deepEqual(await commitWorkspaceDropConversation(deps), { kind: "not-created" });
  assert.equal(opened.length, 0);
});

test("a revision change after async draft creation rejects stale geometry", async () => {
  const { deps, opened } = createDeps({ currentRevision: () => 8 });
  assert.deepEqual(await commitWorkspaceDropConversation(deps), {
    kind: "stale",
    conversationId: "draft-new",
  });
  assert.equal(opened.length, 0);
});

test("a draft whose workdir does not match the dragged workspace is never misplaced", async () => {
  const { deps, opened } = createDeps({ conversationMatchesProject: () => false });
  assert.deepEqual(await commitWorkspaceDropConversation(deps), {
    kind: "identity-mismatch",
    conversationId: "draft-new",
  });
  assert.equal(opened.length, 0);
});

test("a draft already projected into a pane is not duplicated", async () => {
  const { deps, opened } = createDeps({ paneIdForConversation: () => "pane-existing" });
  assert.deepEqual(await commitWorkspaceDropConversation(deps), {
    kind: "already-open",
    conversationId: "draft-new",
  });
  assert.equal(opened.length, 0);
});
