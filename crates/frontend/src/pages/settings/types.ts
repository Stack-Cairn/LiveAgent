import type { AppUpdateController } from "../../lib/appUpdates";
import type { AppSettings } from "../../lib/settings";
import type { SettingsSaveState } from "../../lib/settings/storage";

export type SetSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

export type SectionId =
  | "system"
  | "shortcuts"
  | "systemTools"
  | "providers"
  | "agents"
  | "ssh"
  | "memory"
  | "hooks"
  | "cron"
  | "remote"
  | "about";

export type SettingsPageProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState: SettingsSaveState;
  onBack: () => void;
  initialSection?: SectionId;
  initialProviderId?: string;
  hiddenSections?: SectionId[];
  appUpdate: AppUpdateController;
};

export type SettingsSectionProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState?: SettingsSaveState;
};
