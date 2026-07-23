import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Brain,
  Clock3,
  Cloud,
  Cpu,
  Key,
  MonitorSmartphone,
  Settings2,
  Wrench,
  Zap,
} from "../components/icons";

import { useLocale } from "../i18n";
import { AgentsSection } from "./settings/AgentsSection";
import { CronSection } from "./settings/CronSection";
import { DevicesSection } from "./settings/DevicesSection";
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
      className={`settings-nav-item group relative w-full rounded-lg px-3 py-2 text-left transition-all duration-150 ${
        active
          ? "settings-nav-item-active bg-primary/10 font-medium text-primary"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      }`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`settings-nav-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
            active
              ? "bg-primary/15 text-primary"
              : "bg-muted/60 text-muted-foreground group-hover:bg-accent group-hover:text-foreground"
          }`}
        >
          {icon}
        </div>
        <div className="settings-nav-label min-w-0 truncate text-sm leading-none">{label}</div>
      </div>
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
      { id: "system", icon: <Settings2 className="h-4 w-4" /> },
      { id: "providers", icon: <Cpu className="h-4 w-4" /> },
      { id: "agents", icon: <BookOpen className="h-4 w-4" /> },
    ],
  },
  {
    labelKey: "settings.groupIntelligence",
    items: [
      { id: "memory", icon: <Brain className="h-4 w-4" /> },
      { id: "systemTools", icon: <Wrench className="h-4 w-4" /> },
    ],
  },
  {
    labelKey: "settings.groupAutomation",
    items: [
      { id: "hooks", icon: <Zap className="h-4 w-4" /> },
      { id: "cron", icon: <Clock3 className="h-4 w-4" /> },
    ],
  },
  {
    labelKey: "settings.groupConnectivity",
    items: [
      { id: "ssh", icon: <Key className="h-4 w-4" /> },
      { id: "remote", icon: <Cloud className="h-4 w-4" /> },
      { id: "devices", icon: <MonitorSmartphone className="h-4 w-4" /> },
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
    hiddenSections = [],
    onAgentDirectoryChanged,
  } = props;
  const { t } = useLocale();
  const [section, setSection] = useState<SectionId>(initialSection);

  const sectionLabels: Record<SectionId, string> = {
    system: t("settings.navSystem"),
    systemTools: t("settings.navSystemTools"),
    providers: t("settings.navProviders"),
    agents: t("settings.navAgents"),
    ssh: t("settings.navSsh"),
    memory: t("settings.navMemory"),
    hooks: t("settings.navHooks"),
    cron: t("settings.navCron"),
    devices: t("settings.navAgentManagement"),
    remote: t("settings.navRemote"),
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
  }, [initialSection]);

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
        return <ProvidersSection settings={settings} setSettings={setSettings} />;
      case "system":
        return <SystemSettingsForm settings={settings} setSettings={setSettings} />;
      case "systemTools":
        return <SystemToolsSection settings={settings} setSettings={setSettings} />;
      case "hooks":
        return <HooksSection settings={settings} setSettings={setSettings} />;
      case "cron":
        return <CronSection settings={settings} setSettings={setSettings} />;
      case "agents":
        return <AgentsSection settings={settings} setSettings={setSettings} />;
      case "ssh":
        return <SshSection settings={settings} setSettings={setSettings} />;
      case "remote":
        return <RemoteSection settings={settings} setSettings={setSettings} />;
      case "devices":
        return <DevicesSection onDirectoryChanged={onAgentDirectoryChanged} />;
      case "memory":
        return (
          <MemoryPanel
            workdir={settings.system.workdir}
            settings={settings}
            setSettings={setSettings}
          />
        );
      default: {
        const unreachable: never = section;
        return unreachable;
      }
    }
  })();

  return (
    <div className="settings-page-shell flex h-full bg-background">
      <aside className="settings-sidebar flex w-60 shrink-0 flex-col border-r border-border/60 bg-muted/20">
        <div className="settings-back-bar">
          <button
            type="button"
            onClick={onBack}
            className="settings-back-button flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
            <span>{t("settings.backToChat")}</span>
          </button>
        </div>

        <div className="settings-sidebar-header border-b border-border/60 px-3 pb-3 pt-3">
          <button
            type="button"
            onClick={onBack}
            className="settings-back-button flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>{t("settings.backToChat")}</span>
          </button>

          <div className="mt-3 flex items-center gap-2.5 px-1">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Settings2 className="h-4 w-4 text-primary" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">{t("settings.title")}</div>
              <div className="text-[11px] text-muted-foreground">LiveAgent</div>
            </div>
          </div>
        </div>

        <nav className="settings-nav flex-1 overflow-y-auto px-3 py-3">
          {navGroups.map((group, gi) => (
            <div key={group.label} className={`settings-nav-group ${gi > 0 ? "mt-4" : ""}`}>
              <div className="settings-nav-group-label mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                {group.label}
              </div>
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
      </aside>

      <main className="settings-main flex min-w-0 flex-1 flex-col">
        <header className="settings-main-header flex items-center justify-between border-b px-6 py-4">
          <div className="settings-main-title overflow-hidden">
            <div key={section} className="settings-section-title-enter text-base font-semibold">
              {sectionLabels[section]}
            </div>
          </div>
          {section !== "devices" ? (
            <div
              className="settings-save-indicator flex items-center gap-1.5 text-xs text-muted-foreground"
              title={saveIndicator.title}
            >
              <div className={`h-1.5 w-1.5 rounded-full ${saveIndicator.dotClass}`} />
              {saveIndicator.text}
            </div>
          ) : null}
        </header>

        <div
          key={section}
          className={`settings-content settings-content-${section} settings-section-enter flex-1 px-6 py-5 ${
            section === "hooks" || section === "providers" || section === "memory"
              ? "flex min-h-0 flex-col overflow-hidden"
              : "overflow-auto"
          }`}
        >
          <div
            className={`settings-section-shell settings-section-shell-${section} ${
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
  );
}
