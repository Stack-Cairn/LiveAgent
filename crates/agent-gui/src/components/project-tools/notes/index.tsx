// Right-dock notes list: directory tree over ~/.liveagent/notes plus an
// inline markdown editor for quick global notes.
//
// MIRROR NOTICE: keep byte-identical with crates/agent-gateway/web/src.

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
import { defaultNewNoteName, ensureNotesRoot, isNotesEditablePath } from "../../../lib/notes/root";
import { cn } from "../../../lib/shared/utils";
import { BookOpen, Check, FilePlus, FolderPlus, Loader2, RefreshCw, Trash2, X } from "../../icons";
import { Button } from "../../ui/button";
import { useConfirmDialog } from "../../ui/confirm-dialog";
import { Input } from "../../ui/input";
import {
  addExpandedPaths,
  basename,
  dirname,
  FILE_TREE_ROW_HEIGHT,
  type FileTreeKind,
  flattenFileTreeRows,
  ROOT_PATH,
  removeExpandedPath,
  removeExpandedSubtree,
} from "../file-tree/model";
import { FileTreeErrorRow, FileTreeRow } from "../file-tree/Row";
import { useFileTreeData } from "../file-tree/useFileTreeData";
import { useRightDockToolContext } from "../RightDockContext";
import { NotesEditor } from "./NotesEditor";

const NOTES_BUCKET_KEY = "notes:global";
const MIN_TREE_RATIO = 0.22;
const MAX_TREE_RATIO = 0.72;
const DEFAULT_TREE_RATIO = 0.38;

type PendingAction = "file" | "folder" | "rename" | null;

