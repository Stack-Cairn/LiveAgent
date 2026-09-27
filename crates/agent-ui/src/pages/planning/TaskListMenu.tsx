import { useState } from "react";
import {
  Check,
  ChevronDown,
  MoreHorizontal,
  Plus,
  SquarePen,
  Star,
  Trash2,
} from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { translate } from "../../lib/planning/i18n";
import { taskLists } from "../../lib/planning/taskLists";
import type { PlanningSnapshot } from "../../lib/planning/types";
import { type TaskListAction, TaskListDialog } from "./TaskListDialog";
export function TaskListMenu({
  snapshot,
  value,
  onChange,
  actionsOnly,
}: {
  snapshot: PlanningSnapshot;
  value: string;
  onChange(value: string): void;
  /** Card header kebab: only rename/delete the pinned list. */
  actionsOnly?: boolean;
}) {
  const [action, setAction] = useState<TaskListAction | null>(null);
  const currentList = snapshot.groups?.find((list) => list.id === value);
  const lists = taskLists(snapshot);
  const selected =
    value === "starred"
      ? translate("planner.starred")
      : (lists.find((l) => l.id === value)?.name ?? translate("planner.myTasks"));
  const count = (id: string) =>
    snapshot.todos.filter(
      (t) =>
        !t.deletedAt &&
        t.status === "open" &&
        (id === "starred" ? t.priority === "high" : (t.groupId ?? "") === id),
    ).length;
  const dialog = action && (
    <TaskListDialog action={action} onClose={() => setAction(null)} onSelect={onChange} />
  );
  // The default list (My Tasks) and Starred are built in: nothing to rename or delete.
  if (actionsOnly) {
    if (!currentList) return null;
    return (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" className="rounded-full" />}
            aria-label={translate("planner.list.actions", { name: selected })}
          >
            <MoreHorizontal className="size-4 rotate-90" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setAction({ kind: "rename", list: currentList })}>
              <SquarePen className="size-4" />
              {translate("planner.list.rename")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => setAction({ kind: "delete", list: currentList })}
            >
              <Trash2 className="size-4" />
              {translate("planner.list.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {dialog}
      </>
    );
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" />}
          aria-label={translate("planner.list.switch", { name: selected })}
          className="-ml-1 h-8 max-w-full justify-start gap-1 rounded-md px-1 text-lg font-normal"
        >
          <span className="truncate">{selected}</span>
          <ChevronDown className="size-4 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onClick={() => onChange("starred")}>
            <Star className="size-4" />
            <span className="flex-1">{translate("planner.starred")}</span>
            <span className="text-xs text-muted-foreground">{count("starred")}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {lists.map((list) => (
            <DropdownMenuItem key={list.id} onClick={() => onChange(list.id)}>
              <span className="w-4 shrink-0">
                {list.id === value && <Check className="size-4" />}
              </span>
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: list.color }}
              />
              <span className="min-w-0 flex-1 truncate">{list.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{count(list.id)}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setAction({ kind: "create" })}>
            <Plus className="size-4" />
            {translate("planner.list.new")}
          </DropdownMenuItem>
          {currentList && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setAction({ kind: "rename", list: currentList })}>
                <SquarePen className="size-4" />
                {translate("planner.list.renameCurrent")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => setAction({ kind: "delete", list: currentList })}
              >
                <Trash2 className="size-4" />
                {translate("planner.list.deleteCurrent")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}
