import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const taskProgress = createWebModuleLoader({ rootDir }).loadModule("@liveagent/ui/lib/chat/taskProgress.ts");
const todo = (content, status, activeForm = content) => ({ content, status, activeForm });
const block = ({
  todos,
  id,
  settled = true,
  isError = false,
  resultKind = "todo_write",
  resultTodos = todos,
}) => ({
  kind: "tool",
  item: {
    toolCall: { id, name: "TodoWrite", arguments: { todos } },
    toolResult: settled
      ? { isError, details: { kind: resultKind, todos: resultTodos } }
      : undefined,
  },
});

test("web projection prefers successful result details and summarizes progress", () => {
  const resultTodos = [
    todo("Inspect", "completed"),
    todo("Implement", "in_progress", "Working"),
  ];
  const rows = [
    {
      kind: "assistant",
      rounds: [
        {
          blocks: [block({ todos: [todo("Stale", "pending")], resultTodos })],
        },
      ],
    },
  ];
  const snapshot = taskProgress.selectLatestTodoProgress(rows);
  assert.deepEqual(snapshot.todos, resultTodos);
  assert.deepEqual(
    [snapshot.completedCount, snapshot.totalCount, snapshot.currentStep, snapshot.state],
    [1, 2, 2, "in_progress"],
  );
});

test("web projection mirrors streaming, failure, and clear semantics", () => {
  const live = [todo("Live", "in_progress", "Working live")];
  const stable = [todo("Inspect", "completed"), todo("Implement", "in_progress", "Working")];
  const rows = [
    { kind: "assistant", rounds: [{ blocks: [block({ todos: stable })] }] },
    {
      kind: "assistant",
      rounds: [{ blocks: [block({ todos: [{ content: "Partial" }], settled: false }), block({ todos: [todo("Failed", "pending")], isError: true })] }],
    },
  ];
  assert.deepEqual(taskProgress.selectLatestTodoProgress(rows).todos, stable);
  assert.deepEqual(
    taskProgress.selectLatestTodoProgress(rows, [{ blocks: [block({ todos: live, settled: false })] }]).todos,
    live,
  );
  rows.push({ kind: "assistant", rounds: [{ blocks: [block({ todos: [] })] }] });
  assert.equal(taskProgress.selectLatestTodoProgress(rows), null);
});

test("web projection distinguishes tentative, invalid, and settled TodoWrite frames", () => {
  const boundary = { kind: "user", key: "new-turn" };
  const oneTodo = [todo("Task 1", "in_progress")];
  const twelveTodos = Array.from({ length: 12 }, (_, index) =>
    todo(`Task ${index + 1}`, index === 0 ? "in_progress" : "pending"),
  );
  const rowsWith = (todoBlock) => [
    boundary,
    { kind: "assistant", rounds: [{ blocks: [todoBlock] }] },
  ];

  const tentative = taskProgress.selectTodoProgressUpdates(
    rowsWith(block({ id: "todo-live", todos: oneTodo, settled: false })),
  ).at(-1);
  assert.equal(tentative.settled, false);
  assert.equal(tentative.snapshot.totalCount, 1);

  const invalid = taskProgress.selectTodoProgressUpdates(
    rowsWith(block({ id: "todo-live", todos: [{ content: "Partial" }], settled: false })),
  ).at(-1);
  assert.equal(invalid.settled, false);
  assert.equal(invalid.snapshot, undefined);

  const settled = taskProgress.selectTodoProgressUpdates(
    rowsWith(block({ id: "todo-live", todos: twelveTodos })),
  ).at(-1);
  assert.equal(settled.settled, true);
  assert.equal(settled.snapshot.totalCount, 12);
});

