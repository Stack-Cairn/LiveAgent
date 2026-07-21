// GitReview status view: staged/unstaged change lists, the commit bar, the
// working-tree/branch diff pane and the change context menus.
//
// MIRROR NOTICE: every file under components/project-tools/git-review exists
// byte-for-byte in both frontends (crates/agent-gui/src and
// crates/agent-gateway/web/src). Keep changes in sync on both ends; only
// relative or @tauri-apps/* imports are allowed here.

import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocale } from "../../../i18n";
import type { GitStatusEntry } from "../../../lib/git/types";
import { cn } from "../../../lib/shared/utils";
import { getFileTypeIcon } from "../../chat/fileTypeIcons";
import {
  BrushCleaning,
  ChevronRight,
  ExternalLink,
  Eye,
  FilePenLine,
  FolderTree,
  GitCommitHorizontal,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from "../../icons";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { useRightDockToolContext } from "../RightDockContext";
import { DiffReviewCard } from "./DiffView";
import {
  basename,
  CHANGE_CONTEXT_MENU_ITEM_CLASS,
  type ChangeContextMenuState,
  type ChangeListSection,
  type ChangesMenuState,
  CONTEXT_MENU_CONTAINER_CLASS,
  canStageEntry,
  canUnstageEntry,
  clampMenuRectWithinRect,
  type DiffViewKind,
  GIT_REVIEW_SPLIT_GRID_CLASS,
  type GitDiscardConfirmState,
  type GitReviewStackedPane,
  isDeletedStatusEntry,
  parentPath,
  revealTargetForEntry,
  statusLabel,
  statusTone,
} from "./model";
import { GitDiscardConfirmModal } from "./Toolbar";
import type { GitReviewData } from "./useGitReviewData";
import { GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS, useOverlayScrollbar } from "./useOverlayScrollbar";

const INITIAL_CHANGE_ENTRY_RENDER_COUNT = 160;
const CHANGE_ENTRY_RENDER_BATCH_SIZE = 160;

export function GitReviewStatusView(props: {
  activeDiffView: DiffViewKind;
  collapsedSections: Record<ChangeListSection, boolean>;
  commitMessage: string;
  data: GitReviewData;
  onActiveDiffViewChange: (view: DiffViewKind) => void;
  onCommitMessageChange: (value: string) => void;
  onStackedPaneChange: (pane: GitReviewStackedPane, dir: "forward" | "back") => void;
  onToggleSection: (section: ChangeListSection) => void;
  panelRef: RefObject<HTMLDivElement | null>;
  stackedDir: "forward" | "back";
  stackedPane: GitReviewStackedPane;
  useSplitReviewLayout: boolean;
  writeDisabled: boolean;
}) {
  const {
    activeDiffView,
    collapsedSections,
    commitMessage,
    data,
    onActiveDiffViewChange,
    onCommitMessageChange,
    onStackedPaneChange,
    onToggleSection,
    panelRef,
    stackedDir,
    stackedPane,
    useSplitReviewLayout,
    writeDisabled,
  } = props;
  const {
    branchDiff,
    branchError,
    busy,
    cwd,
    diffLoading,
    gitClient,
    loading,
    refresh,
    runOperation,
    selectPath,
    selectedPath,
    setError,
    state,
    worktreeDiff,
  } = data;
  const context = useRightDockToolContext();
  const onRevealInFileTree = context.fileTree.onRevealInFileTree;
  const { t } = useLocale();

  const handleOverlayScroll = useOverlayScrollbar();
  const [changeContextMenu, setChangeContextMenu] = useState<ChangeContextMenuState | null>(null);
  const [changesMenu, setChangesMenu] = useState<ChangesMenuState | null>(null);
  const [discardConfirm, setDiscardConfirm] = useState<GitDiscardConfirmState | null>(null);
  const listPaneRef = useRef<HTMLElement | null>(null);
  const detailPaneRef = useRef<HTMLElement | null>(null);
  const changeContextMenuRef = useRef<HTMLDivElement | null>(null);
  const changesMenuRef = useRef<HTMLDivElement | null>(null);

  // Clamp the menus against their measured size after they render (no
  // hard-coded menu dimensions); useLayoutEffect corrects the position before
  // paint, so an out-of-bounds menu never flashes at the raw pointer spot.
  useLayoutEffect(() => {
    if (!changeContextMenu) return;
    const menu = changeContextMenuRef.current;
    const panel = panelRef.current;
    if (!menu || !panel) return;
    const { dx, dy } = clampMenuRectWithinRect(
      menu.getBoundingClientRect(),
      panel.getBoundingClientRect(),
      8,
    );
    if (dx !== 0 || dy !== 0) {
      setChangeContextMenu({
        ...changeContextMenu,
        x: changeContextMenu.x + dx,
        y: changeContextMenu.y + dy,
      });
    }
  }, [changeContextMenu, panelRef]);

  useLayoutEffect(() => {
    if (!changesMenu) return;
    const menu = changesMenuRef.current;
    const panel = panelRef.current;
    if (!menu || !panel) return;
    const { dx, dy } = clampMenuRectWithinRect(
      menu.getBoundingClientRect(),
      panel.getBoundingClientRect(),
      8,
    );
    if (dx !== 0 || dy !== 0) {
      setChangesMenu({ ...changesMenu, x: changesMenu.x + dx, y: changesMenu.y + dy });
    }
  }, [changesMenu, panelRef]);

  useEffect(() => {
    if (useSplitReviewLayout) return;
    const el = stackedPane === "list" ? listPaneRef.current : detailPaneRef.current;
    if (!el) return;
    const cls =
      stackedDir === "back" ? "git-review-pane-enter-back" : "git-review-pane-enter-forward";
    el.classList.remove("git-review-pane-enter-forward", "git-review-pane-enter-back");
    void el.offsetHeight;
    el.classList.add(cls);
  }, [stackedPane, useSplitReviewLayout, stackedDir]);

  const entries = state.entries;
  const stagedEntries = useMemo(() => entries.filter(canUnstageEntry), [entries]);
  const workingEntries = useMemo(() => entries.filter(canStageEntry), [entries]);
  const [visibleStagedEntryCount, setVisibleStagedEntryCount] = useState(
    INITIAL_CHANGE_ENTRY_RENDER_COUNT,
  );
  const [visibleWorkingEntryCount, setVisibleWorkingEntryCount] = useState(
    INITIAL_CHANGE_ENTRY_RENDER_COUNT,
  );
  useEffect(() => {
    setVisibleStagedEntryCount(INITIAL_CHANGE_ENTRY_RENDER_COUNT);
    setVisibleWorkingEntryCount(INITIAL_CHANGE_ENTRY_RENDER_COUNT);
  }, [state.repoRoot, state.head, stagedEntries.length, workingEntries.length]);
  const visibleStagedEntries = useMemo(
    () => stagedEntries.slice(0, visibleStagedEntryCount),
    [stagedEntries, visibleStagedEntryCount],
  );
  const visibleWorkingEntries = useMemo(
    () => workingEntries.slice(0, visibleWorkingEntryCount),
    [workingEntries, visibleWorkingEntryCount],
  );
  const hiddenStagedEntryCount = Math.max(0, stagedEntries.length - visibleStagedEntries.length);
  const hiddenWorkingEntryCount = Math.max(0, workingEntries.length - visibleWorkingEntries.length);
  const operationBusy = busy !== "";
  const hasStageableChanges = state.dirtyCounts.unstaged > 0 || state.dirtyCounts.untracked > 0;
  const hasStagedChanges = state.dirtyCounts.staged > 0;
  const hasDiscardableChanges = entries.length > 0;
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.path === selectedPath) ?? null,
    [entries, selectedPath],
  );
  const contextEntry = useMemo(
    () => entries.find((entry) => entry.path === changeContextMenu?.path) ?? null,
    [changeContextMenu?.path, entries],
  );
  const contextEntrySection = changeContextMenu?.section ?? "changes";
  const contextEntryCanStage =
    contextEntrySection === "changes" && contextEntry ? canStageEntry(contextEntry) : false;
  const contextEntryCanUnstage =
    contextEntrySection === "staged" && contextEntry ? canUnstageEntry(contextEntry) : false;
  const contextEntryCanAddToGitignore =
    contextEntrySection === "changes" && Boolean(contextEntry?.untracked);

  useEffect(() => {
    if (!changeContextMenu) return;
    const closeMenu = () => setChangeContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [changeContextMenu]);

  useEffect(() => {
    if (!changesMenu) return;
    const closeMenu = () => setChangesMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [changesMenu]);

  const selectEntry = useCallback(
    (entry: GitStatusEntry) => {
      selectPath(entry.path);
      if (!useSplitReviewLayout) {
        onStackedPaneChange("detail", "forward");
      }
    },
    [onStackedPaneChange, selectPath, useSplitReviewLayout],
  );

  const openChangeContextMenu = useCallback(
    (event: ReactMouseEvent, entry: GitStatusEntry, section: ChangeListSection) => {
      event.preventDefault();
      event.stopPropagation();
      setChangesMenu(null);
      const panelRect = panelRef.current?.getBoundingClientRect();
      // Raw pointer position; the measured-clamp layout effect corrects it.
      setChangeContextMenu({
        x: panelRect ? event.clientX - panelRect.left : event.clientX,
        y: panelRect ? event.clientY - panelRect.top : event.clientY,
        path: entry.path,
        section,
      });
    },
    [panelRef],
  );

  const toggleChangeSection = useCallback(
    (section: ChangeListSection) => {
      setChangeContextMenu((current) => (current?.section === section ? null : current));
      setChangesMenu((current) => (current?.section === section ? null : current));
      onToggleSection(section);
    },
    [onToggleSection],
  );

  const openChangesMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, section: ChangeListSection) => {
      event.preventDefault();
      event.stopPropagation();
      setChangeContextMenu(null);
      const panelRect = panelRef.current?.getBoundingClientRect();
      const buttonRect = event.currentTarget.getBoundingClientRect();
      // Anchor at the button's bottom-right corner; the menu right-aligns via
      // translateX(-100%) and the measured-clamp layout effect corrects it.
      setChangesMenu({
        x: panelRect ? buttonRect.right - panelRect.left : buttonRect.right,
        y: panelRect ? buttonRect.bottom - panelRect.top + 4 : buttonRect.bottom + 4,
        section,
      });
    },
    [panelRef],
  );

  const viewEntryChanges = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      onActiveDiffViewChange("workingTree");
      selectEntry(entry);
    },
    [onActiveDiffViewChange, selectEntry],
  );

  const stageEntry = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      void runOperation("stage", () => gitClient!.stage(cwd, entry.path));
    },
    [cwd, gitClient, runOperation],
  );

  const unstageEntry = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      void runOperation("unstage", () => gitClient!.unstage(cwd, entry.path));
    },
    [cwd, gitClient, runOperation],
  );

  const discardEntry = useCallback((entry: GitStatusEntry) => {
    setChangeContextMenu(null);
    setDiscardConfirm({
      kind: "entry",
      path: entry.path,
      oldPath: entry.oldPath ?? null,
    });
  }, []);

  const addEntryToGitignore = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      void runOperation("add_to_gitignore", () => gitClient!.addToGitignore(cwd, entry.path));
    },
    [cwd, gitClient, runOperation],
  );

  const stageAllChanges = useCallback(() => {
    setChangesMenu(null);
    void runOperation("stage_all", () => gitClient!.stageAll(cwd));
  }, [cwd, gitClient, runOperation]);

  const unstageAllChanges = useCallback(() => {
    setChangesMenu(null);
    void runOperation("unstage_all", () => gitClient!.unstageAll(cwd));
  }, [cwd, gitClient, runOperation]);

  const discardAllChanges = useCallback(() => {
    setChangesMenu(null);
    setDiscardConfirm({ kind: "all" });
  }, []);

  const closeDiscardConfirm = useCallback(() => {
    if (busy === "discard" || busy === "discard_all") return;
    setDiscardConfirm(null);
  }, [busy]);

  const confirmDiscardChanges = useCallback(async () => {
    if (!discardConfirm) return;
    if (discardConfirm.kind === "all") {
      await runOperation("discard_all", () => gitClient!.discardAll(cwd), "discard_all");
    } else {
      const target = discardConfirm;
      await runOperation(
        "discard",
        () => gitClient!.discard(cwd, target.path, target.oldPath ?? undefined),
        "discard",
      );
    }
    setDiscardConfirm(null);
  }, [cwd, discardConfirm, gitClient, runOperation]);

  const revealEntryInFileTree = useCallback(
    (entry: GitStatusEntry) => {
      if (!onRevealInFileTree) return;
      setChangeContextMenu(null);
      onRevealInFileTree(revealTargetForEntry(entry));
    },
    [onRevealInFileTree],
  );

  const canOpenSystemFileLocation = typeof gitClient?.openSystemFileLocation === "function";

  const openEntrySystemFileLocation = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      setError("");
      void gitClient?.openSystemFileLocation?.(cwd, entry.path).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    },
    [cwd, gitClient, setError],
  );

  const renderChangeEntry = (entry: GitStatusEntry, section: ChangeListSection) => {
    const selected = entry.path === selectedPath;
    const contextMenuOpen =
      entry.path === changeContextMenu?.path && section === changeContextMenu?.section;
    const TypeIcon = getFileTypeIcon(entry.path, "file");
    const fileName = basename(entry.path);
    const filePath = parentPath(entry.path);
    const deleted = isDeletedStatusEntry(entry);
    return (
      <div
        key={`${section}:${entry.kind}:${entry.oldPath ?? ""}:${entry.path}`}
        className={cn(
          "select-none border-b border-l-2 border-border/60 border-l-transparent px-3 py-2 transition-colors hover:bg-muted/40",
          selected && "border-l-emerald-500 bg-emerald-500/10",
          contextMenuOpen && "border-l-primary bg-primary/10 ring-1 ring-inset ring-primary/35",
        )}
        onContextMenu={(event) => openChangeContextMenu(event, entry, section)}
      >
        <button
          type="button"
          className="flex w-full select-none items-start gap-2 rounded-sm bg-transparent p-0 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => selectEntry(entry)}
          title={entry.path}
        >
          <TypeIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 select-none">
            <span
              className={cn(
                "block truncate text-xs font-medium text-foreground",
                deleted && "line-through",
              )}
            >
              {fileName}
            </span>
            <span
              className={cn(
                "block truncate text-[calc(11px*var(--zone-font-scale,1))] leading-4 text-muted-foreground",
                deleted && "line-through",
              )}
            >
              {filePath}
            </span>
          </span>
          <span
            className={cn(
              "mt-0.5 shrink-0 text-[calc(10px*var(--zone-font-scale,1))] font-semibold",
              statusTone(entry),
            )}
          >
            {statusLabel(entry)}
          </span>
        </button>
      </div>
    );
  };

  const renderChangeSection = (
    section: ChangeListSection,
    title: string,
    sectionEntries: GitStatusEntry[],
    visibleSectionEntries: GitStatusEntry[],
    hiddenCount: number,
    emptyLabel: string,
    onShowMore: () => void,
    collapsed: boolean,
    onToggle: () => void,
  ) => (
    <section className="relative border-b border-border/60 bg-background last:border-b-0">
      <div className="sticky top-0 z-20 grid h-7 w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-border/60 bg-muted px-3">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-sm bg-transparent p-0 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
              !collapsed && "rotate-90",
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate text-[calc(11px*var(--zone-font-scale,1))] font-semibold text-muted-foreground">
            {title}
          </span>
        </button>
        <span className="inline-flex h-4 min-w-6 shrink-0 items-center justify-center justify-self-end rounded bg-background/70 px-1.5 text-center text-[calc(10px*var(--zone-font-scale,1))] font-medium tabular-nums text-muted-foreground">
          {sectionEntries.length}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="-mr-1 h-5 w-5 shrink-0 px-0 text-muted-foreground"
          title={t("projectTools.gitReview.changesActions")}
          aria-label={t("projectTools.gitReview.changesActions")}
          onClick={(event) => openChangesMenu(event, section)}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div
        aria-hidden={collapsed}
        inert={collapsed}
        className={cn(
          "grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          collapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
        )}
      >
        <div
          className={cn(
            "min-h-0 overflow-hidden transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
            collapsed ? "-translate-y-1 opacity-0" : "translate-y-0 opacity-100",
          )}
        >
          {sectionEntries.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">{emptyLabel}</div>
          ) : (
            <>
              {visibleSectionEntries.map((entry) => renderChangeEntry(entry, section))}
              {hiddenCount > 0 ? (
                <div className="border-b border-border/60 px-3 py-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-full text-xs"
                    onClick={onShowMore}
                  >
                    {t("projectTools.gitReview.showMoreChanges").replace(
                      "{count}",
                      String(hiddenCount),
                    )}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );

  return (
    <>
      <GitDiscardConfirmModal
        target={discardConfirm}
        loading={busy === "discard" || busy === "discard_all"}
        onClose={closeDiscardConfirm}
        onConfirm={confirmDiscardChanges}
      />
      <div
        key="changes"
        className={cn(
          "git-review-tab-enter min-h-0 flex-1 gap-3 overflow-hidden p-3",
          useSplitReviewLayout ? `grid ${GIT_REVIEW_SPLIT_GRID_CLASS}` : "flex flex-col",
        )}
      >
        <aside
          ref={listPaneRef}
          className={cn(
            "min-h-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-background",
            useSplitReviewLayout || stackedPane === "list" ? "flex" : "hidden",
            !useSplitReviewLayout && "flex-1",
          )}
        >
          <div
            className={cn(
              GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS,
              "isolate min-h-0 flex-1 overflow-auto [overscroll-behavior:contain]",
            )}
            onScroll={handleOverlayScroll}
          >
            {entries.length === 0 ? (
              <div className="px-3 py-6 text-xs text-muted-foreground">
                {t("projectTools.gitReview.noLocalChanges")}
              </div>
            ) : (
              <>
                {renderChangeSection(
                  "staged",
                  t("projectTools.gitReview.stagedChangesTitle"),
                  stagedEntries,
                  visibleStagedEntries,
                  hiddenStagedEntryCount,
                  t("projectTools.gitReview.noStagedChanges"),
                  () =>
                    setVisibleStagedEntryCount(
                      (current) => current + CHANGE_ENTRY_RENDER_BATCH_SIZE,
                    ),
                  collapsedSections.staged,
                  () => toggleChangeSection("staged"),
                )}
                {renderChangeSection(
                  "changes",
                  t("projectTools.gitReview.changesTitle"),
                  workingEntries,
                  visibleWorkingEntries,
                  hiddenWorkingEntryCount,
                  t("projectTools.gitReview.noWorkingChanges"),
                  () =>
                    setVisibleWorkingEntryCount(
                      (current) => current + CHANGE_ENTRY_RENDER_BATCH_SIZE,
                    ),
                  collapsedSections.changes,
                  () => toggleChangeSection("changes"),
                )}
              </>
            )}
          </div>
        </aside>
        <main
          ref={detailPaneRef}
          className={cn(
            "h-full min-h-0 flex-col overflow-hidden",
            useSplitReviewLayout || stackedPane === "detail" ? "flex" : "hidden",
            !useSplitReviewLayout && "flex-1",
          )}
        >
          <div className="mb-3 flex shrink-0 items-center gap-2">
            <GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />
            <Input
              value={commitMessage}
              onChange={(event) => onCommitMessageChange(event.target.value)}
              placeholder={t("projectTools.gitReview.commitMessagePlaceholder")}
              disabled={writeDisabled || operationBusy}
              className="h-8 text-[calc(11px*var(--zone-font-scale,1))] placeholder:text-[calc(11px*var(--zone-font-scale,1))] focus-visible:ring-1 focus-visible:ring-border/40"
            />
            <Button
              size="sm"
              disabled={writeDisabled || operationBusy || !commitMessage.trim()}
              onClick={() => {
                void runOperation(
                  "commit",
                  () => gitClient!.commit(cwd, commitMessage),
                  "commit",
                ).then((ok) => {
                  if (ok) onCommitMessageChange("");
                });
              }}
            >
              {busy === "commit" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t("projectTools.gitReview.commit")
              )}
            </Button>
          </div>
          {selectedEntry ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              <div className="flex shrink-0 items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs">
                <span className="text-muted-foreground">
                  {t("projectTools.gitReview.selected")}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium" title={selectedEntry.path}>
                  {selectedEntry.path}
                </span>
              </div>
              <DiffReviewCard
                activeView={activeDiffView}
                branchDiff={branchDiff}
                branchError={branchError}
                diffLoading={diffLoading}
                onActiveViewChange={onActiveDiffViewChange}
                showStat={useSplitReviewLayout}
                worktreeDiff={worktreeDiff}
              />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border/70 bg-muted/10 px-4 text-center text-xs text-muted-foreground">
              {t("projectTools.gitReview.selectFileToViewDiff")}
            </div>
          )}
        </main>
      </div>
      {changesMenu ? (
        <div
          ref={changesMenuRef}
          role="menu"
          className={cn("absolute z-[75] min-w-56", CONTEXT_MENU_CONTAINER_CLASS)}
          style={{ left: changesMenu.x, top: changesMenu.y, transform: "translateX(-100%)" }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {changesMenu.section === "changes" ? (
            <button
              type="button"
              role="menuitem"
              className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
              disabled={writeDisabled || busy !== "" || !hasStageableChanges}
              onClick={stageAllChanges}
            >
              <FilePenLine className="h-3.5 w-3.5" />
              <span>{t("projectTools.gitReview.stageAllChanges")}</span>
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
              disabled={writeDisabled || busy !== "" || !hasStagedChanges}
              onClick={unstageAllChanges}
            >
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              <span>{t("projectTools.gitReview.unstageAllChanges")}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== "" || !hasDiscardableChanges}
            onClick={discardAllChanges}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.discardAllChanges")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={loading}
            onClick={() => {
              setChangesMenu(null);
              void refresh();
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.refreshChanges")}</span>
          </button>
        </div>
      ) : null}
      {changeContextMenu && contextEntry ? (
        <div
          ref={changeContextMenuRef}
          role="menu"
          className={cn("absolute z-[80] min-w-56", CONTEXT_MENU_CONTAINER_CLASS)}
          style={{ left: changeContextMenu.x, top: changeContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            onClick={() => viewEntryChanges(contextEntry)}
          >
            <Eye className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.viewChanges")}</span>
          </button>
          {contextEntrySection === "staged" ? (
            <button
              type="button"
              role="menuitem"
              className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
              disabled={writeDisabled || busy !== "" || !contextEntryCanUnstage}
              onClick={() => unstageEntry(contextEntry)}
            >
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              <span>{t("projectTools.gitReview.unstageChanges")}</span>
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
              disabled={writeDisabled || busy !== "" || !contextEntryCanStage}
              onClick={() => stageEntry(contextEntry)}
            >
              <FilePenLine className="h-3.5 w-3.5" />
              <span>{t("projectTools.gitReview.stageChanges")}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== ""}
            onClick={() => discardEntry(contextEntry)}
          >
            <BrushCleaning className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.discardChanges")}</span>
          </button>
          {contextEntryCanAddToGitignore ? (
            <button
              type="button"
              role="menuitem"
              className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
              disabled={writeDisabled || busy !== ""}
              onClick={() => addEntryToGitignore(contextEntry)}
            >
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              <span>{t("projectTools.gitReview.addToGitignore")}</span>
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={!onRevealInFileTree}
            onClick={() => revealEntryInFileTree(contextEntry)}
          >
            <FolderTree className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.revealInFileTree")}</span>
          </button>
          {canOpenSystemFileLocation ? (
            <button
              type="button"
              role="menuitem"
              className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
              onClick={() => openEntrySystemFileLocation(contextEntry)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>{t("projectTools.gitReview.openSystemFileLocation")}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
