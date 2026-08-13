import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { reconcileSidebarSelection, updateSidebarSelection } = loader.loadModule(
  "@liveagent/ui/lib/sidebar/selection.ts",
);
const { deleteSidebarConversations } = loader.loadModule("@liveagent/ui/lib/sidebar/batchDelete.ts");

const orderedIds = ["one", "two", "three", "four", "five"];
const selectableIds = new Set(["one", "two", "four", "five"]);

test("toggle selection supports non-contiguous Ctrl/Command clicks", () => {
  const first = updateSidebarSelection({
    orderedIds,
    selectableIds,
    selectedIds: new Set(),
    anchorId: null,
    targetId: "one",
    shiftKey: false,
    toggleKey: true,
  });
  const second = updateSidebarSelection({
    orderedIds,
    selectableIds,
    selectedIds: first.selectedIds,
    anchorId: first.anchorId,
    targetId: "five",
    shiftKey: false,
    toggleKey: true,
  });

  assert.deepEqual([...second.selectedIds], ["one", "five"]);
  assert.equal(second.anchorId, "five");
});

test("Shift replaces selection with the anchored range and skips unavailable rows", () => {
  const result = updateSidebarSelection({
    orderedIds,
    selectableIds,
    selectedIds: new Set(["five"]),
    anchorId: "one",
    targetId: "four",
    shiftKey: true,
    toggleKey: false,
  });

  assert.deepEqual([...result.selectedIds], ["one", "two", "four"]);
  assert.equal(result.anchorId, "one");
});

test("Ctrl/Command+Shift adds a reverse range to the existing selection", () => {
  const result = updateSidebarSelection({
    orderedIds,
    selectableIds,
    selectedIds: new Set(["one"]),
    anchorId: "five",
    targetId: "two",
    shiftKey: true,
    toggleKey: true,
  });

  assert.deepEqual([...result.selectedIds], ["one", "two", "four", "five"]);
  assert.equal(result.anchorId, "five");
});

test("a missing range anchor falls back to toggling the target", () => {
  const result = updateSidebarSelection({
    orderedIds,
    selectableIds,
    selectedIds: new Set(),
    anchorId: "missing",
    targetId: "two",
    shiftKey: true,
    toggleKey: false,
  });

  assert.deepEqual([...result.selectedIds], ["two"]);
  assert.equal(result.anchorId, "two");
});

test("reconcile drops removed and newly unavailable selections", () => {
  const result = reconcileSidebarSelection({
    orderedIds: ["one", "two", "four"],
    selectableIds: new Set(["one", "four"]),
    selectedIds: new Set(["one", "two", "five"]),
    anchorId: "five",
  });

  assert.deepEqual([...result.selectedIds], ["one"]);
  assert.equal(result.anchorId, null);
});

test("batch deletion continues after returned and thrown failures", async () => {
  const calls = [];
  const result = await deleteSidebarConversations(["one", "two", "three"], async (id) => {
    calls.push(id);
    if (id === "two") return false;
    if (id === "three") throw new Error("offline");
    return true;
  });

  assert.deepEqual(calls, ["one", "two", "three"]);
  assert.deepEqual(result.deletedIds, ["one"]);
  assert.deepEqual(result.failedIds, ["two", "three"]);
  assert.deepEqual(result.skippedIds, []);
});

test("a stop request halts the batch and reports the rest as skipped", async () => {
  const calls = [];
  let stopRequested = false;
  const result = await deleteSidebarConversations(
    ["one", "two", "three"],
    async (id) => {
      calls.push(id);
      stopRequested = true;
      return true;
    },
    { shouldStop: () => stopRequested },
  );

  assert.deepEqual(calls, ["one"]);
  assert.deepEqual(result.deletedIds, ["one"]);
  assert.deepEqual(result.failedIds, []);
  assert.deepEqual(result.skippedIds, ["two", "three"]);
});

test("conversation rename suppresses the menu's return-focus without changing double-click rename", () => {
  const source = readFileSync(
    new URL("../../../agent-ui/src/components/chat/ChatHistorySidebar.tsx", import.meta.url),
    "utf8",
  );

  // HistoryRow's rename entry arms the one-shot flag. ProjectRow now opens the
  // project-settings flow instead of owning a second inline rename path.
  assert.equal((source.match(/suppressMenuReturnFocusRef\.current = true;/g) ?? []).length, 1);
  assert.equal((source.match(/onSelect=\{handleStartRenamingFromMenu\}/g) ?? []).length, 1);
  assert.equal((source.match(/onSelect=\{\(\) => onConfigureProject\(project\)\}/g) ?? []).length, 1);
  // The conversation dropdown consumes the flag declaratively via Base UI's
  // finalFocus, keeping the default trigger return-focus for every other close.
  assert.equal((source.match(/finalFocus=\{\(\) => \{/g) ?? []).length, 1);
  assert.equal(
    (source.match(/suppressMenuReturnFocusRef\.current = false;\s*return false;/g) ?? []).length,
    1,
  );
  // Double-click rename keeps the plain path, and the retired blur-swallowing
  // guard must not come back — blur either skips once (Enter/Escape) or commits.
  assert.match(source, /onDoubleClick=\{\(event\) => \{[\s\S]*?handleStartRenaming\(\);/);
  assert.doesNotMatch(source, /ignoreMenuCloseBlurRef/);
});
