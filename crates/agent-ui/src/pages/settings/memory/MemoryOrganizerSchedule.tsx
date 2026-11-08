// K-brain's automatic memory organizer schedule, shown above the organizer history.
// Hidden unless the connected backend reports the setting, so older backends see no change.
//
// Shared implementation owned by @liveagent/ui.

import { SettingsRow } from "@liveagent/ui/components/settings/SettingsLayout";
import {
  SettingsSelectContent,
  SettingsSelectTrigger,
} from "@liveagent/ui/components/settings/SettingsSelect";
import { Select, SelectItem, SelectValue } from "@liveagent/ui/components/ui/select";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { toast } from "@liveagent/ui/components/ui/toast-manager";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useRef, useState } from "react";
import type {
  KBrainMemoryOrganizerConfig,
  KBrainSettingsAdapter,
  KBrainSettingsDocument,
} from "../kbrainSettingsAdapter";

/** Interval choices in hours; K-brain accepts 1 to 168. */
export const MEMORY_ORGANIZER_INTERVALS = [1, 6, 12, 24, 48, 72, 168] as const;

/** The schedule in a K-brain settings document, or null when the backend has none. */
export function memoryOrganizerFromSettings(
  document: Pick<KBrainSettingsDocument, "memoryOrganizer">,
): KBrainMemoryOrganizerConfig | null {
  const value = document.memoryOrganizer as Partial<KBrainMemoryOrganizerConfig> | undefined;
  if (!value || typeof value !== "object") return null;
  const { enabled, intervalHours } = value;
  if (typeof enabled !== "boolean") return null;
  if (typeof intervalHours !== "number" || !Number.isFinite(intervalHours)) return null;
  return { enabled, intervalHours };
}

/**
 * Authoritative schedule, or null when the backend does not support it. Rejects when the
 * backend cannot be read, which callers must not treat as unsupported.
 */
export async function loadMemoryOrganizer(
  kbrain: KBrainSettingsAdapter,
): Promise<KBrainMemoryOrganizerConfig | null> {
  if (kbrain.getCapabilities) {
    const capabilities = await kbrain.getCapabilities();
    if (capabilities.memory_organizer_settings !== 1) return null;
  }
  return memoryOrganizerFromSettings(await kbrain.getSettings());
}

export function memoryOrganizerIntervalLabel(t: (key: string) => string, hours: number): string {
  switch (hours) {
    case 1:
      return t("settings.memoryOrganizerEveryHour");
    case 6:
      return t("settings.memoryOrganizerEverySixHours");
    case 12:
      return t("settings.memoryOrganizerEveryTwelveHours");
    case 24:
      return t("settings.memoryOrganizerEveryDay");
    case 48:
      return t("settings.memoryOrganizerEveryTwoDays");
    case 72:
      return t("settings.memoryOrganizerEveryThreeDays");
    case 168:
      return t("settings.memoryOrganizerEveryWeek");
    default:
      return t("settings.memoryOrganizerEveryHours").replace(
        "{count}",
        String(Math.round(hours * 100) / 100),
      );
  }
}

export function MemoryOrganizerSchedule({ kbrain }: { kbrain: KBrainSettingsAdapter }) {
  const { t } = useLocale();
  const [schedule, setSchedule] = useState<KBrainMemoryOrganizerConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const epoch = useRef(0);
  const savingRef = useRef(false);

  useEffect(() => {
    // A failed read keeps what is shown: hidden before the first answer, the last
    // backend-confirmed schedule after it.
    const load = () => {
      const ticket = ++epoch.current;
      loadMemoryOrganizer(kbrain).then(
        (value) => {
          if (ticket === epoch.current) setSchedule(value);
        },
        () => {},
      );
    };
    const onChanged = () => {
      if (!savingRef.current) load();
    };
    load();
    window.addEventListener("kbrain:settings-changed", onChanged);
    return () => {
      ++epoch.current;
      window.removeEventListener("kbrain:settings-changed", onChanged);
    };
  }, [kbrain]);

  async function change(update: Partial<KBrainMemoryOrganizerConfig>) {
    if (saving || schedule === null) return;
    const next = { ...schedule, ...update };
    if (next.enabled === schedule.enabled && next.intervalHours === schedule.intervalHours) return;
    const ticket = ++epoch.current;
    const before = schedule;
    savingRef.current = true;
    setSaving(true);
    setSchedule(next);
    try {
      const saved = memoryOrganizerFromSettings(
        await kbrain.updateSettings({ memoryOrganizer: update }),
      );
      if (ticket !== epoch.current) return;
      setSchedule(saved ?? next);
      window.dispatchEvent(new Event("kbrain:settings-changed"));
    } catch {
      if (ticket !== epoch.current) return;
      // Roll back to what the backend holds; a write can land even when its response is lost.
      const current = await loadMemoryOrganizer(kbrain).catch(() => before);
      if (ticket !== epoch.current) return;
      setSchedule(current);
      if (current?.enabled !== next.enabled || current?.intervalHours !== next.intervalHours) {
        toast.error(t("settings.memoryOrganizerScheduleSaveFailed"));
      }
      window.dispatchEvent(new Event("kbrain:settings-changed"));
    } finally {
      savingRef.current = false;
      if (ticket === epoch.current) setSaving(false);
    }
  }

  if (schedule === null) return null;
  const intervals: number[] = [...MEMORY_ORGANIZER_INTERVALS];
  if (!intervals.includes(schedule.intervalHours)) {
    intervals.push(schedule.intervalHours);
    intervals.sort((a, b) => a - b);
  }
  return (
    <section className="py-3" data-testid="memory-organizer-schedule" aria-busy={saving}>
      <SettingsRow
        title={t("settings.memoryOrganizerToggle")}
        description={t(
          schedule.enabled
            ? "settings.memoryOrganizerScheduleOnDescription"
            : "settings.memoryOrganizerScheduleOffDescription",
        )}
        control={
          <Switch
            checked={schedule.enabled}
            disabled={saving}
            onCheckedChange={(checked) => void change({ enabled: checked === true })}
            aria-label={t("settings.memoryOrganizerToggle")}
          />
        }
      />
      {schedule.enabled ? (
        <SettingsRow
          title={t("settings.memoryOrganizerSchedule")}
          control={
            <Select
              value={String(schedule.intervalHours)}
              disabled={saving}
              onValueChange={(value) => {
                const hours = Number(value);
                if (Number.isFinite(hours)) void change({ intervalHours: hours });
              }}
            >
              <SettingsSelectTrigger
                aria-label={t("settings.memoryOrganizerSchedule")}
                className="min-w-28 justify-between"
              >
                <SelectValue>{memoryOrganizerIntervalLabel(t, schedule.intervalHours)}</SelectValue>
              </SettingsSelectTrigger>
              <SettingsSelectContent>
                {intervals.map((hours) => (
                  <SelectItem key={hours} value={String(hours)}>
                    {memoryOrganizerIntervalLabel(t, hours)}
                  </SelectItem>
                ))}
              </SettingsSelectContent>
            </Select>
          }
        />
      ) : null}
    </section>
  );
}
