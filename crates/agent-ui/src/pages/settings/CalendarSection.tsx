import { updateCustomSettings } from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { useState } from "react";
import { CalendarDays, Plus, RefreshCw, Trash2, Upload } from "../../components/IconSet";
import { SettingsNotice } from "../../components/settings/SettingsNotice";
import {
  SettingsSelectContent,
  SettingsSelectTrigger,
} from "../../components/settings/SettingsSelect";
import {
  SettingsToggleGroup,
  SettingsToggleGroupItem,
} from "../../components/settings/SettingsToggleGroup";
import { Button } from "../../components/ui/button";
import { ConfirmDeletePopover } from "../../components/ui/confirm-action-popover";
import { Select, SelectItem, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import {
  calendarName,
  localizePlanningError,
  planningDateLocale,
  planningLunarAvailable,
} from "../../lib/planning/i18n";
import { planningStore, usePlanning } from "../../lib/planning/store";
import { CalendarImport } from "../planning/CalendarImport";
import { CalendarManager } from "../planning/CalendarManager";
import { type CalendarPreferences, useCalendarPreferences } from "../planning/calendarDisplay";
import { PlanningTrash } from "../planning/PlanningTrash";
import {
  intervalLabel,
  SUBSCRIPTION_INTERVALS,
  SubscriptionDialog,
} from "../planning/SubscriptionDialog";
import { TimeZonePicker } from "../planning/TimeZonePicker";
import { usePlanningT } from "../planning/usePlanningT";
import { AgentActivationSwitch, PromptTag, SettingsGroup, SettingsRow } from "./shared";

const HOURS = Array.from({ length: 25 }, (_, hour) => hour);
const clock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

function HourSelect({
  value,
  hours,
  label,
  onChange,
}: {
  value: number;
  hours: number[];
  label: string;
  onChange(hour: number): void;
}) {
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
      <SettingsSelectTrigger aria-label={label} className="min-w-24 justify-between">
        <SelectValue>{clock(value)}</SelectValue>
      </SettingsSelectTrigger>
      <SettingsSelectContent>
        {hours.map((hour) => (
          <SelectItem key={hour} value={String(hour)}>
            {clock(hour)}
          </SelectItem>
        ))}
      </SettingsSelectContent>
    </Select>
  );
}

