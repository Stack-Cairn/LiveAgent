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

const { resolveEffectiveConversationWorkdir, syncMovedConversationRuntimeWorkdir } = loader.loadModule(
  "src/pages/chat/runtime/chatPageRuntime.ts",
);

test("persisted moved cwd wins over stale GUI runtime cwd for the next agent turn", () => {
  assert.equal(
    resolveEffectiveConversationWorkdir({
      isAgentMode: true,
      persistedWorkdir: "C:/workspace-b",
      runtimeWorkdir: "C:/workspace-a",
      globalWorkdir: "C:/global",
    }),
    "C:/workspace-b",
  );
});

test("explicit turn workdir overrides persisted cwd and text mode has no workdir", () => {
  const input = {
    persistedWorkdir: "C:/workspace-b",
    runtimeWorkdir: "C:/workspace-a",
    globalWorkdir: "C:/global",
  };

  assert.equal(
    resolveEffectiveConversationWorkdir({
      ...input,
      isAgentMode: true,
      workdirOverride: "C:/explicit",
    }),
    "C:/explicit",
  );
  assert.equal(resolveEffectiveConversationWorkdir({ ...input, isAgentMode: false }), "");
});

test("successful move updates an existing idle GUI runtime entry", () => {
  const runtimeCache = new Map([
    ["current", { isSending: false, workdir: "C:/workspace-a" }],
  ]);
  const updates = [];

  assert.equal(
    syncMovedConversationRuntimeWorkdir({
      conversationId: "current",
      cwd: "C:/workspace-b",
      runtimeCache,
      isConversationRunning: () => false,
      updateConversationRuntimeEntry(id, updater) {
        const next = updater(runtimeCache.get(id));
        runtimeCache.set(id, next);
        updates.push(id);
      },
    }),
    true,
  );
  assert.equal(runtimeCache.get("current").workdir, "C:/workspace-b");
  assert.deepEqual(updates, ["current"]);
});

test("move does not rewrite sending, running, or missing GUI runtime entries", () => {
  const runtimeCache = new Map([
    ["sending", { isSending: true, workdir: "C:/workspace-a" }],
    ["running", { isSending: false, workdir: "C:/workspace-a" }],
  ]);
  const updates = [];
  const sync = (conversationId) =>
    syncMovedConversationRuntimeWorkdir({
      conversationId,
      cwd: "C:/workspace-b",
      runtimeCache,
      isConversationRunning: (id) => id === "running",
      updateConversationRuntimeEntry(id) {
        updates.push(id);
      },
    });

  assert.equal(sync("sending"), false);
  assert.equal(sync("running"), false);
  assert.equal(sync("missing"), false);
  assert.deepEqual(updates, []);
});
