import { createSettingsExtension } from "@liveagent/adapters/settingsExtension";
import type { SttProviderId } from "@liveagent/app/lib/settings";
import type { SettingsPageProps } from "@liveagent/app/pages/settings/types";
import {
  BookOpen,
  Brain,
  Clock3,
  Cloud,
  Cpu,
  Key,
  Mic,
  Settings2,
  SquareMousePointer,
  Wrench,
  Zap,
} from "@liveagent/ui/components/IconSet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SettingsSectionDefinition, UiExtensionRegistry } from "../../contracts/registry";
import { AgentsSection } from "./AgentsSection";
import { CronSection } from "./CronSection";
import { CuaDriverSection } from "./CuaDriverSection";
import { HooksSection } from "./HooksSection";
import { MemoryPanel } from "./memory/MemoryPanel";
import { ProvidersSection } from "./ProvidersSection";
import { RemoteSection } from "./RemoteSection";
import { SettingsShell } from "./SettingsShell";
import { SshSection } from "./SshSection";
import { SttSection } from "./SttSection";
import { SystemSettingsForm } from "./SystemSettingsForm";
import { SystemToolsSection } from "./SystemToolsSection";

const EMPTY_SERVICES = {};
const STT_SELECTED_PROVIDER_CACHE = new WeakMap<
  SettingsPageProps["sttSettingsService"],
  SttProviderId
>();

export function SettingsPage(props: SettingsPageProps) {
  const {
    settings,
    setSettings,
    saveState,
    onBack,
    initialSection = "system",
    initialProviderId,
    hiddenSections = [],
    sttSettingsService,
    onSttProviderChange,
  } = props;
  const [pendingProviderId, setPendingProviderId] = useState(initialProviderId);
  const [sttSelectedProvider, setSttSelectedProvider] = useState<SttProviderId>(
    () =>
      STT_SELECTED_PROVIDER_CACHE.get(sttSettingsService) ??
      settings.stt.provider ??
      "tencent_cloud",
  );
  const sttSelectionChangedRef = useRef(STT_SELECTED_PROVIDER_CACHE.has(sttSettingsService));
  const extension = createSettingsExtension(props);

  useEffect(() => setPendingProviderId(initialProviderId), [initialProviderId]);
  useEffect(() => {
    if (!sttSelectionChangedRef.current) {
      setSttSelectedProvider(settings.stt.provider ?? "tencent_cloud");
    }
  }, [settings.stt.provider]);

  const handleSttProviderChange = useCallback(
    (provider: SttProviderId) => {
      sttSelectionChangedRef.current = true;
      STT_SELECTED_PROVIDER_CACHE.set(sttSettingsService, provider);
      setSttSelectedProvider(provider);
      onSttProviderChange?.(provider);
    },
    [onSttProviderChange, sttSettingsService],
  );

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
        // Computer Use（CUA）。两端同一份引导页：探测与授权状态经宿主真实读取
        // （WebUI 走 gateway 中继），设置项两端同样可写，只有安装与授权两个必须
        // 在桌面主机那台机器上完成的动作在 web 面收起——判定交给组件的 surface。
        id: "cua",
        groupKey: "settings.groupIntelligence",
        groupOrder: 20,
        order: 25,
        labelKey: "settings.navCua",
        icon: <SquareMousePointer className={extension.iconClassName} />,
        render: () => (
          <CuaDriverSection
            settings={settings}
            setSettings={setSettings}
            surface={extension.surface}
          />
        ),
      },
      {
        id: "stt",
        groupKey: "settings.groupIntelligence",
        groupOrder: 20,
        order: 30,
        labelKey: "settings.navStt",
        icon: <Mic className={extension.iconClassName} />,
        render: () => (
          <SttSection
            settings={settings}
            setSettings={setSettings}
            service={sttSettingsService}
            selectedProvider={sttSelectedProvider}
            onSelectedProviderChange={handleSttProviderChange}
          />
        ),
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
    [
      extension,
      handleSttProviderChange,
      pendingProviderId,
      saveState,
      setSettings,
      settings,
      sttSelectedProvider,
      sttSettingsService,
    ],
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
