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

test("selectRoundsTaskProgress is tri-state: absent / explicit clear / snapshot", () => {
  assert.equal(taskProgress.selectRoundsTaskProgress([{ blocks: [] }]), undefined);
  assert.equal(
    taskProgress.selectRoundsTaskProgress([
      { blocks: [block({ name: "TaskList", tasks: [], revision: 0 })] },
    ]),
    null,
  );
  const snapshot = taskProgress.selectRoundsTaskProgress([
    { blocks: [block({ tasks: [task("1", "Active", "pending")] })] },
  ]);
  assert.equal(snapshot?.totalCount, 1);
});

test("an explicit clear in the live tail overrides a history baseline", () => {
  // 中途压缩把带任务的前半段回合提交进历史后，live 里的空 TaskList 必须清空
  // 指示器，而不是回退到历史里的旧列表。
  assert.equal(
    taskProgress.selectLatestTaskProgress(
      [row([block({ tasks: [task("1", "Active", "pending")] })])],
      [{ blocks: [block({ name: "TaskList", tasks: [], revision: 0 })] }],
    ),
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
  // 历史基线与 live 尾部分开记忆（性能：避免每帧全量扫历史），但仍直接
  // 投影 canonical live 结果，无时序兼容层。
  assert.match(source, /selectLatestTaskProgress\(historyItems\)/);
  assert.match(source, /selectRoundsTaskProgress\(liveRounds\)/);
  // live 的三态：undefined 才回退基线；null（明确清空）必须覆盖基线。
  assert.match(source, /liveSnapshot === undefined \? historyBaseline : liveSnapshot/);
  assert.match(source, /key=\{snapshot\.conversationId\}/);
});


const todowriteArgs = (todos) => ({ todos });
const todowriteResult = (details, extra = {}) => ({ details, ...extra });
const todowriteBlock = (name, callArgs, details, extra = {}) => ({
  kind: "tool",
  item: {
    toolCall: { id: "call-1", name, arguments: callArgs },
    toolResult: { details, ...extra },
  },
});

function todowriteDetails(runId, revision, todos) {
  return taskProgress.taskResultDetails(
    "todowrite",
    todowriteArgs(todos),
    todowriteResult(undefined),
    runId,
    revision,
  );
}

test("adapts the real K-brain todowrite payload and preserves ids/statuses", () => {
  const details = todowriteDetails("run-1", 4, [
    { id: "build", content: "Build the UI", status: "in_progress" },
    { content: "Verify the result", status: "pending" },
  ]);
  assert.deepEqual(details.tasks, [
    { id: "build", subject: "Build the UI", description: "Build the UI", activeForm: "Build the UI", status: "in_progress" },
    { id: "t2", subject: "Verify the result", description: "Verify the result", activeForm: "Verify the result", status: "pending" },
  ]);
  const selected = taskProgress.selectRoundsTaskProgress([{
    blocks: [todowriteBlock("todowrite", todowriteArgs([{ id: "build", content: "Build the UI", status: "in_progress" }]), details)],
  }]);
  assert.equal(selected.runId, "run-1");
  assert.equal(selected.state, "in_progress");
});

test("empty todowrite clears the capsule while failed/cancelled/malformed results do not", () => {
  const valid = todowriteDetails("run-1", 1, [{ id: "a", content: "Keep this", status: "in_progress" }]);
  const empty = todowriteDetails("run-1", 2, []);
  const rounds = [{ blocks: [todowriteBlock("todowrite", todowriteArgs([{ id: "a", content: "Keep this", status: "in_progress" }]), valid)] }];
  assert.deepEqual(taskProgress.selectRoundsTaskProgress(rounds), taskProgress.createTaskProgressSnapshot("run-1", 1, valid.tasks));
  assert.equal(taskProgress.selectRoundsTaskProgress([{ blocks: [todowriteBlock("todowrite", todowriteArgs([]), empty)] }]), null);
  assert.equal(taskProgress.taskResultDetails("todowrite", todowriteArgs([]), todowriteResult(undefined, { isError: true }), "run-1", 3), undefined);
  assert.equal(taskProgress.taskResultDetails("todowrite", todowriteArgs([{ content: "", status: "pending" }]), todowriteResult(undefined), "run-1", 3), undefined);
});

test("a new user turn clears the previous task snapshot and replay keeps the latest valid update", () => {
  const first = todowriteDetails("run-1", 1, [{ id: "a", content: "First", status: "in_progress" }]);
  const second = todowriteDetails("run-2", 1, [{ id: "b", content: "Second", status: "completed" }]);
  const rows = [
    { kind: "assistant", rounds: [{ blocks: [todowriteBlock("todowrite", todowriteArgs([{ id: "a", content: "First", status: "in_progress" }]), first)] }] },
    { kind: "user", content: "next" },
    { kind: "assistant", rounds: [{ blocks: [todowriteBlock("todowrite", todowriteArgs([{ id: "b", content: "Second", status: "completed" }]), second)] }] },
  ];
  assert.equal(taskProgress.selectLatestTaskProgress(rows).runId, "run-2");
  assert.equal(taskProgress.selectLatestTaskProgress(rows).state, "completed");
});
