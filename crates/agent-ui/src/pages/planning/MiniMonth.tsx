import { ChevronRight } from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { planningDateLocale, translate, weekdayNames } from "../../lib/planning/i18n";
import { monthDays } from "../../lib/planning/time";
import { isoWeek } from "./calendarDisplay";

/** Sidebar month picker: six fixed weeks so the sidebar height never jumps. */
export function MiniMonth({
  month,
  selected,
  today,
  weekStartsOn,
  showWeekNumbers,
  onMonth,
  onSelect,
}: {
  month: string;
  selected: string;
  today: string;
  weekStartsOn: "monday" | "sunday";
  showWeekNumbers: boolean;
  onMonth(month: string): void;
  onSelect(date: string): void;
}) {
  const first = `${month.slice(0, 7)}-01`;
  const days = monthDays(first, weekStartsOn);
  const labels = weekdayNames(weekStartsOn);
  const shift = (direction: number) => {
    const value = new Date(`${first}T12:00:00Z`);
    value.setUTCMonth(value.getUTCMonth() + direction);
    onMonth(value.toISOString().slice(0, 10));
  };
  return (
    <section className="planning-mini-month" aria-label={translate("planner.mini.label")}>
      <div className="flex items-center gap-1 pl-2">
        <span className="flex-1 text-sm font-medium tabular-nums">
          {new Intl.DateTimeFormat(planningDateLocale(), {
            year: "numeric",
            month: "long",
            timeZone: "UTC",
          }).format(new Date(`${first.slice(0, 7)}-15T12:00:00Z`))}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="rounded-full"
          aria-label={translate("planner.nav.prevMonth")}
          onClick={() => shift(-1)}
        >
          <ChevronRight className="size-4 rotate-180" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="rounded-full"
          aria-label={translate("planner.nav.nextMonth")}
          onClick={() => shift(1)}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
      <div
        className="planning-mini-grid"
        style={{ gridTemplateColumns: `${showWeekNumbers ? "1.5rem " : ""}repeat(7, 1fr)` }}
      >
        {showWeekNumbers && <span />}
        {labels.map(({ weekday, label }) => (
          <span key={weekday} className="planning-mini-label">
            {label}
          </span>
        ))}
        {days.map((day, index) => (
          <MiniDay
            key={day}
            day={day}
            weekNumber={showWeekNumbers && index % 7 === 0 ? isoWeek(day) : null}
            outside={day.slice(0, 7) !== month.slice(0, 7)}
            today={day === today}
            selected={day === selected}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

function MiniDay({
  day,
  weekNumber,
  outside,
  today,
  selected,
  onSelect,
}: {
  day: string;
  weekNumber: number | null;
  outside: boolean;
  today: boolean;
  selected: boolean;
  onSelect(date: string): void;
}) {
  return (
    <>
      {weekNumber !== null && <span className="planning-mini-week">{weekNumber}</span>}
      <button
        type="button"
        aria-label={day}
        aria-current={today ? "date" : undefined}
        aria-pressed={selected}
        className={`planning-mini-day ${outside ? "is-outside" : ""} ${today ? "is-today" : ""} ${selected ? "is-selected" : ""}`}
        onClick={() => onSelect(day)}
      >
        {Number(day.slice(-2))}
      </button>
    </>
  );
}
