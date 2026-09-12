import { ArrowLeft, Search } from "@liveagent/ui/components/IconSet";
import { useEffect, useMemo, useState } from "react";
import type { SettingsSaveState, UiExtensionRegistry } from "../../contracts/registry";
import { useLocale } from "../../i18n";
import { cn } from "../../lib/shared/utils";

const WEB_SETTINGS_CONTENT_RESPONSIVE_CLASS = cn(
  "web:max-820:[&_.settings-content-hooks]:overflow-y-auto web:max-820:[&_.settings-content-hooks]:overscroll-y-contain web:max-820:[&_.settings-content-hooks]:[-webkit-overflow-scrolling:touch] web:max-820:[&_.settings-content-memory]:overflow-y-auto web:max-820:[&_.settings-content-memory]:overscroll-y-contain web:max-820:[&_.settings-content-memory]:[-webkit-overflow-scrolling:touch]",
  "web:max-820:[&_.settings-section-shell-hooks]:block web:max-820:[&_.settings-section-shell-hooks]:min-h-auto web:max-820:[&_.settings-section-shell-hooks]:flex-none web:max-820:[&_.settings-section-shell-memory]:block web:max-820:[&_.settings-section-shell-memory]:min-h-auto web:max-820:[&_.settings-section-shell-memory]:flex-none",
  "web:max-820:[&_.settings-card-actions]:opacity-100 web:max-820:[&_.settings-hover-actions]:opacity-100 web:touch-primary:[&_.settings-card-actions]:opacity-100 web:touch-primary:[&_.settings-hover-actions]:opacity-100",
  "web:max-820:[&_.settings-form-grid]:grid-cols-1 web:max-820:[&_.settings-choice-grid]:grid-cols-1 web:max-820:[&_.settings-hooks-stat]:gap-6px web:max-820:[&_.settings-hooks-stat]:px-9px web:max-820:[&_.settings-hooks-stat]:py-5px web:max-820:[&_.settings-hooks-stat-label]:text-xs web:max-820:[&_.settings-hooks-stat-value]:text-xs",
  "web:max-820:[&_.settings-log-row]:flex-wrap web:max-820:[&_.settings-log-row>span]:w-auto web:max-820:[&_.settings-log-row>span:first-of-type]:flex-[1_1_100%] web:max-820:[&_.settings-log-row>span:nth-of-type(3)]:ml-0",
  "web:max-640:[&_.settings-card-actions]:ml-auto web:max-640:[&_.settings-inline-form]:flex-col web:max-640:[&_.settings-inline-form>button]:w-full web:max-640:[&_.settings-hooks-card-actions]:min-h-32px web:max-640:[&_.settings-hooks-card-actions]:items-center web:max-640:[&_.settings-hooks-card-actions]:gap-4px",
  "web:max-640:[&_.settings-hooks-card-actions_[role=switch]]:size-auto web:max-640:[&_.settings-hooks-card-actions_[role=switch]]:h-20px web:max-640:[&_.settings-hooks-card-actions_[role=switch]]:w-36px web:max-640:[&_.settings-hooks-card-actions_[role=switch]]:self-center web:max-640:[&_.settings-hooks-card-actions_[role=switch]]:border web:max-640:[&_.settings-hooks-card-actions_[role=switch]]:border-border/58 web:max-640:[&_.settings-hooks-card-actions_[role=switch]]:bg-muted-foreground/18 web:max-640:[&_.settings-hooks-card-actions_[role=switch][aria-checked=true]]:border-primary/40 web:max-640:[&_.settings-hooks-card-actions_[role=switch][aria-checked=true]]:bg-primary web:max-640:[&_.settings-hooks-card-actions>button:not([role=switch])]:size-30px",
  "web:max-520:[&_.settings-section-actions>button:not([role=switch])]:flex-auto web:max-520:[&_.settings-section-actions>.settings-section-action]:flex-auto web:max-520:[&_.settings-card-row]:flex-wrap web:max-520:[&_.settings-card-row]:items-start web:max-520:[&_.settings-log-row]:grid web:max-520:[&_.settings-log-row]:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] web:max-520:[&_.settings-log-row]:items-center web:max-520:[&_.settings-log-row]:gap-6px web:max-520:[&_.settings-log-row]:px-10px web:max-520:[&_.settings-log-row]:py-8px",
  "web:max-520:[&_.settings-log-row>span]:min-w-0 web:max-520:[&_.settings-log-row>span:first-of-type]:truncate web:max-520:[&_.settings-hooks-card-actions]:ml-auto web:max-520:[&_.settings-hooks-card-actions]:mt-0 web:max-520:[&_.settings-hooks-card-actions]:w-auto web:max-520:[&_.settings-hooks-card-actions]:basis-auto web:max-520:[&_.settings-hooks-card-actions]:justify-end web:max-520:[&_.settings-hooks-card-actions]:border-t-0 web:max-520:[&_.settings-hooks-card-actions]:pt-0 web:max-520:[&_.settings-hooks-stat]:min-w-0 web:max-520:[&_.settings-hooks-stat]:flex-[1_1_calc(50%-var(--spacing-4px))] web:max-520:[&_.settings-hooks-stat]:justify-center",
);

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
  const [previousInitialSection, setPreviousInitialSection] = useState(initialSection);
  // Synchronize before children commit, so a deep link never paints the old section.
  if (previousInitialSection !== initialSection) {
    setPreviousInitialSection(initialSection);
    setSection(initialSection);
  }
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
      className={cn(
        "flex h-full bg-background",
        web &&
          "web:min-w-0 web:max-820:h-full web:max-820:min-h-0 web:max-820:flex-col web:max-820:overflow-hidden [&_.settings-section-actions]:min-w-0 [&_.settings-card-actions]:min-w-0",
        web && WEB_SETTINGS_CONTENT_RESPONSIVE_CLASS,
        !web &&
          "flex-col desktop:max-640:[&_.settings-section-heading-row]:items-stretch desktop:max-640:[&_.settings-section-actions]:w-full desktop:max-640:[&_.settings-section-actions]:flex-wrap desktop:max-640:[&_.settings-hover-actions]:opacity-100 desktop:no-hover:[&_.settings-hover-actions]:opacity-100",
      )}
    >
      <div className={web ? "contents" : "flex min-h-0 flex-1"}>
        <aside
          className={cn(
            "flex w-68 shrink-0 flex-col bg-settings-rail",
            "web:max-820:w-full web:max-820:flex-none web:max-820:bg-background/96",
          )}
        >
          {registry.slots.sidebarLeading}
          {web ? (
            <div
              className={cn(
                "web:hidden web:max-820:flex web:max-820:items-center web:max-820:px-10px",
                "web:max-820:pt-settings-back-bar-pt web:max-820:pb-2 web:max-640:px-8px",
              )}
            >
              <button
                type="button"
                onClick={onBack}
                className={cn(
                  "settings-back-button flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5",
                  "text-sm text-muted-foreground transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground",
                  "web:max-820:min-h-34px web:max-820:w-auto web:max-820:px-10px web:max-820:py-8px",
                )}
              >
                <ArrowLeft className="size-3.5 shrink-0" />
                <span>{t("settings.backToChat")}</span>
              </button>
            </div>
          ) : null}
          <div className="px-3 pb-2 pt-4 web:max-820:hidden">
            <button
              type="button"
              onClick={onBack}
              className={cn(
                "settings-back-button flex w-full cursor-pointer items-center justify-start gap-1 rounded-md px-2 py-1.5 text-left",
                "text-sm text-muted-foreground transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground",
              )}
            >
              <ArrowLeft className="size-3.5 shrink-0" />
              <span>{t("settings.backToChat")}</span>
            </button>
            <div className="relative mt-2.5">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/75" />
              <input
                type="search"
                value={navQuery}
                onChange={(event) => setNavQuery(event.currentTarget.value)}
                placeholder={t("settings.searchPlaceholder")}
                aria-label={t("settings.searchPlaceholder")}
                className={cn(
                  "h-8 w-full rounded-full border-0 bg-background pl-8 pr-3",
                  "text-sm outline-none transition-[background-color,box-shadow] duration-150",
                  "placeholder:text-muted-foreground/70 focus:ring-2 focus:ring-foreground/15",
                )}
              />
            </div>
          </div>
          <nav
            className={cn(
              "settings-nav flex-1 overflow-y-auto px-2.5 pb-6 pt-3.5",
              "web:max-820:flex web:max-820:flex-none web:max-820:flex-nowrap web:max-820:gap-1.5 web:max-820:overflow-x-auto web:max-820:overscroll-x-contain",
              "web:max-820:px-10px web:max-820:pb-10px web:max-820:pt-2 web:max-820:[scrollbar-width:none] web:max-820:[&::-webkit-scrollbar]:hidden web:max-640:px-8px",
            )}
          >
            {visibleGroups.map(([groupKey, definitions], groupIndex) => (
              <div
                key={groupKey}
                className={cn(
                  "web:max-820:contents web:max-820:mt-0 web:max-820:[&_>_div:last-child]:contents web:max-820:[&_>_div:last-child_>_*_+_*]:mt-0",
                  groupIndex > 0 && "mt-3.5",
                )}
              >
                <div className="mb-1.5 px-2.5 text-xs font-medium text-muted-foreground/70 web:max-820:hidden">
                  {t(groupKey)}
                </div>
                <div className="space-y-px">
                  {definitions.map((definition) => {
                    const active = definition.id === activeSection.id;
                    return (
                      <button
                        key={definition.id}
                        type="button"
                        onClick={() => setSection(definition.id)}
                        aria-current={active ? "page" : undefined}
                        data-testid={`settings-nav-${definition.id}`}
                        data-settings-nav-id={definition.id}
                        data-active={active ? "true" : "false"}
                        className={cn(
                          "group relative flex w-full cursor-pointer items-center gap-2.5 rounded-md",
                          "px-2.5 py-1.5 text-left text-sm leading-tight transition-colors duration-150",
                          "web:max-820:w-auto web:max-820:flex-none web:max-820:whitespace-nowrap web:max-820:bg-settings-tile web:max-820:px-10px web:max-820:py-8px",
                          "web:max-820:[&_>_div]:gap-8px web:max-520:px-9px web:max-520:py-7px",
                          active
                            ? "bg-foreground/10 font-medium text-foreground"
                            : "text-foreground/75 hover:bg-foreground/5 hover:text-foreground",
                        )}
                      >
                        <span
                          className={cn(
                            "flex size-4 shrink-0 items-center justify-center transition-colors",
                            active
                              ? "text-foreground"
                              : "text-muted-foreground group-hover:text-foreground",
                            "web:max-820:size-24px web:max-820:rounded-8px",
                          )}
                        >
                          {definition.icon}
                        </span>
                        <span className="min-w-0 truncate leading-tight web:max-820:text-xs">
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
            <div className="px-3 py-3">
              <div
                className="flex items-center gap-1.5 px-2.5 text-xs text-muted-foreground"
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
              "px-10 pb-2 pt-9 web:max-820:gap-3 web:max-820:px-14px web:max-820:py-10px web:max-640:px-10px web:max-640:py-9px",
              web && "flex items-center justify-between",
            )}
          >
            <div
              className={cn(
                "settings-main-title w-full overflow-hidden",
                !fillContent && "mx-auto max-w-920px",
              )}
            >
              <div key={activeSection.id} className="text-2xl font-semibold tracking-tight">
                {t(activeSection.labelKey)}
              </div>
            </div>
            {web && showSaveIndicator ? (
              <div
                className={cn(
                  "flex shrink-0 items-center gap-1.5",
                  "whitespace-nowrap text-xs text-muted-foreground web:max-820:flex-none web:max-820:whitespace-nowrap",
                )}
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
                !fillContent && "mx-auto w-full max-w-920px",
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
