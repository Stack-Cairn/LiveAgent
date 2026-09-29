import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { addDays } from "../../lib/planning/time";
import type { Recurrence } from "../../lib/planning/types";
import { PlanningField, PlanningSelect } from "./PlanningControls";
import { PlanningDateTimePicker } from "./PlanningDateTimePicker";
import {
  type Frequency,
  presetOptions,
  presetRule,
  type RepeatPreset,
  weekdayName,
  weekdayOf,
} from "./recurrence";
import { usePlanningT } from "./usePlanningT";

export interface RepeatValue {
  preset: RepeatPreset;
  /** The custom rule; presets are rebuilt from the start date on save. */
  rule: Recurrence | null;
}

/** The rule to store: presets follow the (possibly edited) first date, custom rules as typed. */
export function repeatRule(value: RepeatValue, date: string, previous?: Recurrence | null) {
  const rule = value.preset === "custom" ? value.rule : presetRule(value.preset, date);
  return rule ? { ...rule, excludedDates: previous?.excludedDates ?? [] } : null;
}

export function RecurrenceFields({
  value,
  date,
  zone,
  disabled,
  onChange,
}: {
  value: RepeatValue;
  /** First day of the series; presets and defaults derive from it. */
  date: string;
  zone: string;
  disabled?: boolean;
  onChange(value: RepeatValue): void;
}) {
  const { t, locale } = usePlanningT();
  const rule = value.rule;
  const setRule = (patch: Partial<Recurrence>) =>
    rule && onChange({ preset: "custom", rule: { ...rule, ...patch } });
  const ends = rule?.until ? "until" : rule?.count ? "count" : "never";
  return (
    <div className="space-y-3">
      <PlanningField label={t("planner.editor.repeat")}>
        <PlanningSelect
          disabled={disabled}
          value={value.preset}
          onValueChange={(next) => {
            const preset = next as RepeatPreset;
            onChange({
              preset,
              rule:
                preset === "custom"
                  ? (rule ?? presetRule("weekly", date))
                  : presetRule(preset, date),
            });
          }}
          options={presetOptions(t, locale, date)}
        />
      </PlanningField>
      {value.preset === "custom" && rule && (
        <div className="space-y-3 rounded-xl border border-border p-3">
          <PlanningField label={t("planner.repeat.repeatEvery")}>
            <div className="flex items-center gap-2">
              <Input
                variant="plain"
                type="number"
                className="w-20"
                min={1}
                max={365}
                disabled={disabled}
                aria-label={t("planner.repeat.repeatEvery")}
                value={rule.interval}
                onChange={(e) =>
                  setRule({ interval: Math.min(365, Math.max(1, Number(e.target.value) || 1)) })
                }
              />
              <PlanningSelect
                className="w-auto"
                disabled={disabled}
                aria-label={t("planner.repeat.unit")}
                value={rule.frequency}
                onValueChange={(frequency) =>
                  setRule({
                    frequency: frequency as Frequency,
                    weekdays: frequency === "weekly" ? [weekdayOf(date)] : [],
                  })
                }
                options={(["daily", "weekly", "monthly", "yearly"] as const).map((f) => ({
                  value: f,
                  label: t(`planner.repeat.unit.${f}`),
                }))}
              />
            </div>
          </PlanningField>
          {rule.frequency === "weekly" && (
            <PlanningField label={t("planner.repeat.repeatOn")}>
              <div className="flex flex-wrap gap-1.5">
                {[0, 1, 2, 3, 4, 5, 6].map((day) => {
                  const on = rule.weekdays.length
                    ? rule.weekdays.includes(day)
                    : day === weekdayOf(date);
                  return (
                    <Button
                      key={day}
                      type="button"
                      size="icon-sm"
                      variant={on ? "default" : "outline"}
                      className="rounded-full"
                      aria-pressed={on}
                      aria-label={weekdayName(day, locale)}
                      disabled={disabled}
                      onClick={() => {
                        const current = rule.weekdays.length ? rule.weekdays : [weekdayOf(date)];
                        const next = on ? current.filter((d) => d !== day) : [...current, day];
                        // At least one weekday stays selected.
                        if (next.length) setRule({ weekdays: next.sort() });
                      }}
                    >
                      {weekdayName(day, locale, "narrow")}
                    </Button>
                  );
                })}
              </div>
            </PlanningField>
          )}
          <PlanningField label={t("planner.repeat.ends")}>
            <div className="flex flex-wrap items-center gap-2">
              <PlanningSelect
                className="w-auto"
                disabled={disabled}
                aria-label={t("planner.repeat.ends")}
                value={ends}
                onValueChange={(next) =>
                  setRule(
                    next === "until"
                      ? { until: addDays(date, 30), count: null }
                      : next === "count"
                        ? { until: null, count: 10 }
                        : { until: null, count: null },
                  )
                }
                options={[
                  { value: "never", label: t("planner.repeat.never") },
                  { value: "until", label: t("planner.repeat.onDate") },
                  { value: "count", label: t("planner.repeat.afterCount") },
                ]}
              />
              {ends === "until" && (
                <div className="min-w-40 flex-1">
                  <PlanningDateTimePicker
                    value={{ date: rule.until ?? "", time: "" }}
                    onChange={(v) => v.date && setRule({ until: v.date < date ? date : v.date })}
                    zone={zone}
                    dateOnly
                    clearable={false}
                    label={t("planner.repeat.onDate")}
                    disabled={disabled}
                  />
                </div>
              )}
              {ends === "count" && (
                <div className="flex items-center gap-2">
                  <Input
                    variant="plain"
                    type="number"
                    className="w-20"
                    min={1}
                    max={10000}
                    disabled={disabled}
                    aria-label={t("planner.repeat.afterCount")}
                    value={rule.count ?? 1}
                    onChange={(e) =>
                      setRule({ count: Math.min(10000, Math.max(1, Number(e.target.value) || 1)) })
                    }
                  />
                  <span className="text-sm text-muted-foreground">
                    {t("planner.repeat.occurrences")}
                  </span>
                </div>
              )}
            </div>
          </PlanningField>
        </div>
      )}
    </div>
  );
}
