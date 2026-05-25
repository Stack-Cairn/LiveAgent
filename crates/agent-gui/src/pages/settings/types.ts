import type { AppSettings } from "../../lib/settings";
import type { SettingsSaveState } from "../../lib/settings/storage";

export type SetSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

export type SectionId =
  | "system"
  | "providers"
  | "agents"
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
  hiddenSections?: SectionId[];
};

export type SettingsSectionProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
};
