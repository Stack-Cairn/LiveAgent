import { useLocale } from "@liveagent/ui/i18n/index";
import { AgentActivationSwitch } from "@liveagent/ui/pages/settings/shared";
import { useMemo } from "react";
import { CheckCircle2, LogOut, Minimize2, MonitorSmartphone } from "../components/icons";
import { inferRuntimePlatform } from "../lib/runtimePlatform";
import { CLOSE_WINDOW_BEHAVIOR_OPTIONS } from "../lib/settings";
import { useTrayPrefs, writeTrayPrefs } from "../lib/tray/trayPrefs";
import type { SettingsSectionProps } from "../pages/settings/types";

export {
  buildFontFamilySelectOptions,
  FONT_FAMILY_CUSTOM_SELECT_VALUE,
  FONT_FAMILY_DEFAULT_SELECT_VALUE,
  fromFontFamilySelectValue,
  listLocalFontFamilies,
  toFontFamilySelectValue,
} from "../lib/system/fontFamily";

export function SystemSettingsExtensions(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const trayPrefs = useTrayPrefs();
  const isMacPlatform = useMemo(() => inferRuntimePlatform() === "macos", []);

  return (
    <>
      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Minimize2 className="h-4 w-4 text-muted-foreground" />
          {t("settings.closeWindowBehavior")}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {CLOSE_WINDOW_BEHAVIOR_OPTIONS.map((behavior) => {
            const selected = settings.closeWindowBehavior === behavior;
            const isMinimize = behavior === "minimize";
            return (
              <button
                key={behavior}
                type="button"
                onClick={() =>
                  setSettings((previous) => ({ ...previous, closeWindowBehavior: behavior }))
                }
                className={`group relative flex h-full items-start gap-3 rounded-xl border px-3.5 py-3.5 text-left transition-all ${
                  selected
                    ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                    : "border-border/60 bg-background/80 hover:border-border hover:bg-muted/35"
                }`}
              >
                <div
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                    selected
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground group-hover:bg-accent/80"
                  }`}
                >
                  {isMinimize ? (
                    <Minimize2 className="h-4.5 w-4.5" />
                  ) : (
                    <LogOut className="h-4.5 w-4.5" />
                  )}
                </div>
                <div className="min-w-0 pr-6">
                  <div className="text-sm font-semibold">
                    {isMinimize ? t("settings.closeWindowMinimize") : t("settings.closeWindowExit")}
                  </div>
                  <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {isMinimize
                      ? t("settings.closeWindowMinimizeDesc")
                      : t("settings.closeWindowExitDesc")}
                  </div>
                </div>
                {selected ? (
                  <div className="absolute right-3 top-3">
                    <CheckCircle2 className="h-4.5 w-4.5 text-primary" />
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
          {t("settings.trayTitle")}
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-foreground">{t("settings.trayShowTitles")}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("settings.trayShowTitlesDesc")}
            </p>
          </div>
          <AgentActivationSwitch
            checked={trayPrefs.showConversationTitles}
            title={t("settings.trayShowTitles")}
            onToggle={() =>
              writeTrayPrefs({ showConversationTitles: !trayPrefs.showConversationTitles })
            }
          />
        </div>
        {isMacPlatform ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-foreground">{t("settings.trayRunningBadge")}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("settings.trayRunningBadgeDesc")}
              </p>
            </div>
            <AgentActivationSwitch
              checked={trayPrefs.showRunningBadge}
              title={t("settings.trayRunningBadge")}
              onToggle={() => writeTrayPrefs({ showRunningBadge: !trayPrefs.showRunningBadge })}
            />
          </div>
        ) : null}
      </section>
    </>
  );
}
