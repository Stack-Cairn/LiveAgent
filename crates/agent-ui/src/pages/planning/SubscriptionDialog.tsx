import { openUrl } from "@liveagent/app/shims/tauriOpener";
import { useState } from "react";
import { ExternalLink } from "../../components/IconSet";
import { SettingsNotice } from "../../components/settings/SettingsNotice";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { localizePlanningError } from "../../lib/planning/i18n";
import { planningStore } from "../../lib/planning/store";
import { ColorSwatches, PLANNING_COLORS, PlanningField, PlanningSelect } from "./PlanningControls";
import { usePlanningT } from "./usePlanningT";

export const SUBSCRIPTION_INTERVALS = [15, 30, 60, 180, 360, 720, 1440] as const;

export function intervalLabel(
  t: (key: string, vars?: Record<string, number>) => string,
  minutes: number,
) {
  return minutes < 60
    ? t("planner.subscription.everyMinutes", { count: minutes })
    : minutes < 1440
      ? t("planner.subscription.everyHours", { count: minutes / 60 })
      : t("planner.subscription.daily");
}

/** Google Calendar settings, where each calendar's "Integrate calendar" shows its iCal address. */
export const GOOGLE_CALENDAR_SETTINGS_URL = "https://calendar.google.com/calendar/r/settings";

/** Opens Google Calendar settings in the system browser (new tab on the web). */
export function GoogleCalendarLink({ className }: { className?: string }) {
  const { t } = usePlanningT();
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline ${className ?? ""}`}
      onClick={() =>
        void openUrl(GOOGLE_CALENDAR_SETTINGS_URL).catch(() =>
          window.open(GOOGLE_CALENDAR_SETTINGS_URL, "_blank", "noreferrer"),
        )
      }
    >
      {t("planner.subscription.openGoogle")}
      <ExternalLink className="size-3.5" />
    </button>
  );
}

/** Add an iCal subscription (Google "secret address", Outlook, Apple, Feishu…). */
export function SubscriptionDialog({ onClose }: { onClose(): void }) {
  const { t } = usePlanningT();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState(PLANNING_COLORS[0]);
  const [refreshMinutes, setRefreshMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await planningStore.command("subscription.create", {
        url: url.trim(),
        name: name.trim() || t("planner.subscription.defaultName"),
        color,
        refreshMinutes,
      });
      onClose();
    } catch (e) {
      setError(localizePlanningError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="max-w-lg"
        showCloseButton
        closeLabel={t("planner.common.close")}
        closeDisabled={busy}
      >
        <DialogHeader>
          <DialogTitle>{t("planner.subscription.add")}</DialogTitle>
          <DialogDescription>{t("planner.subscription.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) void save();
            }}
          >
            <PlanningField
              label={t("planner.subscription.url")}
              description={
                <>
                  {t("planner.subscription.urlHint")} <GoogleCalendarLink />
                </>
              }
            >
              <Input
                variant="plain"
                autoFocus
                value={url}
                disabled={busy}
                placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setUrl(e.target.value)}
              />
            </PlanningField>
            <PlanningField label={t("planner.calendar.name")}>
              <Input
                variant="plain"
                value={name}
                disabled={busy}
                maxLength={60}
                placeholder={t("planner.subscription.defaultName")}
                onChange={(e) => setName(e.target.value)}
              />
            </PlanningField>
            <ColorSwatches
              label={t("planner.calendar.color")}
              value={color}
              disabled={busy}
              onChange={setColor}
            />
            <PlanningField label={t("planner.subscription.interval")}>
              <PlanningSelect
                value={refreshMinutes}
                disabled={busy}
                onValueChange={(value) => setRefreshMinutes(Number(value))}
                options={SUBSCRIPTION_INTERVALS.map((minutes) => ({
                  value: minutes,
                  label: intervalLabel(t, minutes),
                }))}
              />
            </PlanningField>
            {error && (
              <SettingsNotice role="alert" variant="action-error">
                {error}
              </SettingsNotice>
            )}
            <button type="submit" hidden />
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogActions>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t("planner.common.cancel")}
            </Button>
            <Button disabled={busy || !url.trim()} onClick={() => void save()}>
              {busy ? t("planner.common.saving") : t("planner.subscription.subscribe")}
            </Button>
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
