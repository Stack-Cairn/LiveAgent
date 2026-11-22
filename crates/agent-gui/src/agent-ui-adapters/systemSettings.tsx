import { invoke } from "@liveagent/app/shims/tauriCore";
import { RefreshCw } from "@liveagent/ui/components/IconSet";
import {
  SettingsSelectContent,
  SettingsSelectTrigger,
} from "@liveagent/ui/components/settings/SettingsSelect";
import { Button, RefreshButton } from "@liveagent/ui/components/ui/button";
import { Select, SelectItem, SelectValue } from "@liveagent/ui/components/ui/select";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  loadDetectedEditors,
  useEditors,
  writePreferredEditorId,
} from "@liveagent/ui/lib/editors/editors";
import { updateRunCompletionSound, updateRunNotifications } from "@liveagent/ui/lib/settings/index";
import {
  AgentActivationSwitch,
  SettingsGroup,
  SettingsRow,
} from "@liveagent/ui/pages/settings/shared";
import { useMemo, useState } from "react";
import { isTauriHost } from "../lib/host";
import { LegacyHistoryImportSettings } from "../lib/kbrain/LegacyHistoryImportSettings";
import { completionSoundPlayer } from "../lib/notifications/completionSound";
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

/** Desktop run notifications and completion chime; shared by Settings and onboarding. */
export function notificationSettingsAvailable(): boolean {
  return isTauriHost();
}

export function NotificationSettingsRows(
  props: Pick<SettingsSectionProps, "settings" | "setSettings">,
) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  return (
    <SettingsGroup title={t("settings.notificationsGroup")}>
      <SettingsRow
        data-settings-anchor="run-notifications"
        title={t("settings.runNotifications")}
        description={t("settings.runNotificationsDesc")}
        control={
          <AgentActivationSwitch
            checked={settings.customSettings.runNotifications}
            title={t("settings.runNotifications")}
            onToggle={() =>
              setSettings((prev) =>
                updateRunNotifications(prev, !prev.customSettings.runNotifications),
              )
            }
          />
        }
      />
      <SettingsRow
        data-settings-anchor="run-completion-sound"
        title={t("settings.runCompletionSound")}
        description={t("settings.runCompletionSoundDesc")}
        control={
          <AgentActivationSwitch
            checked={settings.customSettings.runCompletionSound}
            title={t("settings.runCompletionSound")}
            onToggle={() => {
              const enabled = !settings.customSettings.runCompletionSound;
              // Turning it on previews the chime; the click also unlocks audio
              // for later background playback.
              if (enabled) completionSoundPlayer().play();
              setSettings((prev) => updateRunCompletionSound(prev, enabled));
            }}
          />
        }
      />
    </SettingsGroup>
  );
}

export function SystemSettingsExtensions(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const trayPrefs = useTrayPrefs();
  const isMacPlatform = useMemo(() => inferRuntimePlatform() === "macos", []);
  const [notificationMessage, setNotificationMessage] = useState("");
  const [testingNotification, setTestingNotification] = useState(false);

  return (
    <>
      <LegacyHistoryImportSettings />
      {isTauriHost() && <NotificationSettingsRows settings={settings} setSettings={setSettings} />}
      {isTauriHost() && (
        <SettingsGroup title={t("settings.calendarNotifications")}>
          <SettingsRow
            title={t("settings.notificationTest")}
            description={t("settings.notificationTestHint")}
            control={
              <Button
                disabled={testingNotification}
                onClick={async () => {
                  setTestingNotification(true);
                  setNotificationMessage("");
                  try {
                    await invoke("planning_notification_test");
                    setNotificationMessage(t("settings.notificationSubmitted"));
                  } catch (error) {
                    setNotificationMessage(String(error));
                  } finally {
                    setTestingNotification(false);
                  }
                }}
              >
                {t("settings.notificationTest")}
              </Button>
            }
          />
          {notificationMessage && (
            <p role="status" className="text-sm">
              {notificationMessage}
            </p>
          )}
        </SettingsGroup>
      )}
      <SettingsGroup title={t("settings.closeWindowBehavior")}>
        <SettingsRow
          data-settings-anchor="close-window"
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

      {isTauriHost() && <PreferredEditorSettings />}

      <SettingsGroup title={t("settings.trayTitle")}>
        <SettingsRow
          data-settings-anchor="tray-titles"
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
            data-settings-anchor="tray-badge"
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

function PreferredEditorSettings() {
  const { t } = useLocale();
  const { loaded, editors, preferred } = useEditors();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await loadDetectedEditors({ refresh: true });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <SettingsGroup title={t("settings.editorGroup")}>
      <SettingsRow
        data-settings-anchor="preferred-editor"
        title={t("settings.preferredEditor")}
        description={
          !loaded || preferred
            ? t("settings.preferredEditorDesc")
            : t("settings.preferredEditorNoneDetected")
        }
        control={
          <div className="flex items-center gap-2">
            <RefreshButton
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("settings.preferredEditorRefresh")}
              title={t("settings.preferredEditorRefresh")}
              aria-busy={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw data-refresh-icon className="size-4" />
            </RefreshButton>
            {preferred ? (
              <Select
                value={preferred.id}
                onValueChange={(value) => writePreferredEditorId(String(value))}
              >
                <SettingsSelectTrigger
                  data-testid="preferred-editor-select"
                  className="min-w-32 justify-between"
                >
                  <SelectValue>{preferred.name}</SelectValue>
                </SettingsSelectTrigger>
                <SettingsSelectContent>
                  {editors.map((editor) => (
                    <SelectItem key={editor.id} value={editor.id}>
                      {editor.name}
                    </SelectItem>
                  ))}
                </SettingsSelectContent>
              </Select>
            ) : null}
          </div>
        }
      />
    </SettingsGroup>
  );
}
