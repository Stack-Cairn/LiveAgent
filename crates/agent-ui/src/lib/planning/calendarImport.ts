import ICAL from "ical.js";
import JSZip from "jszip";
import PostalMime from "postal-mime";
import { translate } from "./i18n";
import { addDays, dayStart, localEpoch, timeBounds } from "./time";
import type { EventTime } from "./types";
export interface CalendarImportEntry {
  uid: string;
  title: string;
  notes: string;
  time: EventTime;
}
/** A Google Tasks item from a Takeout export. */
export interface TaskImportEntry {
  uid: string;
  list: string;
  title: string;
  notes: string;
  status: "open" | "completed";
  dueDate?: string;
  completedAt?: number;
  parentUid?: string;
}
export interface ImportPreview {
  entries: CalendarImportEntry[];
  tasks: TaskImportEntry[];
  warnings: string[];
}
/** Backend batch size for `calendar.import` / `todo.import`. */
export const IMPORT_BATCH = 200;
const MAX_ENTRIES = 5000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ZIP_BYTES = 100 * 1024 * 1024;
type IcalTime = InstanceType<typeof ICAL.Time>;
type IcalEvent = InstanceType<typeof ICAL.Event>;
function calendarTime(value: IcalTime, event: IcalEvent, end: boolean, fallback: string) {
  const property =
    event.component.getFirstProperty(end ? "dtend" : "dtstart") ??
    event.component.getFirstProperty("dtstart");
  const zone = String(property?.getParameter("tzid") ?? fallback);
  if (value.zone && value.zone.tzid !== "floating") return value.toUnixTime() * 1000;
  const date = value.toString().slice(0, 10),
    clock = `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
  return localEpoch(date, clock, zone) + value.second * 1000;
}
export interface ParseRange {
  from: string;
  to: string;
  zone: string;
  /** Subscriptions mirror a wider window than manual imports. */
  maxDays?: number;
}
/**
 * ical.js requires the text to start at `BEGIN:VCALENDAR`; a UTF-8 BOM, zero-width
 * characters or any preamble line makes it throw an internal "designSet.propertyGroups"
 * TypeError. Some feeds ship a BOM, and a wrong Google URL returns an HTML page instead.
 */
function parseIcs(text: string) {
  const start = text.search(/BEGIN:VCALENDAR/i);
  if (start < 0)
    throw Error(
      translate(
        /^\s*</.test(text.replace(/^[\uFEFF\u200B]+/, ""))
          ? "planner.import.htmlNotIcs"
          : "planner.import.notIcs",
      ),
    );
  try {
    return ICAL.parse(text.slice(start));
  } catch (error) {
    throw Error(
      translate("planner.import.invalidIcs", {
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export function parseCalendar(
  text: string,
  { from, to, zone, maxDays = 367 }: ParseRange,
): ImportPreview {
  const first = dayStart(from, zone),
    last = dayStart(addDays(to, 1), zone);
  if (last <= first || last - first > maxDays * 86400000)
    throw Error(translate("planner.import.rangeDays"));
  const root = new ICAL.Component(parseIcs(text));
  if (root.name !== "vcalendar") throw Error(translate("planner.import.notIcs"));
  if (root.getFirstPropertyValue("method") === "CANCEL")
    throw Error(translate("planner.import.cancelled"));
  const entries: CalendarImportEntry[] = [],
    warnings: string[] = [];
  const components = root.getAllSubcomponents("vevent");
  if (components.length > 5000) throw Error(translate("planner.import.tooManyItems"));
  const append = (event: IcalEvent, start: IcalTime, end: IcalTime, uid: string) => {
    if (event.component.getFirstPropertyValue("status") === "CANCELLED") return;
    const time: EventTime = start.isDate
      ? {
          kind: "allDay",
          startDate: start.toString().slice(0, 10),
          endDateExclusive: end.toString().slice(0, 10),
          timeZone: zone,
        }
      : {
          kind: "timed",
          startAt: calendarTime(start, event, false, zone),
          endAt: calendarTime(end, event, true, zone),
          timeZone: zone,
        };
    const [a, b] = timeBounds(time);
    if (b <= first || a >= last) return;
    if (b <= a || (time.kind === "timed" && b - a < 15 * 60000))
      throw Error(translate("planner.import.tooShort"));
    entries.push({
      uid,
      title: (event.summary || translate("planner.import.untitled")).slice(0, 500),
      notes: [
        event.description,
        event.location ? translate("planner.import.location", { location: event.location }) : "",
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 20000),
      time,
    });
  };
  for (const component of components) {
    const event = new ICAL.Event(component);
    if (event.isRecurrenceException()) continue;
    const checkpoint = entries.length;
    try {
      if (!event.uid) throw Error(translate("planner.import.missingUid"));
      if (event.isRecurring()) {
        const iterator = event.iterator();
        let attempts = 0;
        while (true) {
          if (++attempts > 20000) throw Error(translate("planner.import.recurrenceTooDense"));
          const next = iterator.next();
          if (!next) break;
          const occurrence = event.getOccurrenceDetails(next);
          // Include moved exceptions before ending the iteration.
          if (calendarTime(next, event, false, zone) >= last + 366 * 86400000) break;
          append(
            occurrence.item,
            occurrence.startDate,
            occurrence.endDate,
            `${event.uid}/${next.toString()}`,
          );
          if (entries.length > MAX_ENTRIES) throw Error(translate("planner.import.overLimit"));
        }
      } else append(event, event.startDate, event.endDate, event.uid);
    } catch (error) {
      entries.splice(checkpoint);
      warnings.push(
        translate("planner.import.warning", {
          title: event.summary || translate("planner.import.untitled"),
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  if (entries.length > MAX_ENTRIES) throw Error(translate("planner.import.overLimit"));
  return {
    entries: [...new Map(entries.map((entry) => [entry.uid, entry])).values()],
    tasks: [],
    warnings,
  };
}

type TakeoutTask = {
  id?: string;
  title?: string;
  notes?: string;
  status?: string;
  due?: string;
  completed?: string;
  parent?: string;
  deleted?: boolean;
  hidden?: boolean;
};
type TakeoutList = { title?: string; items?: TakeoutTask[] };

/** Google Takeout "Tasks.json": lists with tasks; parents are ordered before subtasks. */
export function parseGoogleTasks(text: string): TaskImportEntry[] {
  let root: { kind?: string; items?: TakeoutList[] };
  try {
    root = JSON.parse(text);
  } catch {
    throw Error(translate("planner.import.notTasks"));
  }
  if (!Array.isArray(root?.items)) throw Error(translate("planner.import.notTasks"));
  const tasks: TaskImportEntry[] = [];
  for (const list of root.items) {
    for (const task of list.items ?? []) {
      if (!task.id || task.deleted || !task.title?.trim()) continue;
      const completedAt = task.completed ? Date.parse(task.completed) : Number.NaN;
      tasks.push({
        uid: task.id,
        list: (list.title ?? "").slice(0, 60),
        title: task.title.trim().slice(0, 500),
        notes: (task.notes ?? "").slice(0, 20000),
        status: task.status === "completed" ? "completed" : "open",
        ...(task.due && /^\d{4}-\d{2}-\d{2}/.test(task.due)
          ? { dueDate: task.due.slice(0, 10) }
          : {}),
        ...(Number.isFinite(completedAt) ? { completedAt } : {}),
        ...(task.parent ? { parentUid: task.parent } : {}),
      });
    }
  }
  if (tasks.length > MAX_ENTRIES) throw Error(translate("planner.import.overLimit"));
  return tasks.sort((a, b) => Number(!!a.parentUid) - Number(!!b.parentUid));
}

function merge(target: ImportPreview, next: ImportPreview) {
  target.entries.push(...next.entries);
  target.tasks.push(...next.tasks);
  target.warnings.push(...next.warnings);
}

/** Google Calendar's export ZIP (one .ics per calendar) or a Takeout ZIP with Tasks.json. */
async function readZip(file: File, range: ParseRange): Promise<ImportPreview> {
  if (file.size > MAX_ZIP_BYTES) throw Error(translate("planner.import.tooLarge"));
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw Error(translate("planner.import.badZip"));
  }
  const result: ImportPreview = { entries: [], tasks: [], warnings: [] };
  let found = false;
  for (const entry of Object.values(zip.files)) {
    const name = entry.name.toLowerCase();
    if (entry.dir || name.split("/").some((part) => part.startsWith("__macosx"))) continue;
    if (name.endsWith(".ics")) {
      found = true;
      const label = entry.name.split("/").pop() ?? entry.name;
      try {
        merge(result, parseCalendar(await entry.async("string"), range));
      } catch (error) {
        result.warnings.push(
          translate("planner.import.warning", {
            title: label,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    } else if (name.endsWith("tasks.json")) {
      found = true;
      result.tasks.push(...parseGoogleTasks(await entry.async("string")));
    }
  }
  if (!found) throw Error(translate("planner.import.emptyZip"));
  return result;
}
export async function readCalendarFile(file: File, range: ParseRange): Promise<ImportPreview> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".zip")) return dedupe(await readZip(file, range));
  if (file.size > MAX_FILE_BYTES) throw Error(translate("planner.import.tooLarge"));
  if (name.endsWith(".json"))
    return { entries: [], tasks: parseGoogleTasks(await file.text()), warnings: [] };
  if (!name.endsWith(".eml")) return parseCalendar(await file.text(), range);
  const mail = await PostalMime.parse(await file.arrayBuffer(), {
    maxNestingDepth: 30,
    maxHeadersSize: 256000,
  });
  const invitations = mail.attachments.filter(
    (a) =>
      a.mimeType.toLowerCase() === "text/calendar" || a.filename?.toLowerCase().endsWith(".ics"),
  );
  if (!invitations.length) throw Error(translate("planner.import.noInvitation"));
  const result: ImportPreview = { entries: [], tasks: [], warnings: [] };
  for (const attachment of invitations) {
    const text =
      typeof attachment.content === "string"
        ? attachment.content
        : new TextDecoder().decode(attachment.content);
    merge(result, parseCalendar(text, range));
  }
  return dedupe(result);
}

function dedupe(result: ImportPreview): ImportPreview {
  if (result.entries.length > MAX_ENTRIES || result.tasks.length > MAX_ENTRIES)
    throw Error(translate("planner.import.overLimit"));
  return {
    ...result,
    entries: [...new Map(result.entries.map((entry) => [entry.uid, entry])).values()],
    tasks: [...new Map(result.tasks.map((task) => [task.uid, task])).values()],
  };
}
