import type { Locale } from "@liveagent/app/i18n/config";
import { planningDateLocale, translate } from "./i18n";

const WEEKDAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function number(field: string, min: number, max: number) {
  if (!/^\d{1,2}$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

/** "*" → 1, "*\/N" or "0/N" → N; anything else is not a plain step. */
function step(field: string, max: number) {
  if (field === "*") return 1;
  const match = field.match(/^(?:\*|0)\/(\d{1,2})$/);
  if (!match) return null;
  const value = Number(match[1]);
  return value >= 1 && value <= max ? value : null;
}

function weekday(field: string) {
  const index = WEEKDAY_NAMES.indexOf(field.toUpperCase());
  if (index >= 0) return index;
  const value = number(field, 0, 7);
  return value === null ? null : value % 7;
}

function every(unit: "second" | "minute" | "hour", count: number, locale: Locale) {
  return count === 1
    ? translate(`planner.cron.every.${unit}`, undefined, locale)
    : translate(`planner.cron.every.${unit}s`, { count }, locale);
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Human-readable description for common six-field cron shapes (seconds first, as used by the
 * scheduler). Anything outside these shapes falls back to the raw expression.
 */
export function describeCron(expression: string, locale: Locale) {
  const raw = expression.trim();
  const fields = raw.split(/\s+/);
  if (fields.length !== 6) return raw;
  const [second, minute, hour, dom, month, dow] = fields;
  const anyDay = (field: string) => field === "*" || field === "?";
  if (month !== "*" || !anyDay(dom) || !anyDay(dow)) {
    // Weekly / monthly shapes below need a fixed clock time.
    const time = clock(second, minute, hour);
    if (!time || month !== "*") return raw;
    if (anyDay(dom) && !anyDay(dow)) {
      const day = weekday(dow);
      if (day === null) return raw;
      const name = new Intl.DateTimeFormat(planningDateLocale(locale), {
        weekday: "long",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(2024, 0, 7 + day, 12)));
      return translate("planner.cron.weeklyAt", { weekday: name, time }, locale);
    }
    if (!anyDay(dom) && anyDay(dow)) {
      const day = number(dom, 1, 31);
      return day === null ? raw : translate("planner.cron.monthlyAt", { day, time }, locale);
    }
    return raw;
  }
  const secondStep = step(second, 59);
  if (secondStep !== null && minute === "*" && hour === "*") {
    return every("second", secondStep, locale);
  }
  if (second === "0") {
    const minuteStep = step(minute, 59);
    if (minuteStep !== null && hour === "*") return every("minute", minuteStep, locale);
    if (minute === "0") {
      const hourStep = step(hour, 23);
      if (hourStep !== null) return every("hour", hourStep, locale);
    }
  }
  const time = clock(second, minute, hour);
  return time ? translate("planner.cron.dailyAt", { time }, locale) : raw;
}

function clock(second: string, minute: string, hour: string) {
  if (second !== "0") return null;
  const m = number(minute, 0, 59);
  const h = number(hour, 0, 23);
  return m === null || h === null ? null : `${pad(h)}:${pad(m)}`;
}