export function NotesPanel(props: { active: boolean }) {
  const { active } = props;
  const context = useRightDockToolContext();
  const { theme } = context;
  const { t } = useLocale();
  const { confirm: requestConfirmDialog, dialog: confirmDialog } = useConfirmDialog();

  const [notesRoot, setNotesRoot] = useState("");
  const [rootError, setRootError] = useState<string | null>(null);
  const [rootLoading, setRootLoading] = useState(true);
  const [expandedPaths, setExpandedPaths] = useState<string[]>([ROOT_PATH]);
  const [selectedPath, setSelectedPath] = useState(ROOT_PATH);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [treeRatio, setTreeRatio] = useState(DEFAULT_TREE_RATIO);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [pendingTargetPath, setPendingTargetPath] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const expandedRef = useRef(expandedPaths);
  expandedRef.current = expandedPaths;

  useEffect(() => {
    let cancelled = false;
    setRootLoading(true);
    setRootError(null);
    void ensureNotesRoot()
      .then((root) => {
        if (cancelled) return;
        setNotesRoot(root);
        setRootLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRootError(error instanceof Error ? error.message : String(error));
        setRootLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { nodes, loadChildren, refreshVisible, createEntry, renameEntry, deleteEntry } =
    useFileTreeData({
      projectPathKey: NOTES_BUCKET_KEY,
      cwd: notesRoot,
      active: active && Boolean(notesRoot),
      initialized: Boolean(notesRoot),
      workspaceActivityClient: null,
      expandedPaths,
      query: "",
      showHidden: false,
    });

  const expandedSet = useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const rows = useMemo(() => flattenFileTreeRows(nodes, expandedSet), [expandedSet, nodes]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => treeScrollRef.current,
    estimateSize: () => FILE_TREE_ROW_HEIGHT,
    overscan: 12,
  });

  const selectedNode = nodes[selectedPath] ?? nodes[ROOT_PATH];
  const selectedKind: FileTreeKind = selectedNode?.kind ?? "dir";
  const targetDir = selectedKind === "dir" ? selectedPath || ROOT_PATH : dirname(selectedPath);

  const toggleDirectory = useCallback(
    (path: string, isExpanded: boolean) => {
      if (isExpanded) {
        const next = removeExpandedPath(expandedRef.current, path);
        expandedRef.current = next;
        setExpandedPaths(next);
      } else {
        const next = addExpandedPaths(expandedRef.current, [path]);
        expandedRef.current = next;
        setExpandedPaths(next);
        void loadChildren(path);
      }
    },
    [loadChildren],
  );

  const selectPath = useCallback(
    (path: string) => {
      setSelectedPath(path);
      const node = nodes[path];
      if (node?.kind === "file" && isNotesEditablePath(path)) {
        setOpenPath(path);
        setActionError(null);
      }
    },
    [nodes],
  );

  const openNote = useCallback(
    (path: string) => {
      if (!isNotesEditablePath(path)) {
        setActionError(t("projectTools.notes.unsupportedFile"));
        return;
      }
      setSelectedPath(path);
      setOpenPath(path);
      setActionError(null);
    },
    [t],
  );

  const startAction = useCallback(
    (action: Exclude<PendingAction, null>, targetPath = targetDir) => {
      setPendingAction(action);
      setPendingTargetPath(targetPath);
      setDraftName(
        action === "file" ? defaultNewNoteName() : action === "rename" ? basename(targetPath) : "",
      );
      setActionError(null);
    },
    [targetDir],
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
      if (pendingAction === "file" || pendingAction === "folder") {
        const dir = pendingTargetPath ?? ROOT_PATH;
        const created = await createEntry(
          pendingAction === "file" ? "file" : "dir",
          dir,
          pendingAction === "file" && !isNotesEditablePath(name) ? `${name}.md` : name,
        );
        const parentExpanded = addExpandedPaths(expandedRef.current, [dir]);
        expandedRef.current = parentExpanded;
        setExpandedPaths(parentExpanded);
        setSelectedPath(created);
        if (pendingAction === "file") {
          setOpenPath(created);
        }
      } else if (pendingAction === "rename" && pendingTargetPath) {
        const nextPath = await renameEntry(pendingTargetPath, name);
        if (openPath === pendingTargetPath) setOpenPath(nextPath);
        setSelectedPath(nextPath);
        if (selectedKind === "dir") {
          const remapped = expandedRef.current.map((path) =>
            path === pendingTargetPath || path.startsWith(`${pendingTargetPath}/`)
              ? `${nextPath}${path.slice(pendingTargetPath.length)}`
              : path,
          );
          expandedRef.current = remapped;
          setExpandedPaths(remapped);
        }
      }
      setPendingAction(null);
      setPendingTargetPath(null);
      setDraftName("");
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(false);
    }
  }, [
    busyAction,
    createEntry,
    draftName,
    openPath,
    pendingAction,
    pendingTargetPath,
    renameEntry,
    selectedKind,
    t,
  ]);

  const deletePath = useCallback(
    async (path: string) => {
      if (!path) return;
      const confirmed = await requestConfirmDialog({
        title: t("projectTools.fileTree.deleteConfirm").replace("{path}", path),
        description: t("projectTools.fileTree.deleteConfirmDescription"),
        confirmLabel: t("projectTools.fileTree.delete"),
        cancelLabel: t("projectTools.close"),
        closeLabel: t("projectTools.fileTree.deleteConfirmClose"),
        tone: "destructive",
      });
      if (!confirmed) return;
      try {
        await deleteEntry(path);
        if (openPath === path || openPath?.startsWith(`${path}/`)) {
          setOpenPath(null);
        }
        if (selectedPath === path || selectedPath.startsWith(`${path}/`)) {
          setSelectedPath(ROOT_PATH);
        }
        const nextExpanded = removeExpandedSubtree(expandedRef.current, path);
        expandedRef.current = nextExpanded;
        setExpandedPaths(nextExpanded);
      } catch (error: unknown) {
        setActionError(error instanceof Error ? error.message : String(error));
      }
    },
    [deleteEntry, openPath, requestConfirmDialog, selectedPath, t],
  );

  const beginTreeResize = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      const panel = panelRef.current;
      if (!panel) return;
      const startY = event.clientY;
      const startRatio = treeRatio;
      const onMove = (moveEvent: MouseEvent) => {
        const height = panel.getBoundingClientRect().height;
        if (height <= 0) return;
        const delta = (moveEvent.clientY - startY) / height;
        const next = Math.min(MAX_TREE_RATIO, Math.max(MIN_TREE_RATIO, startRatio + delta));
        setTreeRatio(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [treeRatio],
  );

  if (rootLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("projectTools.notes.preparing")}
      </div>
    );
  }

  if (rootError || !notesRoot) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
        <BookOpen className="h-6 w-6 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">{t("projectTools.notesTitle")}</div>
        <div className="text-xs text-destructive">
          {rootError || t("projectTools.notes.rootFailed")}
        </div>
        <Button
          size="sm"
          onClick={() => {
            setRootLoading(true);
            setRootError(null);
            void ensureNotesRoot()
              .then((root) => {
                setNotesRoot(root);
                setRootLoading(false);
              })
              .catch((error: unknown) => {
                setRootError(error instanceof Error ? error.message : String(error));
                setRootLoading(false);
              });
          }}
        >
          {t("projectTools.notes.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div ref={panelRef} className="flex h-full min-h-0 select-none flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <div className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-foreground">
          {t("projectTools.notesTitle")}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-md"
          title={t("projectTools.notes.newNote")}
          onClick={() => startAction("file", targetDir)}
        >
          <FilePlus className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-md"
          title={t("projectTools.fileTree.newFolder")}
          onClick={() => startAction("folder", targetDir)}
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-md"
          title={t("projectTools.fileTree.refresh")}
          onClick={() => refreshVisible({ silent: false })}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-md"
          title={t("projectTools.fileTree.delete")}
          disabled={!selectedPath}
          onClick={() => void deletePath(selectedPath)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {pendingAction ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1.5">
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
            placeholder={
              pendingAction === "file"
                ? t("projectTools.notes.newNotePlaceholder")
                : pendingAction === "folder"
                  ? t("projectTools.fileTree.newFolderPlaceholder")
                  : t("projectTools.fileTree.renamePlaceholder")
            }
            className="h-7 text-[calc(11px*var(--zone-font-scale,1))]"
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 rounded-md"
            disabled={busyAction}
            onClick={() => void finishAction()}
          >
            {busyAction ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 rounded-md"
            onClick={() => {
              setPendingAction(null);
              setPendingTargetPath(null);
            }}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          {actionError}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 overflow-hidden" style={{ flex: `0 0 ${treeRatio * 100}%` }}>
          <div
            role="tree"
            ref={treeScrollRef}
            className="project-file-tree-panel-scroll h-full min-h-0 select-none overflow-auto px-1.5 py-1.5"
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
                      title={row.path || notesRoot}
                      onToggle={toggleDirectory}
                      onSelect={selectPath}
                      onOpen={openNote}
                      onContextMenu={(event: ReactMouseEvent, path: string) => {
                        event.preventDefault();
                        setSelectedPath(path);
                        const nodeAtPath = nodes[path];
                        if (nodeAtPath?.kind === "file") {
                          startAction("rename", path);
                        }
                      }}
                    />
                  </div>
                );
              })}
            </div>
            {rows.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t("projectTools.notes.empty")}
              </div>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          aria-label={t("projectTools.notes.resizeTree")}
          title={t("projectTools.notes.resizeTree")}
          className="group relative z-10 flex h-2 shrink-0 cursor-row-resize items-center justify-center border-0 bg-transparent p-0"
          onMouseDown={beginTreeResize}
        >
          <span
            aria-hidden="true"
            className={cn(
              "h-0.5 w-10 rounded-full bg-muted-foreground/25 transition-[width,background-color]",
              "group-hover:w-16 group-hover:bg-primary/60",
            )}
          />
        </button>

        <div className="flex min-h-0 flex-1 flex-col border-t border-border/70">
          {openPath ? (
            <NotesEditor active={active} notesRoot={notesRoot} path={openPath} theme={theme} />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <BookOpen className="h-5 w-5 text-muted-foreground" />
              <div className="text-xs text-muted-foreground">
                {t("projectTools.notes.pickNote")}
              </div>
              <Button size="sm" variant="outline" onClick={() => startAction("file", ROOT_PATH)}>
                {t("projectTools.notes.newNote")}
              </Button>
            </div>
          )}
        </div>
      </div>

      {confirmDialog}
    </div>
  );
}
