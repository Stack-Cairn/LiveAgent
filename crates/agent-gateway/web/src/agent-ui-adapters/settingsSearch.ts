import type { SettingsSearchExtension } from "@liveagent/ui/lib/settings/settingsSearchIndex";

/** Settings rows only the WebUI renders, for settings search and the palette. */
export const webSettingsSearch: SettingsSearchExtension = {
  sectionLabelKeys: { devices: "settings.navAgentManagement" },
  entries: [
    {
      section: "devices",
      anchor: "devices",
      labelKey: "settings.devicesTitle",
      descriptionKey: "settings.devicesDesc",
      keywords: ["device", "client", "token", "pairing"],
    },
  ],
};
