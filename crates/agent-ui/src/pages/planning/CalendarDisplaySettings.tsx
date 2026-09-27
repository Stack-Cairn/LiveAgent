import { Checkbox } from "../../components/ui/checkbox";
import { Label } from "../../components/ui/label";
import { Popover, PopoverContent } from "../../components/ui/popover";
import { planningLunarAvailable } from "../../lib/planning/i18n";
import type { CalendarPreferences } from "./calendarDisplay";
import { PlanningField, PlanningSelect } from "./PlanningControls";
import { TimeZonePicker } from "./TimeZonePicker";
import { usePlanningT } from "./usePlanningT";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const clock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

/** Opened from the toolbar's "more" menu and anchored to that button. */
export function CalendarDisplaySettings({
  anchor,
  onClose,
  value,
  onChange,
  zone,
  onZoneChange,
  disabled,
}: {
  anchor: Element;
  onClose(): void;
  value: CalendarPreferences;
  onChange(patch: Partial<CalendarPreferences>): void;
  zone: string;
  onZoneChange(zone: string): Promise<void>;
  disabled: boolean;
}) {
  const { t, locale } = usePlanningT();
  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverContent
        anchor={anchor}
        align="end"
        className="max-h-[80dvh] w-72 space-y-4 overflow-y-auto"
      >
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
