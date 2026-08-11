import { isTaskToolName, type TaskItem } from "../../contracts/task";

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
      (status !== "pending" && status !== "in_progress" && status !== "completed")
    ) {
      return null;
    }
    if (status === "in_progress" && ++inProgressCount > 1) return null;
    ids.add(id);
    tasks.push({ id, subject, description, activeForm, status });
  }
  return tasks;
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

export function selectLatestTaskProgress(
  rows: readonly unknown[],
  liveRounds: readonly unknown[] = [],
): TaskProgressSnapshot | null {
  let latest: TaskProgressSnapshot | null = null;
  const visitRounds = (rounds: readonly unknown[]) => {
    for (const round of rounds) {
      if (!isRecord(round) || !Array.isArray(round.blocks)) continue;
      for (const block of round.blocks) {
        const snapshot = readTaskSnapshot(block);
        if (snapshot !== undefined) latest = snapshot;
      }
    }
  };
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (row.kind === "user") {
      latest = null;
    } else if (row.kind === "assistant" && Array.isArray(row.rounds)) {
      visitRounds(row.rounds);
    }
  }
  visitRounds(liveRounds);
  return latest;
}
