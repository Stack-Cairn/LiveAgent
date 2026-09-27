import ICAL from "ical.js";
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
export interface ImportPreview {
  entries: CalendarImportEntry[];
  warnings: string[];
}
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
export function parseCalendar(
  text: string,
  { from, to, zone }: { from: string; to: string; zone: string },
): ImportPreview {
  const first = dayStart(from, zone),
    last = dayStart(addDays(to, 1), zone);
  if (last <= first || last - first > 367 * 86400000)
    throw Error(translate("planner.import.rangeDays"));
  const root = new ICAL.Component(ICAL.parse(text));
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
          if (entries.length > 200) throw Error(translate("planner.import.over200"));
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
  if (entries.length > 200) throw Error(translate("planner.import.over200"));
  return { entries: [...new Map(entries.map((entry) => [entry.uid, entry])).values()], warnings };
}
export async function readCalendarFile(
  file: File,
  range: { from: string; to: string; zone: string },
): Promise<ImportPreview> {
  if (file.size > 5 * 1024 * 1024) throw Error(translate("planner.import.tooLarge"));
  if (!file.name.toLowerCase().endsWith(".eml")) return parseCalendar(await file.text(), range);
  const mail = await PostalMime.parse(await file.arrayBuffer(), {
    maxNestingDepth: 30,
    maxHeadersSize: 256000,
  });
  const invitations = mail.attachments.filter(
    (a) =>
      a.mimeType.toLowerCase() === "text/calendar" || a.filename?.toLowerCase().endsWith(".ics"),
  );
  if (!invitations.length) throw Error(translate("planner.import.noInvitation"));
  const result: ImportPreview = { entries: [], warnings: [] };
  for (const attachment of invitations) {
    const text =
      typeof attachment.content === "string"
        ? attachment.content
        : new TextDecoder().decode(attachment.content);
    const preview = parseCalendar(text, range);
    result.entries.push(...preview.entries);
    result.warnings.push(...preview.warnings);
  }
  if (result.entries.length > 200) throw Error(translate("planner.import.over200"));
  return {
    ...result,
    entries: [...new Map(result.entries.map((entry) => [entry.uid, entry])).values()],
  };
}
