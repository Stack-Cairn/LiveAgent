import { DEFAULT_LOCALE, t as hostTranslate, type Locale } from "@liveagent/app/i18n/config";

export type PlanningVars = Record<string, string | number>;

// Pure helpers (time labels, store errors) run outside React; the Planning page keeps this
// in sync with the UI locale on every render so they format in the same language.
let currentLocale: Locale = DEFAULT_LOCALE;

/** BCP-47 tag for Intl date/number formatting in the current UI language. */
export function planningDateLocale(locale: Locale = currentLocale) {
  return locale === "en-US" ? "en-US" : "zh-CN";
}

/** Chinese lunar dates are only offered in the Chinese UI. */
export function planningLunarAvailable(locale: Locale = currentLocale) {
  return locale === "zh-CN";
}

/** Called by the Planning page on every render with the UI locale. */
export function setPlanningLocale(locale: Locale) {
  currentLocale = locale;
}

export function format(message: string, vars?: PlanningVars) {
  if (!vars) return message;
  return message.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  );
}

/** Translate a Planning message in the current UI locale (for non-React helpers). */
export function translate(key: string, vars?: PlanningVars, locale: Locale = currentLocale) {
  return format(hostTranslate(key, locale), vars);
}

const DEFAULT_CALENDARS: Record<string, string> = {
  工作: "planner.calendar.defaultWork",
  个人: "planner.calendar.defaultPersonal",
};

/**
 * Calendars seeded on first run keep their Chinese names in data; show them localized while
 * the seeded name is unchanged (recoloring or making one default must not revert to Chinese).
 */
export function calendarName(calendar: { name: string; sourceKind: string }) {
  const key = calendar.sourceKind === "local" && DEFAULT_CALENDARS[calendar.name];
  return key ? translate(key) : calendar.name;
}

/** Narrow weekday headers ("一" / "M") starting at the configured first day. */
export function weekdayNames(weekStartsOn: "monday" | "sunday" = "monday") {
  const format = new Intl.DateTimeFormat(planningDateLocale(), {
    weekday: "narrow",
    timeZone: "UTC",
  });
  // 2024-01-01 is a Monday, 2023-12-31 a Sunday.
  const first = Date.UTC(2024, 0, weekStartsOn === "sunday" ? 0 : 1, 12);
  return Array.from({ length: 7 }, (_, i) => {
    const at = new Date(first + i * 86_400_000);
    return { weekday: at.getUTCDay(), label: format.format(at) };
  });
}

const ERROR_PATTERN = /^E:([a-z0-9_]+)(?::([\s\S]*))?$/;

/**
 * Backend errors are stable codes (`E:code` or `E:code:detail`) so every client can
 * localize them; anything else (network, OS errors) is shown as-is.
 */
export function localizePlanningError(error: unknown, locale: Locale = currentLocale) {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const match = raw.trim().match(ERROR_PATTERN);
  if (!match) return raw;
  const key = `planner.error.${match[1]}`;
  const message = hostTranslate(key, locale);
  if (message === key) return raw;
  return format(message, { detail: match[2] ?? "" });
}
