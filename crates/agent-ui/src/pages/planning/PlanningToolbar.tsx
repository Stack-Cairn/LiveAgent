import {
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
} from "../../components/IconSet";
import {
  SettingsToggleGroup,
  SettingsToggleGroupItem,
} from "../../components/settings/SettingsToggleGroup";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { planningDateLocale } from "../../lib/planning/i18n";
import { CalendarDisplaySettings } from "./CalendarDisplaySettings";
import { type CalendarPreferences, isoWeek, lunarDate, lunarMonth } from "./calendarDisplay";
import { usePlanningT } from "./usePlanningT";

export type PlanningView = "day" | "week" | "month" | "agenda";
export type PlanningMode = "calendar" | "tasks";
export const VIEWS: PlanningView[] = ["day", "week", "month", "agenda"];
const VIEW_KEYS: Record<PlanningView, string> = { day: "D", week: "W", month: "M", agenda: "A" };

function periodTitle(date: string, view: PlanningView, days: string[], locale: string) {
  const at = (day: string) => new Date(`${day}T12:00:00Z`);
  if (view === "day")
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(at(date));
  const month = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  if (view === "agenda" || view === "month") return month.format(at(date));
  const first = days[0] ?? date,
    last = days[days.length - 1] ?? date;
  return first.slice(0, 7) === last.slice(0, 7)
    ? month.format(at(first))
    : month.formatRange(at(first), at(last));
}

export function PlanningToolbar({
  date,
  days,
  view,
  mode,
  preferences,
  onPreferences,
  interaction,
  busy,
  onNavigate,
  onView,
  onMode,
  onCalendars,
  onTrash,
  onImport,
}: {
  date: string;
  days: string[];
  view: PlanningView;
  mode: PlanningMode;
  preferences: CalendarPreferences;
  onPreferences(p: Partial<CalendarPreferences>): void;
  interaction: boolean;
  busy: boolean;
  onNavigate(direction: number): void;
  onView(view: PlanningView): void;
  onMode(mode: PlanningMode): void;
  onCalendars(): void;
  onTrash(): void;
  onImport(): void;
}) {
  const { t, locale } = usePlanningT();
  const viewLabel = (v: PlanningView) => t(`planner.view.${v}`);
  const step = view === "day" ? "Day" : view === "month" ? "Month" : "Week";
  const lunar =
    preferences.showLunar && mode === "calendar"
      ? view === "day"
        ? `${lunarMonth(date)}${lunarDate(date) === lunarMonth(date) ? "初一" : lunarDate(date)}`
        : [...new Set([days[0] ?? date, days[days.length - 1] ?? date].map(lunarMonth))]
            .filter(Boolean)
            .join(" ~ ")
      : "";
  return (
    // Sizes follow the toolbar's own width (container queries), so a narrow page between
    // two sidebars drops the title and week badge instead of squeezing them.
    <header className="planning-topbar @container">
      <h1
        className={`mr-2 shrink-0 whitespace-nowrap text-xl font-normal ${mode === "calendar" ? "hidden @3xl:block" : ""}`}
      >
        {t("settings.navPlanning")}
      </h1>
      {mode === "calendar" ? (
        <>
          <div className="flex shrink-0 items-center">
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              aria-label={t(`planner.nav.prev${step}`)}
              disabled={interaction}
              onClick={() => onNavigate(-1)}
            >
              <ChevronRight className="size-5 rotate-180" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              aria-label={t(`planner.nav.next${step}`)}
              disabled={interaction}
              onClick={() => onNavigate(1)}
            >
              <ChevronRight className="size-5" />
            </Button>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <div className="min-w-0">
              <p className="truncate text-xl leading-7 tabular-nums">
                {periodTitle(date, view, days, planningDateLocale(locale))}
              </p>
              {lunar && (
                <p className="text-xs text-muted-foreground">
                  {t("planner.lunar.label", { date: lunar })}
                </p>
              )}
            </div>
            {preferences.showWeekNumbers && (view === "week" || view === "day") && (
              <span className="hidden shrink-0 whitespace-nowrap rounded bg-muted px-1 text-xs font-medium leading-5 @2xl:inline">
                {t("planner.weekNumber", { week: isoWeek(date) })}
              </span>
            )}
          </div>
        </>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <CalendarDisplaySettings
          showDisplay={mode === "calendar"}
          onCalendars={onCalendars}
          onImport={onImport}
          onTrash={onTrash}
          value={preferences}
          onChange={onPreferences}
          disabled={interaction || busy}
        />
        {mode === "calendar" && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" className="h-9 gap-1 rounded-full pl-4 pr-3" />}
              aria-label={t("planner.toolbar.viewLabel", { view: viewLabel(view) })}
              disabled={interaction}
            >
              {viewLabel(view)}
              <ChevronDown className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuRadioGroup
                value={view}
                onValueChange={(value) => onView(value as PlanningView)}
              >
                {VIEWS.map((v) => (
                  <DropdownMenuRadioItem key={v} value={v}>
                    <span className="flex-1">{viewLabel(v)}</span>
                    <kbd className="text-xs text-muted-foreground">{VIEW_KEYS[v]}</kbd>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              {(
                [
                  ["showWeekends", t("planner.view.showWeekends")],
                  ["showCompleted", t("planner.view.showCompleted")],
                ] as const
              ).map(([key, label]) => (
                <DropdownMenuItem
                  className="gap-2"
                  key={key}
                  closeOnClick={false}
                  onClick={() => onPreferences({ [key]: !preferences[key] })}
                >
                  <span className="w-4">{preferences[key] && <Check className="size-4" />}</span>
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <SettingsToggleGroup
          aria-label={t("planner.toolbar.switchMode")}
          className="h-9"
          value={[mode]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "calendar" || next === "tasks") onMode(next);
          }}
        >
          {(
            [
              ["calendar", t("planner.mode.calendar"), CalendarDays],
              ["tasks", t("planner.mode.tasks"), CheckCircle2],
            ] as const
          ).map(([value, label, Icon]) => (
            <SettingsToggleGroupItem
              key={value}
              value={value}
              aria-label={label}
              title={label}
              disabled={interaction}
              className="w-11"
            >
              <Icon className="size-4" />
            </SettingsToggleGroupItem>
          ))}
        </SettingsToggleGroup>
      </div>
    </header>
  );
}
