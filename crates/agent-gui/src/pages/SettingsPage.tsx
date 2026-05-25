import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, BookOpen, Brain, Clock3, Cloud, Cpu, Info, Settings2, Zap } from "../components/icons";

import { useLocale } from "../i18n";
import { AgentsSection } from "./settings/AgentsSection";
import { AboutSection } from "./settings/AboutSection";
import { CronSection } from "./settings/CronSection";
import { HooksSection } from "./settings/HooksSection";
import { MemoryPanel } from "./settings/MemoryPanel";
import { ProvidersSection } from "./settings/ProvidersSection";
import { RemoteSection } from "./settings/RemoteSection";
import { SystemSettingsForm } from "./settings/SystemSettingsForm";
import type { SectionId, SettingsPageProps } from "./settings/types";

function getSaveIndicator(
  state: SettingsPageProps["saveState"],
  t: (key: string) => string,
) {
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
      className={`group w-full rounded-xl px-3 py-2.5 text-left transition-all ${
        active
          ? "bg-primary text-primary-foreground shadow-xs"
          : "text-foreground hover:bg-accent/60"
      }`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
            active
              ? "bg-primary-foreground/20 text-primary-foreground"
              : "bg-accent text-muted-foreground group-hover:bg-accent/80"
          }`}
        >
          {icon}
        </div>
        <div className="min-w-0 text-sm font-medium leading-none">{label}</div>
      </div>
    </button>
  );
}

const NAV_ITEMS_STATIC: Array<{ id: SectionId; icon: ReactNode }> = [
  {
    id: "system",
    icon: <Settings2 className="h-4 w-4" />,
  },
  {
    id: "providers",
    icon: <Cpu className="h-4 w-4" />,
  },
  {
    id: "agents",
    icon: <BookOpen className="h-4 w-4" />,
  },
  {
    id: "memory",
    icon: <Brain className="h-4 w-4" />,
  },
  {
    id: "hooks",
    icon: <Zap className="h-4 w-4" />,
  },
  {
    id: "cron",
    icon: <Clock3 className="h-4 w-4" />,
  },
  {
    id: "remote",
    icon: <Cloud className="h-4 w-4" />,
  },
  {
    id: "about",
    icon: <Info className="h-4 w-4" />,
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
  } = props;
  const { t } = useLocale();
  const [section, setSection] = useState<SectionId>(initialSection);

  const sectionLabels: Record<SectionId, string> = {
    system: t("settings.navSystem"),
    providers: t("settings.navProviders"),
    agents: t("settings.navAgents"),
    memory: t("settings.navMemory"),
    hooks: t("settings.navHooks"),
    cron: t("settings.navCron"),
    remote: t("settings.navRemote"),
    about: t("settings.navAbout"),
  };

  const hiddenSectionSet = useMemo(() => new Set(hiddenSections), [hiddenSections]);
  const navItems = useMemo(
    () =>
      NAV_ITEMS_STATIC.filter((item) => !hiddenSectionSet.has(item.id)).map((item) => ({
        ...item,
        label: sectionLabels[item.id],
      })),
    [hiddenSectionSet, sectionLabels],
  );

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    if (navItems.some((item) => item.id === section)) {
      return;
    }
    setSection(navItems[0]?.id ?? "system");
  }, [navItems, section]);

  const saveIndicator = getSaveIndicator(saveState, t);
  const sectionContent = (() => {
    switch (section) {
      case "providers":
        return <ProvidersSection settings={settings} setSettings={setSettings} />;
      case "system":
        return <SystemSettingsForm settings={settings} setSettings={setSettings} />;
      case "hooks":
        return <HooksSection settings={settings} setSettings={setSettings} />;
      case "cron":
        return <CronSection settings={settings} setSettings={setSettings} />;
      case "agents":
        return <AgentsSection settings={settings} setSettings={setSettings} />;
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
        return <AboutSection settings={settings} setSettings={setSettings} />;
      default: {
        const unreachable: never = section;
        return unreachable;
      }
    }
  })();

  return (
    <div className="flex h-full bg-background">
      <aside className="flex w-60 shrink-0 flex-col border-r bg-muted/30">
        <div className="flex items-center gap-2.5 border-b px-4 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <Settings2 className="h-4 w-4 text-primary" />
          </div>
          <div>
            <div className="text-sm font-semibold">{t("settings.title")}</div>
            <div className="text-[11px] text-muted-foreground">LiveAgent</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-3">
          {navItems.map((item) => (
            <NavItem
              key={item.id}
              icon={item.icon}
              label={item.label}
              active={section === item.id}
              onClick={() => setSection(item.id)}
            />
          ))}
        </nav>

        <div className="border-t px-3 py-3">
          <button
            type="button"
            onClick={onBack}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>{t("settings.backToChat")}</span>
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b px-6 py-4">
          <div className="overflow-hidden">
            <div key={section} className="settings-section-title-enter text-base font-semibold">
              {sectionLabels[section]}
            </div>
          </div>
          <div
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            title={saveIndicator.title}
          >
            <div className={`h-1.5 w-1.5 rounded-full ${saveIndicator.dotClass}`} />
            {saveIndicator.text}
          </div>
        </header>

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
  );
}
