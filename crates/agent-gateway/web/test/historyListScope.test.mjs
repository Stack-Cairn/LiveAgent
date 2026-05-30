import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const historyListScope = loader.loadModule("src/lib/chat/historyListScope.ts");

function summary(id, cwd, updatedAt = 1) {
  return {
    id,
    title: id,
    created_at: updatedAt,
    updated_at: updatedAt,
    message_count: 1,
    cwd,
  };
}

test("web history scope drops conversations from other projects", () => {
  const scoped = historyListScope.filterConversationSummariesForScope(
    [
      summary("project-a-run", "/tmp/project-a", 30),
      summary("project-b-run", "/tmp/project-b", 40),
      summary("chat-mode", undefined, 50),
    ],
    { cwd: "/tmp/project-a" },
  );

  assert.deepEqual(scoped.map((item) => item.id), ["project-a-run"]);
});

test("web history scope treats missing cwd as chat-mode only", () => {
  const scoped = historyListScope.filterConversationSummariesForScope(
    [summary("project-a", "/tmp/project-a"), summary("chat-mode", undefined)],
    { cwdEmpty: true },
  );

  assert.deepEqual(scoped.map((item) => item.id), ["chat-mode"]);
});
