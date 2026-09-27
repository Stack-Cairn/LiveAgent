import { translate } from "./i18n";
import { addDays, HOUR, localEpoch } from "./time";
import type { EventTime } from "./types";

export interface DateTimeValue {
  date: string;
  time: string;
  endDate?: string;
  endTime?: string;
}
export function dateTimeEvent(value: DateTimeValue, zone: string): EventTime {
  if (!value.date) throw Error(translate("planner.dateTime.pickDate"));
  if (!value.time) {
    const end = value.endDate || value.date;
    if (end < value.date) throw Error(translate("planner.dateTime.endBeforeStart"));
    return {
      kind: "allDay",
      startDate: value.date,
      endDateExclusive: addDays(end, 1),
      timeZone: zone,
    };
  }
  const startAt = localEpoch(value.date, value.time, zone);
  const endAt = value.endTime
    ? localEpoch(value.endDate || value.date, value.endTime, zone)
    : startAt + HOUR;
  if (endAt - startAt < 15 * 60000) throw Error(translate("planner.dateTime.minDuration"));
  return { kind: "timed", startAt, endAt, timeZone: zone };
}
export function dateTimeLabel(value: DateTimeValue) {
  if (!value.date) return translate("planner.dateTime.label");
  const end = value.endDate && value.endDate !== value.date ? ` – ${value.endDate}` : "";
  return `${value.date}${end}${value.time ? ` · ${value.time}${value.endTime ? `–${value.endTime}` : ""}` : ` · ${translate("planner.allDay")}`}`;
}
export function moveDate(value: DateTimeValue, date: string): DateTimeValue {
  const days =
    value.date && value.endDate
      ? Math.round((Date.parse(value.endDate) - Date.parse(value.date)) / 86400000)
      : 0;
  return {
    ...value,
    date,
    ...(value.endDate ? { endDate: addDays(date, Math.max(0, days)) } : {}),
  };
}
