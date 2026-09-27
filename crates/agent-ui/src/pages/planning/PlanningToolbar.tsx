import {
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  ListChecks,
  Menu,
  MoreHorizontal,
  Trash2,
  Upload,
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
  zone,
  preferences,
  onPreferences,
  onZoneChange,
  interaction,
  busy,
  compact,
  taskPanelOpen,
  onNavigate,
  onToday,
  onView,
  onMode,
  onSidebar,
  onTasks,
  onReminders,
  onCalendars,
  onTrash,
  onImport,
  reminderCount,
}: {
  date: string;
  days: string[];
  view: PlanningView;
  mode: PlanningMode;
  zone: string;
  preferences: CalendarPreferences;
  onPreferences(p: Partial<CalendarPreferences>): void;
  onZoneChange(zone: string): Promise<void>;
  interaction: boolean;
  busy: boolean;
  compact: boolean;
  taskPanelOpen: boolean;
  onNavigate(direction: number): void;
  onToday(): void;
  onView(view: PlanningView): void;
  onMode(mode: PlanningMode): void;
  onSidebar(): void;
  onTasks(): void;
  onReminders(): void;
  onCalendars(): void;
  onTrash(): void;
  onImport(): void;
  reminderCount: number;
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
    <header className="planning-topbar">
      <Button
        variant="ghost"
        size="icon"
        className="rounded-full"
        aria-label={t("planner.toolbar.toggleSidebar")}
        onClick={onSidebar}
      >
        <Menu className="size-5" />
      </Button>
      <h1 className={`mr-4 text-xl font-normal ${mode === "calendar" ? "hidden md:block" : ""}`}>
        {t("settings.navPlanning")}
      </h1>
      {mode === "calendar" ? (
        <>
          <Button
            variant="outline"
            className="h-9 rounded-full px-5"
            disabled={interaction}
            onClick={onToday}
          >
            {t("planner.today")}
          </Button>
          <div className="flex items-center">
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
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0">
              <p className="truncate text-xl leading-7 tabular-nums">
                {periodTitle(date, view, days, planningDateLocale(locale))}
              </p>
              {lunar && <p className="text-tiny leading-4 text-muted-foreground">农历{lunar}</p>}
            </div>
            {preferences.showWeekNumbers && (view === "week" || view === "day") && (
              <span className="hidden shrink-0 rounded bg-muted px-1 text-xs font-medium leading-5 sm:inline">
                {t("planner.weekNumber", { week: isoWeek(date) })}
              </span>
            )}
          </div>
        </>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {mode === "calendar" && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="relative rounded-full"
              aria-label={`${t("planner.toolbar.reminders")}${reminderCount ? ` · ${reminderCount}` : ""}`}
              onClick={onReminders}
            >
              <Clock3 className="size-5" />
              {reminderCount > 0 && (
                <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-destructive" />
              )}
            </Button>
            <CalendarDisplaySettings
              value={preferences}
              onChange={onPreferences}
              zone={zone}
              onZoneChange={onZoneChange}
              disabled={interaction || busy}
            />
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" className="rounded-full" />}
            aria-label={t("planner.toolbar.manage")}
          >
            <MoreHorizontal className="size-5 rotate-90" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onCalendars}>
              <CalendarDays className="size-4" />
              {t("planner.toolbar.manageCalendars")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onImport}>
              <Upload className="size-4" />
              {t("planner.toolbar.import")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onTrash}>
              <Trash2 className="size-4" />
              {t("planner.trash")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
        {mode === "calendar" && (
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            aria-label={
              taskPanelOpen ? t("planner.toolbar.hideTasks") : t("planner.toolbar.showTasks")
            }
            aria-pressed={!compact && taskPanelOpen}
            onClick={onTasks}
          >
            <ListChecks className="size-5" />
          </Button>
        )}
      </div>
    </header>
  );
}
