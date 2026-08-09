import type { SettingsSectionDefinition, UiExtensionSlots } from "@liveagent/ui/contracts/registry";
import { Info, Keyboard } from "../components/icons";
import { isMacOsTauri, MacOsTitleBarSpacer } from "../components/MacOsTitleBarSpacer";
import { AboutSection } from "../pages/settings/AboutSection";
import { GlobalShortcutsSection } from "../pages/settings/GlobalShortcutsSection";
import type { SettingsPageProps } from "../pages/settings/types";

export function createSettingsExtension(props: SettingsPageProps): {
  surface: "desktop";
  iconClassName: string;
  slots: UiExtensionSlots;
  sections: SettingsSectionDefinition<void>[];
} {
  const { settings, setSettings, appUpdate } = props;
  return {
    surface: "desktop",
    iconClassName: "h-3.5 w-3.5",
    slots: {
      sidebarLeading: isMacOsTauri() ? (
        <div data-tauri-drag-region className="h-[38px] shrink-0" />
      ) : null,
      mainLeading: <MacOsTitleBarSpacer />,
    },
    sections: [
      {
        id: "shortcuts",
        groupKey: "settings.groupOther",
        groupOrder: 50,
        order: 10,
        labelKey: "settings.navShortcuts",
        icon: <Keyboard className="h-3.5 w-3.5" />,
        render: () => <GlobalShortcutsSection />,
      },
      {
        id: "about",
        groupKey: "settings.groupOther",
        groupOrder: 50,
        order: 20,
        labelKey: "settings.navAbout",
        icon: <Info className="h-3.5 w-3.5" />,
        render: () => (
          <AboutSection settings={settings} setSettings={setSettings} appUpdate={appUpdate} />
        ),
      },
    ],
  };
}
