import type {
  AppSettings,
  EffectiveTheme,
  MemoryOrganizerFrequency,
  MemoryOrganizerMode,
  MemoryOrganizerSchedule,
  MemoryOrganizerScope,
  Theme,
} from "./types";

const SYSTEM_THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export function normalizeTheme(input: unknown): Theme {
  if (input === "dark") return "dark";
  if (input === "system" || input === "auto") return "system";
  return "light";
}

export function resolveEffectiveTheme(theme: Theme): EffectiveTheme {
  if (theme !== "system") return theme;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia(SYSTEM_THEME_MEDIA_QUERY).matches ? "dark" : "light";
}

export function getNextTheme(theme: Theme): Theme {
  if (theme === "light") return "dark";
  if (theme === "dark") return "system";
  return "light";
}

export function subscribeToSystemThemePreference(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }

  const query = window.matchMedia(SYSTEM_THEME_MEDIA_QUERY);
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }

  query.addListener(listener);
  return () => query.removeListener(listener);
}

function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

export function getDefaultMemoryOrganizerSchedule(): MemoryOrganizerSchedule {
  return {
    frequency: "none",
    timeLocal: "03:00",
    weekday: 1,
    timezone: localTimezone(),
  };
}

function normalizeMemoryOrganizerFrequency(input: unknown): MemoryOrganizerFrequency {
  if (input === "daily" || input === "weekly") return input;
  return "none";
}

function normalizeMemoryOrganizerTime(input: unknown) {
  const value = typeof input === "string" ? input.trim() : "";
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return "03:00";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? value : "03:00";
}

function normalizeMemoryOrganizerWeekday(input: unknown) {
  const value = typeof input === "number" ? input : Number(input);
  return Number.isInteger(value) && value >= 0 && value <= 6 ? value : 1;
}

export function normalizeMemoryOrganizerSchedule(input: unknown): MemoryOrganizerSchedule {
  const defaults = getDefaultMemoryOrganizerSchedule();
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    frequency: normalizeMemoryOrganizerFrequency(obj.frequency),
    timeLocal: normalizeMemoryOrganizerTime(obj.timeLocal),
    weekday: normalizeMemoryOrganizerWeekday(obj.weekday),
    timezone:
      typeof obj.timezone === "string" && obj.timezone.trim()
        ? obj.timezone.trim()
        : defaults.timezone,
  };
}

export function normalizeMemoryOrganizerScope(input: unknown): MemoryOrganizerScope {
  switch (input) {
    case "global":
    case "projects":
    case "current-project":
      return input;
    default:
      return "all";
  }
}

export function normalizeMemoryOrganizerMode(input: unknown): MemoryOrganizerMode {
  switch (input) {
    case "conservative":
    case "aggressive":
      return input;
    default:
      return "standard";
  }
}

export function normalizeOptionalTimestamp(input: unknown): number | undefined {
  const value = typeof input === "number" ? input : Number(input);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number };

function zonedParts(epoch: number, zone: string): ZonedParts | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(epoch);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    return {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour"),
      minute: get("minute"),
    };
  } catch {
    return null;
  }
}

/** Epoch of a wall-clock time in `zone` (DST gaps resolve to the shifted instant). */
function zonedEpoch(target: ZonedParts, zone: string): number {
  const wanted = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  let guess = wanted;
  for (let i = 0; i < 3; i += 1) {
    const actual = zonedParts(guess, zone);
    if (!actual) break;
    const shown = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    if (shown === wanted) break;
    guess += wanted - shown;
  }
  return guess;
}

/**
 * Next scheduled organizer run. `zone` is the app default time zone (Settings → General), so
 * "03:00" means 03:00 there; without it the schedule's own stored zone is used.
 */
export function computeNextMemoryOrganizerRunAt(
  schedule: MemoryOrganizerSchedule,
  from = Date.now(),
  zone: string = schedule.timezone,
): number | undefined {
  if (schedule.frequency === "none") {
    return undefined;
  }
  const [hourRaw, minuteRaw] = schedule.timeLocal.split(":");
  const hour = Number.isInteger(Number(hourRaw)) ? Number(hourRaw) : 3;
  const minute = Number.isInteger(Number(minuteRaw)) ? Number(minuteRaw) : 0;
  const today = zonedParts(from, zone);
  if (!today) return computeInBrowserZone(schedule, from, hour, minute);
  const targetWeekday = normalizeMemoryOrganizerWeekday(schedule.weekday);
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (schedule.frequency === "weekly" && date.getUTCDay() !== targetWeekday) continue;
    const at = zonedEpoch(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour,
        minute,
      },
      zone,
    );
    if (at > from) return at;
  }
  return undefined;
}

/** Fallback when the zone is not a valid IANA name: the browser's own local time. */
function computeInBrowserZone(
  schedule: MemoryOrganizerSchedule,
  from: number,
  hour: number,
  minute: number,
) {
  const candidate = new Date(from);
  candidate.setHours(hour, minute, 0, 0);
  if (schedule.frequency === "weekly") {
    const targetWeekday = normalizeMemoryOrganizerWeekday(schedule.weekday);
    let days = (targetWeekday - candidate.getDay() + 7) % 7;
    if (days === 0 && candidate.getTime() <= from) days = 7;
    candidate.setDate(candidate.getDate() + days);
    return candidate.getTime();
  }
  if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

/**
 * `organizerSchedule.timezone` records the zone the next run was computed in. When the app
 * default time zone differs (changed here, in the WebUI, or while the app was closed), the
 * pending run is recomputed at once so "03:00" means 03:00 in the new zone. Returns null when
 * nothing needs to change.
 */
export function rescheduleOrganizerForTimeZone(
  settings: AppSettings,
  zone: string,
  now = Date.now(),
): AppSettings | null {
  const { organizerEnabled, organizerSchedule } = settings.memory;
  if (!organizerEnabled || organizerSchedule.frequency === "none") return null;
  if (organizerSchedule.timezone === zone) return null;
  const schedule = { ...organizerSchedule, timezone: zone };
  return {
    ...settings,
    memory: {
      ...settings.memory,
      organizerSchedule: schedule,
      organizerNextRunAt: computeNextMemoryOrganizerRunAt(schedule, now, zone),
    },
  };
}
