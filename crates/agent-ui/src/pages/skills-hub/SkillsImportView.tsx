import { GlassPanel } from "@liveagent/ui/components/hub/HubChrome";
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  RefreshCw,
  X,
} from "@liveagent/ui/components/IconSet";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Button } from "@liveagent/ui/components/ui/button";
import { Checkbox } from "@liveagent/ui/components/ui/checkbox";
import { SearchHighlight } from "@liveagent/ui/components/ui/search-highlight";
import { useLocale } from "@liveagent/ui/i18n/index";
import { rankFuzzySearchResults } from "@liveagent/ui/lib/shared/fuzzySearch";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ExternalSkillEntry, ExternalToolScan } from "@liveagent/ui/lib/skills/index";
import { truncateLocalSkillCardDescription } from "@liveagent/ui/lib/skills/skillCardMetadata";
import { useEffect, useMemo, useRef, useState } from "react";
import { SkillsImportSourceTabs } from "./SkillsImportSourceTabs";

export function SkillsImportView(props: {
  scans: ExternalToolScan[];
  initializing: boolean;
  loading: boolean;
  error: string | null;
  query: string;
  selected: ReadonlySet<string>;
  installedNames: ReadonlySet<string>;
  importProgress: { done: number; total: number } | null;
  importingExternalBaseDir: string | null;
  importErrors: Array<{ baseDir: string; name: string; message: string }>;
  importedCount: number | null;
  importToast: string | null;
  onDismissImportToast: () => void;
  onDismissImportResult: () => void;
  bulkMode: boolean;
  onToggle: (baseDir: string) => void;
  onBatchToggle: (baseDirs: string[], on: boolean) => void;
  onRescan: () => Promise<boolean>;
  onImport: (skill?: ExternalSkillEntry) => void;
}) {
  const {
    scans,
    initializing,
    loading,
    error,
    query,
    selected,
    installedNames,
    importProgress,
    importingExternalBaseDir,
    importErrors,
    importedCount,
    importToast,
    onDismissImportToast,
    onDismissImportResult,
    bulkMode,
    onToggle,
    onBatchToggle,
    onRescan,
    onImport,
  } = props;
  const { t } = useLocale();
  const bulkAnchorRef = useRef<string | null>(null);
  const rescanFeedbackTimerRef = useRef<number | null>(null);
  const [rescanComplete, setRescanComplete] = useState(false);

  useEffect(() => {
    if (!bulkMode) bulkAnchorRef.current = null;
  }, [bulkMode]);

  useEffect(
    () => () => {
      if (rescanFeedbackTimerRef.current !== null) {
        window.clearTimeout(rescanFeedbackTimerRef.current);
      }
    },
    [],
  );

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
  // 「已选 X / Y」与全选按钮都只统计可导入项：已安装项不可选，不计入分子分母。
  const selectableVisibleBaseDirs = useMemo(
    () =>
      activeScan?.skills
        .filter((skill) => !installedNames.has(skill.name))
        .map((skill) => skill.baseDir) ?? [],
    [activeScan, installedNames],
  );
  const selectedSelectableVisibleCount = useMemo(
    () =>
      selectableVisibleBaseDirs.reduce(
        (count, baseDir) => count + (selected.has(baseDir) ? 1 : 0),
        0,
      ),
    [selectableVisibleBaseDirs, selected],
  );
  const allVisibleSelected =
    selectableVisibleBaseDirs.length > 0 &&
    selectedSelectableVisibleCount === selectableVisibleBaseDirs.length;

  async function handleRescan() {
    if (rescanFeedbackTimerRef.current !== null) {
      window.clearTimeout(rescanFeedbackTimerRef.current);
      rescanFeedbackTimerRef.current = null;
    }
    setRescanComplete(false);
    const succeeded = await onRescan();
    if (!succeeded) return;
    setRescanComplete(true);
    rescanFeedbackTimerRef.current = window.setTimeout(() => {
      setRescanComplete(false);
      rescanFeedbackTimerRef.current = null;
    }, 2400);
  }

  return (
    <div className="relative h-full min-h-0">
      {importToast || importErrors.length > 0 || (importedCount !== null && importedCount > 0) ? (
        <div className="pointer-events-none absolute inset-x-2 top-2 z-40 flex justify-end">
          {importToast ? (
            <div
              role="status"
              className="notify-toast-enter pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-xl border border-amber-500/30 bg-background px-3 py-2.5 text-sm shadow-xl"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="min-w-0 flex-1 leading-relaxed text-foreground">{importToast}</p>
              <Button
                variant="ghost"
                size="icon"
                onClick={onDismissImportToast}
                className="mt-0.5 h-6 w-6 shrink-0"
                aria-label={t("settings.close")}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : importErrors.length > 0 ? (
            <div
              role="alert"
              className="notify-toast-enter pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-xl border border-destructive/30 bg-background px-3 py-2.5 text-sm shadow-xl"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-destructive">{t("settings.skillsImportFailed")}</p>
                <div className="mt-1 max-h-40 space-y-1 overflow-y-auto pr-1 text-xs leading-relaxed text-muted-foreground">
                  {importErrors.map((failure) => (
                    <p key={failure.baseDir} className="break-words">
                      {failure.name}: {failure.message}
                    </p>
                  ))}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={onDismissImportResult}
                className="mt-0.5 h-6 w-6 shrink-0"
                aria-label={t("settings.close")}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <div
              role="status"
              className="notify-toast-enter pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-xl border border-emerald-500/30 bg-background px-3 py-2.5 text-sm shadow-xl"
            >
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--chat-success))]" />
              <p className="min-w-0 flex-1 leading-relaxed text-foreground">
                {t("settings.skillsImportDone")} ({importedCount})
              </p>
              <Button
                variant="ghost"
                size="icon"
                onClick={onDismissImportResult}
                className="mt-0.5 h-6 w-6 shrink-0"
                aria-label={t("settings.close")}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      ) : null}
      <div
        className={cn(
          "h-full min-h-0 overflow-y-auto px-1.5 pb-4 pt-1.5",
          bulkMode ? "pb-[calc(5rem+env(safe-area-inset-bottom))] sm:pb-20" : null,
        )}
      >
        <div className="flex flex-col gap-3">
          {error ? (
            <GlassPanel tone="error" className="hub-panel-enter">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                <span className="text-xs text-destructive">
                  {t("settings.skillsImportScanFailed")}: {error}
                </span>
              </div>
            </GlassPanel>
          ) : null}

          <div className="hub-panel-enter sticky top-0 z-30 -mx-0.5 flex flex-wrap items-center justify-between gap-3 bg-background/95 px-0.5 backdrop-blur supports-[backdrop-filter]:bg-background/90">
            <SkillsImportSourceTabs
              scans={filteredScans}
              value={activeTool}
              disabled={initializing}
              onChange={(nextTool) => {
                userChoseToolRef.current = true;
                setActiveTool(nextTool);
              }}
            />

            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="min-w-[6.75rem] justify-center gap-1.5"
                disabled={loading || importing || initializing}
                aria-busy={loading}
                onClick={() => void handleRescan()}
              >
                {loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : rescanComplete ? (
                  <Check className="h-3.5 w-3.5 text-[hsl(var(--chat-success))]" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                <span aria-live="polite">
                  {loading
                    ? t("settings.skillsImportScanning")
                    : rescanComplete
                      ? t("settings.skillsScanComplete")
                      : t("settings.skillsImportRescan")}
                </span>
              </Button>
              {!bulkMode ? (
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={selected.size === 0 || importing || initializing}
                  onClick={() => onImport()}
                >
                  {importing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {importing && importProgress
                    ? `${t("settings.skillsImportProgress")} ${importProgress.done + 1}/${importProgress.total}`
                    : `${t("settings.skillsImportButton")}${importableSelectedCount > 0 ? ` (${importableSelectedCount})` : ""}`}
                </Button>
              ) : null}
            </div>
          </div>

          {initializing ? (
            <div
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
              role="status"
              aria-live="polite"
              aria-busy="true"
            >
              {[1, 2, 3, 4].map((item) => (
                <div key={item} className="hub-frost-skeleton min-h-48 p-3.5">
                  <div className="flex h-full flex-col gap-3">
                    <div className="flex items-center gap-3">
                      <div className="skills-skeleton-shimmer h-5 w-5 shrink-0 rounded" />
                      <div className="skills-skeleton-shimmer h-3.5 w-28 rounded" />
                    </div>
                    <div className="space-y-2">
                      <div className="skills-skeleton-shimmer h-3 w-full rounded" />
                      <div className="skills-skeleton-shimmer h-3 w-4/5 rounded" />
                    </div>
                    <div className="skills-skeleton-shimmer mt-auto h-8 w-20 rounded-md" />
                  </div>
                </div>
              ))}
              <span className="sr-only">{t("settings.skillsImportScanning")}</span>
            </div>
          ) : activeScan ? (
            <div key={activeScan.tool} className="hub-panel-enter flex flex-col gap-3">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                <span className="font-mono">{activeScan.rootDir}</span>
                {activeScan.tool === "codebuddy" && activeScan.exists ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{t("settings.skillsImportCodebuddyHint")}</span>
                  </>
                ) : null}
                {activeScan.errors.length > 0 ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      {t("settings.skillsImportUnparsable").replace(
                        "{count}",
                        String(activeScan.errors.length),
                      )}
                    </span>
                  </>
                ) : null}
                {activeScan.exists && activeScan.skills.length > 0 ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{t("settings.skillsImportOverwriteHint")}</span>
                  </>
                ) : null}
              </p>

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
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs text-muted-foreground">
                      {t("settings.skillsHubSelectedShort")} {selectedSelectableVisibleCount} /{" "}
                      {selectableVisibleBaseDirs.length}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      disabled={importing || selectableVisibleBaseDirs.length === 0}
                      onClick={() => onBatchToggle(selectableVisibleBaseDirs, !allVisibleSelected)}
                    >
                      <Checkbox checked={allVisibleSelected} className="pointer-events-none" />
                      {allVisibleSelected
                        ? t("settings.skillsImportDeselectAll")
                        : t("settings.skillsImportSelectAll")}
                    </Button>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
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
                            "group flex min-h-48 w-full flex-col rounded-xl border border-foreground/15 bg-card p-3.5 text-left shadow-sm transition-[border-color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                            alreadyInstalled
                              ? "border-emerald-600/25"
                              : checked
                                ? "border-foreground bg-muted/30 shadow-sm"
                                : "hover:border-foreground/30 hover:bg-muted/20",
                            importing && !alreadyInstalled ? "opacity-60" : null,
                          )}
                        >
                          <div className="flex h-full flex-col gap-3">
                            <div className="flex items-start gap-3">
                              <Checkbox
                                checked={checked}
                                disabled={locked}
                                className="mt-0.5"
                                onClick={(event) => event.stopPropagation()}
                                onCheckedChange={() => onToggle(skill.baseDir)}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <SearchHighlight
                                    text={skill.name}
                                    query={query}
                                    className="truncate text-[13px] font-semibold leading-tight text-foreground"
                                  />
                                  {alreadyInstalled ? (
                                    <Badge variant="success" className="h-5 px-1.5 text-[10px]">
                                      {t("settings.skillsImportInstalledBadge")}
                                    </Badge>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                            <p
                              className="line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground"
                              title={skill.description}
                            >
                              <SearchHighlight
                                text={truncateLocalSkillCardDescription(skill.description)}
                                query={query}
                              />
                            </p>
                            <div className="mt-auto space-y-2.5">
                              <span
                                className="block truncate px-0.5 text-[10.5px] text-muted-foreground"
                                title={skill.baseDir}
                              >
                                <SearchHighlight text={skill.baseDir} query={query} />
                              </span>
                              <Button
                                type="button"
                                variant={alreadyInstalled ? "outline" : "default"}
                                size="sm"
                                className="h-9 w-full gap-1.5 rounded-xl"
                                disabled={locked}
                                aria-busy={installing}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onImport(skill);
                                }}
                              >
                                {installing ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : alreadyInstalled ? (
                                  <Check className="h-3.5 w-3.5" />
                                ) : (
                                  <Download className="h-3.5 w-3.5" />
                                )}
                                {installing
                                  ? t("settings.skillsImportProgress")
                                  : alreadyInstalled
                                    ? t("settings.skillsImportInstalledBadge")
                                    : t("settings.skillsBulkImportAction")}
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {bulkMode ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-1 z-40 flex justify-center px-2 max-sm:bottom-[calc(0.25rem+env(safe-area-inset-bottom))]">
          <div
            className={cn(
              "hub-panel-enter pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-full border border-border/50 bg-background/95 text-[12.5px] shadow-[0_8px_24px_-12px_rgba(15,23,42,0.35)] max-sm:justify-center max-sm:rounded-3xl max-sm:whitespace-nowrap dark:border-white/[0.1] dark:bg-popover/95",
              importableSelectedCount > 0 || importing ? "py-2 pl-4 pr-2" : "px-4 py-2.5",
            )}
          >
            {importableSelectedCount > 0 || importing ? (
              <>
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
                  size="sm"
                  disabled={importing}
                  className="h-7 rounded-full px-3 text-xs"
                  onClick={() => onImport()}
                >
                  {importing && importProgress ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      {`${t("settings.skillsImportProgress")} ${importProgress.done + 1}/${importProgress.total}`}
                    </>
                  ) : (
                    `${t("settings.skillsBulkImportAction")}${importableSelectedCount > 0 ? ` (${importableSelectedCount})` : ""}`
                  )}
                </Button>
              </>
            ) : (
              <span className="text-muted-foreground">{t("settings.skillsBulkClickToSelect")}</span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
