import { useState } from "react";
import { ChevronDown } from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { planningDateLocale, translate } from "../../lib/planning/i18n";
import { planningStore } from "../../lib/planning/store";
import { compareTaskOrder, type TaskNode, taskTree } from "../../lib/planning/taskLists";
import { timeBounds, zonedParts } from "../../lib/planning/time";
import type { PlanningEvent, PlanningSnapshot, Todo } from "../../lib/planning/types";
import { TaskComposer } from "./TaskComposer";
import { TaskListMenu } from "./TaskListMenu";
import { TaskRow } from "./TaskRow";
import type { PlanningDragStart } from "./TimeGrid";
import { useTaskDrag } from "./useTaskDrag";

const PAGE_SIZE = 20;
export function TaskPanel({
  snapshot,
  busy,
  run,
  onEdit,
  onSchedule,
  onDrag,
  onDragEnd,
  list: fixedList,
  variant = "panel",
}: {
  /** Pin the panel to one list (Tasks board cards); otherwise the header switches lists. */
  list?: string;
  variant?: "panel" | "card";
  snapshot: PlanningSnapshot;
  busy: boolean;
  run(fn: () => Promise<unknown>): Promise<void>;
  onEdit(todo?: Todo): void;
  onSchedule(todo: Todo, event?: PlanningEvent): void;
  onDrag(drag: PlanningDragStart): void;
  onDragEnd(): void;
}) {
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [list, setList] = useState("");
  const [sort, setSort] = useState("manual");
  const [completedOpen, setCompletedOpen] = useState(false);
  const [openLimit, setOpenLimit] = useState(PAGE_SIZE);
  const [completedLimit, setCompletedLimit] = useState(PAGE_SIZE);
  const resetPages = () => {
    setOpenLimit(PAGE_SIZE);
    setCompletedLimit(PAGE_SIZE);
  };
  const lists = snapshot.groups ?? [];
  const current = fixedList ?? list;
  const selectedList =
    lists.some((l) => l.id === current) || ["", "starred"].includes(current) ? current : "";
  const tasks = snapshot.todos.filter(
    (t) =>
      !t.deletedAt &&
      (selectedList === "starred" ? t.priority === "high" : (t.groupId ?? "") === selectedList),
  );
  const open = tasks
    .filter((t) => t.status === "open")
    .sort((a, b) =>
      sort === "priority"
        ? Number(b.priority === "high") - Number(a.priority === "high")
        : sort === "title"
          ? a.title.localeCompare(b.title, planningDateLocale())
          : sort === "manual"
            ? compareTaskOrder(a, b)
            : b.createdAt - a.createdAt,
    );
  const completed = tasks
    .filter((t) => t.status === "completed")
    .sort((a, b) =>
      sort === "manual" ? compareTaskOrder(a, b) : (b.completedAt ?? 0) - (a.completedAt ?? 0),
    );
  const update = (todo: Todo, data: Record<string, unknown>) =>
    void run(() =>
      planningStore.mutate({
        action: "todo.update",
        id: todo.id,
        expectedRevision: todo.revision,
        data,
      }),
    );
  const move = (todo: Todo, data: Record<string, unknown>) => {
    setSort("manual");
    void run(() =>
      planningStore.mutate({
        action: "todo.move",
        id: todo.id,
        expectedRevision: todo.revision,
        data,
      }),
    );
  };
  const drag = useTaskDrag({
    todos: snapshot.todos,
    onDrag,
    onFinish: onDragEnd,
    onMove: (todo, target, edge) =>
      move(todo, {
        parentId: target.parentId ?? null,
        groupId: target.groupId ?? null,
        [edge === "before" ? "beforeId" : "afterId"]: target.id,
        relativeRevision: target.revision,
      }),
  });
  const calendarId =
    snapshot.calendars.find((c) => c.isDefault && !c.readOnly)?.id ??
    snapshot.calendars.find((c) => !c.readOnly)?.id;
  const row = (
    todo: Todo,
    children: TaskNode[] = [],
    previous?: Todo,
    nextSibling?: Todo,
    depth = 0,
  ) => {
    const schedules = (snapshot.eventMasters ?? snapshot.events)
      .filter((e) => e.todoId === todo.id && !e.deletedAt)
      .sort((a, b) => timeBounds(a.time)[0] - timeBounds(b.time)[0]);
    const next = schedules.find((e) => timeBounds(e.time)[1] > Date.now()) ?? schedules[0];
    const when =
      next?.time.kind === "timed" ? zonedParts(next.time.startAt, snapshot.timeZone) : null;
    return (
      <TaskRow
        key={todo.id}
        todo={todo}
        lists={lists}
        zone={snapshot.timeZone}
        busy={busy}
        dragging={drag.dragged === todo.id}
        dropEdge={drag.drop?.id === todo.id ? drag.drop.edge : undefined}
        childCount={children.length}
        collapsed={collapsed.has(todo.id)}
        parentTitle={!depth ? snapshot.todos.find((t) => t.id === todo.parentId)?.title : undefined}
        onToggleChildren={() =>
          setCollapsed((old) => {
            const next = new Set(old);
            if (next.has(todo.id)) next.delete(todo.id);
            else next.add(todo.id);
            return next;
          })
        }
        onAddSubtask={() => {
          setAddingTo(todo.id);
          setCollapsed((old) => {
            const next = new Set(old);
            next.delete(todo.id);
            return next;
          });
        }}
        onIndent={previous ? () => move(todo, { parentId: previous.id }) : undefined}
        onOutdent={
          todo.parentId
            ? () => {
                const parent = snapshot.todos.find((t) => t.id === todo.parentId);
                if (parent)
                  move(todo, {
                    parentId: parent.parentId ?? null,
                    afterId: parent.id,
                    relativeRevision: parent.revision,
                  });
              }
            : undefined
        }
        onMoveUp={
          previous
            ? () =>
                move(todo, {
                  parentId: todo.parentId ?? null,
                  beforeId: previous.id,
                  relativeRevision: previous.revision,
                })
            : undefined
        }
        onMoveDown={
          nextSibling
            ? () =>
                move(todo, {
                  parentId: todo.parentId ?? null,
                  afterId: nextSibling.id,
                  relativeRevision: nextSibling.revision,
                })
            : undefined
        }
        scheduleLabel={
          next
            ? `${when ? `${when.date.slice(5)} ${when.time}` : translate("planner.allDay")}${schedules.length > 1 ? ` · ${translate("planner.panel.blocks", { count: schedules.length })}` : ""}`
            : undefined
        }
        onEdit={() => onEdit(todo)}
        onSchedule={() => onSchedule(todo)}
        onOpenSchedule={() => onSchedule(todo, next)}
        onToggle={() => update(todo, { status: todo.status === "open" ? "completed" : "open" })}
        onMove={(groupId) => update(todo, { groupId })}
        onStar={() => update(todo, { priority: todo.priority === "high" ? "medium" : "high" })}
        onTrash={() =>
          void run(() =>
            planningStore.mutate({
              action: "todo.delete",
              id: todo.id,
              expectedRevision: todo.revision,
              data: {},
            }),
          )
        }
        onDrag={(event) => drag.start(event, todo)}
      >
        {(!collapsed.has(todo.id) || addingTo === todo.id) &&
          (children.length > 0 || addingTo === todo.id) && (
            <ul className={`${depth < 4 ? "ml-4" : "ml-1"} border-l border-border/60 pl-1`}>
              {children.map((child, index) =>
                row(
                  child.todo,
                  child.children,
                  children[index - 1]?.todo,
                  children[index + 1]?.todo,
                  depth + 1,
                ),
              )}
              {addingTo === todo.id && (
                <li>
                  <TaskComposer
                    parent={todo}
                    listId={selectedList}
                    zone={snapshot.timeZone}
                    calendarId={calendarId}
                    onClose={() => setAddingTo(null)}
                  />
                </li>
              )}
            </ul>
          )}
      </TaskRow>
    );
  };
  const openRoots = taskTree(open),
    completedRoots = taskTree(completed);
  const rows = (items: Todo[], limit: number) =>
    taskTree(items)
      .slice(0, limit)
      .map(({ todo, children }, index, visible) =>
        row(todo, children, visible[index - 1]?.todo, visible[index + 1]?.todo),
      );
  return (
    <div
      className={variant === "panel" ? "flex h-full min-h-0 flex-col" : "flex flex-col"}
      data-testid={variant === "panel" ? "planning-task-panel" : "planning-task-card"}
    >
      {variant === "panel" ? (
        <div className="flex shrink-0 items-start gap-1 px-4 pb-1 pt-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-tiny font-medium uppercase tracking-wider text-muted-foreground">
              {translate("planner.mode.tasks")}
            </h2>
            <TaskListMenu
              snapshot={snapshot}
              value={selectedList}
              onChange={(value) => {
                setList(value);
                setAddingTo(null);
                resetPages();
              }}
            />
          </div>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1 px-4 pb-1 pt-3">
          <h2 className="min-w-0 flex-1 truncate text-lg">
            {selectedList === "starred"
              ? translate("planner.starred")
              : (lists.find((l) => l.id === selectedList)?.name ?? translate("planner.myTasks"))}
          </h2>
          {selectedList !== "starred" && (
            <TaskListMenu
              snapshot={snapshot}
              value={selectedList}
              onChange={() => {}}
              actionsOnly
            />
          )}
        </div>
      )}
      <TaskComposer
        key={selectedList}
        listId={selectedList}
        zone={snapshot.timeZone}
        calendarId={calendarId}
        sort={sort}
        onSort={setSort}
      />
      <section
        className={`${variant === "panel" ? "min-h-0 flex-1 overflow-y-auto overscroll-contain" : ""} px-2 pb-1`}
        data-task-scroll
        aria-label={translate("planner.panel.open")}
      >
        {open.length ? (
          <ul>{rows(open, openLimit)}</ul>
        ) : (
          <EmptyState className={`h-auto px-4 text-xs ${variant === "panel" ? "py-10" : "py-4"}`}>
            {selectedList === "starred"
              ? translate("planner.panel.emptyStarred")
              : translate("planner.panel.empty")}
          </EmptyState>
        )}
        {openRoots.length > openLimit && (
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => setOpenLimit(openLimit + PAGE_SIZE)}
          >
            {translate("planner.panel.loadMore", { count: openRoots.length - openLimit })}
          </Button>
        )}
      </section>
      <div
        className={`flex shrink-0 flex-col ${variant === "panel" ? "max-h-[45%] border-t border-border/60" : "pb-2"}`}
      >
        <Button
          variant="ghost"
          className={`h-10 shrink-0 justify-start gap-3 px-4 text-sm font-medium text-muted-foreground ${variant === "panel" ? "rounded-none" : "mx-2 rounded-full px-2"}`}
          aria-expanded={completedOpen}
          onClick={() => setCompletedOpen(!completedOpen)}
        >
          <ChevronDown className={`size-4 ${completedOpen ? "" : "-rotate-90"}`} />
          {translate("planner.panel.completedCount", { count: completed.length })}
        </Button>
        {completedOpen && (
          <section
            className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-2"
            data-task-scroll
            aria-label={translate("planner.panel.completed")}
          >
            <ul>{rows(completed, completedLimit)}</ul>
            {!completed.length && (
              <p className="px-4 py-3 text-xs text-muted-foreground">
                {translate("planner.panel.noneCompleted")}
              </p>
            )}
            {completedRoots.length > completedLimit && (
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => setCompletedLimit(completedLimit + PAGE_SIZE)}
              >
                {translate("planner.panel.loadMoreCompleted", {
                  count: completedRoots.length - completedLimit,
                })}
              </Button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
