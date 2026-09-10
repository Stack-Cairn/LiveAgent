import { ArrowLeft, Search } from "@liveagent/ui/components/IconSet";
import { useEffect, useMemo, useState } from "react";
import type { SettingsSaveState, UiExtensionRegistry } from "../../contracts/registry";
import { useLocale } from "../../i18n";
import { cn } from "../../lib/shared/utils";

const WEB_SETTINGS_RESPONSIVE_CLASS = [
  "web:max-820:[&_.settings-nav]:order-2 web:max-820:[&_.settings-nav]:flex web:max-820:[&_.settings-nav]:flex-none web:max-820:[&_.settings-nav]:flex-nowrap web:max-820:[&_.settings-nav]:gap-6px web:max-820:[&_.settings-nav]:overflow-x-auto web:max-820:[&_.settings-nav]:overscroll-x-contain web:max-820:[&_.settings-nav]:px-10px web:max-820:[&_.settings-nav]:pt-8px web:max-820:[&_.settings-nav]:pb-10px web:max-820:[&_.settings-nav]:[scrollbar-width:none] web:max-820:[&_.settings-nav::-webkit-scrollbar]:hidden web:max-640:[&_.settings-nav]:px-8px",
  "web:max-820:[&_.settings-back-button]:min-h-34px web:max-820:[&_.settings-back-button]:w-auto web:max-820:[&_.settings-back-button]:px-10px web:max-820:[&_.settings-back-button]:py-8px",
  "web:max-820:[&_.settings-content-hooks]:overflow-y-auto web:max-820:[&_.settings-content-hooks]:overscroll-y-contain web:max-820:[&_.settings-content-hooks]:[-webkit-overflow-scrolling:touch] web:max-820:[&_.settings-content-memory]:overflow-y-auto web:max-820:[&_.settings-content-memory]:overscroll-y-contain web:max-820:[&_.settings-content-memory]:[-webkit-overflow-scrolling:touch]",
  "web:max-820:[&_.settings-section-shell-hooks]:block web:max-820:[&_.settings-section-shell-hooks]:min-h-auto web:max-820:[&_.settings-section-shell-hooks]:flex-none web:max-820:[&_.settings-section-shell-memory]:block web:max-820:[&_.settings-section-shell-memory]:min-h-auto web:max-820:[&_.settings-section-shell-memory]:flex-none",
  "web:max-820:[&_.settings-section-heading-row]:flex-col web:max-820:[&_.settings-section-heading-row]:items-stretch web:max-820:[&_.settings-section-heading-row]:gap-12px web:max-820:[&_.settings-section-title-group]:min-w-0 web:max-820:[&_.settings-section-actions]:w-full web:max-820:[&_.settings-section-actions]:flex-wrap web:max-820:[&_.settings-section-actions]:justify-start web:max-820:[&_.settings-card-actions]:opacity-100 web:max-820:[&_.settings-hover-actions]:opacity-100 web:touch-primary:[&_.settings-card-actions]:opacity-100 web:touch-primary:[&_.settings-hover-actions]:opacity-100",
  "web:max-820:[&_.settings-form-grid]:grid-cols-1 web:max-820:[&_.settings-choice-grid]:grid-cols-1 web:max-820:[&_.settings-hooks-stat]:gap-6px web:max-820:[&_.settings-hooks-stat]:px-9px web:max-820:[&_.settings-hooks-stat]:py-5px web:max-820:[&_.settings-hooks-stat-label]:text-11px web:max-820:[&_.settings-hooks-stat-value]:text-12px",
  "web:max-820:[&_.settings-log-row]:flex-wrap web:max-820:[&_.settings-log-row>span]:w-auto web:max-820:[&_.settings-log-row>span:first-of-type]:flex-[1_1_100%] web:max-820:[&_.settings-log-row>span:nth-of-type(3)]:ml-0",
  "web:max-640:[&_.settings-card-row]:p-12px web:max-640:[&_.settings-card-actions]:ml-auto web:max-640:[&_.settings-inline-form]:flex-col web:max-640:[&_.settings-inline-form>button]:w-full web:max-640:[&_.settings-hooks-card-actions]:min-h-32px web:max-640:[&_.settings-hooks-card-actions]:items-center web:max-640:[&_.settings-hooks-card-actions]:gap-4px",
  "web:max-640:[&_.settings-hooks-card-actions_[role=switch]]:size-auto web:max-640:[&_.settings-hooks-card-actions_[role=switch]]:h-20px web:max-640:[&_.settings-hooks-card-actions_[role=switch]]:w-36px web:max-640:[&_.settings-hooks-card-actions_[role=switch]]:self-center web:max-640:[&_.settings-hooks-card-actions_[role=switch]]:border web:max-640:[&_.settings-hooks-card-actions_[role=switch]]:border-border/58 web:max-640:[&_.settings-hooks-card-actions_[role=switch]]:bg-muted-foreground/18 web:max-640:[&_.settings-hooks-card-actions_[role=switch][aria-checked=true]]:border-primary/40 web:max-640:[&_.settings-hooks-card-actions_[role=switch][aria-checked=true]]:bg-primary web:max-640:[&_.settings-hooks-card-actions>button:not([role=switch])]:size-30px",
  "web:max-520:[&_.settings-section-actions>button:not([role=switch])]:flex-auto web:max-520:[&_.settings-section-actions>.settings-section-action]:flex-auto web:max-520:[&_.settings-card-row]:flex-wrap web:max-520:[&_.settings-card-row]:items-start web:max-520:[&_.settings-log-row]:grid web:max-520:[&_.settings-log-row]:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] web:max-520:[&_.settings-log-row]:items-center web:max-520:[&_.settings-log-row]:gap-6px web:max-520:[&_.settings-log-row]:px-10px web:max-520:[&_.settings-log-row]:py-8px",
  "web:max-520:[&_.settings-log-row>span]:min-w-0 web:max-520:[&_.settings-log-row>span:first-of-type]:truncate web:max-520:[&_.settings-hooks-card-actions]:ml-auto web:max-520:[&_.settings-hooks-card-actions]:mt-0 web:max-520:[&_.settings-hooks-card-actions]:w-auto web:max-520:[&_.settings-hooks-card-actions]:basis-auto web:max-520:[&_.settings-hooks-card-actions]:justify-end web:max-520:[&_.settings-hooks-card-actions]:border-t-0 web:max-520:[&_.settings-hooks-card-actions]:pt-0 web:max-520:[&_.settings-hooks-stat]:min-w-0 web:max-520:[&_.settings-hooks-stat]:flex-[1_1_calc(50%-var(--spacing-4px))] web:max-520:[&_.settings-hooks-stat]:justify-center",
].join(" ");

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
  const [navQuery, setNavQuery] = useState("");
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
  const visibleGroups = useMemo(() => {
    const query = navQuery.trim().toLocaleLowerCase();
    if (!query) return groups;
    return groups
      .map(
        ([groupKey, definitions]) =>
          [
            groupKey,
            definitions.filter((definition) =>
              t(definition.labelKey).toLocaleLowerCase().includes(query),
            ),
          ] as const,
      )
      .filter(([, definitions]) => definitions.length > 0);
  }, [groups, navQuery, t]);

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
        web
          ? `flex h-full bg-background web:min-w-0 web:max-820:h-full web:max-820:min-h-0 web:max-820:flex-col web:max-820:overflow-hidden [&_.settings-section-actions]:min-w-0 [&_.settings-card-actions]:min-w-0 ${WEB_SETTINGS_RESPONSIVE_CLASS}`
          : "flex h-full flex-col bg-background desktop:max-640:[&_.settings-section-heading-row]:flex-col desktop:max-640:[&_.settings-section-heading-row]:items-stretch desktop:max-640:[&_.settings-section-heading-row]:gap-3 desktop:max-640:[&_.settings-section-title-group]:min-w-0 desktop:max-640:[&_.settings-section-actions]:w-full desktop:max-640:[&_.settings-section-actions]:flex-wrap desktop:max-640:[&_.settings-section-actions]:justify-start desktop:max-640:[&_.settings-hover-actions]:opacity-100 desktop:max-640:[&_.settings-card-row]:p-3 desktop:no-hover:[&_.settings-hover-actions]:opacity-100"
      }
    >
      <div className={web ? "contents" : "flex min-h-0 flex-1"}>
        <aside className="flex w-64 shrink-0 flex-col border-r border-border/60 bg-muted/30 web:max-820:w-full web:max-820:flex-none web:max-820:border-r-0 web:max-820:border-r-current web:max-820:border-b web:max-820:border-solid web:max-820:border-b-border web:max-820:bg-background/96">
          {registry.slots.sidebarLeading}
          {web ? (
            <div className="web:hidden web:max-820:flex web:max-820:items-center web:max-820:order-1 web:max-820:border-t-0 web:max-820:border-t-current web:max-820:border-b web:max-820:border-solid web:max-820:border-b-border/72 web:max-820:px-10px web:max-820:pt-settings-back-bar-pt web:max-820:pb-8px">
              <button
                type="button"
                onClick={onBack}
                className="settings-back-button flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                <ArrowLeft className="size-3.5 shrink-0" />
                <span>{t("settings.backToChat")}</span>
              </button>
            </div>
          ) : null}
          <div className="px-3 pb-2 pt-3 web:max-820:hidden">
            <button
              type="button"
              onClick={onBack}
              className="settings-back-button flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <ArrowLeft className="size-4 shrink-0" />
              <span>{t("settings.backToChat")}</span>
            </button>
            <div className="relative mt-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/75" />
              <input
                type="search"
                value={navQuery}
                onChange={(event) => setNavQuery(event.currentTarget.value)}
                placeholder={t("settings.searchPlaceholder")}
                aria-label={t("settings.searchPlaceholder")}
                className="h-9 w-full rounded-xl border border-border/70 bg-background/85 pl-9 pr-3 text-sm shadow-xs outline-none placeholder:text-muted-foreground/70 focus:border-border focus:ring-2 focus:ring-foreground/5"
              />
            </div>
          </div>
          <nav className="settings-nav flex-1 overflow-y-auto p-3">
            {visibleGroups.map(([groupKey, definitions], groupIndex) => (
              <div
                key={groupKey}
                className={cn(
                  "web:max-820:contents web:max-820:mt-0 web:max-820:[&_>_div:last-child]:contents web:max-820:[&_>_div:last-child_>_*_+_*]:mt-0",
                  groupIndex > 0 && "mt-5",
                )}
              >
                <div className="mb-1 px-3 text-xs font-medium text-muted-foreground/65 web:max-820:hidden">
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
                        data-testid={`settings-nav-${definition.id}`}
                        data-settings-nav-id={definition.id}
                        data-active={active ? "true" : "false"}
                        className={cn(
                          "group relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-all duration-150 web:max-820:w-auto web:max-820:flex-none web:max-820:whitespace-nowrap web:max-820:border web:max-820:border-solid web:max-820:border-border/50 web:max-820:px-10px web:max-820:py-8px web:max-820:rounded-10px web:max-820:[&_>_div]:gap-8px web:max-520:px-9px web:max-520:py-7px",
                          active
                            ? "bg-accent font-medium text-foreground web:max-820:border-primary/35!"
                            : "text-foreground/75 hover:bg-accent/60 hover:text-foreground",
                        )}
                      >
                        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground transition-colors group-hover:text-foreground web:max-820:size-24px web:max-820:rounded-8px">
                          {definition.icon}
                        </span>
                        <span className="min-w-0 truncate leading-tight web:max-820:text-12px">
                          {t(definition.labelKey)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {visibleGroups.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t("settings.searchNoResults")}
              </div>
            ) : null}
          </nav>
          {!web && showSaveIndicator ? (
            <div className="border-t border-border/60 px-3 py-2.5">
              <div
                className="flex items-center gap-1.5 px-2.5 text-11px text-muted-foreground"
                title={saveIndicator.title}
              >
                <div className={cn("size-1.5 rounded-full", saveIndicator.dotClass)} />
                {saveIndicator.text}
              </div>
            </div>
          ) : null}
        </aside>
        <main className="flex min-w-0 flex-1 flex-col web:min-w-0 web:max-820:min-h-0 web:max-820:flex-auto">
          {registry.slots.mainLeading}
          <header
            className={cn(
              "px-8 pb-2 pt-8 web:max-820:gap-12px web:max-820:px-14px web:max-820:py-10px web:max-640:px-10px web:max-640:py-9px",
              web && "flex items-center justify-between",
            )}
          >
            <div
              className={cn(
                "settings-main-title w-full overflow-hidden",
                activeSection.id === "system" && "mx-auto max-w-920px",
              )}
            >
              <div key={activeSection.id} className="text-28px font-semibold tracking-tight">
                {t(activeSection.labelKey)}
              </div>
            </div>
            {web && showSaveIndicator ? (
              <div
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground web:max-820:flex-none web:max-820:whitespace-nowrap"
                title={saveIndicator.title}
              >
                <div className={cn("size-1.5 shrink-0 rounded-full", saveIndicator.dotClass)} />
                {saveIndicator.text}
              </div>
            ) : null}
          </header>
          <div
            key={activeSection.id}
            className={cn(
              "flex-1 px-8 pb-8 pt-6 web:min-w-0 web:max-820:min-h-0 web:max-820:p-14px web:max-640:p-10px",
              `settings-content-${activeSection.id}`,
              fillContent ? "flex min-h-0 flex-col overflow-hidden" : "overflow-auto",
            )}
          >
            <div
              className={cn(
                "relative isolate web:min-w-0",
                `settings-section-shell-${activeSection.id}`,
                activeSection.id === "system" && "mx-auto w-full max-w-920px",
                fillContent ? "flex min-h-0 flex-1 flex-col" : "min-h-full",
              )}
            >
              {activeSection.render(context)}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
