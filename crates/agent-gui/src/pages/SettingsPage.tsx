import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Brain,
  Clock3,
  Cloud,
  Cpu,
  Info,
  Key,
  Keyboard,
  Settings2,
  Wrench,
  Zap,
} from "../components/icons";
import { isMacOsTauri, MacOsTitleBarSpacer } from "../components/MacOsTitleBarSpacer";

import { useLocale } from "../i18n";
import { AboutSection } from "./settings/AboutSection";
import { AgentsSection } from "./settings/AgentsSection";
import { CronSection } from "./settings/CronSection";
import { GlobalShortcutsSection } from "./settings/GlobalShortcutsSection";
import { HooksSection } from "./settings/HooksSection";
import { MemoryPanel } from "./settings/memory/MemoryPanel";
import { ProvidersSection } from "./settings/ProvidersSection";
import { RemoteSection } from "./settings/RemoteSection";
import { SshSection } from "./settings/SshSection";
import { SystemSettingsForm } from "./settings/SystemSettingsForm";
import { SystemToolsSection } from "./settings/SystemToolsSection";
import type { SectionId, SettingsPageProps } from "./settings/types";

function getSaveIndicator(state: SettingsPageProps["saveState"], t: (key: string) => string) {
  switch (state.status) {
    case "saving":
      return {
        dotClass: "bg-amber-500 animate-pulse",
        text: t("settings.saving"),
        title: t("settings.savingDesc"),
      };
    case "error":
      return {
        dotClass: "bg-destructive",
        text: t("settings.saveError"),
        title: state.message,
      };
    case "saved":
    case "idle":
    default:
      return {
        dotClass: "bg-emerald-500",
        text: t("settings.saved"),
        title: t("settings.savedDesc"),
      };
  }
}

type NavItemProps = {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
};

function NavItem({ icon, label, active, onClick }: NavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-active={active || undefined}
      className="settings-nav-item group relative flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[13.5px] tracking-[-0.01em]"
    >
      <span className="settings-nav-item-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
        {icon}
      </span>
      <span className="truncate leading-none">{label}</span>
    </button>
  );
}

type NavGroup = {
  labelKey: string;
  items: Array<{ id: SectionId; icon: ReactNode }>;
};

const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "settings.groupGeneral",
    items: [
      { id: "system", icon: <Settings2 className="h-3.5 w-3.5" /> },
      { id: "providers", icon: <Cpu className="h-3.5 w-3.5" /> },
      { id: "agents", icon: <BookOpen className="h-3.5 w-3.5" /> },
    ],
  },
  {
    labelKey: "settings.groupIntelligence",
    items: [
      { id: "memory", icon: <Brain className="h-3.5 w-3.5" /> },
      { id: "systemTools", icon: <Wrench className="h-3.5 w-3.5" /> },
    ],
  },
  {
    labelKey: "settings.groupAutomation",
    items: [
      { id: "hooks", icon: <Zap className="h-3.5 w-3.5" /> },
      { id: "cron", icon: <Clock3 className="h-3.5 w-3.5" /> },
    ],
  },
  {
    labelKey: "settings.groupConnectivity",
    items: [
      { id: "ssh", icon: <Key className="h-3.5 w-3.5" /> },
      { id: "remote", icon: <Cloud className="h-3.5 w-3.5" /> },
    ],
  },
  {
    labelKey: "settings.groupOther",
    items: [
      { id: "shortcuts", icon: <Keyboard className="h-3.5 w-3.5" /> },
      { id: "about", icon: <Info className="h-3.5 w-3.5" /> },
    ],
  },
];

