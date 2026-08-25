import { ArrowLeft, Search } from "@liveagent/ui/components/IconSet";
import { useEffect, useMemo, useState } from "react";
import type { SettingsSaveState, UiExtensionRegistry } from "../../contracts/registry";
import { useLocale } from "../../i18n";
import { cn } from "../../lib/shared/utils";

type SettingsShellProps<Context> = {
  registry: UiExtensionRegistry<Context>;
  context: Context;
  saveState: SettingsSaveState;
  onBack: () => void;
  initialSection?: string;
  hiddenSections?: readonly string[];
};

// CUA-036: the inner `.settings-section-enter` / `.settings-section-title-enter`
// keyframe animations are paused by WebKit/Chromium while the document is
// hidden (background launch, minimized window). CUA-033/034 only cover the
// outer overlay container; without this fallback the inner section body
// stays at the `from` state (opacity:0, translateY(14px) scale(0.985)) and
// the entire settings page reads as blank. Mirrors the LEAVE_FALLBACK_MS
// shape: subscribe to visibilitychange so the override clears the moment the
// window becomes visible again.
function useIsDocumentHidden() {
  const [hidden, setHidden] = useState(() => {
    if (typeof document === "undefined") return false;
    return document.visibilityState === "hidden";
  });
  useEffect(() => {
    if (typeof document === "undefined") return;
    const sync = () => setHidden(document.visibilityState === "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  return hidden;
}

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
  const isDocumentHidden = useIsDocumentHidden();
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
        web ? "settings-page-shell flex h-full bg-background" : "flex h-full flex-col bg-background"
      }
    >
      <div className={web ? "contents" : "flex min-h-0 flex-1"}>
        <aside className="settings-sidebar flex w-64 shrink-0 flex-col border-r border-border/60 bg-muted/30">
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
          <div className="settings-sidebar-header px-3 pb-2 pt-3">
            <button
              type="button"
              onClick={onBack}
              className="settings-back-button flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" />
              <span>{t("settings.backToChat")}</span>
            </button>
            <div className="relative mt-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" />
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
          <nav className="settings-nav flex-1 overflow-y-auto px-3 py-3">
            {visibleGroups.map(([groupKey, definitions], groupIndex) => (
              <div key={groupKey} className={cn("settings-nav-group", groupIndex > 0 && "mt-5")}>
                <div className="settings-nav-group-label mb-1 px-3 text-xs font-medium text-muted-foreground/65">
                  {t(groupKey)}
                </div>
                <div className="space-y-0.5">
                  {definitions.map((definition) => {
                    const active = definition.id === activeSection.id;
                    return (
                      <button
                        // CUA-037: include the active state in the React key so the button
                        // unmounts/remounts when it toggles between idle and active. The
                        // Tauri WKWebView occasionally caches a stale composited layer for
                        // this sidebar region — the DOM class flips correctly but the rendered
                        // pixel (and getComputedStyle) sticks on the previous active item.
                        // Forcing a fresh DOM element via key change makes the WebView recompute
                        // styles from scratch instead of trying to interpolate the bg-accent /
                        // font-medium transition over its cached frame.
                        key={`${definition.id}-${active ? "active" : "idle"}`}
                        type="button"
                        onClick={() => setSection(definition.id)}
                        data-testid={`settings-nav-${definition.id}`}
                        data-settings-nav-id={definition.id}
                        data-active={active ? "true" : "false"}
                        className={cn(
                          "settings-nav-item group relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-all duration-150",
                          active
                            ? "settings-nav-item-active bg-accent font-medium text-foreground"
                            : "text-foreground/75 hover:bg-accent/60 hover:text-foreground",
                        )}
                      >
                        <span className="settings-nav-icon flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground transition-colors group-hover:text-foreground">
                          {definition.icon}
                        </span>
                        <span className="settings-nav-label min-w-0 truncate leading-tight">
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
                className="flex items-center gap-1.5 px-2.5 text-[11px] text-muted-foreground"
                title={saveIndicator.title}
              >
                <div className={cn("h-1.5 w-1.5 rounded-full", saveIndicator.dotClass)} />
                {saveIndicator.text}
              </div>
            </div>
          ) : null}
        </aside>
        <main className="settings-main flex min-w-0 flex-1 flex-col">
          {registry.slots.mainLeading}
          <header
            className={cn(
              "settings-main-header px-8 pb-2 pt-8",
              web && "flex items-center justify-between",
            )}
          >
            <div
              className={cn(
                "settings-main-title w-full overflow-hidden",
                activeSection.id === "system" && "mx-auto max-w-[920px]",
              )}
            >
              <div
                key={activeSection.id}
                className="settings-section-title-enter text-[28px] font-semibold tracking-tight"
                data-anim-suspended={isDocumentHidden ? "true" : undefined}
                style={
                  isDocumentHidden
                    ? { animation: "none", opacity: 1, transform: "none" }
                    : undefined
                }
              >
                {t(activeSection.labelKey)}
              </div>
            </div>
            {web && showSaveIndicator ? (
              <div
                className="settings-save-indicator flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"
                title={saveIndicator.title}
              >
                <div className={cn("h-1.5 w-1.5 shrink-0 rounded-full", saveIndicator.dotClass)} />
                {saveIndicator.text}
              </div>
            ) : null}
          </header>
          <div
            key={activeSection.id}
            className={cn(
              "settings-content settings-section-enter flex-1 px-8 pb-8 pt-6",
              `settings-content-${activeSection.id}`,
              fillContent ? "flex min-h-0 flex-col overflow-hidden" : "overflow-auto",
            )}
            data-anim-suspended={isDocumentHidden ? "true" : undefined}
            style={
              isDocumentHidden
                ? { animation: "none", opacity: 1, transform: "none" }
                : undefined
            }
          >
            <div
              className={cn(
                "settings-section-shell",
                `settings-section-shell-${activeSection.id}`,
                activeSection.id === "system" && "mx-auto w-full max-w-[920px]",
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
