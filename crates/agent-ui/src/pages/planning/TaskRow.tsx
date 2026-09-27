import { type PointerEvent, type ReactNode, useState } from "react";
import { Check, ChevronDown, Circle, Clock3, Star, Trash2 } from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { ContextMenuPopup } from "../../components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../../components/ui/dropdown-menu";
import { planningDateLocale, translate } from "../../lib/planning/i18n";
import { addDays, zonedParts } from "../../lib/planning/time";
import type { PlanningCategory, Todo } from "../../lib/planning/types";
import { usePlanningT } from "./usePlanningT";

export function TaskRow({
  todo,
  lists,
  zone,
  busy,
  onEdit,
  onSchedule,
  onOpenSchedule,
  onToggle,
  onTrash,
  onMove,
  onStar,
  onDrag,
  scheduleLabel,
  children,
  childCount = 0,
  collapsed = false,
  parentTitle,
  onToggleChildren,
  onAddSubtask,
  onIndent,
  onOutdent,
  onMoveUp,
  onMoveDown,
  dragging,
  dropEdge,
}: {
  children?: ReactNode;
  childCount?: number;
  collapsed?: boolean;
  parentTitle?: string;
  onToggleChildren?(): void;
  onAddSubtask?(): void;
  onIndent?(): void;
  onOutdent?(): void;
  onMoveUp?(): void;
  onMoveDown?(): void;
  dragging?: boolean;
  dropEdge?: "before" | "after";
  todo: Todo;
  lists: PlanningCategory[];
  zone: string;
  busy: boolean;
  scheduleLabel?: string;
  onEdit(): void;
  onSchedule(): void;
  onOpenSchedule(): void;
  onToggle(): void;
  onTrash(): void;
  onMove(id: string | null): void;
  onStar(): void;
  onDrag(event: PointerEvent<HTMLElement>): void;
}) {
  const { t, locale } = usePlanningT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const completed = todo.status === "completed";
  const due = todo.dueAt ? zonedParts(todo.dueAt, todo.dueTimeZone ?? zone) : null;
  const today = zonedParts(Date.now(), zone).date;
  const dueDay = due?.date ?? todo.dueDate ?? null;
  const overdue = todo.dueAt != null ? todo.dueAt < Date.now() : !!dueDay && dueDay < today;
  const dueLabel = dueDay ? `${relativeDay(dueDay, today)}${due ? ` ${due.time}` : ""}` : "";
  return (
    <li>
      <fieldset
        data-task-row={todo.id}
        aria-label={t("planner.task.rowLabel", { title: todo.title })}
        title={t("planner.task.dragHint")}
        onPointerDown={(e) => {
          if (!busy) onDrag(e);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left + 20, y: r.top + 20 });
          }
        }}
        className={`group/task relative flex cursor-grab select-none items-start gap-2 rounded-lg px-1.5 py-1 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-within:bg-accent/50 ${dragging ? "opacity-40" : ""} ${dropEdge === "before" ? "border-t-2 border-primary" : dropEdge === "after" ? "border-b-2 border-primary" : ""}`}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="mt-0.5 shrink-0 rounded-full text-muted-foreground"
          data-task-control
          role="checkbox"
          aria-checked={completed}
          aria-label={t(completed ? "planner.task.uncomplete" : "planner.task.complete", {
            title: todo.title,
          })}
          disabled={busy}
          onClick={onToggle}
        >
          {completed ? <Check className="size-4 text-primary" /> : <Circle className="size-4" />}
        </Button>
        <div className="min-w-0 flex-1 py-1">
          <Button
            variant="ghost"
            className={`h-auto min-h-0 w-full justify-start whitespace-normal break-words p-0 text-left text-sm font-normal hover:bg-transparent ${completed ? "text-muted-foreground line-through" : ""}`}
            onClick={onEdit}
          >
            {todo.title}
          </Button>
          {parentTitle && (
            <p className="truncate text-xs text-muted-foreground">
              {t("planner.task.subtaskOf", { title: parentTitle })}
            </p>
          )}
          {childCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-0 text-xs text-muted-foreground"
              aria-label={t(
                collapsed ? "planner.task.expandSubtasks" : "planner.task.collapseSubtasks",
                { title: todo.title },
              )}
              data-task-control
              aria-expanded={!collapsed}
              onClick={onToggleChildren}
            >
              <ChevronDown className={`size-3 ${collapsed ? "-rotate-90" : ""}`} />
              {t("planner.task.subtaskCount", { count: childCount })}
            </Button>
          )}
          {!completed && todo.notes && (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{todo.notes}</p>
          )}
          {completed ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {todo.completedAt
                ? t("planner.task.completedOn", {
                    date: new Date(todo.completedAt).toLocaleDateString(
                      planningDateLocale(locale),
                      {
                        timeZone: zone,
                      },
                    ),
                  })
                : t("planner.status.completed")}
            </p>
          ) : (
            <div className="mt-1 flex flex-wrap gap-1 empty:hidden">
              {scheduleLabel && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 rounded-full bg-transparent px-2.5 text-xs font-medium text-primary"
                  data-task-control
                  onClick={onOpenSchedule}
                >
                  <Clock3 className="size-3" />
                  {scheduleLabel}
                </Button>
              )}
              {(due || todo.dueDate) && (
                <Button
                  variant="outline"
                  size="sm"
                  className={`h-6 rounded-full bg-transparent px-2.5 text-xs font-medium ${overdue ? "text-destructive" : ""}`}
                  data-task-control
                  aria-label={t("planner.task.dueLabel", { due: dueLabel })}
                  onClick={onEdit}
                >
                  <Clock3 className="size-3.5" />
                  {dueLabel}
                </Button>
              )}
            </div>
          )}
        </div>
        {todo.priority === "high" && (
          <Star
            className="mt-2 size-3.5 shrink-0 fill-current text-primary"
            aria-label={t("planner.starred")}
          />
        )}
        {completed && (
          <Button
            data-task-control
            variant="ghost"
            size="icon-xs"
            aria-label={t("planner.task.trashLabel", { title: todo.title })}
            disabled={busy}
            onClick={onTrash}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
        {menu && (
          <ContextMenuPopup point={menu} onClose={() => setMenu(null)}>
            <DropdownMenuItem onClick={onEdit}>{t("planner.task.edit")}</DropdownMenuItem>
            <DropdownMenuItem onClick={onToggle}>
              {completed ? t("planner.task.markOpen") : t("planner.task.markDone")}
            </DropdownMenuItem>
            {onMoveUp && (
              <DropdownMenuItem onClick={onMoveUp}>{t("planner.task.moveUp")}</DropdownMenuItem>
            )}
            {onMoveDown && (
              <DropdownMenuItem onClick={onMoveDown}>{t("planner.task.moveDown")}</DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onSchedule}>{t("planner.editor.schedule")}</DropdownMenuItem>
            {onAddSubtask && (
              <DropdownMenuItem onClick={onAddSubtask}>
                {t("planner.task.addSubtask")}
              </DropdownMenuItem>
            )}
            {onIndent && (
              <DropdownMenuItem onClick={onIndent}>{t("planner.task.indent")}</DropdownMenuItem>
            )}
            {onOutdent && (
              <DropdownMenuItem onClick={onOutdent}>{t("planner.task.outdent")}</DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onStar}>
              <Star className="size-4" />
              {todo.priority === "high" ? t("planner.task.unstar") : t("planner.task.star")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onTrash} className="text-destructive">
              <Trash2 className="size-4" />
              {t("planner.common.moveToTrash")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("planner.task.moveToList")}</DropdownMenuLabel>
            {[{ id: "", name: t("planner.myTasks") }, ...lists].map((list) => (
              <DropdownMenuItem
                key={list.id}
                disabled={(todo.groupId ?? "") === list.id}
                onClick={() => onMove(list.id || null)}
              >
                <span className="w-4">
                  {(todo.groupId ?? "") === list.id && <Check className="size-4" />}
                </span>
                {list.name}
              </DropdownMenuItem>
            ))}
          </ContextMenuPopup>
        )}
      </fieldset>
      {children}
    </li>
  );
}

/** Google Tasks style due label: today / tomorrow / yesterday / weekday / date. */
export function relativeDay(day: string, today: string) {
  if (day === today) return translate("planner.today");
  if (day === addDays(today, 1)) return translate("planner.tomorrow");
  if (day === addDays(today, -1)) return translate("planner.yesterday");
  const at = new Date(`${day}T12:00:00Z`);
  const locale = planningDateLocale();
  if (day > today && day < addDays(today, 7))
    return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(at);
  return new Intl.DateTimeFormat(locale, {
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(at);
}
