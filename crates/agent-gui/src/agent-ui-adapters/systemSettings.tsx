import {
  SettingsSelectContent,
  SettingsSelectTrigger,
} from "@liveagent/ui/components/settings/SettingsSelect";
import { Select, SelectItem, SelectValue } from "@liveagent/ui/components/ui/select";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  AgentActivationSwitch,
  SettingsGroup,
  SettingsRow,
} from "@liveagent/ui/pages/settings/shared";
import { invoke } from "@tauri-apps/api/core";
import { useMemo } from "react";
import { inferRuntimePlatform } from "../lib/runtimePlatform";
import { CLOSE_WINDOW_BEHAVIOR_OPTIONS } from "../lib/settings";
import { useTrayPrefs, writeTrayPrefs } from "../lib/tray/trayPrefs";
import type { SettingsSectionProps } from "../pages/settings/types";

export {
  buildFontFamilySelectOptions,
  FONT_FAMILY_CUSTOM_SELECT_VALUE,
  FONT_FAMILY_DEFAULT_SELECT_VALUE,
  fromFontFamilySelectValue,
  toFontFamilySelectValue,
} from "@liveagent/ui/lib/shared/fontFamily";

let fontFamiliesRequest: Promise<string[]> | undefined;

export function listLocalFontFamilies(): Promise<string[]> {
  fontFamiliesRequest ??= invoke<string[]>("system_list_font_families").catch(() => {
    fontFamiliesRequest = undefined;
    return [];
  });
  return fontFamiliesRequest;
}

export function SystemSettingsExtensions(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const trayPrefs = useTrayPrefs();
  const isMacPlatform = useMemo(() => inferRuntimePlatform() === "macos", []);

  return (
    <>
      <SettingsGroup title={t("settings.closeWindowBehavior")}>
        <SettingsRow
          title={t("settings.defaultCloseWindowBehavior")}
          description={
            settings.closeWindowBehavior === "minimize"
              ? t("settings.closeWindowMinimizeDesc")
              : t("settings.closeWindowExitDesc")
          }
          control={
            <Select
              value={settings.closeWindowBehavior}
              onValueChange={(value) =>
                setSettings((previous) => ({
                  ...previous,
                  closeWindowBehavior: value as (typeof CLOSE_WINDOW_BEHAVIOR_OPTIONS)[number],
                }))
              }
            >
              <SettingsSelectTrigger className="min-w-32 justify-between">
                <SelectValue>
                  {settings.closeWindowBehavior === "minimize"
                    ? t("settings.closeWindowMinimize")
                    : t("settings.closeWindowExit")}
                </SelectValue>
              </SettingsSelectTrigger>
              <SettingsSelectContent>
                {CLOSE_WINDOW_BEHAVIOR_OPTIONS.map((behavior) => (
                  <SelectItem key={behavior} value={behavior}>
                    {behavior === "minimize"
                      ? t("settings.closeWindowMinimize")
                      : t("settings.closeWindowExit")}
                  </SelectItem>
                ))}
              </SettingsSelectContent>
            </Select>
          }
        />
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
