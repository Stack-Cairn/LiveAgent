import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const taskProgress = createTsModuleLoader().loadModule("src/lib/chat/taskProgress.ts");
const todo = (content, status, activeForm = content) => ({ content, status, activeForm });
const row = (blocks) => ({ kind: "assistant", rounds: [{ blocks }] });
const userRow = (key) => ({ kind: "user", key });
const block = ({ args, details, id, isError = false, settled = true }) => ({
  kind: "tool",
  item: {
    toolCall: { id, name: "TodoWrite", arguments: args },
    toolResult: settled ? { isError, details } : undefined,
  },
});

test("prefers result details and summarizes progress", () => {
  const todos = [todo("Inspect", "completed"), todo("Implement", "in_progress", "Working")];
  const snapshot = taskProgress.selectLatestTodoProgress([
    row([block({ args: { todos: [todo("stale", "pending")] }, details: { kind: "todo_write", todos } })]),
  ]);
  assert.deepEqual(snapshot.todos, todos);
  assert.deepEqual([snapshot.completedCount, snapshot.totalCount, snapshot.currentStep, snapshot.state], [1, 2, 2, "in_progress"]);
});

test("uses complete streaming arguments", () => {
  const historical = [todo("Previous", "completed")];
  const todos = [todo("Inspect", "completed"), todo("Implement", "pending")];
  assert.deepEqual(
    taskProgress.selectLatestTodoProgress(
      [row([block({ args: { todos: historical }, details: { kind: "todo_write", todos: historical } })])],
      [{ blocks: [block({ args: { todos }, settled: false })] }],
    ).todos,
    todos,
  );
});

test("distinguishes tentative, invalid, and settled TodoWrite frames", () => {
  const oneTodo = [todo("Task 1", "in_progress")];
  const twelveTodos = Array.from({ length: 12 }, (_, index) =>
    todo(`Task ${index + 1}`, index === 0 ? "in_progress" : "pending"),
  );
  const rowsWith = (todoBlock) => [userRow("new-turn"), row([todoBlock])];

  const tentative = taskProgress.selectTodoProgressUpdates(
    rowsWith(block({ id: "todo-live", args: { todos: oneTodo }, settled: false })),
  ).at(-1);
  assert.equal(tentative.settled, false);
  assert.equal(tentative.snapshot.totalCount, 1);

  const invalid = taskProgress.selectTodoProgressUpdates(
    rowsWith(
      block({ id: "todo-live", args: { todos: [{ content: "Partial" }] }, settled: false }),
    ),
  ).at(-1);
  assert.equal(invalid.settled, false);
  assert.equal(invalid.snapshot, undefined);

  const settled = taskProgress.selectTodoProgressUpdates(
    rowsWith(
      block({
        id: "todo-live",
        args: { todos: twelveTodos },
        details: { kind: "todo_write", todos: twelveTodos },
      }),
    ),
  ).at(-1);
  assert.equal(settled.settled, true);
  assert.equal(settled.snapshot.totalCount, 12);
});

test("identifies only TodoWrite tool blocks for transcript filtering", () => {
  assert.equal(taskProgress.isTodoWriteToolBlock(block({ args: { todos: [] }, settled: false })), true);
  assert.equal(
    taskProgress.isTodoWriteToolBlock({
      kind: "tool",
      item: { toolCall: { name: "Read", arguments: { path: "README.md" } } },
    }),
    false,
  );
});

test("GUI adapter projects live rounds without waiting for transcript persistence", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../src/pages/ChatPage.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(source, /liveTranscriptStore\.subscribe/);
  assert.match(source, /selectTodoProgressUpdates\(historyItems, liveRounds\)/);
  assert.match(source, /useSequencedTaskProgress\(updates, isConversationRunning\)/);
  assert.match(source, /key=\{currentConversationId\}/);
  assert.match(source, /<CurrentTaskProgress/);
});

test("keeps real TodoWrite updates ordered and deduplicates live-history overlap by call id", () => {
  const first = [todo("One", "in_progress", "Working one"), todo("Two", "pending")];
  const second = [todo("One", "completed"), todo("Two", "in_progress", "Working two")];
  const updates = taskProgress.selectTodoProgressUpdates(
    [
      row([
        block({
          id: "todo-1",
          args: { todos: first },
          details: { kind: "todo_write", todos: first },
        }),
      ]),
    ],
    [
      {
        blocks: [
          block({
            id: "todo-1",
            args: { todos: first },
            details: { kind: "todo_write", todos: first },
          }),
          block({
            id: "todo-2",
            args: { todos: second },
            details: { kind: "todo_write", todos: second },
          }),
        ],
      },
    ],
  );
  assert.deepEqual(
    updates.map((update) => [update.key, update.snapshot.completedCount]),
    [
      ["todo-1", 0],
      ["todo-2", 1],
    ],
  );
});

test("a submitted user turn hides the old plan until a new TodoWrite starts", () => {
  const oldTodos = [todo("Old task", "completed")];
  const oldBlock = block({
    id: "old-todo",
    args: { todos: oldTodos },
    details: { kind: "todo_write", todos: oldTodos },
  });
  const hiddenUpdates = taskProgress.selectTodoProgressUpdates(
    [row([oldBlock]), userRow("next-message")],
    [{ blocks: [oldBlock] }],
  );

  assert.deepEqual(
    hiddenUpdates.map((update) => [update.key, update.snapshot]),
    [["user-turn:next-message", null]],
  );
  assert.equal(
    taskProgress.selectLatestTodoProgress([row([oldBlock]), userRow("next-message")]),
    null,
  );

  const newTodos = [todo("New task", "in_progress", "Working new task")];
  const resumedUpdates = taskProgress.selectTodoProgressUpdates([
    row([oldBlock]),
    userRow("next-message"),
    row([
      block({
        id: "new-todo",
        args: { todos: newTodos },
        details: { kind: "todo_write", todos: newTodos },
      }),
    ]),
  ]);
  const resumedPlan = taskProgress.foldTodoProgressUpdates(resumedUpdates);
  assert.deepEqual(
    resumedUpdates.map((update) => update.key),
    ["user-turn:next-message", "new-todo"],
  );
  assert.deepEqual(resumedPlan.snapshot.todos, newTodos);
});

