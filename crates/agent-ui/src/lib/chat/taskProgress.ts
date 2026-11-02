import { isTaskToolName, type TaskItem, type TaskListResultDetails } from "../../contracts/task";

export type TaskProgressState = "pending" | "in_progress" | "completed";

export type TaskProgressSnapshot = {
  runId: string;
  revision: number;
  tasks: TaskItem[];
  completedCount: number;
  totalCount: number;
  currentStep: number;
  state: TaskProgressState;
};

type TaskResultLike = {
  details?: unknown;
  isError?: boolean;
  output?: string;
};

type RecordLike = Record<string, unknown>;
type TaskToolBlock = RecordLike & {
  item: RecordLike & { toolCall: RecordLike };
};

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === "object";
}

export function isTaskToolBlock(block: unknown): block is TaskToolBlock {
  if (!isRecord(block) || block.kind !== "tool" || !isRecord(block.item)) return false;
  const toolCall = block.item.toolCall;
  return isRecord(toolCall) && isTaskToolName(toolCall.name);
}

function readTaskItems(value: unknown): TaskItem[] | null {
  if (!Array.isArray(value)) return null;
  const tasks: TaskItem[] = [];
  const ids = new Set<string>();
  let inProgressCount = 0;
  for (const valueItem of value) {
    if (!isRecord(valueItem)) return null;
    const { id, subject, description, activeForm, status } = valueItem;
    if (
      typeof id !== "string" ||
      !id.trim() ||
      ids.has(id) ||
      typeof subject !== "string" ||
      !subject.trim() ||
      typeof description !== "string" ||
      !description.trim() ||
      typeof activeForm !== "string" ||
      !activeForm.trim() ||
      (status !== "pending" &&
        status !== "in_progress" &&
        status !== "completed" &&
        status !== "cancelled")
    ) {
      return null;
    }
    if (status === "in_progress" && ++inProgressCount > 1) return null;
    ids.add(id);
    tasks.push({ id, subject, description, activeForm, status });
  }
  return tasks;
}

export function taskResultDetails(
  name: unknown,
  argumentsValue: unknown,
  result: TaskResultLike,
  runId: string,
  revision: number,
): TaskListResultDetails | undefined {
  if (!isTaskToolName(name) && name !== "todowrite") return undefined;
  if (result.isError === true || !isRecord(argumentsValue)) return undefined;
  if (isTaskToolName(name) && isRecord(result.details)) {
    return result.details as TaskListResultDetails;
  }
  if (name !== "todowrite" || !Array.isArray(argumentsValue.todos)) return undefined;
  const tasks: TaskItem[] = [];
  const ids = new Set<string>();
  for (const [index, item] of argumentsValue.todos.entries()) {
    if (!isRecord(item)) return undefined;
    const content = typeof item.content === "string" ? item.content.trim() : "";
    const status = item.status;
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `t${index + 1}`;
    if (
      !content ||
      ids.has(id) ||
      (status !== "pending" &&
        status !== "in_progress" &&
        status !== "completed" &&
        status !== "cancelled")
    ) {
      return undefined;
    }
    ids.add(id);
    tasks.push({ id, subject: content, description: content, activeForm: content, status });
  }
  return { kind: "task_list", action: "updated", runId, revision, tasks };
}

function readTaskSnapshot(block: unknown): TaskProgressSnapshot | null | undefined {
  if (!isTaskToolBlock(block) || !isRecord(block.item.toolResult)) return undefined;
  const result = block.item.toolResult;
  if (result.isError === true || !isRecord(result.details)) return undefined;
  const details = result.details;
  if (
    details.kind !== "task_list" ||
    typeof details.runId !== "string" ||
    !details.runId.trim() ||
    !Number.isSafeInteger(details.revision) ||
    (details.revision as number) < 0
  ) {
    return undefined;
  }
  const tasks = readTaskItems(details.tasks);
  return tasks
    ? createTaskProgressSnapshot(details.runId, details.revision as number, tasks)
    : undefined;
}

export function createTaskProgressSnapshot(
  runId: string,
  revision: number,
  tasks: TaskItem[],
): TaskProgressSnapshot | null {
  if (tasks.length === 0) return null;
  const completedCount = tasks.filter((task) => task.status === "completed").length;
  const inProgressIndex = tasks.findIndex((task) => task.status === "in_progress");
  const pendingIndex = tasks.findIndex((task) => task.status === "pending");
  const state: TaskProgressState =
    completedCount === tasks.length
      ? "completed"
      : inProgressIndex >= 0
        ? "in_progress"
        : "pending";
  return {
    runId,
    revision,
    tasks,
    completedCount,
    totalCount: tasks.length,
    currentStep:
      inProgressIndex >= 0
        ? inProgressIndex + 1
        : pendingIndex >= 0
          ? pendingIndex + 1
          : tasks.length,
    state,
  };
}

// Latest canonical result inside `rounds`: `undefined` when no task tool has
// settled there yet, `null` when the newest one is an explicit clear (empty
// TaskList), otherwise the snapshot. Callers layering live rounds over a
// history baseline need the tri-state: a `null` from the live tail must
// override the baseline, not fall back to it.
export function selectRoundsTaskProgress(
  rounds: readonly unknown[],
): TaskProgressSnapshot | null | undefined {
  let latest: TaskProgressSnapshot | null | undefined;
  for (const round of rounds) {
    if (!isRecord(round) || !Array.isArray(round.blocks)) continue;
    for (const block of round.blocks) {
      const snapshot = readTaskSnapshot(block);
      if (snapshot !== undefined) latest = snapshot;
    }
  }
  return latest;
}

export function selectLatestTaskProgress(
  rows: readonly unknown[],
  liveRounds: readonly unknown[] = [],
): TaskProgressSnapshot | null {
  let latest: TaskProgressSnapshot | null = null;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (row.kind === "user") {
      latest = null;
    } else if (row.kind === "assistant" && Array.isArray(row.rounds)) {
      const result = selectRoundsTaskProgress(row.rounds);
      if (result !== undefined) latest = result;
    }
  }
  const live = selectRoundsTaskProgress(liveRounds);
  return live === undefined ? latest : live;
}
