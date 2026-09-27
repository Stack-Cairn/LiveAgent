import { useRef, useState } from "react";
import { CalendarDays, ChevronRight } from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../../components/ui/popover";
import {
  type DateTimeValue,
  dateTimeEvent,
  dateTimeLabel,
  moveDate,
} from "../../lib/planning/dateTime";
import { localizePlanningError, planningDateLocale, weekdayNames } from "../../lib/planning/i18n";
import { addDays, localEpoch, monthDays, zonedParts } from "../../lib/planning/time";
import { PlanningField } from "./PlanningControls";
import { usePlanningT } from "./usePlanningT";

export function PlanningDateTimePicker({
  value,
  onChange,
  zone,
  label,
  range = false,
  dateOnly = false,
  clearable = true,
  disabled = false,
  className,
}: {
  value: DateTimeValue;
  onChange(value: DateTimeValue): void;
  zone: string;
  label?: string;
  range?: boolean;
  dateOnly?: boolean;
  clearable?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { t, locale } = usePlanningT();
  let today: string;
  try {
    today = zonedParts(Date.now(), zone).date;
  } catch {
    today = new Date().toISOString().slice(0, 10);
  }
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [month, setMonth] = useState((value.date || today).slice(0, 7));
  const [endpoint, setEndpoint] = useState<"start" | "end">("start");
  const [error, setError] = useState("");
  const daysRef = useRef(new Map<string, HTMLElement>());
  const first = `${month}-01`;
  const days = monthDays(first);
  const active = endpoint === "start" ? draft.date : draft.endDate || draft.date;
  const shiftMonth = (by: number) => {
    const d = new Date(`${first}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + by);
    setMonth(d.toISOString().slice(0, 7));
  };
  const choose = (date: string) => {
    setError("");
    setDraft((old) => (endpoint === "end" ? { ...old, endDate: date } : moveDate(old, date)));
  };
  const apply = () => {
    try {
      if (!draft.date) throw Error(t("planner.dateTime.pickDate"));
      if (range && draft.time && !draft.endTime) throw Error(t("planner.picker.needEndTime"));
      if (range) dateTimeEvent(draft, zone);
      else if (draft.time) localEpoch(draft.date, draft.time, zone);
      onChange(draft);
      setOpen(false);
    } catch (e) {
      setError(localizePlanningError(e));
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setDraft(value);
          setMonth((value.date || today).slice(0, 7));
          setEndpoint("start");
          setError("");
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={`h-8 min-w-0 max-w-full justify-start gap-2 ${className ?? ""}`}
          />
        }
        disabled={disabled}
        aria-label={t("planner.picker.setLabel", { label: label ?? t("planner.dateTime.label") })}
      >
        <CalendarDays className="size-3.5 shrink-0" />
        <span className="truncate text-xs">
          {value.date ? (dateOnly ? value.date : dateTimeLabel(value)) : label}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] space-y-3 p-3"
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
            e.preventDefault();
            apply();
          }
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <PopoverTitle className="text-sm">{label}</PopoverTitle>
          <span className="truncate text-xs text-muted-foreground">{zone}</span>
        </div>
        {range && (
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            {(["start", "end"] as const).map((part) => (
              <Button
                key={part}
                size="sm"
                variant={endpoint === part ? "secondary" : "ghost"}
                className="h-auto flex-col gap-0.5 py-1"
                onClick={() => {
                  setEndpoint(part);
                  setMonth(
                    ((part === "start" ? draft.date : draft.endDate || draft.date) || today).slice(
                      0,
                      7,
                    ),
                  );
                }}
                aria-pressed={endpoint === part}
              >
                <span className="text-xs text-muted-foreground">
                  {part === "start" ? t("planner.picker.start") : t("planner.picker.end")}
                </span>
                <span className="text-xs">
                  {(part === "start" ? draft.date : draft.endDate || draft.date) ||
                    t("planner.picker.chooseDate")}
                </span>
              </Button>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("planner.nav.prevMonth")}
            onClick={() => shiftMonth(-1)}
          >
            <ChevronRight className="size-4 rotate-180" />
          </Button>
          <span className="text-sm font-medium">
            {new Intl.DateTimeFormat(planningDateLocale(locale), {
              year: "numeric",
              month: "long",
              timeZone: "UTC",
            }).format(new Date(`${month}-15T12:00:00Z`))}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("planner.nav.nextMonth")}
            onClick={() => shiftMonth(1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <fieldset className="grid grid-cols-7 gap-0.5" aria-label={t("planner.picker.chooseDate")}>
          {weekdayNames().map(({ weekday, label: day }) => (
            <span key={weekday} className="py-1 text-center text-xs text-muted-foreground">
              {day}
            </span>
          ))}
          {days.map((date) => (
            <Button
              key={date}
              ref={(el) => {
                if (el) daysRef.current.set(date, el);
                else daysRef.current.delete(date);
              }}
              variant={date === active ? "default" : "ghost"}
              size="sm"
              className={`h-8 px-0 text-xs ${date.slice(0, 7) !== month ? "opacity-40" : ""} ${date === today ? "font-bold underline underline-offset-4" : ""}`}
              aria-label={date}
              aria-pressed={date === active}
              onClick={() => choose(date)}
              onKeyDown={(e) => {
                const offset = (
                  { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<
                    string,
                    number
                  >
                )[e.key];
                if (offset) {
                  e.preventDefault();
                  const next = addDays(date, offset);
                  if (daysRef.current.has(next)) daysRef.current.get(next)?.focus();
                }
              }}
            >
              {Number(date.slice(-2))}
            </Button>
          ))}
        </fieldset>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => choose(today)}
          >
            {t("planner.today")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => choose(addDays(today, 1))}
          >
            {t("planner.tomorrow")}
          </Button>
          {!dateOnly && (
            <div className="ml-auto flex gap-1">
              <Button
                variant={!draft.time ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs"
                aria-pressed={!draft.time}
                onClick={() => setDraft((v) => ({ ...v, time: "", endTime: "" }))}
              >
                {range ? t("planner.allDay") : t("planner.picker.dateOnly")}
              </Button>
              <Button
                variant={draft.time ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs"
                aria-pressed={!!draft.time}
                onClick={() =>
                  setDraft((v) => ({
                    ...v,
                    date: v.date || today,
                    time: v.time || "09:00",
                    ...(range ? { endTime: v.endTime || "10:00" } : {}),
                  }))
                }
              >
                {t("planner.picker.timed")}
              </Button>
            </div>
          )}
        </div>
        {!!draft.time && !dateOnly && (
          <div className={`grid gap-2 ${range ? "grid-cols-2" : "grid-cols-1"}`}>
            <PlanningField label={range ? t("planner.picker.startTime") : t("planner.picker.time")}>
              <Input
                variant="plain"
                className="h-8"
                type="time"
                value={draft.time}
                onChange={(e) => setDraft((v) => ({ ...v, time: e.target.value }))}
              />
            </PlanningField>
            {range && (
              <PlanningField label={t("planner.picker.endTime")}>
                <Input
                  variant="plain"
                  className="h-8"
                  type="time"
                  value={draft.endTime || "10:00"}
                  onChange={(e) => setDraft((v) => ({ ...v, endTime: e.target.value }))}
                />
              </PlanningField>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-1 border-t border-border pt-2">
          {clearable && (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto"
              onClick={() => {
                onChange({ date: "", time: "" });
                setOpen(false);
              }}
            >
              {t("planner.common.clear")}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            {t("planner.common.cancel")}
          </Button>
          <Button size="sm" onClick={apply}>
            {t("planner.common.confirm")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