test("partial and failed updates preserve the previous snapshot", () => {
  const todos = [todo("Stable", "in_progress", "Working")];
  const snapshot = taskProgress.selectLatestTodoProgress([
    row([block({ args: { todos }, details: { kind: "todo_write", todos } })]),
    row([
      block({ args: { todos: [{ content: "Partial" }] }, settled: false }),
      block({ args: { todos: [todo("Failed", "pending")] }, isError: true }),
    ]),
  ]);
  assert.deepEqual(snapshot.todos, todos);
});

test("invalid settled results do not fall back to arguments", () => {
  const stable = [todo("Stable", "in_progress", "Working")];
  const replacement = [todo("Untrusted", "pending")];
  const snapshot = taskProgress.selectLatestTodoProgress([
    row([block({ args: { todos: stable }, details: { kind: "todo_write", todos: stable } })]),
    row([
      block({
        args: { todos: replacement },
        details: { kind: "unexpected", todos: replacement },
      }),
      block({
        args: { todos: replacement },
        details: { kind: "todo_write", todos: [{ content: "Partial" }] },
      }),
    ]),
  ]);
  assert.deepEqual(snapshot.todos, stable);
});

test("empty clears and invalid snapshots are ignored", () => {
  const active = [todo("Old", "pending")];
  assert.equal(
    taskProgress.selectLatestTodoProgress([
      row([block({ args: { todos: active }, details: { kind: "todo_write", todos: active } })]),
      row([block({ args: { todos: [] }, details: { kind: "todo_write", todos: [] } })]),
    ]),
    null,
  );
  assert.equal(
    taskProgress.readCompleteTodoList([todo("One", "in_progress"), todo("Two", "in_progress")]),
    null,
  );
});

test("locks the confirmed plan roster while later calls merge only task statuses", () => {
  const initialTodos = Array.from({ length: 12 }, (_, index) =>
    todo(`Task ${index + 1}`, index === 0 ? "in_progress" : "pending", `Working ${index + 1}`),
  );
  const initialSnapshot = taskProgress.createTodoProgressSnapshot(initialTodos);
  let plan = taskProgress.applyTodoProgressUpdate(
    { anchorKey: null, snapshot: null },
    { key: "initial-plan", snapshot: initialSnapshot },
  );

  const shorterUpdate = taskProgress.createTodoProgressSnapshot(
    initialTodos.slice(0, 5).map((item) => ({ ...item, status: "completed" })),
  );
  plan = taskProgress.applyTodoProgressUpdate(plan, {
    key: "status-update-1",
    snapshot: shorterUpdate,
  });

  assert.equal(plan.snapshot.totalCount, 12);
  assert.equal(plan.snapshot.completedCount, 5);
  assert.deepEqual(
    plan.snapshot.todos.map((item) => item.content),
    initialTodos.map((item) => item.content),
  );

  const rewrittenFullUpdate = taskProgress.createTodoProgressSnapshot(
    initialTodos.map((item, index) =>
      todo(
        `Rewritten ${index + 1}`,
        index < 5 ? "completed" : index === 5 ? "in_progress" : "pending",
      ),
    ),
  );
  plan = taskProgress.applyTodoProgressUpdate(plan, {
    key: "status-update-2",
    snapshot: rewrittenFullUpdate,
  });

  assert.equal(plan.snapshot.totalCount, 12);
  assert.equal(plan.snapshot.currentStep, 6);
  assert.equal(plan.snapshot.todos[5].status, "in_progress");
  assert.deepEqual(
    plan.snapshot.todos.map((item) => item.content),
    initialTodos.map((item) => item.content),
  );
});

test("allows the anchor call to finish its roster, then uses empty as the next plan boundary", () => {
  const provisional = taskProgress.createTodoProgressSnapshot([
    todo("One", "in_progress"),
    todo("Two", "pending"),
  ]);
  const confirmed = taskProgress.createTodoProgressSnapshot([
    todo("One", "in_progress"),
    todo("Two", "pending"),
    todo("Three", "pending"),
  ]);
  const nextPlan = taskProgress.createTodoProgressSnapshot([todo("Fresh", "pending")]);
  const plan = taskProgress.foldTodoProgressUpdates([
    { key: "initial-plan", snapshot: provisional },
    { key: "initial-plan", snapshot: confirmed },
    { key: "clear", snapshot: null },
    { key: "next-plan", snapshot: nextPlan },
  ]);

  assert.equal(plan.anchorKey, "next-plan");
  assert.deepEqual(plan.snapshot.todos, nextPlan.todos);
});

test("completed lists report the final step", () => {
  const snapshot = taskProgress.createTodoProgressSnapshot([
    todo("One", "completed"),
    todo("Two", "completed"),
  ]);
  assert.deepEqual([snapshot.completedCount, snapshot.currentStep, snapshot.state], [2, 2, "completed"]);
});
