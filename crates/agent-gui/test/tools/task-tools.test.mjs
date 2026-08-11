import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as typebox from "typebox";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function toolCall(name, argumentsValue = {}, id = `call-${name}`) {
  return { type: "toolCall", id, name, arguments: argumentsValue };
}

function createStore(overrides = {}) {
  let state;
  const commits = [];
  return {
    store: {
      runId: "run-stable",
      getState: () => state,
      commitState: async (nextState) => {
        await overrides.beforeCommit?.(nextState);
        state = nextState;
        commits.push(nextState);
      },
    },
    getState: () => state,
    commits,
  };
}

function loadTaskTools(options = {}) {
  return createTsModuleLoader({ mocks: { typebox }, ...options }).loadModule(
    "src/lib/tools/taskTools.ts",
  );
}

const createArgs = (subject) => ({
  subject,
  description: `${subject} completion criteria`,
  activeForm: `${subject} in progress`,
});

test("TaskCreate schema requires the complete task description", () => {
  const { createTaskTools } = loadTaskTools();
  const { store } = createStore();
  const createTool = createTaskTools(store).tools.find((tool) => tool.name === "TaskCreate");
  assert.ok(createTool);
  assert.deepEqual(
    validateToolArguments(createTool, toolCall("TaskCreate", createArgs("Inspect"))),
    createArgs("Inspect"),
  );
  assert.throws(() =>
    validateToolArguments(
      createTool,
      toolCall("TaskCreate", { subject: "Inspect", description: "Inspect files" }),
    ),
  );
});

test("TaskCreate allocates stable monotonic IDs and revisions", async () => {
  const { createTaskTools } = loadTaskTools();
  const harness = createStore();
  const bundle = createTaskTools(harness.store);

  const first = await bundle.executeToolCall(toolCall("TaskCreate", createArgs("Inspect"), "c1"));
  const second = await bundle.executeToolCall(
    toolCall("TaskCreate", createArgs("Implement"), "c2"),
  );

  assert.equal(first.isError, false);
  assert.equal(second.isError, false);
  assert.deepEqual(
    harness.getState().tasks.map((task) => task.id),
    ["1", "2"],
  );
  assert.equal(harness.getState().revision, 2);
  assert.equal(harness.getState().nextTaskId, 3);
  assert.deepEqual(second.details.tasks, harness.getState().tasks);
});

test("parallel TaskCreate calls are serialized before allocating IDs", async () => {
  const { createTaskTools } = loadTaskTools();
  const harness = createStore({ beforeCommit: () => new Promise((resolve) => setImmediate(resolve)) });
  const bundle = createTaskTools(harness.store);

  const results = await Promise.all([
    bundle.executeToolCall(toolCall("TaskCreate", createArgs("One"), "parallel-1")),
    bundle.executeToolCall(toolCall("TaskCreate", createArgs("Two"), "parallel-2")),
    bundle.executeToolCall(toolCall("TaskCreate", createArgs("Three"), "parallel-3")),
  ]);

  assert.ok(results.every((result) => result.isError === false));
  assert.deepEqual(
    harness.getState().tasks.map((task) => task.id),
    ["1", "2", "3"],
  );
  assert.deepEqual(
    harness.commits.map((state) => state.revision),
    [1, 2, 3],
  );
});

test("TaskUpdate changes one stable task and enforces one in_progress task", async () => {
  const { createTaskTools } = loadTaskTools();
  const harness = createStore();
  const bundle = createTaskTools(harness.store);
  await bundle.executeToolCall(toolCall("TaskCreate", createArgs("One"), "create-1"));
  await bundle.executeToolCall(toolCall("TaskCreate", createArgs("Two"), "create-2"));

  const started = await bundle.executeToolCall(
    toolCall("TaskUpdate", { taskId: "1", status: "in_progress" }, "start-1"),
  );
  const rejected = await bundle.executeToolCall(
    toolCall("TaskUpdate", { taskId: "2", status: "in_progress" }, "start-2"),
  );
  const completed = await bundle.executeToolCall(
    toolCall("TaskUpdate", { taskId: "1", status: "completed" }, "complete-1"),
  );

  assert.equal(started.isError, false);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /already in_progress/);
  assert.equal(completed.isError, false);
  assert.deepEqual(
    harness.getState().tasks.map(({ id, status }) => ({ id, status })),
    [
      { id: "1", status: "completed" },
      { id: "2", status: "pending" },
    ],
  );
});

