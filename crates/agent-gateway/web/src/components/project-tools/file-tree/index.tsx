// Right-dock file tree panel: virtualized tree over the useFileTreeData
// layer, reading its wiring from the right-dock tool context.
//
// MIRROR NOTICE: every file under components/project-tools/file-tree/ exists
// byte-for-byte in both frontends (crates/agent-gui/src and
// crates/agent-gateway/web/src). Keep changes in sync on both ends; only
// relative, npm-package, or @tauri-apps/* imports are allowed here.

import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocale } from "../../../i18n";
import type { RightDockFileTreeStatePatch } from "../../../lib/settings";
import { cn } from "../../../lib/shared/utils";
import { getFileTypeIcon } from "../../chat/fileTypeIcons";
import { Check, FolderOpen, Loader2, RefreshCw, Search, Trash2, X } from "../../icons";
import { Button } from "../../ui/button";
import { useConfirmDialog } from "../../ui/confirm-dialog";
import { Input } from "../../ui/input";
import { isWorkspaceImagePath } from "../../workspace-editor/workspaceImagePreview";
import { useRightDockToolContext } from "../RightDockContext";
import { FileTreeContextMenu } from "./ContextMenu";
import {
  addExpandedPaths,
  ancestorDirsOfPath,
  basename,
  dirname,
  FILE_TREE_ROW_HEIGHT,
  type FileTreeKind,
  flattenFileTreeRows,
  ROOT_PATH,
  remapExpandedPathsForRename,
  removeExpandedPath,
  removeExpandedSubtree,
} from "./model";
import { FileTreeErrorRow, FileTreeRow } from "./Row";
import { useFileTreeData } from "./useFileTreeData";

const FILE_TREE_QUERY_SYNC_DEBOUNCE_MS = 180;

type PendingAction = "file" | "folder" | "rename" | null;

type ContextMenuState = {
  x: number;
  y: number;
  path: string;
};

