import { useSyncExternalStore } from "react";
import { taskListLayer } from "../../lib/planning/taskLists";
import { dayStart } from "../../lib/planning/time";
import type { PlanningEvent, PlanningSnapshot } from "../../lib/planning/types";

export function calendarLayer(event: PlanningEvent, snapshot: PlanningSnapshot) {
  return event.todoId
    ? taskListLayer(snapshot.todos.find((t) => t.id === event.todoId)?.groupId)
    : event.calendarId;
}
export function activeEvent(event: PlanningEvent, snapshot: PlanningSnapshot) {
  const masters = snapshot.eventMasters ?? snapshot.events;
  return (
    !event.deletedAt &&
    !masters.some((e) => e.id === event.seriesId && e.deletedAt) &&
    !snapshot.todos.some((t) => t.id === event.todoId && t.deletedAt)
  );
}
export interface CalendarPreferences {
  showWeekNumbers: boolean;
  showLunar: boolean;
  showCompleted: boolean;
  showWeekends: boolean;
  weekStartsOn: "monday" | "sunday";
  view: "day" | "week" | "month" | "agenda";
  /** Only render working hours in day/week views. */
  workHoursOnly: boolean;
  workStart: number;
  workEnd: number;
  /** Overlay the read-only scheduled-task (cron) layer on the calendar views. */
  showCronTasks: boolean;
}
/** Minimum hour height in day/week views (Google uses 48px); taller windows stretch it. */
export const HOUR_HEIGHT = 48;
const defaults: CalendarPreferences = {
  showWeekNumbers: true,
  showLunar: false,
  showCompleted: true,
  showWeekends: true,
  weekStartsOn: "monday",
  view: "week",
  workHoursOnly: false,
  workStart: 9,
  workEnd: 18,
  showCronTasks: false,
};
function workHours(start: unknown, end: unknown) {
  const valid =
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    (start as number) >= 0 &&
    (end as number) <= 24 &&
    (start as number) < (end as number);
  return valid
    ? { workStart: start as number, workEnd: end as number }
    : { workStart: defaults.workStart, workEnd: defaults.workEnd };
}
const STORAGE_KEY = "planning.display";
function loadPreferences(): CalendarPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      showWeekNumbers:
        typeof saved.showWeekNumbers === "boolean"
          ? saved.showWeekNumbers
          : defaults.showWeekNumbers,
      showLunar: saved.showLunar === true,
      showCompleted: saved.showCompleted !== false,
      showWeekends: saved.showWeekends !== false,
      weekStartsOn: saved.weekStartsOn === "sunday" ? "sunday" : "monday",
      view: ["day", "week", "month", "agenda"].includes(saved.view) ? saved.view : defaults.view,
      ...workHours(saved.workStart, saved.workEnd),
      workHoursOnly: saved.workHoursOnly === true,
      showCronTasks: saved.showCronTasks === true,
    };
  } catch {
    return defaults;
  }
}

// One shared copy: the calendar page and the settings overlay can be mounted together.
let preferences: CalendarPreferences | null = null;
const listeners = new Set<() => void>();
function currentPreferences() {
  preferences ??= loadPreferences();
  return preferences;
}
function subscribePreferences(listener: () => void) {
  listeners.add(listener);
  // Other windows (desktop multi-window, WebUI tabs) write the same key.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    preferences = loadPreferences();
    for (const notify of listeners) notify();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
export function updateCalendarPreferences(patch: Partial<CalendarPreferences>) {
  preferences = { ...currentPreferences(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    /* preferences remain usable in memory */
  }
  for (const notify of listeners) notify();
}
export function useCalendarPreferences() {
  const value = useSyncExternalStore(subscribePreferences, currentPreferences, currentPreferences);
  return [value, updateCalendarPreferences] as const;
}
export function isoWeek(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
}
export function lunarDate(date: string) {
  try {
    const parts = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).formatToParts(new Date(`${date}T12:00:00Z`));
    const day = Number(parts.find((p) => p.type === "day")?.value);
    const names = [
      "",
      "初一",
      "初二",
      "初三",
      "初四",
      "初五",
      "初六",
      "初七",
      "初八",
      "初九",
      "初十",
      "十一",
      "十二",
      "十三",
      "十四",
      "十五",
      "十六",
      "十七",
      "十八",
      "十九",
      "二十",
      "廿一",
      "廿二",
      "廿三",
      "廿四",
      "廿五",
      "廿六",
      "廿七",
      "廿八",
      "廿九",
      "三十",
    ];
    return day === 1
      ? (parts.find((p) => p.type === "month")?.value ?? "初一")
      : (names[day] ?? "");
  } catch {
    return "";
  }
}
export function lunarMonth(date: string) {
  try {
    return (
      new Intl.DateTimeFormat("zh-CN-u-ca-chinese", { month: "long", timeZone: "UTC" })
        .formatToParts(new Date(`${date}T12:00:00Z`))
        .find((p) => p.type === "month")?.value ?? ""
    );
  } catch {
    return "";
  }
}
export function zoneOffset(date: string, zone: string) {
  return (
    new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(dayStart(date, zone))
      .find((p) => p.type === "timeZoneName")?.value ?? zone
  );
}
