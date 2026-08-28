import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  readStoredWorkbenchLayout,
  writeStoredWorkbenchLayout,
  WORKBENCH_LAYOUT_MAX_BYTES,
} = loader.loadModule("@liveagent/ui/lib/workbench/layoutStorage.ts");

function memoryStorage() {
  const entries = new Map();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
}

function layout() {
  return {
    schemaVersion: 1,
    revision: 4,
    root: { type: "leaf", paneId: "terminal-pane" },
    panes: {
      "terminal-pane": {
        paneId: "terminal-pane",
        surface: {
          kind: "localTerminal",
          surfaceId: "terminal-surface",
          project: { projectId: "project", projectPathKey: "/workspace" },
          launchSpec: { cwd: "/workspace", shell: "zsh", title: "Build" },
        },
        view: {},
      },
    },
    focusedPaneId: "terminal-pane",
  };
}

test("workbench layout recovery preserves topology and launch specs but no session id", () => {
  const storage = memoryStorage();
  const input = layout();
  assert.equal(writeStoredWorkbenchLayout(input, storage, "layout"), true);
  const restored = readStoredWorkbenchLayout(storage, "layout");
  assert.deepEqual(restored, input);
  assert.equal(JSON.stringify(restored).includes("sessionId"), false);
});

test("workbench layout recovery rejects corrupt, invalid, and oversized payloads", () => {
  const storage = memoryStorage();
  storage.setItem("layout", "{broken");
  assert.equal(readStoredWorkbenchLayout(storage, "layout"), null);

  storage.setItem("layout", JSON.stringify({ ...layout(), focusedPaneId: "missing" }));
  assert.equal(readStoredWorkbenchLayout(storage, "layout"), null);

  storage.setItem("layout", "x".repeat(WORKBENCH_LAYOUT_MAX_BYTES + 1));
  assert.equal(readStoredWorkbenchLayout(storage, "layout"), null);
});
