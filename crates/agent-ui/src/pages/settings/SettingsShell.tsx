import { ArrowLeft, Settings2 } from "@liveagent/app/components/icons";
import { useEffect, useMemo, useState } from "react";
import type { SettingsSaveState, UiExtensionRegistry } from "../../contracts/registry";
import { useLocale } from "../../i18n";

type SettingsShellProps<Context> = {
  registry: UiExtensionRegistry<Context>;
  context: Context;
  saveState: SettingsSaveState;
  onBack: () => void;
  initialSection?: string;
  hiddenSections?: readonly string[];
};

function getSaveIndicator(state: SettingsSaveState, t: (key: string) => string) {
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
      return {
        dotClass: "bg-emerald-500",
        text: t("settings.saved"),
        title: t("settings.savedDesc"),
      };
  }
}

export function SettingsShell<Context>(props: SettingsShellProps<Context>) {
  const {
    registry,
    context,
    saveState,
    onBack,
    initialSection = "system",
    hiddenSections = [],
  } = props;
  const { t } = useLocale();
  const [section, setSection] = useState(initialSection);
  const hiddenSectionSet = useMemo(() => new Set(hiddenSections), [hiddenSections]);
  const sections = useMemo(
    () =>
      [...registry.settingsSections]
        .filter(
          (definition) =>
            !hiddenSectionSet.has(definition.id) &&
            (definition.isAvailable?.(registry.services) ?? true),
        )
        .sort((left, right) => left.groupOrder - right.groupOrder || left.order - right.order),
    [hiddenSectionSet, registry.services, registry.settingsSections],
  );
  const groups = useMemo(() => {
    const result = new Map<string, typeof sections>();
    for (const definition of sections) {
      const group = result.get(definition.groupKey) ?? [];
      result.set(definition.groupKey, [...group, definition]);
    }
    return [...result.entries()];
  }, [sections]);

  useEffect(() => setSection(initialSection), [initialSection]);
  useEffect(() => {
    if (!sections.some((definition) => definition.id === section)) {
      setSection(sections[0]?.id ?? "system");
    }
  }, [section, sections]);

  const activeSection = sections.find((definition) => definition.id === section) ?? sections[0];
  if (!activeSection) return null;

  const web = registry.surface === "web";
  const fillContent = activeSection.contentMode === "fill";
  const saveIndicator = getSaveIndicator(saveState, t);
  const showSaveIndicator = activeSection.showSaveIndicator !== false;

  return (
    <div
      className={
        web ? "settings-page-shell flex h-full bg-background" : "flex h-full flex-col bg-background"
      }
    >
      <div className={web ? "contents" : "flex min-h-0 flex-1"}>
        <aside
          className={`settings-sidebar flex shrink-0 flex-col border-r border-border/60 bg-muted/20 ${web ? "w-60" : "w-56"}`}
        >
          {registry.slots.sidebarLeading}
          {web ? (
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
          ) : null}
          <div className="settings-sidebar-header border-b border-border/60 px-3 pb-3 pt-3">
            <button
              type="button"
              onClick={onBack}
              className={`settings-back-button flex w-full items-center gap-2 rounded-lg py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground ${web ? "px-3" : "px-2.5"}`}
            >
              <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
              <span>{t("settings.backToChat")}</span>
            </button>
            <div className="mt-3 flex items-center gap-2.5 px-1">
              <div
                className={`flex items-center justify-center rounded-lg bg-primary/10 ${web ? "h-8 w-8" : "h-7 w-7"}`}
              >
                <Settings2 className={`${web ? "h-4 w-4" : "h-3.5 w-3.5"} text-primary`} />
              </div>
              <div>
                <div className="text-sm font-semibold tracking-tight">{t("settings.title")}</div>
                {web ? <div className="text-[11px] text-muted-foreground">LiveAgent</div> : null}
              </div>
            </div>
          </div>
          <nav className="settings-nav flex-1 overflow-y-auto px-3 py-3">
            {groups.map(([groupKey, definitions], groupIndex) => (
              <div key={groupKey} className={`settings-nav-group ${groupIndex > 0 ? "mt-4" : ""}`}>
                <div
                  className={`settings-nav-group-label mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 ${web ? "px-3" : "px-2.5"}`}
                >
                  {t(groupKey)}
                </div>
                <div className="space-y-0.5">
                  {definitions.map((definition) => {
                    const active = definition.id === activeSection.id;
                    return (
                      <button
                        key={definition.id}
                        type="button"
                        onClick={() => setSection(definition.id)}
                        className={`settings-nav-item group relative w-full rounded-lg py-2 text-left transition-all duration-150 ${web ? "px-3" : "flex items-center gap-3 px-2.5 text-sm"} ${
                          active
                            ? "settings-nav-item-active bg-primary/10 font-medium text-primary"
                            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                        }`}
                      >
                        <div className={web ? "flex items-center gap-3" : "contents"}>
                          <span
                            className={`settings-nav-icon flex shrink-0 items-center justify-center rounded-md transition-colors ${web ? "h-7 w-7" : "h-6 w-6"} ${
                              active
                                ? "bg-primary/15 text-primary"
                                : "bg-muted/60 text-muted-foreground group-hover:bg-accent group-hover:text-foreground"
                            }`}
                          >
                            {definition.icon}
                          </span>
                          <span className="settings-nav-label min-w-0 truncate leading-none">
                            {t(definition.labelKey)}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
          {!web && showSaveIndicator ? (
            <div className="border-t border-border/60 px-3 py-2.5">
              <div
                className="flex items-center gap-1.5 px-2.5 text-[11px] text-muted-foreground"
                title={saveIndicator.title}
              >
                <div className={`h-1.5 w-1.5 rounded-full ${saveIndicator.dotClass}`} />
                {saveIndicator.text}
              </div>
            </div>
          ) : null}
        </aside>
        <main className="settings-main flex min-w-0 flex-1 flex-col">
          {registry.slots.mainLeading}
          <header
            className={`settings-main-header border-b px-6 ${web ? "flex items-center justify-between py-4" : "py-3.5"}`}
          >
            <div
              key={activeSection.id}
              className="settings-section-title-enter text-base font-semibold"
            >
              {t(activeSection.labelKey)}
            </div>
            {web && showSaveIndicator ? (
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
            key={activeSection.id}
            className={`settings-content settings-content-${activeSection.id} settings-section-enter flex-1 px-6 py-5 ${fillContent ? "flex min-h-0 flex-col overflow-hidden" : "overflow-auto"}`}
          >
            <div
              className={`settings-section-shell settings-section-shell-${activeSection.id} ${fillContent ? "flex min-h-0 flex-1 flex-col" : "min-h-full"}`}
            >
              {activeSection.render(context)}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
