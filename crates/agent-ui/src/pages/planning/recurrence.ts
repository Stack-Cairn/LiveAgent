import type { Locale } from "@liveagent/app/i18n/config";
import { planningDateLocale } from "../../lib/planning/i18n";
import type { Recurrence } from "../../lib/planning/types";

type Translate = (key: string, vars?: Record<string, string>) => string;
export type Frequency = Recurrence["frequency"];
/** Google-style repeat choices derived from the start date; "custom" opens the full rule. */
export type RepeatPreset = "" | Frequency | "weekdays" | "custom";

const at = (date: string) => new Date(`${date}T12:00:00Z`);
/** Weekday of a YYYY-MM-DD date, 0 = Monday … 6 = Sunday (the backend's numbering). */
export function weekdayOf(date: string) {
  return (at(date).getUTCDay() + 6) % 7;
}
export function weekdayName(
  index: number,
  locale: Locale,
  width: "long" | "short" | "narrow" = "long",
) {
  // 2024-01-01 is a Monday.
  return new Intl.DateTimeFormat(planningDateLocale(locale), {
    weekday: width,
    timeZone: "UTC",
  }).format(at(`2024-01-0${index + 1}`));
}
function monthDay(date: string, locale: Locale) {
  return new Intl.DateTimeFormat(planningDateLocale(locale), {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(at(date));
}

export function presetRule(preset: RepeatPreset, date: string): Recurrence | null {
  if (!preset || preset === "custom") return null;
  const base = { interval: 1, excludedDates: [], until: null, count: null };
  if (preset === "weekdays") return { ...base, frequency: "weekly", weekdays: [0, 1, 2, 3, 4] };
  return { ...base, frequency: preset, weekdays: preset === "weekly" ? [weekdayOf(date)] : [] };
}

/** The preset a stored rule matches, so the dropdown shows it; anything else is "custom". */
export function rulePreset(rule: Recurrence | null | undefined, date: string): RepeatPreset {
  if (!rule) return "";
  if (rule.interval !== 1 || rule.count || rule.until) return "custom";
  const days = [...rule.weekdays].sort().join();
  if (rule.frequency === "weekly") {
    if (days === "0,1,2,3,4") return "weekdays";
    return !days || days === String(weekdayOf(date)) ? "weekly" : "custom";
  }
  return days ? "custom" : rule.frequency;
}

export function presetOptions(t: Translate, locale: Locale, date: string, withCustom = true) {
  return [
    { value: "", label: t("planner.repeat.none") },
    { value: "daily", label: t("planner.repeat.daily") },
    {
      value: "weekly",
      label: t("planner.repeat.weeklyOn", { weekday: weekdayName(weekdayOf(date), locale) }),
    },
    {
      value: "monthly",
      label: t("planner.repeat.monthlyOn", { day: String(Number(date.slice(8, 10))) }),
    },
    { value: "yearly", label: t("planner.repeat.yearlyOn", { date: monthDay(date, locale) }) },
    { value: "weekdays", label: t("planner.repeat.weekdaysPreset") },
    ...(withCustom ? [{ value: "custom", label: t("planner.repeat.custom") }] : []),
  ];
}

const EVERY: Record<Frequency, string> = {
  daily: "planner.repeat.everyDays",
  weekly: "planner.repeat.everyWeeks",
  monthly: "planner.repeat.everyMonths",
  yearly: "planner.repeat.everyYears",
};

/** One-line summary, e.g. "每 2 周（周一、周三），共 10 次". `date` is the series' first day. */
export function describeRecurrence(t: Translate, locale: Locale, rule: Recurrence, date: string) {
  let text =
    rule.interval === 1
      ? t(`planner.repeat.${rule.frequency}`)
      : t(EVERY[rule.frequency], { count: String(rule.interval) });
  if (rule.frequency === "weekly") {
    const days = rule.weekdays.length ? [...rule.weekdays].sort() : [weekdayOf(date)];
    text = t("planner.repeat.descWeekdays", {
      base: text,
      days:
        days.join() === "0,1,2,3,4"
          ? t("planner.repeat.workdays")
          : days.map((d) => weekdayName(d, locale, "short")).join(t("planner.repeat.separator")),
    });
  } else if (rule.frequency === "monthly") {
    text = t("planner.repeat.descMonthDay", { base: text, day: String(Number(date.slice(8, 10))) });
  } else if (rule.frequency === "yearly") {
    text = t("planner.repeat.descYearDay", { base: text, date: monthDay(date, locale) });
  }
  if (rule.until)
    text = t("planner.repeat.descUntil", {
      base: text,
      date: new Intl.DateTimeFormat(planningDateLocale(locale), {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(at(rule.until)),
    });
  else if (rule.count)
    text = t("planner.repeat.descCount", { base: text, count: String(rule.count) });
  return text;
}
