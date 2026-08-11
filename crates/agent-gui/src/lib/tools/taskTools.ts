import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  type BuiltinToolBundle,
  createBuiltinMetadataMap,
  type TaskItem,
  type TaskListResultDetails,
  type TaskListState,
  type TaskStatus,
} from "./builtinTypes";
import { cloneTaskListState, readNonEmptyString } from "./taskState";

export type TaskStateStore = {
  runId: string;
  getState: () => TaskListState | undefined;
  commitState: (state: TaskListState) => Promise<void>;
};

const TASK_CREATE_DESCRIPTION = `Create one task in the current run's durable task list.

Use TaskCreate for multi-step work, then use TaskUpdate to mark one task in_progress before starting it and completed immediately after finishing it. The executor assigns a stable numeric task ID; never invent or reuse task IDs.`;

const TASK_UPDATE_DESCRIPTION = `Update one existing task by its stable taskId.

Only supplied fields are changed. At most one task may be in_progress. Completed tasks remain in the list for progress reporting. Use TaskList whenever the current authoritative state is unclear.`;

const TASK_LIST_DESCRIPTION = `Return the complete authoritative task list for the current run, including stable task IDs and statuses. Use it after uncertainty or context compaction; do not recreate tasks that are already present.`;

const taskStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
]);

const taskCreateParameters = Type.Object({
  subject: Type.String({ description: "Short imperative task title." }),
  description: Type.String({ description: "Detailed completion criteria for the task." }),
  activeForm: Type.String({ description: "Present-continuous label shown while in progress." }),
});

const taskUpdateParameters = Type.Object({
  taskId: Type.String({ description: "Stable numeric ID returned by TaskCreate or TaskList." }),
  subject: Type.Optional(Type.String({ description: "Replacement short imperative title." })),
  description: Type.Optional(Type.String({ description: "Replacement completion criteria." })),
  activeForm: Type.Optional(
    Type.String({ description: "Replacement present-continuous progress label." }),
  ),
  status: Type.Optional(taskStatusSchema),
});

const taskListParameters = Type.Object({});

function readOptionalString(value: unknown, field: string) {
  return value === undefined ? undefined : readNonEmptyString(value, field);
}

function readOptionalStatus(value: unknown): TaskStatus | undefined {
  if (value === undefined) return undefined;
  if (value !== "pending" && value !== "in_progress" && value !== "completed") {
    throw new Error('status must be "pending", "in_progress", or "completed".');
  }
  return value;
}

function emptyState(runId: string): TaskListState {
  return { runId, revision: 0, nextTaskId: 1, tasks: [] };
}

function currentState(store: TaskStateStore) {
  const state = store.getState();
  return state?.runId === store.runId ? cloneTaskListState(state) : undefined;
}

function resultDetails(
  state: TaskListState,
  action: TaskListResultDetails["action"],
  taskId?: string,
): TaskListResultDetails {
  return {
    kind: "task_list",
    action,
    runId: state.runId,
    revision: state.revision,
    tasks: state.tasks.map((task) => ({ ...task })),
    taskId,
  };
}

function resultText(state: TaskListState, message: string) {
  return `${message}\n${JSON.stringify(state)}`;
}

function toolError(toolCall: ToolCall, message: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: message }],
    details: {},
    isError: true,
    timestamp: Date.now(),
  };
}

export function formatTaskListRuntimeContext(state: TaskListState | undefined) {
  if (!state || state.tasks.length === 0) return "";
  return [
    "## Authoritative Task Runtime State",
    "<task_list>",
    JSON.stringify(state),
    "</task_list>",
    "The JSON above is the authoritative task state for this run. Context compaction does not start a new plan. Do not recreate, renumber, reorder, or replace these tasks. Use TaskCreate, TaskUpdate, and TaskList to modify or inspect them by stable taskId.",
  ].join("\n");
}

