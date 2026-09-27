import { Settings2 } from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Label } from "../../components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { planningLunarAvailable } from "../../lib/planning/i18n";
import type { CalendarPreferences } from "./calendarDisplay";
import { PlanningField, PlanningSelect } from "./PlanningControls";
import { TimeZonePicker } from "./TimeZonePicker";
import { usePlanningT } from "./usePlanningT";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const clock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

export function CalendarDisplaySettings({
  value,
  onChange,
  zone,
  onZoneChange,
  disabled,
}: {
  value: CalendarPreferences;
  onChange(patch: Partial<CalendarPreferences>): void;
  zone: string;
  onZoneChange(zone: string): Promise<void>;
  disabled: boolean;
}) {
  const { t, locale } = usePlanningT();
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon" className="rounded-full" />}
        aria-label={t("planner.display.settings")}
      >
        <Settings2 className="size-5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[80dvh] w-72 space-y-4 overflow-y-auto">
        <h3 className="text-sm font-semibold">{t("planner.display.title")}</h3>
        <PlanningField label={t("planner.timeZone")}>
          <TimeZonePicker
            label={t("planner.timeZone")}
            value={zone}
            disabled={disabled}
            onChange={(next) => {
              if (next !== zone) void onZoneChange(next);
            }}
          />
        </PlanningField>
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
        <PlanningField label={t("planner.display.density")}>
          <PlanningSelect
            value={value.hourHeight}
            disabled={disabled}
            onValueChange={(v) => onChange({ hourHeight: Number(v) })}
            options={[
              { value: 40, label: t("planner.display.compact") },
              { value: 48, label: t("planner.display.standard") },
              { value: 64, label: t("planner.display.relaxed") },
              { value: 96, label: t("planner.display.spacious") },
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
              options={HOURS.slice(0, value.workEnd).map((h) => ({ value: h, label: clock(h) }))}
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
          <p className="pl-6 text-xs text-muted-foreground">{t("planner.display.workHoursHint")}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
