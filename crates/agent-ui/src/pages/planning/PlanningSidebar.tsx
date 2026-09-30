import { type CSSProperties, createContext, type ReactNode, useContext, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  MoreHorizontal,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Label } from "../../components/ui/label";
import { CRON_LAYER_COLOR } from "../../lib/planning/cronLayer";
import { calendarName, translate } from "../../lib/planning/i18n";
import { type LayerRef, listLayers, PLANNING_COLORS } from "../../lib/planning/layers";
import { taskListLayer, taskLists } from "../../lib/planning/taskLists";
import type { PlanningSnapshot } from "../../lib/planning/types";
import { useCalendarPreferences } from "./calendarDisplay";
import { recolorLayer } from "./layerActions";
import { colorName } from "./PlanningControls";

const CRON_COLORS = [
  CRON_LAYER_COLOR,
  ...PLANNING_COLORS.filter((c) => c.toLowerCase() !== CRON_LAYER_COLOR),
];

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
  /** The visible name; Base UI's checkbox does not take it from a wrapping label. */
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

/** Lets every layer row offer recolor / manage without threading props through sections. */
const LayerMenuContext = createContext<{
  snapshot: PlanningSnapshot;
  onManage?(ref: LayerRef): void;
  onError?(error: unknown): void;
} | null>(null);

function LayerRow({
  layer,
  color,
  name,
  checked,
  count,
  onToggle,
}: {
  layer?: LayerRef;
  color: string;
  name: string;
  checked: boolean;
  count?: number;
  onToggle(): void;
}) {
  const menu = useContext(LayerMenuContext);
  const base = layer?.kind === "cron" ? CRON_COLORS : PLANNING_COLORS;
  const current = base.find((c) => c.toLowerCase() === color.toLowerCase());
  const palette = current ? base : [color, ...base];
  return (
    <li className="group/row flex items-center">
      {/* The whole row is the checkbox's label, so the name toggles it too. */}
      <Label className="planning-sidebar-row min-w-0 flex-1 cursor-pointer text-sm font-normal">
        <ColorCheckbox color={color} checked={checked} label={name} onChange={onToggle} />
        <span className="min-w-0 flex-1 truncate" title={name}>
          {name}
        </span>
        {count !== undefined && (
          <span className="text-tiny tabular-nums text-muted-foreground">{count}</span>
        )}
      </Label>
      {menu && layer && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="shrink-0 rounded-full opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-[popup-open]:opacity-100 [@media(hover:none)]:opacity-100"
              />
            }
            aria-label={translate("planner.layers.rowActions", { name })}
          >
            <MoreHorizontal className="size-4 rotate-90" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuRadioGroup
              value={current ?? color}
              onValueChange={(next) =>
                void recolorLayer(menu.snapshot, layer, String(next)).catch((e) =>
                  menu.onError?.(e),
                )
              }
            >
              {palette.map((swatch) => (
                <DropdownMenuRadioItem key={swatch} value={swatch}>
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="size-3 shrink-0 rounded-full ring-1 ring-border"
                      style={{ backgroundColor: swatch }}
                    />
                    {colorName(swatch)}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {menu.onManage && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="gap-2" onClick={() => menu.onManage?.(layer)}>
                  {translate("planner.layers.open")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

/**
 * Flat calendar / task-list visibility checklist for places without the sidebar (the ⋮
 * popover on narrow windows). Uses the same layers and rows as the sidebar sections.
 */
export function LayerChecklist({
  snapshot,
  hidden,
  onToggleLayer,
  showCron,
  onToggleCron,
  onManageLayer,
  onError,
}: {
  snapshot: PlanningSnapshot;
  hidden: Set<string>;
  onToggleLayer(id: string): void;
  showCron: boolean;
  onToggleCron(): void;
  onManageLayer?(ref: LayerRef): void;
  onError?(error: unknown): void;
}) {
  const [{ cronColor }] = useCalendarPreferences();
  const layers = listLayers(snapshot, cronColor);
  const groups = (["mine", "tasks", "other"] as const).map((group) => ({
    group,
    title: translate(
      group === "mine"
        ? "planner.sidebar.myCalendars"
        : group === "tasks"
          ? "planner.sidebar.taskLists"
          : "planner.sidebar.otherCalendars",
    ),
    // The scheduled-task layer is listed last under "Other calendars", as in the sidebar.
    rows: layers.filter((l) => l.group === group || (group === "other" && l.group === "cron")),
  }));
  return (
    <LayerMenuContext.Provider value={{ snapshot, onManage: onManageLayer, onError }}>
      <div className="space-y-3">
        {groups.map((group) => (
          <section key={group.group} aria-label={group.title} className="space-y-1">
            <h4 className="text-xs font-medium text-muted-foreground">{group.title}</h4>
            <ul className="-mx-2">
              {group.rows.map((row) => (
                <LayerRow
                  key={row.layerId}
                  layer={row.ref}
                  color={row.color}
                  name={row.name}
                  checked={row.group === "cron" ? showCron : !hidden.has(row.layerId)}
                  onToggle={() =>
                    row.group === "cron" ? onToggleCron() : onToggleLayer(row.layerId)
                  }
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </LayerMenuContext.Provider>
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
  showCron,
  onToggleCron,
  onManageLayer,
  onError,
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
  /** Read-only scheduled-task layer, listed last under "Other calendars". */
  showCron: boolean;
  onToggleCron(): void;
  /** Opens 「日历与列表」 on a row, from the row's ⋮ menu. */
  onManageLayer?(ref: LayerRef): void;
  onError?(error: unknown): void;
}) {
  const [{ cronColor }] = useCalendarPreferences();
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
    <LayerMenuContext.Provider value={{ snapshot, onManage: onManageLayer, onError }}>
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
            <DropdownMenuItem className="gap-2" onClick={onCreateEvent}>
              <CalendarDays className="size-4" />
              {translate("planner.kind.event")}
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2" onClick={onCreateTask}>
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
                  layer={{ kind: "calendar", id: c.id }}
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
                  layer={{ kind: "taskList", id: list.id }}
                  color={list.color}
                  name={list.name}
                  checked={!hidden.has(taskListLayer(list.id))}
                  onToggle={() => onToggleLayer(taskListLayer(list.id))}
                />
              ))}
            </Section>
            <Section title={translate("planner.sidebar.otherCalendars")}>
              {other.map((c) => (
                <LayerRow
                  key={c.id}
                  layer={{ kind: "calendar", id: c.id }}
                  color={c.color}
                  name={calendarName(c)}
                  checked={!hidden.has(c.id)}
                  onToggle={() => onToggleLayer(c.id)}
                />
              ))}
              <LayerRow
                layer={{ kind: "cron" }}
                color={cronColor}
                name={translate("planner.cron.layer")}
                checked={showCron}
                onToggle={onToggleCron}
              />
            </Section>
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
                  layer={{ kind: "taskList", id: list.id }}
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
    </LayerMenuContext.Provider>
  );
}