export function FileTreePanel(props: { active: boolean }) {
  const { active } = props;
  const context = useRightDockToolContext();
  const { projectPathKey, cwd, fileTree } = context;
  const syncState = fileTree.state;
  const initialized = fileTree.initialized;
  const { t } = useLocale();

  const [query, setQuery] = useState(syncState.query);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [pendingTargetPath, setPendingTargetPath] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [revealTarget, setRevealTarget] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { confirm: requestConfirmDialog, dialog: confirmDialog } = useConfirmDialog();

  const {
    nodes,
    loadChildren,
    refreshVisible,
    ensureDirsLoaded,
    createEntry,
    renameEntry,
    deleteEntry,
    openWorkspacePath,
    search,
  } = useFileTreeData({
    projectPathKey,
    cwd,
    active,
    initialized,
    workspaceActivityClient: context.clients.workspaceActivity ?? null,
    expandedPaths: syncState.expandedPaths,
    query,
    showHidden: syncState.showHidden,
  });

  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const onStateChangeRef = useRef(fileTree.onStateChange);
  useEffect(() => {
    onStateChangeRef.current = fileTree.onStateChange;
  }, [fileTree.onStateChange]);
  const emitState = useCallback((patch: RightDockFileTreeStatePatch) => {
    onStateChangeRef.current(patch);
  }, []);

  // Expansion state has one source of truth: the persisted settings state.
  // `expandedRef` is updated both when a patch is emitted and when the
  // persisted state round-trips, so local toggles and sync operate on the
  // same value even mid-async-flow (no stale-closure overwrites).
  const expandedPaths = syncState.expandedPaths;
  const expandedSet = useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const expandedRef = useRef(expandedPaths);
  useEffect(() => {
    expandedRef.current = expandedPaths;
  }, [expandedPaths]);

  const setExpanded = useCallback(
    (next: string[]) => {
      if (next === expandedRef.current) return;
      expandedRef.current = next;
      emitState({ expandedPaths: next });
    },
    [emitState],
  );

  const selectedNode = nodes[syncState.selectedPath] ?? nodes[ROOT_PATH];
  const selectedPath = selectedNode?.path ?? ROOT_PATH;
  const canMutate = initialized && Boolean(projectPathKey && cwd);

  const selectPath = useCallback(
    (path: string) => {
      emitState({ selectedPath: path });
    },
    [emitState],
  );

  const toggleDirectory = useCallback(
    (path: string, isExpanded: boolean) => {
      if (isExpanded) {
        setExpanded(removeExpandedPath(expandedRef.current, path));
      } else {
        setExpanded(addExpandedPaths(expandedRef.current, [path]));
        void loadChildren(path);
      }
    },
    [loadChildren, setExpanded],
  );

  // Local query <-> persisted query (both directions, debounced outbound).
  useEffect(() => {
    setQuery((current) => (current === syncState.query ? current : syncState.query));
  }, [syncState.query]);
  useEffect(() => {
    if (!initialized || !projectPathKey || query === syncState.query) return;
    const timer = window.setTimeout(() => {
      emitState({ query });
    }, FILE_TREE_QUERY_SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [emitState, initialized, projectPathKey, query, syncState.query]);

  // Transient UI state never leaks across project switches.
  useEffect(() => {
    void projectPathKey;
    setContextMenu(null);
    setPendingAction(null);
    setPendingTargetPath(null);
    setDraftName("");
    setActionError(null);
    setRevealTarget(null);
  }, [projectPathKey]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  // Reveal: expand + load the ancestor chain, then scroll the row into view.
  // The expansion merge reads `expandedRef` *after* the awaits so manual
  // expands that happened while loading are preserved (the old panel captured
  // a pre-await snapshot and overwrote them).
  const revealPath = useCallback(
    async (path: string, kind: FileTreeKind) => {
      const dirs =
        kind === "dir" && path ? [...ancestorDirsOfPath(path), path] : ancestorDirsOfPath(path);
      await ensureDirsLoaded(dirs);
      setExpanded(addExpandedPaths(expandedRef.current, dirs));
      selectPath(path);
      setRevealTarget(path);
    },
    [ensureDirsLoaded, selectPath, setExpanded],
  );

  // External reveal requests arrive as a bump of the persisted revision
  // nonce (state.revision) with selectedPath/expandedPaths already patched
  // by RightDockPanel.revealPathInFileTree.
  const lastRevisionRef = useRef(syncState.revision);
  useEffect(() => {
    const previous = lastRevisionRef.current;
    lastRevisionRef.current = syncState.revision;
    if (!initialized || !projectPathKey || previous === syncState.revision) return;
    const target = syncState.selectedPath;
    const kind = nodesRef.current[target]?.kind ?? "file";
    void revealPath(target, kind);
  }, [initialized, projectPathKey, revealPath, syncState.revision, syncState.selectedPath]);

  const rows = useMemo(() => flattenFileTreeRows(nodes, expandedSet), [expandedSet, nodes]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_TREE_ROW_HEIGHT,
    overscan: 12,
  });

  useEffect(() => {
    if (!revealTarget) return;
    const index = rows.findIndex((row) => row.type === "node" && row.path === revealTarget);
    if (index < 0) return;
    rowVirtualizer.scrollToIndex(index, { align: "center" });
    setRevealTarget(null);
  }, [revealTarget, rowVirtualizer, rows]);

  const getSiblingImagePaths = useCallback((targetPath: string) => {
    if (!isWorkspaceImagePath(targetPath)) return [];
    const currentNodes = nodesRef.current;
    const parentNode = currentNodes[dirname(targetPath)];
    const siblingPaths =
      parentNode?.children.filter((childPath) => {
        const child = currentNodes[childPath];
        return child?.kind === "file" && isWorkspaceImagePath(childPath);
      }) ?? [];
    return siblingPaths.includes(targetPath) ? siblingPaths : [targetPath];
  }, []);

  const onOpenFileRef = useRef(fileTree.onOpenFile);
  useEffect(() => {
    onOpenFileRef.current = fileTree.onOpenFile;
  }, [fileTree.onOpenFile]);
  const handleOpenFile = useCallback(
    (path: string) => {
      onOpenFileRef.current?.(path, getSiblingImagePaths(path));
    },
    [getSiblingImagePaths],
  );

  const onInsertFileMentionRef = useRef(fileTree.onInsertFileMention);
  useEffect(() => {
    onInsertFileMentionRef.current = fileTree.onInsertFileMention;
  }, [fileTree.onInsertFileMention]);
  const handleInsertMention = useCallback((path: string) => {
    const node = nodesRef.current[path];
    if (!path || !node) return;
    onInsertFileMentionRef.current?.(path, node.kind);
  }, []);

  const openContextMenu = useCallback(
    (event: ReactMouseEvent, path: string) => {
      event.preventDefault();
      event.stopPropagation();
      const targetPath = nodesRef.current[path] ? path : ROOT_PATH;
      selectPath(targetPath);
      const rect = panelRef.current?.getBoundingClientRect();
      setContextMenu({
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
        path: targetPath,
      });
    },
    [selectPath],
  );

  const startAction = useCallback(
    (action: Exclude<PendingAction, null>, targetPath: string) => {
      const currentNodes = nodesRef.current;
      const targetNode = currentNodes[targetPath] ?? currentNodes[ROOT_PATH];
      const normalizedTargetPath = targetNode?.path ?? ROOT_PATH;
      if (action === "rename" && !normalizedTargetPath) return;
      selectPath(normalizedTargetPath);
      setPendingTargetPath(normalizedTargetPath);
      setPendingAction(action);
      setActionError(null);
      setDraftName(action === "rename" ? basename(normalizedTargetPath) : "");
    },
    [selectPath],
  );

  const finishAction = useCallback(async () => {
    if (!pendingAction || busyAction) return;
    const name = draftName.trim();
    if (!name) {
      setActionError(t("projectTools.fileTree.nameRequired"));
      return;
    }
    setBusyAction(true);
    setActionError(null);
    try {
      const currentNodes = nodesRef.current;
      const targetPath = pendingTargetPath ?? selectedPath;
      const targetNode = currentNodes[targetPath] ?? currentNodes[ROOT_PATH];
      const targetDir =
        targetNode?.kind === "dir" ? targetNode.path : dirname(targetNode?.path ?? targetPath);
      if (pendingAction === "file") {
        const nextPath = await createEntry("file", targetDir, name);
        setExpanded(addExpandedPaths(expandedRef.current, [targetDir]));
        selectPath(nextPath);
      } else if (pendingAction === "folder") {
        const nextPath = await createEntry("dir", targetDir, name);
        setExpanded(addExpandedPaths(expandedRef.current, [targetDir, nextPath]));
        selectPath(nextPath);
      } else if (pendingAction === "rename" && targetPath) {
        const nextPath = await renameEntry(targetPath, name);
        setExpanded(remapExpandedPathsForRename(expandedRef.current, targetPath, nextPath));
        selectPath(nextPath);
      }
      setPendingAction(null);
      setPendingTargetPath(null);
      setDraftName("");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(false);
    }
  }, [
    busyAction,
    createEntry,
    draftName,
    pendingAction,
    pendingTargetPath,
    renameEntry,
    selectPath,
    selectedPath,
    setExpanded,
    t,
  ]);

  const deletePath = useCallback(
    async (targetPath: string) => {
      if (!targetPath || busyAction) return;
      const confirmed = await requestConfirmDialog({
        title: t("projectTools.fileTree.deleteConfirm").replace("{path}", targetPath),
        subtitle: t("projectTools.fileTree.deleteConfirmDescription"),
        description: (
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-destructive/25 bg-destructive/10 text-destructive">
              <Trash2 className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">
                {basename(targetPath)}
              </div>
              <p className="mt-1.5 break-all text-xs leading-5 text-muted-foreground">
                {targetPath}
              </p>
            </div>
          </div>
        ),
        confirmLabel: t("projectTools.fileTree.delete"),
        cancelLabel: t("settings.cancel"),
        closeLabel: t("projectTools.fileTree.deleteConfirmClose"),
        tone: "destructive",
      });
      if (!confirmed) return;
      setBusyAction(true);
      setActionError(null);
      try {
        await deleteEntry(targetPath);
        setExpanded(removeExpandedSubtree(expandedRef.current, targetPath));
        selectPath(dirname(targetPath));
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyAction(false);
      }
    },
    [busyAction, deleteEntry, requestConfirmDialog, selectPath, setExpanded, t],
  );

  const handleOpenExternal = useCallback(
    (path: string) => {
      setActionError(null);
      void openWorkspacePath(path, "open").catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
    },
    [openWorkspacePath],
  );

  const handleOpenContainingDirectory = useCallback(
    (path: string) => {
      setActionError(null);
      void openWorkspacePath(path, "reveal").catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
    },
    [openWorkspacePath],
  );

  const handleMenuRefresh = useCallback(
    (path: string, kind: FileTreeKind) => {
      void loadChildren(kind === "dir" ? path : dirname(path), { force: true });
    },
    [loadChildren],
  );

  const actionPlaceholder = useMemo(() => {
    if (pendingAction === "file") return t("projectTools.fileTree.newFilePlaceholder");
    if (pendingAction === "folder") return t("projectTools.fileTree.newFolderPlaceholder");
    if (pendingAction === "rename") return t("projectTools.fileTree.renamePlaceholder");
    return "";
  }, [pendingAction, t]);

  if (!initialized) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted/80">
          <FolderOpen className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-1">
          <div className="text-sm font-medium text-foreground">{t("projectTools.newFileTree")}</div>
          <div className="text-xs text-muted-foreground">
            {t("projectTools.fileTreeDescription")}
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => {
            fileTree.onInitializedChange(true);
            void loadChildren(ROOT_PATH, { force: true });
          }}
        >
          {t("projectTools.newFileTree")}
        </Button>
      </div>
    );
  }

  const contextNode = contextMenu ? (nodes[contextMenu.path] ?? nodes[ROOT_PATH]) : null;

  return (
    <div ref={panelRef} className="relative flex h-full min-h-0 select-none flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("projectTools.fileTree.searchPlaceholder")}
            className="h-8 pl-7 text-[calc(11px*var(--zone-font-scale,1))] placeholder:text-[calc(11px*var(--zone-font-scale,1))]"
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg"
          title={t("projectTools.fileTree.refresh")}
          onClick={() => refreshVisible()}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {pendingAction ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
          <Input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void finishAction();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setPendingAction(null);
                setPendingTargetPath(null);
                setActionError(null);
              }
            }}
            placeholder={actionPlaceholder}
            className="h-8 text-[calc(11px*var(--zone-font-scale,1))] placeholder:text-[calc(11px*var(--zone-font-scale,1))]"
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded-lg"
            disabled={busyAction}
            onClick={() => void finishAction()}
          >
            {busyAction ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded-lg"
            onClick={() => {
              setPendingAction(null);
              setPendingTargetPath(null);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {actionError}
        </div>
      ) : null}

      {query.trim() ? (
        <div className="project-file-tree-panel-scroll max-h-40 shrink-0 overflow-auto border-b border-border/60 px-2 py-2">
          {search.loading ? (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("projectTools.fileTree.searching")}
            </div>
          ) : search.error ? (
            <div className="px-2 py-1 text-xs text-destructive">{search.error}</div>
          ) : search.results.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {t("projectTools.fileTree.noMatches")}
            </div>
          ) : (
            search.results.map((entry) => {
              const TypeIcon = getFileTypeIcon(entry.path, entry.kind);
              return (
                <button
                  key={`${entry.kind}:${entry.path}`}
                  type="button"
                  className={cn(
                    "flex w-full select-none items-center gap-1.5 rounded-md px-2 text-left text-xs leading-5 text-muted-foreground hover:bg-muted hover:text-foreground",
                    entry.hidden && "opacity-60 hover:opacity-80",
                  )}
                  style={{ minHeight: FILE_TREE_ROW_HEIGHT }}
                  title={entry.path}
                  onClick={() => void revealPath(entry.path, entry.kind)}
                >
                  <TypeIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{entry.path}</span>
                </button>
              );
            })
          )}
          {search.truncated ? (
            <div className="px-2 pt-1 text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
              {t("projectTools.fileTree.resultsTruncated")}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        role="tree"
        ref={scrollRef}
        className="project-file-tree-panel-scroll min-h-0 flex-1 select-none overflow-auto px-2 py-2"
        onContextMenu={(event) => openContextMenu(event, selectedPath || ROOT_PATH)}
      >
        <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            if (row.type === "error") {
              return (
                <div
                  key={row.key}
                  ref={rowVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <FileTreeErrorRow depth={row.depth} message={row.message} />
                </div>
              );
            }
            const node = nodes[row.path];
            if (!node) return null;
            return (
              <div
                key={row.key}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <FileTreeRow
                  path={node.path}
                  name={node.name}
                  kind={node.kind}
                  hidden={node.hidden}
                  depth={row.depth}
                  expanded={expandedSet.has(row.path)}
                  selected={selectedPath === row.path}
                  loading={node.loading}
                  title={row.path || cwd}
                  onToggle={toggleDirectory}
                  onSelect={selectPath}
                  onOpen={handleOpenFile}
                  onContextMenu={openContextMenu}
                />
              </div>
            );
          })}
        </div>
      </div>

      {contextMenu && contextNode ? (
        <FileTreeContextMenu
          key={`${contextMenu.path}:${contextMenu.x}:${contextMenu.y}`}
          anchor={{ x: contextMenu.x, y: contextMenu.y }}
          containerRef={panelRef}
          path={contextNode.path}
          kind={contextNode.kind}
          canMutate={canMutate}
          canOpenFile={Boolean(fileTree.onOpenFile)}
          canInsertMention={Boolean(fileTree.onInsertFileMention)}
          showHidden={syncState.showHidden}
          onClose={() => setContextMenu(null)}
          onOpenFile={handleOpenFile}
          onOpenExternal={handleOpenExternal}
          onOpenContainingDirectory={handleOpenContainingDirectory}
          onStartAction={startAction}
          onDelete={(path) => void deletePath(path)}
          onInsertMention={handleInsertMention}
          onRefresh={handleMenuRefresh}
          onToggleHidden={() => emitState({ showHidden: !syncState.showHidden })}
          onActionError={setActionError}
        />
      ) : null}

      {confirmDialog}
    </div>
  );
}
