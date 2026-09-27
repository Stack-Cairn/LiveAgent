import { type CSSProperties, type ReactNode, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Plus,
  Settings2,
  Star,
} from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { calendarName, translate } from "../../lib/planning/i18n";
import { taskListLayer, taskLists } from "../../lib/planning/taskLists";
import type { PlanningSnapshot } from "../../lib/planning/types";
import { eventAppearance } from "./eventAppearance";
import { MiniMonth } from "./MiniMonth";

export type TaskFilter = "all" | "starred";

/** Colored checkbox matching the calendar swatch, like Google Calendar's calendar list. */
export function ColorCheckbox({
  color,
  checked,
  label,
  onChange,
}: {
  color: string;
  checked: boolean;
  label: string;
  onChange(): void;
}) {
  return (
    <Checkbox
      aria-label={label}
      checked={checked}
      className="planning-color-check"
      style={
        {
          "--planning-color": color,
          "--planning-on-color": eventAppearance(color).color,
        } as CSSProperties
      }
      onCheckedChange={onChange}
    />
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section aria-label={title} className="space-y-0.5">
      <div className="flex h-9 items-center gap-1 pl-2 pr-1">
        <span className="flex-1 text-sm font-medium">{title}</span>
        {action}
        <Button
          variant="ghost"
          size="icon-xs"
          className="rounded-full"
          aria-label={translate(open ? "planner.sidebar.collapse" : "planner.sidebar.expand", {
            title,
          })}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </Button>
      </div>
      {open && <ul>{children}</ul>}
    </section>
  );
}

function LayerRow({
  color,
  name,
  checked,
  count,
  onToggle,
}: {
  color: string;
  name: string;
  checked: boolean;
  count?: number;
  onToggle(): void;
}) {
  return (
    <li className="planning-sidebar-row">
      <ColorCheckbox
        color={color}
        checked={checked}
        label={translate(checked ? "planner.sidebar.hide" : "planner.sidebar.show", { name })}
        onChange={onToggle}
      />
      <span className="min-w-0 flex-1 truncate" title={name}>
        {name}
      </span>
      {count !== undefined && (
        <span className="text-tiny tabular-nums text-muted-foreground">{count}</span>
      )}
    </li>
  );
}

export function PlanningSidebar({
  mode,
  snapshot,
  date,
  today,
  hidden,
  weekStartsOn,
  showWeekNumbers,
  taskFilter,
  onDate,
  onToggleLayer,
  onCreateEvent,
  onCreateTask,
  onManageCalendars,
  onCreateList,
  onTaskFilter,
}: {
  mode: "calendar" | "tasks";
  snapshot: PlanningSnapshot;
  date: string;
  today: string;
  hidden: Set<string>;
  weekStartsOn: "monday" | "sunday";
  showWeekNumbers: boolean;
  taskFilter: TaskFilter;
  onDate(date: string): void;
  onToggleLayer(id: string): void;
  onCreateEvent(): void;
  onCreateTask(): void;
  onManageCalendars(): void;
  onCreateList(): void;
  onTaskFilter(filter: TaskFilter): void;
}) {
  const [month, setMonth] = useState(date);
  const [lastDate, setLastDate] = useState(date);
  if (date !== lastDate) {
    setLastDate(date);
    setMonth(date);
  }
  const openCount = (groupId: string) =>
    snapshot.todos.filter(
      (t) => !t.deletedAt && t.status === "open" && (t.groupId ?? "") === groupId,
    ).length;
  const lists = taskLists(snapshot);
  const own = snapshot.calendars.filter((c) => !c.readOnly);
  const other = snapshot.calendars.filter((c) => c.readOnly);
  return (
    <nav className="planning-sidebar" aria-label={translate("planner.sidebar.label")}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="secondary"
              className="planning-create shadow-sm ring-1 ring-border/60 transition-shadow hover:shadow-md"
              data-planning-create
            />
          }
          aria-label={translate("planner.sidebar.create")}
        >
          <Plus className="size-5" />
          {translate("planner.sidebar.create")}
          <ChevronDown className="size-4 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-36">
          <DropdownMenuItem onClick={onCreateEvent}>
            <CalendarDays className="size-4" />
            {translate("planner.kind.event")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCreateTask}>
            <CheckCircle2 className="size-4" />
            {translate("planner.kind.task")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {mode === "calendar" ? (
        <>
          <MiniMonth
            month={month}
            selected={date}
            today={today}
            weekStartsOn={weekStartsOn}
            showWeekNumbers={showWeekNumbers}
            onMonth={setMonth}
            onSelect={onDate}
          />
          <Section
            title={translate("planner.sidebar.myCalendars")}
            action={
              <Button
                variant="ghost"
                size="icon-xs"
                className="rounded-full"
                aria-label={translate("planner.toolbar.manageCalendars")}
                onClick={onManageCalendars}
              >
                <Settings2 className="size-4" />
              </Button>
            }
          >
            {own.map((c) => (
              <LayerRow
                key={c.id}
                color={c.color}
                name={calendarName(c)}
                checked={!hidden.has(c.id)}
                onToggle={() => onToggleLayer(c.id)}
              />
            ))}
          </Section>
          <Section title={translate("planner.sidebar.taskLists")}>
            {lists.map((list) => (
              <LayerRow
                key={list.id}
                color={list.color}
                name={list.name}
                checked={!hidden.has(taskListLayer(list.id))}
                onToggle={() => onToggleLayer(taskListLayer(list.id))}
              />
            ))}
          </Section>
          {other.length > 0 && (
            <Section title={translate("planner.sidebar.otherCalendars")}>
              {other.map((c) => (
                <LayerRow
                  key={c.id}
                  color={c.color}
                  name={calendarName(c)}
                  checked={!hidden.has(c.id)}
                  onToggle={() => onToggleLayer(c.id)}
                />
              ))}
            </Section>
          )}
        </>
      ) : (
        <>
          <ul className="space-y-0.5">
            {(
              [
                ["all", translate("planner.sidebar.allTasks"), CheckCircle2],
                ["starred", translate("planner.starred"), Star],
              ] as const
            ).map(([id, label, Icon]) => (
              <li key={id}>
                <button
                  type="button"
                  className="planning-nav-item"
                  aria-current={taskFilter === id ? "page" : undefined}
                  onClick={() => onTaskFilter(id)}
                >
                  <Icon className="size-4" />
                  {label}
                </button>
              </li>
            ))}
          </ul>
          <Section title={translate("planner.sidebar.taskLists")}>
            {lists.map((list) => (
              <LayerRow
                key={list.id}
                color={list.color}
                name={list.name}
                count={openCount(list.id)}
                checked={!hidden.has(taskListLayer(list.id))}
                onToggle={() => onToggleLayer(taskListLayer(list.id))}
              />
            ))}
          </Section>
          <button type="button" className="planning-nav-item" onClick={onCreateList}>
            <Plus className="size-4" />
            {translate("planner.list.new")}
          </button>
        </>
      )}
    </nav>
  );
}
