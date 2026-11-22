import {
  type SettingsSearchExtension,
  shortcutCommandSettingsAnchor,
} from "@liveagent/ui/lib/settings/settingsSearchIndex";
import type { ShortcutCommandId } from "@liveagent/ui/lib/shortcuts/shortcutCommands";

/**
 * Shortcut commands the WebUI does not offer: the transcript has no find bar
 * (the browser keeps Cmd/Ctrl+F) and page zoom belongs to the browser.
 */
export const WEB_UNSUPPORTED_SHORTCUT_COMMANDS: readonly ShortcutCommandId[] = [
  "findInConversation",
  "zoomIn",
  "zoomOut",
  "zoomReset",
];

/** Settings rows only the WebUI renders, for settings search and the palette. */
export const webSettingsSearch: SettingsSearchExtension = {
  sectionLabelKeys: { devices: "settings.navAgentManagement", help: "settings.aboutHelp" },
  hiddenAnchors: WEB_UNSUPPORTED_SHORTCUT_COMMANDS.map(shortcutCommandSettingsAnchor),
  entries: [
    {
      section: "devices",
      anchor: "devices",
      labelKey: "settings.devicesTitle",
      descriptionKey: "settings.devicesDesc",
      keywords: ["device", "client", "token", "pairing"],
    },
    {
      section: "help",
      anchor: "web-diagnostics",
      labelKey: "diagnostics.export",
      descriptionKey: "diagnostics.exportDesc",
      keywords: ["diagnostics", "logs", "bug report", "support", "debug", "zip"],
    },
  ],
};
