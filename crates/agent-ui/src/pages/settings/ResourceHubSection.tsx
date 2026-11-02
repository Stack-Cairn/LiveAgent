import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { getResourceHostCapabilities } from "../../lib/resourceHost";
import { McpHubPage } from "../mcp-hub/McpHubPage";
import { SkillsHubPage } from "../skills-hub/SkillsHubPage";

export function ResourceHubSection({
  resource,
  settings,
  setSettings,
}: SettingsSectionProps & { resource: "skills" | "mcp" }) {
  const isAgentMode = settings.system.executionMode !== "text";
  if (resource === "skills") {
    return (
      <SkillsHubPage
        settings={settings}
        setSettings={setSettings}
        isAgentMode={isAgentMode}
        resourceHost={getResourceHostCapabilities()}
        embedded
      />
    );
  }
  return (
    <McpHubPage settings={settings} setSettings={setSettings} isAgentMode={isAgentMode} embedded />
  );
}