test("TaskList returns a complete canonical snapshot without mutating revision", async () => {
  const { createTaskTools } = loadTaskTools();
  const harness = createStore();
  const bundle = createTaskTools(harness.store);
  await bundle.executeToolCall(toolCall("TaskCreate", createArgs("Inspect"), "create"));

  const listed = await bundle.executeToolCall(toolCall("TaskList", {}, "list"));

  assert.equal(listed.isError, false);
  assert.equal(listed.details.kind, "task_list");
  assert.equal(listed.details.action, "listed");
  assert.equal(listed.details.runId, "run-stable");
  assert.equal(listed.details.revision, 1);
  assert.deepEqual(listed.details.tasks, harness.getState().tasks);
  assert.equal(harness.commits.length, 1);
});

test("a failed durable commit is reported as an error and never advances state", async () => {
  const { createTaskTools } = loadTaskTools();
  const harness = createStore({
    beforeCommit: async () => {
      throw new Error("database unavailable");
    },
  });
  const result = await createTaskTools(harness.store).executeToolCall(
    toolCall("TaskCreate", createArgs("Inspect")),
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /database unavailable/);
  assert.equal(harness.getState(), undefined);
  assert.equal(harness.commits.length, 0);
});

test("runtime context serializes the authoritative run, revision, IDs, and task text", () => {
  const { formatTaskListRuntimeContext } = loadTaskTools();
  const state = {
    runId: 'run-<stable>"',
    revision: 7,
    nextTaskId: 3,
    tasks: [
      {
        id: "1",
        subject: "Inspect <state>",
        description: "Keep the same task after compaction",
        activeForm: "Inspecting state",
        status: "in_progress",
      },
    ],
  };
  const prompt = formatTaskListRuntimeContext(state);

  assert.match(prompt, /Authoritative Task Runtime State/);
  assert.match(prompt, /"runId":"run-<stable>\\""/);
  assert.match(prompt, /"revision":7/);
  assert.match(prompt, /"id":"1"/);
  assert.match(prompt, /Do not recreate, renumber, reorder, or replace/);
  assert.equal(formatTaskListRuntimeContext(undefined), "");
});

test("stored task state parser rejects duplicate IDs and multiple active tasks", () => {
  const { parseTaskListState } = createTsModuleLoader().loadModule(
    "src/lib/tools/taskState.ts",
  );
  const task = {
    id: "1",
    subject: "Inspect",
    description: "Inspect files",
    activeForm: "Inspecting",
    status: "in_progress",
  };
  assert.throws(() =>
    parseTaskListState({ runId: "run", revision: 1, nextTaskId: 2, tasks: [task, task] }),
  );
  assert.throws(() =>
    parseTaskListState({
      runId: "run",
      revision: 2,
      nextTaskId: 3,
      tasks: [task, { ...task, id: "2" }],
    }),
  );
});

test("conversation state preserves tasks across appends and clears them only for a new run", () => {
  const conversationState = createTsModuleLoader().loadModule(
    "src/lib/chat/conversation/conversationState.ts",
  );
  const taskList = {
    runId: "run-current",
    revision: 1,
    nextTaskId: 2,
    tasks: [
      {
        id: "1",
        subject: "Inspect",
        description: "Inspect files",
        activeForm: "Inspecting files",
        status: "in_progress",
      },
    ],
  };
  const initial = conversationState.setTaskListState(
    conversationState.createConversationStateFromContext({ systemPrompt: "sys", messages: [] }),
    taskList,
  );
  const appended = conversationState.appendMessagesToConversation(initial, [
    { role: "user", id: "resume", content: "continue", timestamp: 1 },
  ]);

  assert.deepEqual(appended.meta.taskList, taskList);
  assert.equal(conversationState.clearTaskListState(appended).meta.taskList, undefined);
});
