import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { McpHubPage } from "../mcp-hub/McpHubPage";
import { SkillsHubPage } from "../skills-hub/SkillsHubPage";

export function ResourceHubSection({
  resource,
  settings,
  setSettings,
}: SettingsSectionProps & { resource: "skills" | "mcp" }) {
  const Hub = resource === "skills" ? SkillsHubPage : McpHubPage;
  return (
    <Hub
      settings={settings}
      setSettings={setSettings}
      isAgentMode={settings.system.executionMode !== "text"}
      embedded
    />
  );
}
