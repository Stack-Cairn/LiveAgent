export {
  buildFontFamilySelectOptions,
  FONT_FAMILY_CUSTOM_SELECT_VALUE,
  FONT_FAMILY_DEFAULT_SELECT_VALUE,
  fromFontFamilySelectValue,
  listLocalFontFamilies,
  toFontFamilySelectValue,
} from "@liveagent/ui/lib/shared/fontFamily";

export function SystemSettingsExtensions(_props: SettingsSectionProps) {
  return null;
}

/** Run notifications are a desktop feature; the WebUI has none to configure. */
export function notificationSettingsAvailable(): boolean {
  return false;
}

export function NotificationSettingsRows(
  _props: Pick<SettingsSectionProps, "settings" | "setSettings">,
) {
  return null;
}

import type { SettingsSectionProps } from "../pages/settings/types";
