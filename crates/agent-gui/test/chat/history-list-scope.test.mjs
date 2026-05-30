import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const historyListScope = loader.loadModule("src/pages/chat/historyListScope.ts");

function summary(id, cwd, updatedAt = 1) {
  return {
    id,
    title: id,
    providerId: "codex",
    model: "gpt-5",
    cwd,
    createdAt: updatedAt,
    updatedAt,
  };
}

test("history list scope drops conversations from other projects", () => {
  const items = [
    summary("project-a-run", "/tmp/project-a", 30),
    summary("project-b-run", "/tmp/project-b", 40),
    summary("chat-mode", undefined, 50),
  ];

  const scoped = historyListScope.filterHistoryItemsForScope(items, {
    cwd: "/tmp/project-a",
  });

  assert.deepEqual(scoped.map((item) => item.id), ["project-a-run"]);
});

test("silent history refresh cannot retain a contaminated cross-project row", () => {
  const contaminatedCurrent = [
    summary("project-b-running", "/tmp/project-b", 40),
    summary("project-a-old", "/tmp/project-a", 10),
  ];
  const nextPage = [summary("project-a-new", "/tmp/project-a", 60)];

  const merged = historyListScope.mergeScopedHistoryPage(
    contaminatedCurrent,
    nextPage,
    { cwd: "/tmp/project-a" },
  );

  assert.deepEqual(
    merged.map((item) => item.id),
    ["project-a-new", "project-a-old"],
  );
});

test("empty cwd scope only keeps chat-mode conversations", () => {
  const scoped = historyListScope.filterHistoryItemsForScope(
    [summary("project-a", "/tmp/project-a"), summary("chat-mode", undefined)],
    { cwdEmpty: true },
  );

  assert.deepEqual(scoped.map((item) => item.id), ["chat-mode"]);
});
