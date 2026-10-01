import { GlassPanel } from "@liveagent/ui/components/hub/HubChrome";
import { AlertTriangle, Check, Download, Loader2 } from "@liveagent/ui/components/IconSet";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Button } from "@liveagent/ui/components/ui/button";
import { Checkbox } from "@liveagent/ui/components/ui/checkbox";
import { SearchHighlight } from "@liveagent/ui/components/ui/search-highlight";
import { Skeleton } from "@liveagent/ui/components/ui/skeleton";
import { useLocale } from "@liveagent/ui/i18n/index";
import { rankFuzzySearchResults } from "@liveagent/ui/lib/shared/fuzzySearch";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ExternalSkillEntry, ExternalToolScan } from "@liveagent/ui/lib/skills/index";
import { truncateLocalSkillCardDescription } from "@liveagent/ui/lib/skills/skillCardMetadata";
import { useEffect, useMemo, useRef, useState } from "react";
import { SkillsImportSourceTabs } from "./SkillsImportSourceTabs";
import { SKILL_CARD_SHELL_CLASS, SKILL_LIST_GRID_CLASS } from "./skillCardLayout";

export function SkillsImportView(props: {
  scans: ExternalToolScan[];
  initializing: boolean;
  error: string | null;
  query: string;
  selected: ReadonlySet<string>;
  installedNames: ReadonlySet<string>;
  importProgress: { done: number; total: number } | null;
  importingExternalBaseDir: string | null;
  bulkMode: boolean;
  onToggle: (baseDir: string) => void;
  onBatchToggle: (baseDirs: string[], on: boolean) => void;
  onImport: (skill?: ExternalSkillEntry) => void;
}) {
  const {
    scans,
    initializing,
    error,
    query,
    selected,
    installedNames,
    importProgress,
    importingExternalBaseDir,
    bulkMode,
    onToggle,
    onBatchToggle,
    onImport,
  } = props;
  const { t } = useLocale();
  const bulkAnchorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!bulkMode) bulkAnchorRef.current = null;
  }, [bulkMode]);

  const filteredScans = useMemo(
    () =>
      scans.map((scan) => ({
        ...scan,
        skills: rankFuzzySearchResults(scan.skills, query, (skill) => [
          skill.name,
          skill.description,
          skill.baseDir,
          skill.skillFile,
        ]),
      })),
    [query, scans],
  );
  const importing = importProgress !== null;
  const [activeTool, setActiveTool] = useState<string>(scans[0]?.tool ?? "claude-code");
  const userChoseToolRef = useRef(false);
  // 扫描结果就绪后自动定位到第一个有技能的工具；用户手动切换后不再干预
  useEffect(() => {
    if (userChoseToolRef.current || scans.length === 0) return;
    const preferred =
      scans.find((scan) => scan.skills.length > 0) ?? scans.find((scan) => scan.exists) ?? scans[0];
    if (preferred && preferred.tool !== activeTool) {
      setActiveTool(preferred.tool);
    }
  }, [scans, activeTool]);
  const activeScan = filteredScans.find((scan) => scan.tool === activeTool);
  const importableSelectedCount = useMemo(() => {
    let count = 0;
    for (const scan of scans) {
      for (const skill of scan.skills) {
        if (installedNames.has(skill.name)) continue;
        if (selected.has(skill.baseDir)) count += 1;
      }
    }
    return count;
  }, [scans, installedNames, selected]);
  const selectableVisibleBaseDirs = useMemo(
    () =>
      activeScan?.skills
        .filter((skill) => !installedNames.has(skill.name))
        .map((skill) => skill.baseDir) ?? [],
    [activeScan, installedNames],
  );
  const selectedSelectableVisibleCount = selectableVisibleBaseDirs.reduce(
    (count, baseDir) => count + (selected.has(baseDir) ? 1 : 0),
    0,
  );
  const allVisibleSelected =
    selectableVisibleBaseDirs.length > 0 &&
    selectedSelectableVisibleCount === selectableVisibleBaseDirs.length;
  const showBulkBar = importableSelectedCount > 0 || importing;
  return (
    <div className="relative h-full min-h-0">
      <div
        className={cn(
          "h-full min-h-0 overflow-y-auto px-0.5 pb-4 pr-1",
          showBulkBar ? "pb-safe-bottom-5rem sm:pb-20" : null,
        )}
      >
        <div className="flex flex-col gap-3">
          {error ? (
            <GlassPanel tone="error">
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-4 shrink-0 text-destructive" />
                <span className="text-xs text-destructive">
                  {t("settings.skillsImportScanFailed")}: {error}
                </span>
              </div>
            </GlassPanel>
          ) : null}

          <div
            className={cn(
              "sticky top-0 z-30 -mx-0.5 flex flex-wrap items-center justify-between",
              "gap-3 bg-background/95 px-0.5 backdrop-blur supports-[backdrop-filter]:bg-background/90",
            )}
          >
            <SkillsImportSourceTabs
              scans={filteredScans}
              value={activeTool}
              disabled={initializing}
              onChange={(nextTool) => {
                userChoseToolRef.current = true;
                setActiveTool(nextTool);
              }}
            />
          </div>

          {initializing ? (
            <div
              className={SKILL_LIST_GRID_CLASS}
              role="status"
              aria-live="polite"
              aria-busy="true"
            >
              {[1, 2, 3, 4].map((item) => (
                <div key={item} className={SKILL_CARD_SHELL_CLASS} aria-hidden="true">
                  <Skeleton className="size-8 shrink-0 rounded-lg" />
                  <div className="min-w-0 flex-1">
                    <Skeleton className="h-3.5 w-28 rounded" />
                    <Skeleton className="mt-1 h-3 w-4/5 rounded" />
                    <Skeleton className="mt-1 h-3 w-1/2 rounded" />
                  </div>
                  <Skeleton className="h-8 w-20 shrink-0 self-center rounded-md" />
                </div>
              ))}
              <span className="sr-only">{t("settings.skillsImportScanning")}</span>
            </div>
          ) : activeScan ? (
            <div key={activeScan.tool} className="flex flex-col gap-3">
              {!activeScan.exists ? (
                <GlassPanel tone="muted">
                  <p className="py-2 text-center text-xs text-muted-foreground">
                    {t("settings.skillsImportNotDetected")} · {activeScan.rootDir}
                  </p>
                </GlassPanel>
              ) : activeScan.skills.length === 0 ? (
                <GlassPanel tone="muted">
                  <p className="py-2 text-center text-xs text-muted-foreground">
                    {t("settings.skillsImportEmpty")}
                  </p>
                </GlassPanel>
              ) : (
                <div className={SKILL_LIST_GRID_CLASS}>
                  {activeScan.skills.map((skill) => {
                    const alreadyInstalled = installedNames.has(skill.name);
                    const checked = !alreadyInstalled && selected.has(skill.baseDir);
                    const locked = alreadyInstalled || importing;
                    const installing = importing && skill.baseDir === importingExternalBaseDir;
                    return (
                      // biome-ignore lint/a11y/useSemanticElements: The card contains a separate import control.
                      <div
                        key={skill.baseDir}
                        role="button"
                        tabIndex={locked ? -1 : 0}
                        aria-disabled={locked}
                        aria-pressed={checked}
                        onMouseDown={(event) => {
                          if (bulkMode && event.shiftKey) event.preventDefault();
                        }}
                        onClick={(event) => {
                          if (locked) return;
                          const orderedBaseDirs = activeScan.skills
                            .filter((item) => !installedNames.has(item.name))
                            .map((item) => item.baseDir);
                          if (
                            bulkMode &&
                            event.shiftKey &&
                            bulkAnchorRef.current &&
                            bulkAnchorRef.current !== skill.baseDir
                          ) {
                            const from = orderedBaseDirs.indexOf(bulkAnchorRef.current);
                            const to = orderedBaseDirs.indexOf(skill.baseDir);
                            if (from !== -1 && to !== -1) {
                              const [lo, hi] = from < to ? [from, to] : [to, from];
                              onBatchToggle(orderedBaseDirs.slice(lo, hi + 1), !checked);
                              bulkAnchorRef.current = skill.baseDir;
                              return;
                            }
                          }
                          onToggle(skill.baseDir);
                          bulkAnchorRef.current = skill.baseDir;
                        }}
                        onKeyDown={(event) => {
                          if (
                            event.target !== event.currentTarget ||
                            (event.key !== "Enter" && event.key !== " ")
                          ) {
                            return;
                          }
                          event.preventDefault();
                          event.currentTarget.click();
                        }}
                        className={cn(
                          SKILL_CARD_SHELL_CLASS,
                          "cursor-pointer",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                          checked ? "bg-settings-active" : null,
                          importing && !alreadyInstalled ? "opacity-60" : null,
                        )}
                      >
                        <div className="flex size-8 shrink-0 items-center justify-center">
                          <Checkbox
                            checked={checked}
                            disabled={locked}
                            aria-label={`${t("settings.skillsHubBulkSelectLabel")}: ${skill.name}`}
                            onClick={(event) => event.stopPropagation()}
                            onCheckedChange={() => onToggle(skill.baseDir)}
                          />
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <SearchHighlight
                              text={skill.name}
                              query={query}
                              className="truncate text-sm font-semibold text-foreground"
                            />
                            {alreadyInstalled ? (
                              <Badge variant="muted" className="h-5 px-1.5 text-tiny">
                                {t("settings.skillsImportInstalledBadge")}
                              </Badge>
                            ) : null}
                          </div>

                          <p
                            className="mt-1 line-clamp-1 text-xs leading-5 text-muted-foreground"
                            title={skill.description}
                          >
                            <SearchHighlight
                              text={truncateLocalSkillCardDescription(skill.description)}
                              query={query}
                            />
                          </p>

                          <div className="mt-1 flex min-w-0 items-center gap-2 text-tiny text-muted-foreground">
                            <span className="truncate" title={skill.baseDir}>
                              <SearchHighlight text={skill.baseDir} query={query} />
                            </span>
                          </div>
                        </div>

                        <div
                          data-card-action-zone=""
                          role="toolbar"
                          aria-label={skill.name}
                          className="flex shrink-0 items-center gap-1.5 self-center"
                          onPointerDown={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className={cn(
                              "gap-1.5 rounded-lg bg-background text-foreground hover:bg-settings-active",
                              alreadyInstalled &&
                                "bg-transparent text-muted-foreground disabled:opacity-100",
                            )}
                            disabled={locked}
                            aria-busy={installing}
                            onClick={(event) => {
                              event.stopPropagation();
                              onImport(skill);
                            }}
                          >
                            {installing ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : alreadyInstalled ? (
                              <Check className="size-3.5" />
                            ) : (
                              <Download className="size-3.5" />
                            )}
                            {installing
                              ? t("settings.skillsImportProgress")
                              : alreadyInstalled
                                ? t("settings.skillsImportInstalledBadge")
                                : t("settings.skillsBulkImportAction")}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {showBulkBar ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-3",
            "max-sm:bottom-safe-bottom-offset",
          )}
        >
          <div
            role="toolbar"
            aria-label={t("settings.skillsBulkSelect")}
            className={cn(
              "pointer-events-auto flex max-w-full flex-wrap items-center gap-2",
              "rounded-full border border-border/50 bg-background/95",
              "py-2 pl-4 pr-2 text-xs shadow-ui-skillshubpage-51",
              "max-sm:justify-center max-sm:rounded-3xl max-sm:whitespace-nowrap dark:border-white/[0.1] dark:bg-popover/95",
            )}
          >
            <span className="whitespace-nowrap text-foreground">
              {t("settings.skillsBulkSelectedCount").replace(
                "{count}",
                String(importableSelectedCount),
              )}
            </span>
            <span className="hidden text-muted-foreground/50 sm:inline" aria-hidden="true">
              │
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={importing || selectableVisibleBaseDirs.length === 0}
              className="h-7 rounded-full px-2.5 text-xs"
              onClick={() => onBatchToggle(selectableVisibleBaseDirs, !allVisibleSelected)}
            >
              {allVisibleSelected
                ? t("settings.skillsImportDeselectAll")
                : t("settings.skillsImportSelectAll")}
            </Button>
            <span className="hidden text-muted-foreground/50 sm:inline" aria-hidden="true">
              │
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={importing || importableSelectedCount === 0}
              className="h-7 gap-1 rounded-full px-3 text-xs"
              onClick={() => onImport()}
            >
              {importing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              {importing && importProgress
                ? `${t("settings.skillsImportProgress")} ${importProgress.done + 1}/${importProgress.total}`
                : `${t("settings.skillsImportButton")} (${importableSelectedCount})`}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
