import type { TodoItem } from "../tools/builtinTypes";

export type TodoProgressState = "pending" | "in_progress" | "completed";

export type TodoProgressSnapshot = {
  todos: TodoItem[];
  completedCount: number;
  totalCount: number;
  currentStep: number;
  state: TodoProgressState;
};

export type TodoProgressUpdate = {
  key: string;
  snapshot: TodoProgressSnapshot | null | undefined;
  /** False while the value only comes from incrementally streamed arguments. */
  settled?: boolean;
};

export type TodoProgressPlan = {
  anchorKey: string | null;
  snapshot: TodoProgressSnapshot | null;
};

type RecordLike = Record<string, unknown>;
type TodoWriteToolBlock = RecordLike & {
  item: RecordLike & { toolCall: RecordLike };
};

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === "object";
}

export function isTodoWriteToolBlock(block: unknown): block is TodoWriteToolBlock {
  if (!isRecord(block) || block.kind !== "tool" || !isRecord(block.item)) return false;
  return isRecord(block.item.toolCall) && block.item.toolCall.name === "TodoWrite";
}

export function readCompleteTodoList(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null;
  const todos: TodoItem[] = [];
  let inProgressCount = 0;
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (typeof item.content !== "string" || !item.content.trim()) return null;
    if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") {
      return null;
    }
    if (typeof item.activeForm !== "string" || !item.activeForm.trim()) return null;
    if (item.status === "in_progress" && ++inProgressCount > 1) return null;
    todos.push({ content: item.content, status: item.status, activeForm: item.activeForm });
  }
  return todos;
}

type TodoWriteBlockRead = {
  todos: TodoItem[] | undefined;
  settled: boolean;
};

function readTodoWriteBlock(block: unknown): TodoWriteBlockRead | undefined {
  if (!isTodoWriteToolBlock(block)) return undefined;
  const toolCall = block.item.toolCall;
  const toolResult = isRecord(block.item.toolResult) ? block.item.toolResult : null;
  if (toolResult) {
    if (toolResult.isError === true) return { todos: undefined, settled: true };
    if (!isRecord(toolResult.details) || toolResult.details.kind !== "todo_write") {
      return { todos: undefined, settled: true };
    }
    return {
      todos: readCompleteTodoList(toolResult.details.todos) ?? undefined,
      settled: true,
    };
  }
  return {
    todos: isRecord(toolCall.arguments)
      ? (readCompleteTodoList(toolCall.arguments.todos) ?? undefined)
      : undefined,
    settled: false,
  };
}

export function createTodoProgressSnapshot(todos: TodoItem[]): TodoProgressSnapshot | null {
  if (todos.length === 0) return null;
  const completedCount = todos.filter((todo) => todo.status === "completed").length;
  const inProgressIndex = todos.findIndex((todo) => todo.status === "in_progress");
  const pendingIndex = todos.findIndex((todo) => todo.status === "pending");
  const state: TodoProgressState =
    completedCount === todos.length
      ? "completed"
      : inProgressIndex >= 0
        ? "in_progress"
        : "pending";
  const currentStep =
    inProgressIndex >= 0
      ? inProgressIndex + 1
      : pendingIndex >= 0
        ? pendingIndex + 1
        : todos.length;
  return {
    todos,
    completedCount,
    totalCount: todos.length,
    currentStep,
    state,
  };
}

export function todoProgressSnapshotSignature(snapshot: TodoProgressSnapshot | null): string {
  return JSON.stringify(snapshot?.todos ?? null);
}

function cloneTodoProgressSnapshot(snapshot: TodoProgressSnapshot): TodoProgressSnapshot {
  return createTodoProgressSnapshot(
    snapshot.todos.map((todo) => ({ ...todo })),
  ) as TodoProgressSnapshot;
}

export function mergeTodoProgressSnapshots(
  current: TodoProgressSnapshot,
  incoming: TodoProgressSnapshot,
): TodoProgressSnapshot {
  const nextTodos = current.todos.map((todo) => ({ ...todo }));
  const usedIndexes = new Set<number>();
  const matchedIndexes = incoming.todos.map((incomingTodo, incomingIndex) => {
    let matchedIndex = current.todos.findIndex(
      (todo, index) => !usedIndexes.has(index) && todo.content === incomingTodo.content,
    );
    if (
      matchedIndex < 0 &&
      incoming.todos.length === current.todos.length &&
      !usedIndexes.has(incomingIndex)
    ) {
      matchedIndex = incomingIndex;
    }
    if (matchedIndex >= 0) usedIndexes.add(matchedIndex);
    return matchedIndex;
  });

  const incomingActiveIndex = incoming.todos.findIndex((todo) => todo.status === "in_progress");
  const nextActiveIndex =
    incomingActiveIndex >= 0 ? (matchedIndexes[incomingActiveIndex] ?? -1) : -1;
  if (nextActiveIndex >= 0) {
    for (let index = 0; index < nextTodos.length; index += 1) {
      const todo = nextTodos[index];
      if (index !== nextActiveIndex && todo?.status === "in_progress") {
        nextTodos[index] = { ...todo, status: "pending" };
      }
    }
  }

  for (let incomingIndex = 0; incomingIndex < incoming.todos.length; incomingIndex += 1) {
    const matchedIndex = matchedIndexes[incomingIndex] ?? -1;
    const existingTodo = nextTodos[matchedIndex];
    const incomingTodo = incoming.todos[incomingIndex];
    if (matchedIndex < 0 || !existingTodo || !incomingTodo) continue;
    nextTodos[matchedIndex] = { ...existingTodo, status: incomingTodo.status };
  }

  return createTodoProgressSnapshot(nextTodos) as TodoProgressSnapshot;
}

