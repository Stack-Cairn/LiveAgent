type Translate = (key: string, vars?: Record<string, string>) => string;

/** Preset offsets (minutes before the start) shared by calendars and events. */
export const NOTIFY_MINUTES = [0, 5, 15, 30, 60, 1440];

const DURATION_KEYS: Record<number, string> = {
  5: "planner.duration.5m",
  15: "planner.duration.15m",
  30: "planner.duration.30m",
  60: "planner.duration.1h",
  1440: "planner.duration.1d",
};

/** One wording everywhere: "开始时" / "15 分钟前" / "{n} 分钟前". */
export function notifyLabel(t: Translate, minutes: number) {
  if (minutes === 0) return t("planner.notify.atStart");
  const key = DURATION_KEYS[minutes];
  return key
    ? t("planner.notify.before", { duration: t(key) })
    : t("planner.notify.minutesBefore", { minutes: String(minutes) });
}

/** Presets plus the current value when it is not a preset (e.g. 10 set by the Agent). */
function minuteOptions(t: Translate, current: string) {
  const presets = [...NOTIFY_MINUTES];
  const value = Number(current);
  if (current !== "" && Number.isInteger(value) && value >= 0 && !presets.includes(value)) {
    presets.push(value);
    presets.sort((a, b) => a - b);
  }
  return presets.map((minutes) => ({ value: String(minutes), label: notifyLabel(t, minutes) }));
}

/** Calendar default notification: off or an offset. `current` is "" for off. */
export function calendarNotificationOptions(t: Translate, current: string) {
  return [{ value: "", label: t("planner.notify.off") }, ...minuteOptions(t, current)];
}

/** Event notification: follow the calendar ("" ), off ("-1") or an offset. */
export function eventNotificationOptions(
  t: Translate,
  calendarDefault: number | null | undefined,
  current: string,
) {
  return [
    {
      value: "",
      label: t("planner.notify.default", {
        label: calendarDefault == null ? t("planner.notify.off") : notifyLabel(t, calendarDefault),
      }),
    },
    { value: "-1", label: t("planner.notify.off") },
    ...minuteOptions(t, current === "-1" ? "" : current),
  ];
}
