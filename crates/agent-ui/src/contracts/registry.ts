import type { ReactNode } from "react";
import type { SettingsSearchExtension } from "../lib/settings/settingsSearchIndex";

export type UiSurface = "desktop" | "web";

export type UiServices = Readonly<Record<string, unknown>>;

export type UiExtensionSlots = {
  sidebarLeading?: ReactNode;
  mainLeading?: ReactNode;
};

export type SettingsSaveState =
  | { status: "idle" | "saving" | "saved" | "savedOnDevice" }
  | { status: "error"; message: string };

export type SettingsSectionDefinition<Context> = {
  id: string;
  groupKey: string;
  groupOrder: number;
  order: number;
  labelKey: string;
  icon: ReactNode;
  contentMode?: "scroll" | "fill";
  showSaveIndicator?: boolean;
  isAvailable?: (services: UiServices) => boolean;
  render: (context: Context) => ReactNode;
};

export type UiExtensionRegistry<Context> = {
  surface: UiSurface;
  services: UiServices;
  slots: UiExtensionSlots;
  settingsSections: readonly SettingsSectionDefinition<Context>[];
  /** Host-only rows for settings search (shared rows come from the shared index). */
  settingsSearch?: SettingsSearchExtension;
};
