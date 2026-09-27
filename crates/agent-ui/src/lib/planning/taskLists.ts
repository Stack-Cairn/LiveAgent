import { translate } from "./i18n";
import type { PlanningSnapshot, Todo } from "./types";

export const DEFAULT_TASK_COLOR = "#6366f1";
export function taskLists(snapshot: Pick<PlanningSnapshot, "groups">) {
  return [
    { id: "", name: translate("planner.myTasks"), color: DEFAULT_TASK_COLOR },
    ...(snapshot.groups ?? []),
  ];
}
export function taskListLayer(groupId?: string | null) {
  return groupId ? `planning:tasks:${groupId}` : "planning:tasks";
}
export function taskListColor(todo: Todo | undefined, snapshot: Pick<PlanningSnapshot, "groups">) {
  return snapshot.groups?.find((g) => g.id === todo?.groupId)?.color ?? DEFAULT_TASK_COLOR;
}
export interface TaskNode {
  todo: Todo;
  children: TaskNode[];
}
export function taskTree(items: Todo[]): TaskNode[] {
  const nodes = new Map(items.map((todo) => [todo.id, { todo, children: [] as TaskNode[] }]));
  const roots: TaskNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.todo.parentId ? nodes.get(node.todo.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
export function taskDescendants(items: Todo[], root: string) {
  const ids = new Set([root]);
  let size = -1;
  while (size !== ids.size) {
    size = ids.size;
    for (const t of items) if (t.parentId && ids.has(t.parentId)) ids.add(t.id);
  }
  return ids;
}
export function compareTaskOrder(a: Todo, b: Todo) {
  return (
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || b.createdAt - a.createdAt || a.id.localeCompare(b.id)
  );
}