export function applyTodoProgressUpdate(
  plan: TodoProgressPlan,
  update: TodoProgressUpdate,
): TodoProgressPlan {
  if (update.snapshot === undefined) return plan;
  if (update.snapshot === null) return { anchorKey: null, snapshot: null };
  if (plan.snapshot === null) {
    return { anchorKey: update.key, snapshot: cloneTodoProgressSnapshot(update.snapshot) };
  }
  if (plan.anchorKey === update.key) {
    return { anchorKey: plan.anchorKey, snapshot: cloneTodoProgressSnapshot(update.snapshot) };
  }
  return {
    anchorKey: plan.anchorKey,
    snapshot: mergeTodoProgressSnapshots(plan.snapshot, update.snapshot),
  };
}

export function foldTodoProgressUpdates(updates: readonly TodoProgressUpdate[]): TodoProgressPlan {
  let plan: TodoProgressPlan = { anchorKey: null, snapshot: null };
  for (const update of updates) plan = applyTodoProgressUpdate(plan, update);
  return plan;
}

export function selectTodoProgressUpdates(
  rows: readonly unknown[],
  liveRounds: readonly unknown[] = [],
): TodoProgressUpdate[] {
  const updates: TodoProgressUpdate[] = [];
  const updateIndexByKey = new Map<string, number>();
  const ignoredTodoKeys = new Set<string>();
  const visitRounds = (rounds: readonly unknown[], scope: string) => {
    for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
      const round = rounds[roundIndex];
      if (!isRecord(round) || !Array.isArray(round.blocks)) continue;
      for (let blockIndex = 0; blockIndex < round.blocks.length; blockIndex += 1) {
        const block = round.blocks[blockIndex];
        const read = readTodoWriteBlock(block);
        if (!read || !isTodoWriteToolBlock(block)) continue;
        const callId = block.item.toolCall.id;
        const key =
          typeof callId === "string" && callId.trim()
            ? callId.trim()
            : `${scope}:${roundIndex}:${blockIndex}`;
        if (ignoredTodoKeys.has(key)) continue;
        const update: TodoProgressUpdate = {
          key,
          snapshot: read.todos === undefined ? undefined : createTodoProgressSnapshot(read.todos),
          settled: read.settled,
        };
        const existingIndex = updateIndexByKey.get(key);
        if (existingIndex === undefined) {
          updateIndexByKey.set(key, updates.length);
          updates.push(update);
        } else {
          updates[existingIndex] = update;
        }
      }
    }
  };
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!isRecord(row)) continue;
    if (row.kind === "user") {
      for (const update of updates) {
        if (update.snapshot !== null) ignoredTodoKeys.add(update.key);
      }
      updates.length = 0;
      updateIndexByKey.clear();
      const item = isRecord(row.item) ? row.item : null;
      const identity =
        typeof row.key === "string" && row.key.trim()
          ? row.key.trim()
          : typeof row.id === "string" && row.id.trim()
            ? row.id.trim()
            : item && typeof item.id === "string" && item.id.trim()
              ? item.id.trim()
              : String(rowIndex);
      const boundaryKey = `user-turn:${identity}`;
      updates.push({ key: boundaryKey, snapshot: null, settled: true });
      updateIndexByKey.set(boundaryKey, 0);
      continue;
    }
    if (row.kind !== "assistant" || !Array.isArray(row.rounds)) continue;
    visitRounds(row.rounds, `history:${rowIndex}`);
  }
  visitRounds(liveRounds, "live");
  return updates;
}

export function selectLatestTodoProgress(
  rows: readonly unknown[],
  liveRounds: readonly unknown[] = [],
): TodoProgressSnapshot | null {
  const updates = selectTodoProgressUpdates(rows, liveRounds);
  for (let index = updates.length - 1; index >= 0; index -= 1) {
    const snapshot = updates[index]?.snapshot;
    if (snapshot !== undefined) return snapshot;
  }
  return null;
}
