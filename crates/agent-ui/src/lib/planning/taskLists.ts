import { translate } from "./i18n";
import type { PlanningSnapshot, Todo } from "./types";

export const DEFAULT_TASK_COLOR = "#6366f1";
/** All task lists; the built-in "My Tasks" (id "") disappears once it has been deleted. */
export function taskLists(
  snapshot: Pick<PlanningSnapshot, "groups" | "defaultGroupId" | "myTasksColor">,
) {
  return [
    ...(snapshot.defaultGroupId
      ? []
      : [
          {
            id: "",
            name: translate("planner.myTasks"),
            color: snapshot.myTasksColor ?? DEFAULT_TASK_COLOR,
          },
        ]),
    ...(snapshot.groups ?? []),
  ];
}
/** The list new tasks go to when none is chosen. */
export function homeTaskList(snapshot: Pick<PlanningSnapshot, "defaultGroupId">) {
  return snapshot.defaultGroupId ?? "";
}
export function taskListLayer(groupId?: string | null) {
  return groupId ? `planning:tasks:${groupId}` : "planning:tasks";
}
/** Color of a task list; "" (or a list that no longer exists) is the built-in "My Tasks". */
export function listColor(
  snapshot: Pick<PlanningSnapshot, "groups" | "myTasksColor">,
  groupId?: string | null,
) {
  return (
    (groupId ? snapshot.groups?.find((g) => g.id === groupId)?.color : undefined) ??
    snapshot.myTasksColor ??
    DEFAULT_TASK_COLOR
  );
}
export function taskListColor(
  todo: Todo | undefined,
  snapshot: Pick<PlanningSnapshot, "groups" | "myTasksColor">,
) {
  return listColor(snapshot, todo?.groupId);
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
