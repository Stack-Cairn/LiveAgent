import { backend } from "@liveagent/app/lib/planning/backend";
import { useCallback, useEffect, useRef, useState } from "react";
import { TimeZonePicker } from "../../components/settings/TimeZonePicker";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import { localizePlanningError } from "../../lib/planning/i18n";

interface TimeZoneSettings {
  preference: string;
  timeZone: string;
  systemTimeZone: string;
  revision: number;
}

export function PlanningTimeZoneSetting() {
  const { t, locale } = useLocale();
  const [settings, setSettings] = useState<TimeZoneSettings | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const epoch = useRef(0);
  const busy = useRef(false);
  const saveFailed = useRef(false);
  const scope = useRef(backend.scope());
  const refresh = useCallback(async () => {
    if (busy.current) return;
    const currentScope = backend.scope();
    if (scope.current !== currentScope) {
      scope.current = currentScope;
      setSettings(null);
    }
    const ticket = ++epoch.current;
    try {
      const result = await backend.call<TimeZoneSettings>("timezone.get");
      if (ticket === epoch.current && currentScope === backend.scope()) {
        setSettings(result);
        if (!saveFailed.current) setError("");
      }
    } catch (e) {
      if (ticket === epoch.current) setError(localizePlanningError(e, locale));
    }
  }, [locale]);
  useEffect(() => {
    void refresh();
    const unsubscribe = backend.subscribe(() => void refresh());
    return () => {
      ++epoch.current;
      unsubscribe();
    };
  }, [refresh]);
  const save = async (preference: string) => {
    if (!settings || busy.current) return;
    const currentScope = backend.scope();
    if (scope.current !== currentScope) {
      void refresh();
      return;
    }
    const ticket = ++epoch.current;
    busy.current = true;
    saveFailed.current = false;
    setSaving(true);
    setError("");
    try {
      const result = await backend.call<TimeZoneSettings>("timezone", {
        preference,
        expectedRevision: settings.revision,
      });
      if (ticket === epoch.current && currentScope === backend.scope()) setSettings(result);
    } catch (e) {
      saveFailed.current = true;
      if (ticket === epoch.current) setError(localizePlanningError(e, locale));
    } finally {
      busy.current = false;
      if (ticket === epoch.current) setSaving(false);
    }
  };
  return (
    <div className="w-64 max-w-full space-y-2">
      <TimeZonePicker
        value={settings?.preference ?? ""}
        label={t("settings.defaultTimeZone")}
        autoLabel={t("settings.defaultTimeZoneAuto").replace(
          "{zone}",
          settings?.systemTimeZone ?? "…",
        )}
        disabled={!settings || saving}
        onChange={(value) => void save(value)}
      />
      {error && (
        <div role="alert" className="text-sm text-destructive">
          {error}
          <Button
            variant="ghost"
            onClick={() => {
              saveFailed.current = false;
              void refresh();
            }}
          >
            {t("planner.common.retry")}
          </Button>
        </div>
      )}
    </div>
  );
}