/** Settings → Resources → Calendar: entry switch, display preferences and calendar data. */
export function CalendarSection({ settings, setSettings }: SettingsSectionProps) {
  const { t, locale } = usePlanningT();
  const state = usePlanning();
  const snapshot = state.snapshot;
  const [preferences, setPreferences] = useCalendarPreferences();
  const [dialog, setDialog] = useState<"calendars" | "import" | "trash" | "subscribe" | null>(null);
  const [error, setError] = useState("");
  const toggle = (key: keyof CalendarPreferences) => (
    <AgentActivationSwitch
      checked={preferences[key] === true}
      title={t(`planner.settings.${key}`)}
      onToggle={() => setPreferences({ [key]: !preferences[key] })}
    />
  );
  const setZone = async (timeZone: string) => {
    if (!snapshot || timeZone === snapshot.timeZone) return;
    setError("");
    try {
      await planningStore.mutate({
        action: "timezone.set",
        expectedRevision: snapshot.seq,
        data: { timeZone },
      });
    } catch (e) {
      setError(localizePlanningError(e));
    }
  };
  return (
    <div className="mx-auto w-full max-w-920px space-y-8">
      <SettingsGroup title={t("planner.settings.entry")}>
        <SettingsRow
          title={t("planner.settings.showInSidebar")}
          description={t("planner.settings.showInSidebarHint")}
          control={
            <AgentActivationSwitch
              checked={settings.customSettings.sidebarShortcuts.planning}
              title={t("planner.settings.showInSidebar")}
              onToggle={() =>
                setSettings((prev) =>
                  updateCustomSettings(prev, {
                    sidebarShortcuts: {
                      ...prev.customSettings.sidebarShortcuts,
                      planning: !prev.customSettings.sidebarShortcuts.planning,
                    },
                  }),
                )
              }
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("planner.display.title")}>
        <SettingsRow
          title={t("planner.timeZone")}
          description={t("planner.settings.timeZoneHint")}
          control={
            snapshot ? (
              <div className="w-72 max-w-full">
                <TimeZonePicker
                  label={t("planner.timeZone")}
                  value={snapshot.timeZone}
                  onChange={(zone) => void setZone(zone)}
                />
              </div>
            ) : (
              <Skeleton className="h-8 w-48" />
            )
          }
        />
        <SettingsRow
          title={t("planner.display.weekStart")}
          control={
            <SettingsToggleGroup
              aria-label={t("planner.display.weekStart")}
              value={[preferences.weekStartsOn]}
              onValueChange={(values) => {
                const next = values[0];
                if (next === "monday" || next === "sunday") setPreferences({ weekStartsOn: next });
              }}
            >
              <SettingsToggleGroupItem value="monday">
                {t("planner.display.monday")}
              </SettingsToggleGroupItem>
              <SettingsToggleGroupItem value="sunday">
                {t("planner.display.sunday")}
              </SettingsToggleGroupItem>
            </SettingsToggleGroup>
          }
        />
        <SettingsRow title={t("planner.display.weekNumbers")} control={toggle("showWeekNumbers")} />
        {planningLunarAvailable(locale) && (
          <SettingsRow title={t("planner.display.lunar")} control={toggle("showLunar")} />
        )}
        <SettingsRow title={t("planner.view.showWeekends")} control={toggle("showWeekends")} />
        <SettingsRow title={t("planner.view.showCompleted")} control={toggle("showCompleted")} />
        <SettingsRow
          title={t("planner.display.workHoursOnly")}
          description={t("planner.display.workHoursHint")}
          control={toggle("workHoursOnly")}
        />
        {preferences.workHoursOnly && (
          <SettingsRow
            title={t("planner.settings.workHours")}
            control={
              <div className="flex items-center gap-2">
                <HourSelect
                  label={t("planner.display.workStart")}
                  value={preferences.workStart}
                  hours={HOURS.slice(0, preferences.workEnd)}
                  onChange={(workStart) => setPreferences({ workStart })}
                />
                <span className="text-muted-foreground">–</span>
                <HourSelect
                  label={t("planner.display.workEnd")}
                  value={preferences.workEnd}
                  hours={HOURS.slice(preferences.workStart + 1)}
                  onChange={(workEnd) => setPreferences({ workEnd })}
                />
              </div>
            }
          />
        )}
      </SettingsGroup>

      <SettingsGroup title={t("planner.settings.calendars")}>
        {!snapshot ? (
          state.error ? (
            <SettingsRow
              title={t("planner.settings.loadFailed")}
              description={state.error}
              control={
                <Button variant="outline" size="sm" onClick={() => void planningStore.refresh()}>
                  {t("planner.common.retry")}
                </Button>
              }
            />
          ) : (
            <Skeleton className="h-14 w-full rounded-xl" />
          )
        ) : (
          snapshot.calendars.map((calendar) => (
            <SettingsRow
              key={calendar.id}
              title={
                <span className="flex items-center gap-2">
                  <span
                    className="size-3 shrink-0 rounded"
                    style={{ backgroundColor: calendar.color }}
                  />
                  <span className="truncate">{calendarName(calendar)}</span>
                </span>
              }
              control={
                <span className="flex gap-1.5">
                  {calendar.isDefault && <PromptTag label={t("planner.calendar.default")} />}
                  {calendar.sourceKind === "subscription" ? (
                    <PromptTag label={t("planner.subscription.tag")} muted />
                  ) : (
                    calendar.readOnly && <PromptTag label={t("planner.calendar.readOnly")} muted />
                  )}
                </span>
              }
            />
          ))
        )}
        <SettingsRow
          title={t("planner.settings.manage")}
          description={t("planner.settings.manageHint")}
          control={
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!snapshot}
                onClick={() => setDialog("calendars")}
              >
                <CalendarDays className="size-4" />
                {t("planner.toolbar.manageCalendars")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!snapshot}
                onClick={() => setDialog("import")}
              >
                <Upload className="size-4" />
                {t("planner.settings.import")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!snapshot}
                onClick={() => setDialog("trash")}
              >
                <Trash2 className="size-4" />
                {t("planner.trash")}
              </Button>
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("planner.subscription.title")}>
        {snapshot?.calendars
          .filter((calendar) => calendar.sourceKind === "subscription")
          .map((calendar) => {
            const status = snapshot.subscriptions?.find((s) => s.calendarId === calendar.id);
            const when = (at: number) =>
              new Date(at).toLocaleString(planningDateLocale(locale), {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });
            const detail = status?.lastError
              ? t("planner.subscription.failed", { error: localizePlanningError(status.lastError) })
              : status?.lastSyncedAt
                ? t("planner.subscription.syncedAt", { time: when(status.lastSyncedAt) })
                : t("planner.subscription.pending");
            const run = (action: string, input: Record<string, unknown>) =>
              void planningStore
                .command(action, { id: calendar.id, ...input })
                .catch((e) => setError(localizePlanningError(e)));
            return (
              <SettingsRow
                key={calendar.id}
                title={
                  <span className="flex items-center gap-2">
                    <span
                      className="size-3 shrink-0 rounded"
                      style={{ backgroundColor: calendar.color }}
                    />
                    <span className="truncate">{calendarName(calendar)}</span>
                  </span>
                }
                description={
                  <span className={status?.lastError ? "text-destructive" : undefined}>
                    {[status?.host, detail].filter(Boolean).join(" · ")}
                  </span>
                }
                control={
                  <div className="flex items-center gap-2">
                    <Select
                      value={String(status?.refreshMinutes ?? 60)}
                      onValueChange={(value) =>
                        run("subscription.update", { refreshMinutes: Number(value) })
                      }
                    >
                      <SettingsSelectTrigger
                        aria-label={t("planner.subscription.interval")}
                        className="min-w-28 justify-between"
                      >
                        <SelectValue>{intervalLabel(t, status?.refreshMinutes ?? 60)}</SelectValue>
                      </SettingsSelectTrigger>
                      <SettingsSelectContent>
                        {SUBSCRIPTION_INTERVALS.map((minutes) => (
                          <SelectItem key={minutes} value={String(minutes)}>
                            {intervalLabel(t, minutes)}
                          </SelectItem>
                        ))}
                      </SettingsSelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("planner.subscription.refresh")}
                      title={t("planner.subscription.refresh")}
                      onClick={() => run("subscription.refresh", {})}
                    >
                      <RefreshCw className="size-4" />
                    </Button>
                    <ConfirmDeletePopover
                      name={calendarName(calendar)}
                      onConfirm={() => run("subscription.delete", {})}
                    >
                      {(open) => (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("planner.subscription.remove")}
                          title={t("planner.subscription.remove")}
                          onClick={open}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </ConfirmDeletePopover>
                  </div>
                }
              />
            );
          })}
        <SettingsRow
          title={t("planner.subscription.add")}
          description={t("planner.subscription.hint")}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={!snapshot}
              onClick={() => setDialog("subscribe")}
            >
              <Plus className="size-4" />
              {t("planner.subscription.add")}
            </Button>
          }
        />
      </SettingsGroup>

      {error && (
        <SettingsNotice variant="action-error" role="alert">
          {error}
        </SettingsNotice>
      )}
      {snapshot && dialog === "calendars" && (
        <CalendarManager snapshot={snapshot} onClose={() => setDialog(null)} />
      )}
      {snapshot && dialog === "import" && (
        <CalendarImport snapshot={snapshot} onClose={() => setDialog(null)} />
      )}
      {dialog === "subscribe" && <SubscriptionDialog onClose={() => setDialog(null)} />}
      {snapshot && dialog === "trash" && (
        <PlanningTrash snapshot={snapshot} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
