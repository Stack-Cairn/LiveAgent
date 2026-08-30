import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const { createPendingUploadsRegistry } = loader.loadModule(
  "src/app/hooks/pendingUploadsRegistry.ts",
);
const { resolveConversationUploadWorkdir } = loader.loadModule(
  "src/app/hooks/uploadWorkdirRouting.ts",
);

function upload(relativePath) {
  return { relativePath, originalName: relativePath, size: 1 };
}

test("background conversation subscribers observe externally routed attachments", () => {
  const registry = createPendingUploadsRegistry();
  const snapshots = [];
  const unsubscribe = registry.subscribe(() => {
    snapshots.push(registry.get("conversation-b"));
  });

  registry.set("conversation-b", [upload("review.md")]);

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0][0].relativePath, "review.md");
  unsubscribe();
});

test("draft promotion rekeys attachments and notifies pane subscribers", () => {
  const registry = createPendingUploadsRegistry();
  let notifications = 0;
  registry.set("draft-a", [upload("plan.md")]);
  registry.subscribe(() => {
    notifications += 1;
  });

  registry.move("draft-a", "conversation-a");

  assert.equal(registry.get("draft-a").length, 0);
  assert.equal(registry.get("conversation-a")[0].relativePath, "plan.md");
  assert.equal(notifications, 1);
});

test("background upload without owned cwd fails closed instead of using focused workspace", () => {
  assert.equal(
    resolveConversationUploadWorkdir({
      targetConversationId: "conversation-b",
      displayedConversationId: "conversation-a",
      persistedWorkdir: null,
      runtimeWorkdir: null,
      isAgentMode: true,
      activeWorkspacePath: "/workspace/a",
      defaultWorkdir: "/workspace/default",
    }),
    "",
  );
  assert.equal(
    resolveConversationUploadWorkdir({
      targetConversationId: "conversation-b",
      displayedConversationId: "conversation-a",
      persistedWorkdir: "/workspace/b",
      runtimeWorkdir: null,
      isAgentMode: true,
      activeWorkspacePath: "/workspace/a",
      defaultWorkdir: "/workspace/default",
    }),
    "/workspace/b",
  );
});
