import { CRON_LAYER_COLOR, CRON_LAYER_ID } from "./cronLayer";
import { calendarName, translate } from "./i18n";
import { listColor, taskListLayer, taskLists } from "./taskLists";
import type { PlanningEvent, PlanningSnapshot } from "./types";

/**
 * One place that answers "what is this layer and what color is it" for calendars, task lists
 * and the scheduled-task layer. Grids, sidebar, previews, settings and the manager read it.
 */
export type LayerRef =
  | { kind: "calendar"; id: string }
  /** "" is the built-in "My Tasks". */
  | { kind: "taskList"; id: string }
  | { kind: "cron" };
export type LayerGroup = "mine" | "tasks" | "other" | "cron";
export interface LayerInfo {
  ref: LayerRef;
  /** The visibility key used by hidden layers. */
  layerId: string;
  group: LayerGroup;
  name: string;
  color: string;
  isDefault?: boolean;
  subscription?: boolean;
  readOnly?: boolean;
}

/** Shared palette for calendars, task lists and the scheduled-task layer. */
export const PLANNING_COLORS = [
  "#2563EB",
  "#0F766E",
  "#16A34A",
  "#7C3AED",
  "#DB2777",
  "#DC2626",
  "#D97706",
  "#64748B",
];

export function layerIdOf(ref: LayerRef) {
  if (ref.kind === "calendar") return ref.id;
  if (ref.kind === "taskList") return taskListLayer(ref.id);
  return CRON_LAYER_ID;
}

export function sameLayer(a: LayerRef, b: LayerRef) {
  return layerIdOf(a) === layerIdOf(b);
}

/** The layer an event belongs to: task blocks follow their list, events their calendar. */
export function eventLayer(event: PlanningEvent, snapshot: PlanningSnapshot): LayerRef {
  if (event.todoId)
    return {
      kind: "taskList",
      id: snapshot.todos.find((t) => t.id === event.todoId)?.groupId ?? "",
    };
  return event.calendarId === CRON_LAYER_ID
    ? { kind: "cron" }
    : { kind: "calendar", id: event.calendarId };
}

export function layerColor(
  snapshot: Pick<PlanningSnapshot, "calendars" | "groups" | "myTasksColor">,
  ref: LayerRef,
  cronColor: string = CRON_LAYER_COLOR,
): string | undefined {
  if (ref.kind === "taskList") return listColor(snapshot, ref.id);
  if (ref.kind === "cron")
    return snapshot.calendars.find((c) => c.id === CRON_LAYER_ID)?.color ?? cronColor;
  return snapshot.calendars.find((c) => c.id === ref.id)?.color;
}

/** Every layer in display order: my calendars, task lists, other calendars, scheduled tasks. */
export function listLayers(snapshot: PlanningSnapshot, cronColor: string): LayerInfo[] {
  const calendars = snapshot.calendars.filter((c) => c.id !== CRON_LAYER_ID);
  const calendar = (c: (typeof calendars)[number], group: LayerGroup): LayerInfo => ({
    ref: { kind: "calendar", id: c.id },
    layerId: c.id,
    group,
    name: calendarName(c),
    color: c.color,
    isDefault: c.isDefault,
    subscription: c.sourceKind === "subscription",
    readOnly: c.readOnly,
  });
  return [
    ...calendars.filter((c) => !c.readOnly).map((c) => calendar(c, "mine")),
    ...taskLists(snapshot).map(
      (list): LayerInfo => ({
        ref: { kind: "taskList", id: list.id },
        layerId: taskListLayer(list.id),
        group: "tasks",
        name: list.name,
        color: list.color ?? listColor(snapshot, list.id),
      }),
    ),
    ...calendars.filter((c) => c.readOnly).map((c) => calendar(c, "other")),
    {
      ref: { kind: "cron" },
      layerId: CRON_LAYER_ID,
      group: "cron",
      name: translate("planner.cron.layer"),
      color: cronColor,
    },
  ];
}

/** A palette color not used yet (case-insensitive), cycling once every color is taken. */
export function nextPaletteColor(used: readonly (string | undefined)[]) {
  const taken = new Set(used.filter(Boolean).map((c) => (c as string).toLowerCase()));
  return (
    PLANNING_COLORS.find((c) => !taken.has(c.toLowerCase())) ??
    PLANNING_COLORS[taken.size % PLANNING_COLORS.length]
  );
}