export function createTaskTools(store: TaskStateStore): BuiltinToolBundle {
  const tools: Tool[] = [
    { name: "TaskCreate", description: TASK_CREATE_DESCRIPTION, parameters: taskCreateParameters },
    { name: "TaskUpdate", description: TASK_UPDATE_DESCRIPTION, parameters: taskUpdateParameters },
    { name: "TaskList", description: TASK_LIST_DESCRIPTION, parameters: taskListParameters },
  ];
  let queue: Promise<void> = Promise.resolve();

  function runSerialized(operation: () => Promise<ToolResultMessage>) {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function executeToolCall(toolCall: ToolCall, signal?: AbortSignal) {
    return runSerialized(async () => {
      if (signal?.aborted) return toolError(toolCall, "Cancelled");
      const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
      try {
        if (toolCall.name === "TaskCreate") {
          const state = currentState(store) ?? emptyState(store.runId);
          const task: TaskItem = {
            id: String(state.nextTaskId),
            subject: readNonEmptyString(args.subject, "subject"),
            description: readNonEmptyString(args.description, "description"),
            activeForm: readNonEmptyString(args.activeForm, "activeForm"),
            status: "pending",
          };
          const nextState: TaskListState = {
            ...state,
            revision: state.revision + 1,
            nextTaskId: state.nextTaskId + 1,
            tasks: [...state.tasks, task],
          };
          await store.commitState(nextState);
          return {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: resultText(nextState, `Created task ${task.id}.`) }],
            details: resultDetails(nextState, "created", task.id),
            isError: false,
            timestamp: Date.now(),
          };
        }

        if (toolCall.name === "TaskUpdate") {
          const state = currentState(store);
          if (!state) throw new Error("No task list exists for the current run.");
          const taskId = readNonEmptyString(args.taskId, "taskId");
          const taskIndex = state.tasks.findIndex((task) => task.id === taskId);
          if (taskIndex < 0) throw new Error(`Task ${taskId} does not exist.`);
          const subject = readOptionalString(args.subject, "subject");
          const description = readOptionalString(args.description, "description");
          const activeForm = readOptionalString(args.activeForm, "activeForm");
          const status = readOptionalStatus(args.status);
          if (
            subject === undefined &&
            description === undefined &&
            activeForm === undefined &&
            status === undefined
          ) {
            throw new Error("TaskUpdate requires at least one field to update.");
          }
          if (
            status === "in_progress" &&
            state.tasks.some((task) => task.id !== taskId && task.status === "in_progress")
          ) {
            throw new Error("Another task is already in_progress. Complete or pause it first.");
          }
          const existing = state.tasks[taskIndex] as TaskItem;
          const updated: TaskItem = {
            ...existing,
            ...(subject === undefined ? {} : { subject }),
            ...(description === undefined ? {} : { description }),
            ...(activeForm === undefined ? {} : { activeForm }),
            ...(status === undefined ? {} : { status }),
          };
          const tasks = state.tasks.slice();
          tasks[taskIndex] = updated;
          const nextState = { ...state, revision: state.revision + 1, tasks };
          await store.commitState(nextState);
          return {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: resultText(nextState, `Updated task ${taskId}.`) }],
            details: resultDetails(nextState, "updated", taskId),
            isError: false,
            timestamp: Date.now(),
          };
        }

        if (toolCall.name === "TaskList") {
          const state = currentState(store) ?? emptyState(store.runId);
          return {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: resultText(state, "Current task list.") }],
            details: resultDetails(state, "listed"),
            isError: false,
            timestamp: Date.now(),
          };
        }

        return toolError(toolCall, `Unknown tool: ${toolCall.name}`);
      } catch (error) {
        return toolError(
          toolCall,
          error instanceof Error ? error.message : `${toolCall.name} failed.`,
        );
      }
    });
  }

  return {
    groupId: "system",
    tools,
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        "TaskCreate",
        {
          groupId: "system",
          kind: "task_create",
          isReadOnly: false,
          displayCategory: "system",
        },
      ],
      [
        "TaskUpdate",
        {
          groupId: "system",
          kind: "task_update",
          isReadOnly: false,
          displayCategory: "system",
        },
      ],
      [
        "TaskList",
        {
          groupId: "system",
          kind: "task_list",
          isReadOnly: true,
          displayCategory: "system",
        },
      ],
    ]),
  };
}
