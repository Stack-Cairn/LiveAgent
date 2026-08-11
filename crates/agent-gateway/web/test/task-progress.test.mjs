import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const taskProgress = createWebModuleLoader({ rootDir }).loadModule(
  "@liveagent/ui/lib/chat/taskProgress.ts",
);
const task = (id, subject, status, activeForm = subject) => ({
  id,
  subject,
  description: `${subject} completion criteria`,
  activeForm,
  status,
});
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
const assistantRow = (blocks) => ({ kind: "assistant", rounds: [{ blocks }] });

test("WebUI mirrors the latest successful canonical task snapshot", () => {
  const tasks = [
    task("1", "Inspect", "completed", "Inspecting"),
    task("2", "Implement", "in_progress", "Implementing"),
  ];
  const snapshot = taskProgress.selectLatestTaskProgress([
    assistantRow([block({ name: "TaskCreate", tasks: tasks.slice(0, 1) })]),
    assistantRow([block({ tasks, revision: 2 })]),
  ]);

  assert.deepEqual(snapshot.tasks, tasks);
  assert.deepEqual(
    [snapshot.runId, snapshot.revision, snapshot.completedCount, snapshot.currentStep, snapshot.state],
    ["run-1", 2, 1, 2, "in_progress"],
  );
});

test("WebUI ignores provisional, failed, and malformed task data", () => {
  const stable = [task("1", "Stable", "in_progress", "Working")];
  const snapshot = taskProgress.selectLatestTaskProgress([
    assistantRow([block({ tasks: stable })]),
    assistantRow([
      block({ id: "partial", settled: false, tasks: [task("2", "Partial", "pending")] }),
      block({ id: "failed", isError: true, tasks: [task("2", "Failed", "pending")] }),
      block({ id: "wrong", kind: "other", tasks: [task("2", "Wrong", "pending")] }),
    ]),
  ]);
  assert.deepEqual(snapshot.tasks, stable);
});

test("WebUI clears the previous run at a user boundary", () => {
  const oldTasks = [task("1", "Old", "completed")];
  assert.equal(
    taskProgress.selectLatestTaskProgress([
      assistantRow([block({ tasks: oldTasks })]),
      { kind: "user", key: "new-run" },
    ]),
    null,
  );
});

test("WebUI hides all task tool blocks while preserving ordinary tools", () => {
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
  const source = readFileSync(
    fileURLToPath(
      new URL(
        "../../../agent-ui/src/components/chat/assistant-bubble/RoundContent.tsx",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  assert.match(source, /groupedBlocks\.filter\(\(block\) => !isTaskToolBlock\(block\)\)/);
});

test("WebUI app selects a snapshot directly without a sequencing compatibility layer", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/app/GatewayApp.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(source, /selectLatestTaskProgress\(transcriptRows\)/);
  assert.match(source, /key=\{displayedConversationId\}/);
});
