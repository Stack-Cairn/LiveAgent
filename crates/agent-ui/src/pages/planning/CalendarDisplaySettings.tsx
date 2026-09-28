import { useState } from "react";
import { CalendarDays, MoreHorizontal, Trash2, Upload } from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Label } from "../../components/ui/label";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../../components/ui/popover";
import { planningLunarAvailable } from "../../lib/planning/i18n";
import type { CalendarPreferences } from "./calendarDisplay";
import { PlanningField, PlanningSelect } from "./PlanningControls";
import { usePlanningT } from "./usePlanningT";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const clock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

/**
 * The toolbar's single settings button: display settings and calendar management in one
 * popover, without a nested menu.
 */
export function CalendarDisplaySettings({
  showDisplay,
  onCalendars,
  onImport,
  onTrash,
  value,
  onChange,
  disabled,
}: {
  /** Display settings only apply to the calendar views. */
  showDisplay: boolean;
  onCalendars(): void;
  onImport(): void;
  onTrash(): void;
  value: CalendarPreferences;
  onChange(patch: Partial<CalendarPreferences>): void;
  disabled: boolean;
}) {
  const { t, locale } = usePlanningT();
  const [open, setOpen] = useState(false);
  const action = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  const actions = (
    <div className="-mx-2 flex flex-col">
      {(
        [
          [CalendarDays, t("planner.toolbar.manageCalendars"), onCalendars],
          [Upload, t("planner.toolbar.import"), onImport],
          [Trash2, t("planner.trash"), onTrash],
        ] as const
      ).map(([Icon, label, run]) => (
        <Button
          key={label}
          variant="ghost"
          size="sm"
          className="justify-start gap-2 font-normal"
          onClick={action(run)}
        >
          <Icon className="size-4" />
          {label}
        </Button>
      ))}
    </div>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon" className="rounded-full" />}
        aria-label={t("planner.toolbar.manage")}
      >
        <MoreHorizontal className="size-5 rotate-90" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={t("planner.toolbar.manage")}
        className="max-h-[80dvh] w-72 space-y-4 overflow-y-auto"
      >
        {!showDisplay ? (
          actions
        ) : (
          <>
            <PopoverTitle className="text-sm font-semibold">
              {t("planner.display.title")}
            </PopoverTitle>
            <PlanningField label={t("planner.display.weekStart")}>
              <PlanningSelect
                value={value.weekStartsOn}
                disabled={disabled}
                onValueChange={(v) =>
                  onChange({ weekStartsOn: v as CalendarPreferences["weekStartsOn"] })
                }
                options={[
                  { value: "monday", label: t("planner.display.monday") },
                  { value: "sunday", label: t("planner.display.sunday") },
                ]}
              />
            </PlanningField>
            {(
              [
                ["showWeekNumbers", t("planner.display.weekNumbers")],
                ["showLunar", t("planner.display.lunar")],
              ] as const
            )
              .filter(([key]) => key !== "showLunar" || planningLunarAvailable(locale))
              .map(([key, label]) => (
                <Label key={key} className="flex items-center gap-2 text-sm font-normal">
                  <Checkbox
                    checked={value[key]}
                    disabled={disabled}
                    onCheckedChange={(checked) => onChange({ [key]: checked })}
                  />
                  {label}
                </Label>
              ))}
            <div className="space-y-2 border-t border-border pt-3">
              <Label className="flex items-center gap-2 text-sm font-normal">
                <Checkbox
                  checked={value.workHoursOnly}
                  disabled={disabled}
                  onCheckedChange={(checked) => onChange({ workHoursOnly: checked })}
                />
                {t("planner.display.workHoursOnly")}
              </Label>
              <div className="flex items-center gap-2 pl-6">
                <PlanningSelect
                  aria-label={t("planner.display.workStart")}
                  className="flex-1"
                  value={value.workStart}
                  disabled={disabled || !value.workHoursOnly}
                  onValueChange={(v) => onChange({ workStart: Number(v) })}
                  options={HOURS.slice(0, value.workEnd).map((h) => ({
                    value: h,
                    label: clock(h),
                  }))}
                />
                <span className="text-muted-foreground">–</span>
                <PlanningSelect
                  aria-label={t("planner.display.workEnd")}
                  className="flex-1"
                  value={value.workEnd}
                  disabled={disabled || !value.workHoursOnly}
                  onValueChange={(v) => onChange({ workEnd: Number(v) })}
                  options={[...HOURS, 24]
                    .slice(value.workStart + 1)
                    .map((h) => ({ value: h, label: clock(h) }))}
                />
              </div>
              <p className="pl-6 text-xs text-muted-foreground">
                {t("planner.display.workHoursHint")}
              </p>
            </div>
            <div className="border-t border-border pt-2">{actions}</div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