export function SettingsPage(props: SettingsPageProps) {
  const {
    settings,
    setSettings,
    saveState,
    onBack,
    initialSection = "system",
    initialProviderId,
    hiddenSections = [],
    appUpdate,
  } = props;
  const { t } = useLocale();
  const [section, setSection] = useState<SectionId>(initialSection);
  const [pendingProviderId, setPendingProviderId] = useState(initialProviderId);

  const sectionLabels: Record<SectionId, string> = {
    system: t("settings.navSystem"),
    shortcuts: t("settings.navShortcuts"),
    systemTools: t("settings.navSystemTools"),
    providers: t("settings.navProviders"),
    agents: t("settings.navAgents"),
    ssh: t("settings.navSsh"),
    memory: t("settings.navMemory"),
    hooks: t("settings.navHooks"),
    cron: t("settings.navCron"),
    remote: t("settings.navRemote"),
    about: t("settings.navAbout"),
  };

  const hiddenSectionSet = useMemo(() => new Set(hiddenSections), [hiddenSections]);
  const navGroups = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        label: t(group.labelKey),
        items: group.items
          .filter((item) => !hiddenSectionSet.has(item.id))
          .map((item) => ({ ...item, label: sectionLabels[item.id] })),
      })).filter((group) => group.items.length > 0),
    [hiddenSectionSet, sectionLabels, t],
  );
  const allNavItems = useMemo(() => navGroups.flatMap((g) => g.items), [navGroups]);

  useEffect(() => {
    setSection(initialSection);
    setPendingProviderId(initialProviderId);
  }, [initialProviderId, initialSection]);

  useEffect(() => {
    if (allNavItems.some((item) => item.id === section)) {
      return;
    }
    setSection(allNavItems[0]?.id ?? "system");
  }, [allNavItems, section]);

  const saveIndicator = getSaveIndicator(saveState, t);
  const sectionContent = (() => {
    switch (section) {
      case "providers":
        return (
          <ProvidersSection
            settings={settings}
            setSettings={setSettings}
            initialProviderId={pendingProviderId}
            onInitialProviderHandled={() => setPendingProviderId(undefined)}
          />
        );
      case "system":
        return <SystemSettingsForm settings={settings} setSettings={setSettings} />;
      case "shortcuts":
        return <GlobalShortcutsSection />;
      case "systemTools":
        return <SystemToolsSection settings={settings} setSettings={setSettings} />;
      case "hooks":
        return <HooksSection settings={settings} setSettings={setSettings} />;
      case "cron":
        return <CronSection settings={settings} setSettings={setSettings} />;
      case "agents":
        return <AgentsSection settings={settings} setSettings={setSettings} />;
      case "ssh":
        return <SshSection settings={settings} setSettings={setSettings} saveState={saveState} />;
      case "remote":
        return <RemoteSection settings={settings} setSettings={setSettings} />;
      case "memory":
        return (
          <MemoryPanel
            workdir={settings.system.workdir}
            settings={settings}
            setSettings={setSettings}
          />
        );
      case "about":
        return <AboutSection settings={settings} setSettings={setSettings} appUpdate={appUpdate} />;
      default: {
        const unreachable: never = section;
        return unreachable;
      }
    }
  })();

  const onMac = isMacOsTauri();

  return (
    <div className="settings-page flex h-full flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        <aside className="settings-sidebar flex w-56 shrink-0 flex-col">
          {onMac && <div data-tauri-drag-region className="h-[38px] shrink-0" />}
          <div className="settings-sidebar-header px-3 pb-3 pt-3">
            <button type="button" onClick={onBack} className="settings-back-button">
              <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
              <span>{t("settings.backToChat")}</span>
            </button>

            <div className="mt-3.5 flex items-center gap-2.5 px-1">
              <div className="settings-title-icon flex h-7 w-7 items-center justify-center rounded-[9px]">
                <Settings2 className="h-3.5 w-3.5" />
              </div>
              <span className="text-[15px] font-semibold tracking-[-0.02em] text-foreground">
                {t("settings.title")}
              </span>
            </div>
          </div>

          <nav className="settings-nav flex-1 overflow-y-auto px-2.5 py-2.5">
            {navGroups.map((group, gi) => (
              <div key={group.label} className={gi > 0 ? "mt-4" : ""}>
                <div className="settings-nav-group-label mb-1 px-2.5">{group.label}</div>
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <NavItem
                      key={item.id}
                      icon={item.icon}
                      label={item.label}
                      active={section === item.id}
                      onClick={() => setSection(item.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </nav>

          <div className="settings-sidebar-footer px-3 py-2.5">
            <div
              className="flex items-center gap-1.5 px-2.5 text-[11px] text-muted-foreground"
              title={saveIndicator.title}
            >
              <div className={`h-1.5 w-1.5 rounded-full ${saveIndicator.dotClass}`} />
              {saveIndicator.text}
            </div>
          </div>
        </aside>

        <main className="settings-main flex min-w-0 flex-1 flex-col">
          <MacOsTitleBarSpacer />
          <div className="settings-main-header px-6 py-3.5">
            <div
              key={section}
              className="settings-section-title-enter text-[17px] font-semibold tracking-[-0.02em] text-foreground"
            >
              {sectionLabels[section]}
            </div>
          </div>

          <div
            key={section}
            className={`settings-section-enter flex-1 px-6 py-5 ${
              section === "hooks" || section === "providers" || section === "memory"
                ? "flex min-h-0 flex-col overflow-hidden"
                : "overflow-auto"
            }`}
          >
            <div
              className={`settings-section-shell ${
                section === "hooks" || section === "providers" || section === "memory"
                  ? "flex min-h-0 flex-1 flex-col"
                  : "min-h-full"
              }`}
            >
              {sectionContent}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
