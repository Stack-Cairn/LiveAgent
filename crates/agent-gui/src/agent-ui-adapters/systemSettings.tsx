import { useLocale } from "@liveagent/ui/i18n/index";
import {
  AgentActivationSwitch,
  SettingsChoiceRow,
  SettingsGroup,
  SettingsRow,
} from "@liveagent/ui/pages/settings/shared";
import { useMemo } from "react";
import { LogOut, Minimize2 } from "../components/icons";
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
      <SettingsGroup title={t("settings.closeWindowBehavior")}>
        <fieldset
          aria-label={t("settings.closeWindowBehavior")}
          className="m-0 min-w-0 border-0 p-0"
        >
          {CLOSE_WINDOW_BEHAVIOR_OPTIONS.map((behavior) => {
            const selected = settings.closeWindowBehavior === behavior;
            const isMinimize = behavior === "minimize";
            return (
              <SettingsChoiceRow
                key={behavior}
                icon={
                  isMinimize ? (
                    <Minimize2 className="h-4.5 w-4.5" />
                  ) : (
                    <LogOut className="h-4.5 w-4.5" />
                  )
                }
                title={
                  isMinimize ? t("settings.closeWindowMinimize") : t("settings.closeWindowExit")
                }
                description={
                  isMinimize
                    ? t("settings.closeWindowMinimizeDesc")
                    : t("settings.closeWindowExitDesc")
                }
                selected={selected}
                onClick={() =>
                  setSettings((previous) => ({ ...previous, closeWindowBehavior: behavior }))
                }
              />
            );
          })}
        </fieldset>
      </SettingsGroup>

      <SettingsGroup title={t("settings.trayTitle")}>
        <SettingsRow
          title={t("settings.trayShowTitles")}
          description={t("settings.trayShowTitlesDesc")}
          control={
            <AgentActivationSwitch
              checked={trayPrefs.showConversationTitles}
              title={t("settings.trayShowTitles")}
              onToggle={() =>
                writeTrayPrefs({ showConversationTitles: !trayPrefs.showConversationTitles })
              }
            />
          }
        />
        {isMacPlatform ? (
          <SettingsRow
            title={t("settings.trayRunningBadge")}
            description={t("settings.trayRunningBadgeDesc")}
            control={
              <AgentActivationSwitch
                checked={trayPrefs.showRunningBadge}
                title={t("settings.trayRunningBadge")}
                onToggle={() => writeTrayPrefs({ showRunningBadge: !trayPrefs.showRunningBadge })}
              />
            }
          />
        ) : null}
      </SettingsGroup>
    </>
  );
}
