import type { TaskItem, TaskListState, TaskStatus } from "./builtinTypes";

const TASK_STATUSES = new Set<TaskStatus>(["pending", "in_progress", "completed"]);

export function readNonEmptyString(value: unknown, path: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function readPositiveInteger(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${path} must be a positive integer.`);
  }
  return value as number;
}

function readNonNegativeInteger(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative integer.`);
  }
  return value as number;
}

function parseTaskItem(value: unknown, index: number): TaskItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`taskList.tasks[${index}] must be an object.`);
  }
  const item = value as Record<string, unknown>;
  const status = item.status;
  if (typeof status !== "string" || !TASK_STATUSES.has(status as TaskStatus)) {
    throw new Error(`taskList.tasks[${index}].status is invalid.`);
  }
  return {
    id: readNonEmptyString(item.id, `taskList.tasks[${index}].id`),
    subject: readNonEmptyString(item.subject, `taskList.tasks[${index}].subject`),
    description: readNonEmptyString(item.description, `taskList.tasks[${index}].description`),
    activeForm: readNonEmptyString(item.activeForm, `taskList.tasks[${index}].activeForm`),
    status: status as TaskStatus,
  };
}

export function parseTaskListState(value: unknown): TaskListState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("taskList must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.tasks)) {
    throw new Error("taskList.tasks must be an array.");
  }
  const tasks = candidate.tasks.map(parseTaskItem);
  const ids = new Set<string>();
  let inProgressCount = 0;
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`taskList contains duplicate task id ${task.id}.`);
    ids.add(task.id);
    if (task.status === "in_progress") inProgressCount += 1;
  }
  if (inProgressCount > 1) {
    throw new Error("taskList may contain at most one in_progress task.");
  }
  const nextTaskId = readPositiveInteger(candidate.nextTaskId, "taskList.nextTaskId");
  for (const id of ids) {
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId) || numericId < 1 || numericId >= nextTaskId) {
      throw new Error(`taskList task id ${id} is outside the allocated id range.`);
    }
  }
  return {
    runId: readNonEmptyString(candidate.runId, "taskList.runId"),
    revision: readNonNegativeInteger(candidate.revision, "taskList.revision"),
    nextTaskId,
    tasks,
  };
}

export function cloneTaskListState(state: TaskListState): TaskListState {
  return {
    ...state,
    tasks: state.tasks.map((task) => ({ ...task })),
  };
}
