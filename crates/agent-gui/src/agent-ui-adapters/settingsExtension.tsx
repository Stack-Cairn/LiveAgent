import { Archive, Info, Keyboard, SquareMousePointer } from "@liveagent/ui/components/IconSet";
import type { SettingsSectionDefinition, UiExtensionSlots } from "@liveagent/ui/contracts/registry";
import { CuaDriverSection } from "@liveagent/ui/pages/settings/CuaDriverSection";
import { isMacOsTauri, MacOsTitleBarSpacer } from "../components/MacOsTitleBarSpacer";
import { AboutSection } from "../pages/settings/AboutSection";
import { BackupSyncSection } from "../pages/settings/BackupSyncSection";
import { GlobalShortcutsSection } from "../pages/settings/GlobalShortcutsSection";
import type { SettingsPageProps } from "../pages/settings/types";

export function createSettingsExtension(props: SettingsPageProps): {
  surface: "desktop";
  iconClassName: string;
  slots: UiExtensionSlots;
  sections: SettingsSectionDefinition<void>[];
} {
  const { settings, setSettings, appUpdate, reloadSettings } = props;
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
      // Computer Use（CUA）接入引导。桌面端专属：探测 / 安装 / 授权都要
      // Tauri 后端命令，WebUI 下这些 invoke 会直接抛错，所以不在共享的
      // SettingsPage 里注册，而是走桌面 extension。order 取 25 是为了插在
      // 系统工具（20）与语音识别（30）之间。
      {
        id: "cua",
        groupKey: "settings.groupIntelligence",
        groupOrder: 20,
        order: 25,
        labelKey: "settings.navCua",
        icon: <SquareMousePointer className="h-3.5 w-3.5" />,
        render: () => <CuaDriverSection settings={settings} setSettings={setSettings} />,
      },
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
        id: "backup",
        groupKey: "settings.groupOther",
        groupOrder: 50,
        order: 15,
        labelKey: "settings.navBackup",
        icon: <Archive className="h-3.5 w-3.5" />,
        render: () => (
          <BackupSyncSection
            settings={settings}
            setSettings={setSettings}
            reloadSettings={reloadSettings}
          />
        ),
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
