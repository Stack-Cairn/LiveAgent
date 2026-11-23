import "@liveagent/ui/i18n/namespaces/settings";
import { createSettingsExtension } from "@liveagent/adapters/settingsExtension";
import type { SttProviderId } from "@liveagent/app/lib/settings";
import type { SettingsPageProps } from "@liveagent/app/pages/settings/types";
import {
  Blend,
  BookOpen,
  Brain,
  Cable,
  CalendarDays,
  ChartColumn,
  Clock3,
  Cloud,
  Cpu,
  Globe,
  Key,
  Mic,
  Plug,
  Settings2,
  ShieldCheck,
  Wrench,
  Zap,
} from "@liveagent/ui/components/IconSet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SettingsSectionDefinition, UiExtensionRegistry } from "../../contracts/registry";
import {
  KBRAIN_HTML_PREVIEWS_CAPABILITY,
  KBRAIN_PLUGIN_UI_CAPABILITY,
  KBRAIN_PLUGINS_CAPABILITY,
} from "../../lib/plugins/types";
import { AgentsSection } from "./AgentsSection";
import { AIApprovalSection } from "./AIApprovalSection";
import { CalendarSection } from "./CalendarSection";
import { CronSection } from "./CronSection";
import { HooksSection } from "./HooksSection";
import { MemoryPanel } from "./memory/MemoryPanel";
import { PermissionRulesSection } from "./PermissionRulesSection";
import { PluginsSection } from "./PluginsSection";
import { ProvidersSection } from "./ProvidersSection";
import { RemoteSection } from "./RemoteSection";
import { ResourceHubSection } from "./ResourceHubSection";
import { SettingsShell } from "./SettingsShell";
import { SshSection } from "./SshSection";
import { SttSection } from "./SttSection";
import { SystemSettingsForm } from "./SystemSettingsForm";
import { SystemToolsSection } from "./SystemToolsSection";
import { UsageStatsSection } from "./UsageStatsSection";
import { WebSearchSection } from "./WebSearchSection";

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
    rejectedLegacyProviders,
    onRetryRejectedLegacyProviders,
    onDismissRejectedLegacyProviders,
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

  const sandboxedUi = useSandboxedUiCapabilities(props.settingsHost?.kbrain?.getCapabilities);
  const pluginsClient = sandboxedUi.plugins ? props.settingsHost?.kbrain?.plugins : undefined;

  const sections = useMemo<SettingsSectionDefinition<void>[]>(
    () => [
      {
        id: "system",
        groupKey: "settings.groupGeneral",
        groupOrder: 10,
        order: 10,
        labelKey: "settings.navSystem",
        icon: <Settings2 className={extension.iconClassName} />,
        render: () => (
          <SystemSettingsForm
            settings={settings}
            setSettings={setSettings}
            htmlPreviewsAvailable={sandboxedUi.htmlPreviews}
          />
        ),
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
            rejectedLegacyProviders={rejectedLegacyProviders}
            onRetryRejectedLegacyProviders={onRetryRejectedLegacyProviders}
            onDismissRejectedLegacyProviders={onDismissRejectedLegacyProviders}
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
      // Only hosts that can reach K-brain's usage API get the page.
      ...(props.settingsHost?.kbrain?.getUsageStats
        ? [
            {
              id: "usage",
              groupKey: "settings.groupGeneral",
              groupOrder: 10,
              order: 40,
              labelKey: "settings.navUsage",
              icon: <ChartColumn className={extension.iconClassName} />,
              showSaveIndicator: false,
              render: () =>
                props.settingsHost?.kbrain ? (
                  <UsageStatsSection kbrain={props.settingsHost.kbrain} />
                ) : null,
            } satisfies SettingsSectionDefinition<void>,
          ]
        : []),
      ...(["skills", "mcp"] as const).map((id, index) => ({
        id,
        groupKey: "settings.groupResources",
        groupOrder: 20,
        order: (index + 1) * 10,
        labelKey: id === "skills" ? "settings.navSkills" : "settings.navMcp",
        icon:
          id === "skills" ? (
            <Blend className={extension.iconClassName} />
          ) : (
            <Cable className={extension.iconClassName} />
          ),
        contentMode: "fill" as const,
        render: () => (
          <ResourceHubSection resource={id} settings={settings} setSettings={setSettings} />
        ),
      })),
      // Desktop only (the host talks to K-brain directly) and only when K-brain has plugins.
      ...(pluginsClient
        ? [
            {
              id: "plugins",
              groupKey: "settings.groupResources",
              groupOrder: 20,
              order: 32,
              labelKey: "sandboxedUi.plugins.nav",
              icon: <Plug className={extension.iconClassName} />,
              render: () => (
                <PluginsSection
                  client={pluginsClient}
                  workdir={settings.system.workdir || undefined}
                  panels={sandboxedUi.pluginUi}
                  trustClient={props.settingsHost?.kbrain?.folderTrust}
                />
              ),
            } satisfies SettingsSectionDefinition<void>,
          ]
        : []),
      {
        id: "planning",
        groupKey: "settings.groupResources",
        groupOrder: 20,
        order: 35,
        labelKey: "settings.navPlanning",
        icon: <CalendarDays className={extension.iconClassName} />,
        render: () => <CalendarSection settings={settings} setSettings={setSettings} />,
      },
      {
        id: "memory",
        groupKey: "settings.groupResources",
        groupOrder: 20,
        order: 40,
        labelKey: "settings.navMemory",
        icon: <Brain className={extension.iconClassName} />,
        contentMode: "fill",
        render: () => (
          <MemoryPanel
            workdir={settings.system.workdir}
            settings={settings}
            setSettings={setSettings}
            kbrain={props.settingsHost?.kbrain}
          />
        ),
      },
      {
        id: "systemTools",
        groupKey: "settings.groupIntelligence",
        groupOrder: 25,
        order: 20,
        labelKey: "settings.navSystemTools",
        icon: <Wrench className={extension.iconClassName} />,
        render: () => (
          <div className="space-y-7">
            {props.settingsHost?.kbrain && <AIApprovalSection kbrain={props.settingsHost.kbrain} />}
            <SystemToolsSection settings={settings} setSettings={setSettings} />
          </div>
        ),
      },
      // The search service K-brain falls back to when a model API cannot search natively.
      ...(props.settingsHost?.kbrain
        ? [
            {
              id: "webSearch",
              groupKey: "settings.groupIntelligence",
              groupOrder: 25,
              order: 22,
              labelKey: "settings.navWebSearch",
              icon: <Globe className={extension.iconClassName} />,
              render: () =>
                props.settingsHost?.kbrain ? (
                  <WebSearchSection kbrain={props.settingsHost.kbrain} />
                ) : null,
            } satisfies SettingsSectionDefinition<void>,
          ]
        : []),
      // Only hosts that can reach the K-brain rules API get the page.
      ...(props.settingsHost?.kbrain?.listPermissionRules
        ? [
            {
              id: "permissions",
              groupKey: "settings.groupIntelligence",
              groupOrder: 25,
              order: 25,
              labelKey: "settings.navPermissions",
              icon: <ShieldCheck className={extension.iconClassName} />,
              render: () =>
                props.settingsHost?.kbrain ? (
                  <PermissionRulesSection kbrain={props.settingsHost.kbrain} settings={settings} />
                ) : null,
            } satisfies SettingsSectionDefinition<void>,
          ]
        : []),
      {
        id: "stt",
        groupKey: "settings.groupIntelligence",
        groupOrder: 25,
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
        groupKey: "settings.groupResources",
        groupOrder: 20,
        order: 50,
        labelKey: "settings.navHooks",
        icon: <Zap className={extension.iconClassName} />,
        contentMode: "fill",
        render: () => <HooksSection settings={settings} setSettings={setSettings} />,
      },
      {
        id: "cron",
        groupKey: "settings.groupResources",
        groupOrder: 20,
        order: 30,
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
        render: () => (
          <RemoteSection
            settings={settings}
            setSettings={setSettings}
            surface={extension.surface}
          />
        ),
      },
      ...extension.sections,
    ],
    [
      extension,
      pluginsClient,
      props.settingsHost,
      sandboxedUi,
      rejectedLegacyProviders,
      onRetryRejectedLegacyProviders,
      onDismissRejectedLegacyProviders,
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
    settingsSearch: extension.search,
  };

  return (
    <SettingsShell
      registry={registry}
      context={undefined}
      saveState={saveState}
      onBack={onBack}
      initialSection={initialSection === "image-studio" ? "providers" : initialSection}
      hiddenSections={hiddenSections}
      fontScale={settings.customSettings.fontScale.settings}
    />
  );
}

type SandboxedUiCapabilities = { plugins: boolean; pluginUi: boolean; htmlPreviews: boolean };
const NO_SANDBOXED_UI: SandboxedUiCapabilities = {
  plugins: false,
  pluginUi: false,
  htmlPreviews: false,
};

/** K-brain's plugin and preview capabilities; none until (or unless) the read succeeds. */
function useSandboxedUiCapabilities(
  getCapabilities: (() => Promise<Record<string, unknown>>) | undefined,
): SandboxedUiCapabilities {
  const [value, setValue] = useState<SandboxedUiCapabilities>(NO_SANDBOXED_UI);
  useEffect(() => {
    if (!getCapabilities) {
      setValue(NO_SANDBOXED_UI);
      return;
    }
    let cancelled = false;
    getCapabilities().then(
      (capabilities) => {
        if (cancelled) return;
        const has = (name: string) => capabilities[name] === 1;
        const next = {
          plugins: has(KBRAIN_PLUGINS_CAPABILITY),
          pluginUi: has(KBRAIN_PLUGIN_UI_CAPABILITY),
          htmlPreviews: has(KBRAIN_HTML_PREVIEWS_CAPABILITY),
        };
        setValue((current) =>
          current.plugins === next.plugins &&
          current.pluginUi === next.pluginUi &&
          current.htmlPreviews === next.htmlPreviews
            ? current
            : next,
        );
      },
      () => {
        if (!cancelled) setValue(NO_SANDBOXED_UI);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [getCapabilities]);
  return value;
}
