import type {
  CronDaySummary,
  CronOccurrencesResponse,
  CronOccurrenceTask,
  CronRunSummary,
} from "../automation/types";
import { translate } from "./i18n";
import { addDays, MINUTE } from "./time";
import type { PlanningCalendar, PlanningEvent, PlanningSnapshot } from "./types";

/** Virtual calendar id of the read-only scheduled-task layer. */
export const CRON_LAYER_ID = "cron";
/**
 * Layer color: a neutral slate that keeps white text readable in both themes and does not
 * compete with user calendar colors. Calendar colors are hex user data, so the layer uses the
 * same format.
 */
export const CRON_LAYER_COLOR = "#64748b";
/** Minimum block length so instant runs and planned fires stay clickable in the time grid. */
export const CRON_MIN_BLOCK_MS = 15 * MINUTE;

const PREFIX = `${CRON_LAYER_ID}:`;

export type CronEventRef =
  | { kind: "occurrence"; taskId: string; at: number }
  | { kind: "run"; runId: string }
  | { kind: "day"; taskId: string; date: string };

export function cronLayerCalendar(): PlanningCalendar {
  return {
    id: CRON_LAYER_ID,
    name: translate("planner.cron.layer"),
    color: CRON_LAYER_COLOR,
    sortOrder: Number.MAX_SAFE_INTEGER,
    isDefault: false,
    reminderMinutes: null,
    sourceKind: CRON_LAYER_ID,
    readOnly: true,
    revision: 0,
  };
}

export function isCronEvent(event: Pick<PlanningEvent, "id" | "calendarId">) {
  return event.calendarId === CRON_LAYER_ID && event.id.startsWith(PREFIX);
}

export function occurrenceEventId(taskId: string, at: number) {
  return `${PREFIX}occ:${taskId}:${at}`;
}
export function runEventId(runId: string) {
  return `${PREFIX}run:${runId}`;
}
export function dayEventId(taskId: string, date: string) {
  return `${PREFIX}day:${taskId}:${date}`;
}

/** Inverse of the id builders; task ids may contain ":", so the last segment is split off. */
export function parseCronEventId(id: string): CronEventRef | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const split = (value: string) => {
    const index = value.lastIndexOf(":");
    return index > 0 ? [value.slice(0, index), value.slice(index + 1)] : null;
  };
  if (rest.startsWith("run:")) {
    const runId = rest.slice("run:".length);
    return runId ? { kind: "run", runId } : null;
  }
  if (rest.startsWith("occ:")) {
    const parts = split(rest.slice("occ:".length));
    const at = parts ? Number(parts[1]) : Number.NaN;
    return parts && Number.isSafeInteger(at) ? { kind: "occurrence", taskId: parts[0], at } : null;
  }
  if (rest.startsWith("day:")) {
    const parts = split(rest.slice("day:".length));
    return parts && /^\d{4}-\d{2}-\d{2}$/.test(parts[1])
      ? { kind: "day", taskId: parts[0], date: parts[1] }
      : null;
  }
  return null;
}

export function runFailed(run: Pick<CronRunSummary, "state" | "success">) {
  return run.state === "expired" || (run.state === "done" && !run.success);
}

function runTitle(run: CronRunSummary, name: string) {
  const key =
    run.state === "pending" || run.state === "leased"
      ? "planner.cron.runTitle.running"
      : runFailed(run)
        ? "planner.cron.runTitle.failed"
        : "planner.cron.runTitle.success";
  return translate(key, { name });
}

export function summaryTitle(summary: CronDaySummary, name: string) {
  const count = `${summary.planned + summary.ran}${summary.plannedTruncated ? "+" : ""}`;
  return summary.failed > 0
    ? translate("planner.cron.summaryFailed", { name, count, failed: summary.failed })
    : translate("planner.cron.summary", { name, count });
}

function virtualEvent(
  id: string,
  title: string,
  time: PlanningEvent["time"],
  updatedAt: number,
): PlanningEvent {
  return {
    id,
    calendarId: CRON_LAYER_ID,
    title,
    notes: "",
    time,
    revision: 0,
    createdAt: updatedAt,
    updatedAt,
  };
}

/** Maps planned fires, real runs and day summaries to read-only calendar events. */
export function cronVirtualEvents(response: CronOccurrencesResponse, zone: string) {
  const tasks = new Map<string, CronOccurrenceTask>(response.tasks.map((task) => [task.id, task]));
  const events: PlanningEvent[] = [];
  for (const occurrence of response.occurrences) {
    const task = tasks.get(occurrence.taskId);
    if (!task) continue;
    events.push(
      virtualEvent(
        occurrenceEventId(task.id, occurrence.at),
        task.name,
        {
          kind: "timed",
          startAt: occurrence.at,
          endAt: occurrence.at + CRON_MIN_BLOCK_MS,
          timeZone: zone,
        },
        response.now,
      ),
    );
  }
  for (const run of response.runs) {
    const task = tasks.get(run.taskId);
    if (!task) continue;
    events.push(
      virtualEvent(
        runEventId(run.id),
        runTitle(run, task.name),
        {
          kind: "timed",
          startAt: run.startedAt,
          endAt: run.startedAt + Math.max(run.durationMs, CRON_MIN_BLOCK_MS),
          timeZone: zone,
        },
        response.now,
      ),
    );
  }
  for (const summary of response.summaries) {
    const task = tasks.get(summary.taskId);
    if (!task) continue;
    events.push(
      virtualEvent(
        dayEventId(task.id, summary.date),
        summaryTitle(summary, task.name),
        {
          kind: "allDay",
          startDate: summary.date,
          endDateExclusive: addDays(summary.date, 1),
          timeZone: zone,
        },
        response.now,
      ),
    );
  }
  return events;
}

/** Derived snapshot for the calendar views only; the original snapshot is never mutated. */
export function withCronLayer(snapshot: PlanningSnapshot, events: PlanningEvent[]) {
  return {
    ...snapshot,
    calendars: [...snapshot.calendars, cronLayerCalendar()],
    events: [...snapshot.events, ...events],
  };
}
