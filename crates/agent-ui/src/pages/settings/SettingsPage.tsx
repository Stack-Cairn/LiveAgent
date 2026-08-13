import { createSettingsExtension } from "@liveagent/adapters/settingsExtension";
import type { SettingsPageProps } from "@liveagent/app/pages/settings/types";
import {
  BookOpen,
  Brain,
  Clock3,
  Cloud,
  Cpu,
  Key,
  Settings2,
  Wrench,
  Zap,
} from "@liveagent/ui/components/IconSet";
import { useEffect, useMemo, useState } from "react";
import type { SettingsSectionDefinition, UiExtensionRegistry } from "../../contracts/registry";
import { AgentsSection } from "./AgentsSection";
import { CronSection } from "./CronSection";
import { HooksSection } from "./HooksSection";
import { MemoryPanel } from "./memory/MemoryPanel";
import { ProvidersSection } from "./ProvidersSection";
import { RemoteSection } from "./RemoteSection";
import { SettingsShell } from "./SettingsShell";
import { SshSection } from "./SshSection";
import { SystemSettingsForm } from "./SystemSettingsForm";
import { SystemToolsSection } from "./SystemToolsSection";

const EMPTY_SERVICES = {};

export function SettingsPage(props: SettingsPageProps) {
  const {
    settings,
    setSettings,
    saveState,
    onBack,
    initialSection = "system",
    initialProviderId,
    hiddenSections = [],
  } = props;
  const [pendingProviderId, setPendingProviderId] = useState(initialProviderId);
  const extension = createSettingsExtension(props);

  useEffect(() => setPendingProviderId(initialProviderId), [initialProviderId]);

  const sections = useMemo<SettingsSectionDefinition<void>[]>(
    () => [
      {
        id: "system",
        groupKey: "settings.groupGeneral",
        groupOrder: 10,
        order: 10,
        labelKey: "settings.navSystem",
        icon: <Settings2 className={extension.iconClassName} />,
        render: () => <SystemSettingsForm settings={settings} setSettings={setSettings} />,
      },
      {
        id: "providers",
        groupKey: "settings.groupGeneral",
        groupOrder: 10,
        order: 20,
        labelKey: "settings.navProviders",
        icon: <Cpu className={extension.iconClassName} />,
        contentMode: "fill",
        render: () => (
          <ProvidersSection
            settings={settings}
            setSettings={setSettings}
            initialProviderId={pendingProviderId}
            onInitialProviderHandled={() => setPendingProviderId(undefined)}
          />
        ),
      },
      {
        id: "agents",
        groupKey: "settings.groupGeneral",
        groupOrder: 10,
        order: 30,
        labelKey: "settings.navAgents",
        icon: <BookOpen className={extension.iconClassName} />,
        render: () => <AgentsSection settings={settings} setSettings={setSettings} />,
      },
      {
        id: "memory",
        groupKey: "settings.groupIntelligence",
        groupOrder: 20,
        order: 10,
        labelKey: "settings.navMemory",
        icon: <Brain className={extension.iconClassName} />,
        contentMode: "fill",
        render: () => (
          <MemoryPanel
            workdir={settings.system.workdir}
            settings={settings}
            setSettings={setSettings}
          />
        ),
      },
      {
        id: "systemTools",
        groupKey: "settings.groupIntelligence",
        groupOrder: 20,
        order: 20,
        labelKey: "settings.navSystemTools",
        icon: <Wrench className={extension.iconClassName} />,
        render: () => <SystemToolsSection settings={settings} setSettings={setSettings} />,
      },
      {
        id: "hooks",
        groupKey: "settings.groupAutomation",
        groupOrder: 30,
        order: 10,
        labelKey: "settings.navHooks",
        icon: <Zap className={extension.iconClassName} />,
        contentMode: "fill",
        render: () => <HooksSection settings={settings} setSettings={setSettings} />,
      },
      {
        id: "cron",
        groupKey: "settings.groupAutomation",
        groupOrder: 30,
        order: 20,
        labelKey: "settings.navCron",
        icon: <Clock3 className={extension.iconClassName} />,
        render: () => <CronSection settings={settings} setSettings={setSettings} />,
      },
      {
        id: "ssh",
        groupKey: "settings.groupConnectivity",
        groupOrder: 40,
        order: 10,
        labelKey: "settings.navSsh",
        icon: <Key className={extension.iconClassName} />,
        render: () => (
          <SshSection settings={settings} setSettings={setSettings} saveState={saveState} />
        ),
      },
      {
        id: "remote",
        groupKey: "settings.groupConnectivity",
        groupOrder: 40,
        order: 20,
        labelKey: "settings.navRemote",
        icon: <Cloud className={extension.iconClassName} />,
        render: () => <RemoteSection settings={settings} setSettings={setSettings} />,
      },
      ...extension.sections,
    ],
    [extension, pendingProviderId, saveState, setSettings, settings],
  );
  const registry: UiExtensionRegistry<void> = {
    surface: extension.surface,
    services: EMPTY_SERVICES,
    slots: extension.slots,
    settingsSections: sections,
  };

  return (
    <SettingsShell
      registry={registry}
      context={undefined}
      saveState={saveState}
      onBack={onBack}
      initialSection={initialSection}
      hiddenSections={hiddenSections}
    />
  );
}