test("web transcript hides TodoWrite blocks while preserving ordinary tools", () => {
  assert.equal(taskProgress.isTodoWriteToolBlock(block({ todos: [], settled: false })), true);
  assert.equal(
    taskProgress.isTodoWriteToolBlock({
      kind: "tool",
      item: { toolCall: { name: "Read", arguments: { path: "README.md" } } },
    }),
    false,
  );
  const source = readFileSync(
    fileURLToPath(new URL("../src/pages/chat/assistant-bubble/RoundContent.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(source, /groupedBlocks\.filter\(\(block\) => !isTodoWriteToolBlock\(block\)\)/);
  assert.doesNotMatch(source, /latestTodoItem/);
  const appSource = readFileSync(
    fileURLToPath(new URL("../src/app/GatewayApp.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(appSource, /selectTodoProgressUpdates\(transcriptRows\)/);
  assert.match(appSource, /useSequencedTaskProgress\(updates, isConversationRunning\)/);
  assert.match(appSource, /key=\{displayedConversationId\}/);
});

test("web projection keeps real TodoWrite updates ordered across live-history overlap", () => {
  const first = [todo("One", "in_progress", "Working one"), todo("Two", "pending")];
  const second = [todo("One", "completed"), todo("Two", "in_progress", "Working two")];
  const updates = taskProgress.selectTodoProgressUpdates(
    [
      {
        kind: "assistant",
        rounds: [{ blocks: [block({ id: "todo-1", todos: first })] }],
      },
    ],
    [
      {
        blocks: [
          block({ id: "todo-1", todos: first }),
          block({ id: "todo-2", todos: second }),
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

test("web projection hides the old plan on a submitted user turn until a new TodoWrite", () => {
  const oldTodos = [todo("Old task", "completed")];
  const oldBlock = block({ id: "old-todo", todos: oldTodos });
  const hiddenUpdates = taskProgress.selectTodoProgressUpdates(
    [
      { kind: "assistant", rounds: [{ blocks: [oldBlock] }] },
      { kind: "user", key: "next-message" },
    ],
    [{ blocks: [oldBlock] }],
  );

  assert.deepEqual(
    hiddenUpdates.map((update) => [update.key, update.snapshot]),
    [["user-turn:next-message", null]],
  );
  assert.equal(
    taskProgress.selectLatestTodoProgress([
      { kind: "assistant", rounds: [{ blocks: [oldBlock] }] },
      { kind: "user", key: "next-message" },
    ]),
    null,
  );

  const newTodos = [todo("New task", "in_progress", "Working new task")];
  const resumedUpdates = taskProgress.selectTodoProgressUpdates([
    { kind: "assistant", rounds: [{ blocks: [oldBlock] }] },
    { kind: "user", key: "next-message" },
    {
      kind: "assistant",
      rounds: [{ blocks: [block({ id: "new-todo", todos: newTodos })] }],
    },
  ]);
  const resumedPlan = taskProgress.foldTodoProgressUpdates(resumedUpdates);
  assert.deepEqual(
    resumedUpdates.map((update) => update.key),
    ["user-turn:next-message", "new-todo"],
  );
  assert.deepEqual(resumedPlan.snapshot.todos, newTodos);
});

test("web projection ignores invalid settled results instead of falling back to arguments", () => {
  const stable = [todo("Stable", "in_progress", "Working")];
  const replacement = [todo("Untrusted", "pending")];
  const rows = [
    { kind: "assistant", rounds: [{ blocks: [block({ todos: stable })] }] },
    {
      kind: "assistant",
      rounds: [
        {
          blocks: [
            block({ todos: replacement, resultKind: "unexpected" }),
            block({ todos: replacement, resultTodos: [{ content: "Partial" }] }),
          ],
        },
      ],
    },
  ];
  assert.deepEqual(taskProgress.selectLatestTodoProgress(rows).todos, stable);
});

test("web projection locks the confirmed plan roster while later calls merge only task statuses", () => {
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

test("web projection lets the anchor finish its roster, then empty starts the next plan", () => {
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

test("web projection rejects duplicate running items and reports the completed final step", () => {
  assert.equal(
    taskProgress.readCompleteTodoList([
      todo("One", "in_progress"),
      todo("Two", "in_progress"),
    ]),
    null,
  );
  const snapshot = taskProgress.createTodoProgressSnapshot([
    todo("One", "completed"),
    todo("Two", "completed"),
  ]);
  assert.deepEqual([snapshot.completedCount, snapshot.currentStep, snapshot.state], [2, 2, "completed"]);
});
