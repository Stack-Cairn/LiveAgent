import { translate } from "./i18n";
import type { EventTime, PlanningEvent } from "./types";
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(zone, value);
  }
  return value;
}
export function zonedParts(epoch: number, zone: string) {
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(epoch)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}
export function addDays(day: string, amount: number) {
  const epoch = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(epoch)) throw new Error(translate("planner.time.invalidDate"));
  return new Date(epoch + amount * 86_400_000).toISOString().slice(0, 10);
}
export function weekStart(day: string) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}
export type WeekStart = "monday" | "sunday";
/** First day of the calendar week containing `day`. */
export function calendarWeekStart(day: string, weekStartsOn: WeekStart = "monday") {
  const monday = weekStart(day);
  if (weekStartsOn === "monday") return monday;
  return addDays(monday, new Date(`${day}T12:00:00Z`).getUTCDay() === 0 ? 6 : -1);
}
/** Month grid days; `fixed` keeps six weeks so compact pickers never change height. */
export function monthDays(day: string, weekStartsOn: WeekStart = "monday", fixed = true) {
  const first = `${day.slice(0, 7)}-01`;
  const start = calendarWeekStart(first, weekStartsOn);
  const lead = Math.round(
    (Date.parse(`${first}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000,
  );
  const length = new Date(
    Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 0),
  ).getUTCDate();
  const count = fixed ? 42 : Math.ceil((lead + length) / 7) * 7;
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}
/** 返回所有实际对应的时刻：0 项为 DST 缺口，2 项为回拨重复时刻。 */
export function localCandidates(day: string, clock: string, zone: string): number[] {
  const nominal = Date.parse(`${day}T${clock}:00Z`);
  if (!Number.isFinite(nominal)) return [];
  const offsets = new Set<number>();
  for (let h = -36; h <= 36; h += 6) {
    const sample = nominal + h * HOUR;
    const parts = zonedParts(sample, zone);
    offsets.add(Date.parse(`${parts.date}T${parts.time}:00Z`) - sample);
  }
  return [...offsets]
    .map((offset) => nominal - offset)
    .filter((value) => {
      const parts = zonedParts(value, zone);
      return parts.date === day && parts.time === clock;
    })
    .sort((a, b) => a - b);
}
export function localEpoch(day: string, clock: string, zone: string, fold = 0) {
  const matches = localCandidates(day, clock, zone);
  const value = matches[fold];
  if (value === undefined) throw new Error(translate("planner.time.gapTime"));
  return value;
}
const midnightCache = new Map<string, number>();
export function dayStart(day: string, zone: string): number {
  const key = `${zone}:${day}`;
  const cached = midnightCache.get(key);
  if (cached !== undefined) return cached;
  for (let m = 0; m < 180; m += 1) {
    const clock = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const candidate = localCandidates(day, clock, zone)[0];
    if (candidate !== undefined) {
      midnightCache.set(key, candidate);
      return candidate;
    }
  }
  throw new Error(translate("planner.time.gapDate"));
}
export function timeBounds(time: EventTime): [number, number] {
  return time.kind === "timed"
    ? [time.startAt, time.endAt]
    : [dayStart(time.startDate, time.timeZone), dayStart(time.endDateExclusive, time.timeZone)];
}
export function eventTitle(event: PlanningEvent, todos: readonly { id: string; title: string }[]) {
  return todos.find((t) => t.id === event.todoId)?.title ?? event.titleOverride ?? event.title;
}
export function durationLabel(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return (
    [
      h ? translate("planner.time.hours", { count: h }) : "",
      m ? translate("planner.time.minutes", { count: m }) : "",
    ]
      .filter(Boolean)
      .join(" ") || translate("planner.time.minutes", { count: 0 })
  );
}
export function timeLabel(time: EventTime, zone = time.timeZone) {
  if (time.kind === "allDay")
    return `${translate("planner.allDay")} · ${time.startDate}${addDays(time.startDate, 1) === time.endDateExclusive ? "" : ` – ${addDays(time.endDateExclusive, -1)}`}`;
  const start = zonedParts(time.startAt, zone),
    end = zonedParts(time.endAt, zone);
  return `${start.time}–${start.date === end.date ? "" : `${end.date} `}${end.time} · ${durationLabel((time.endAt - time.startAt) / MINUTE)}`;
}
