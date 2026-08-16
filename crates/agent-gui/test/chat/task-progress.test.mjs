import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const taskProgress = createTsModuleLoader().loadModule("@liveagent/ui/lib/chat/taskProgress.ts");
const task = (id, subject, status, activeForm = subject) => ({
  id,
  subject,
  description: `${subject} completion criteria`,
  activeForm,
  status,
});
const row = (blocks) => ({ kind: "assistant", rounds: [{ blocks }] });
const userRow = (key) => ({ kind: "user", key });
const block = ({
  id = "task-call",
  name = "TaskUpdate",
  tasks = [],
  runId = "run-1",
  revision = 1,
  settled = true,
  isError = false,
  kind = "task_list",
}) => ({
  kind: "tool",
  item: {
    toolCall: { id, name, arguments: { taskId: "1", status: "completed" } },
    toolResult: settled
      ? { isError, details: { kind, action: "updated", runId, revision, tasks } }
      : undefined,
  },
});

test("projects only the latest successful canonical task snapshot", () => {
  const first = [task("1", "Inspect", "in_progress", "Inspecting")];
  const second = [
    task("1", "Inspect", "completed", "Inspecting"),
    task("2", "Implement", "in_progress", "Implementing"),
  ];
  const snapshot = taskProgress.selectLatestTaskProgress(
    [row([block({ id: "create", name: "TaskCreate", tasks: first })])],
    [
      {
        blocks: [
          block({ id: "create", name: "TaskCreate", tasks: first }),
          block({ id: "update", tasks: second, revision: 2 }),
        ],
      },
    ],
  );

  assert.deepEqual(snapshot.tasks, second);
  assert.deepEqual(
    [snapshot.runId, snapshot.revision, snapshot.completedCount, snapshot.currentStep, snapshot.state],
    ["run-1", 2, 1, 2, "in_progress"],
  );
});

test("ignores streaming arguments, failed results, and malformed snapshots", () => {
  const stable = [task("1", "Stable", "in_progress", "Working")];
  const snapshot = taskProgress.selectLatestTaskProgress([
    row([block({ tasks: stable })]),
    row([
      block({ id: "streaming", tasks: [task("2", "Untrusted", "pending")], settled: false }),
      block({ id: "failed", tasks: [task("2", "Failed", "pending")], isError: true }),
      block({ id: "wrong-kind", tasks: [task("2", "Wrong", "pending")], kind: "other" }),
      block({
        id: "malformed",
        tasks: [{ id: "2", subject: "Partial", status: "pending" }],
      }),
    ]),
  ]);

  assert.deepEqual(snapshot.tasks, stable);
});

test("a new user run clears old progress until a new canonical snapshot arrives", () => {
  const oldTasks = [task("1", "Old", "completed")];
  const newTasks = [task("1", "New", "pending")];
  assert.equal(
    taskProgress.selectLatestTaskProgress([row([block({ tasks: oldTasks })]), userRow("next")]),
    null,
  );
  assert.deepEqual(
    taskProgress.selectLatestTaskProgress([
      row([block({ tasks: oldTasks })]),
      userRow("next"),
      row([block({ name: "TaskCreate", runId: "run-2", tasks: newTasks })]),
    ]).tasks,
    newTasks,
  );
});

test("an empty successful TaskList clears the progress indicator", () => {
  assert.equal(
    taskProgress.selectLatestTaskProgress([
      row([block({ tasks: [task("1", "Active", "pending")] })]),
      row([block({ name: "TaskList", tasks: [], revision: 0 })]),
    ]),
    null,
  );
});

test("all task tools are standalone transcript-hidden blocks", () => {
  for (const name of ["TaskCreate", "TaskUpdate", "TaskList"]) {
    assert.equal(taskProgress.isTaskToolBlock(block({ name, settled: false })), true);
  }
  assert.equal(
    taskProgress.isTaskToolBlock({
      kind: "tool",
      item: { toolCall: { name: "Read", arguments: { path: "README.md" } } },
    }),
    false,
  );
});

test("GUI projects canonical live results without a sequencing compatibility layer", () => {
  const source = [
    "../../src/pages/ChatPage.tsx",
    "../../src/pages/chat/components/CurrentTaskProgress.tsx",
    "../../src/pages/chat/surfaces/ConversationPaneHost.tsx",
  ]
    .map((relativePath) =>
      readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8"),
    )
    .join("\n");
  assert.match(source, /liveTranscriptStore\.subscribe/);
  assert.match(source, /selectLatestTaskProgress\(historyItems, liveRounds\)/);
  assert.match(source, /key=\{snapshot\.conversationId\}/);
});
