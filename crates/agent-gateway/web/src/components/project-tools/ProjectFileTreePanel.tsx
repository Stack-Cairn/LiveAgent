import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "@/i18n";
import type {
  RightDockFileTreeState,
  RightDockFileTreeStatePatch,
} from "@/lib/settings";
import { cn } from "@/lib/shared/utils";
import { getFileTypeIcon } from "../chat/fileTypeIcons";
import { isWorkspacePreviewPath } from "../workspace-editor/workspaceImagePreview";
import {
  Check,
  ChevronRight,
  Copy,
  Edit3,
  Eye,
  FilePenLine,
  Folder,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "../icons";
import { Button } from "../ui/button";
import { useConfirmDialog } from "../ui/confirm-dialog";
import { Input } from "../ui/input";

type FileTreeKind = "file" | "dir";

type FsListResponse = {
  path?: string | null;
  entries: Array<{ path: string; kind: FileTreeKind }>;
  hasMore?: boolean;
};

type MentionListResponse = {
  entries: Array<{ path: string; kind: FileTreeKind }>;
  truncated: boolean;
};

type FileTreeNode = {
  path: string;
  name: string;
  kind: FileTreeKind;
  children: string[];
  loaded: boolean;
  loading: boolean;
  error?: string;
};

type FileTreeState = {
  initialized: boolean;
  nodes: Record<string, FileTreeNode>;
  expanded: string[];
  selectedPath: string;
};

type PendingAction = "file" | "folder" | "rename" | null;

type ContextMenuState = {
  x: number;
  y: number;
  path: string;
};

const ROOT_PATH = "";
const DEFAULT_MAX_RESULTS = 1000;
const SEARCH_MAX_RESULTS = 80;
const FILE_TREE_AUTO_REFRESH_MS = 3000;

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return "";
  return normalized.split("/").pop() || normalized;
}

function dirname(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function joinPath(parent: string, name: string) {
  const cleanName = name.trim().replace(/^\/+|\/+$/g, "");
  return parent ? `${parent}/${cleanName}` : cleanName;
}

function rootName(cwd: string) {
  return basename(cwd) || cwd.trim() || "Project";
}

function createRootNode(cwd: string): FileTreeNode {
  return {
    path: ROOT_PATH,
    name: rootName(cwd),
    kind: "dir",
    children: [],
    loaded: false,
    loading: false,
  };
}

function createInitialState(cwd: string): FileTreeState {
  return {
    initialized: false,
    nodes: {
      [ROOT_PATH]: createRootNode(cwd),
    },
    expanded: [ROOT_PATH],
    selectedPath: ROOT_PATH,
  };
}

function sortEntries(entries: Array<{ path: string; kind: FileTreeKind }>) {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
    const leftName = basename(left.path).toLowerCase();
    const rightName = basename(right.path).toLowerCase();
    if (leftName === rightName) return left.path.localeCompare(right.path);
    return leftName.localeCompare(rightName);
  });
}

function removeNodeSubtree(nodes: Record<string, FileTreeNode>, path: string) {
  const next = { ...nodes };
  for (const key of Object.keys(next)) {
    if (key === path || key.startsWith(`${path}/`)) {
      delete next[key];
    }
  }
  return next;
}

function sameStringArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function toErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error ?? "").trim();
  return text || fallback;
}

export function ProjectFileTreePanel(props: {
  projectPathKey: string;
  cwd: string;
  initialized: boolean;
  syncState: RightDockFileTreeState;
  onInitializedChange: (initialized: boolean) => void;
  onSyncStateChange: (patch: RightDockFileTreeStatePatch) => void;
  onInsertFileMention?: (path: string, kind: FileTreeKind) => void;
  onOpenFile?: (path: string) => void;
}) {
  const {
    projectPathKey,
    cwd,
    initialized,
    syncState,
    onInitializedChange,
    onSyncStateChange,
    onInsertFileMention,
    onOpenFile,
  } = props;
  const { t } = useLocale();
  const [states, setStates] = useState<Record<string, FileTreeState>>({});
  const [query, setQuery] = useState(syncState.query);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<MentionListResponse["entries"]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchRefreshKey, setSearchRefreshKey] = useState(0);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [pendingTargetPath, setPendingTargetPath] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [copiedPath, setCopiedPath] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onSyncStateChangeRef = useRef(onSyncStateChange);
  const lastRevisionRef = useRef(syncState.revision);
  const { confirm: requestConfirmDialog, dialog: confirmDialog } = useConfirmDialog();

  const state = states[projectPathKey] ?? createInitialState(cwd);
  const selectedNode = state.nodes[state.selectedPath] ?? state.nodes[ROOT_PATH];
  const selectedPath = selectedNode?.path ?? ROOT_PATH;
  const canMutate = initialized && Boolean(projectPathKey && cwd);
  const stateRef = useRef(state);
  const queryRef = useRef(query);

  useEffect(() => {
    onSyncStateChangeRef.current = onSyncStateChange;
  }, [onSyncStateChange]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const setProjectState = useCallback(
    (updater: (state: FileTreeState) => FileTreeState) => {
      if (!projectPathKey) return;
      setStates((prev) => {
        const current = prev[projectPathKey] ?? createInitialState(cwd);
        return {
          ...prev,
          [projectPathKey]: updater(current),
        };
      });
    },
    [cwd, projectPathKey],
  );

  const syncFileTreeState = useCallback((patch: RightDockFileTreeStatePatch) => {
    onSyncStateChangeRef.current(patch);
  }, []);

  const loadChildren = useCallback(
    async (path: string, options?: { force?: boolean; silent?: boolean }) => {
      if (!projectPathKey || !cwd.trim()) return;
      let shouldLoad = true;
      setProjectState((current) => {
        const node = current.nodes[path] ?? (path === ROOT_PATH ? createRootNode(cwd) : null);
        if (!node || node.kind !== "dir") {
          shouldLoad = false;
          return current;
        }
        if (node.loading && options?.silent) {
          shouldLoad = false;
          return current;
        }
        if ((node.loaded || node.loading) && !options?.force) {
          shouldLoad = false;
          return current;
        }
        return {
          ...current,
          initialized: true,
          nodes: {
            ...current.nodes,
            [path]: {
              ...node,
              loading: options?.silent ? node.loading : true,
              error: options?.silent ? node.error : undefined,
            },
          },
        };
      });
      if (!shouldLoad) return;

      try {
        const response = await invoke<FsListResponse>("fs_list", {
          workdir: cwd,
          path: path || undefined,
          depth: 1,
          offset: 0,
          max_results: DEFAULT_MAX_RESULTS,
        });
        const entries = sortEntries(Array.isArray(response.entries) ? response.entries : []);
        setProjectState((current) => {
          const nodes = { ...current.nodes };
          const parent = nodes[path] ?? createRootNode(cwd);
          const childPaths = entries.map((entry) => entry.path).filter(Boolean);
          nodes[path] = {
            ...parent,
            children: childPaths,
            loaded: true,
            loading: false,
            error: response.hasMore ? t("projectTools.fileTree.tooManyItems") : undefined,
          };
          for (const entry of entries) {
            if (!entry.path) continue;
            const existing = nodes[entry.path];
            nodes[entry.path] = {
              path: entry.path,
              name: basename(entry.path) || entry.path,
              kind: entry.kind,
              children: existing?.children ?? [],
              loaded: existing?.loaded ?? false,
              loading: false,
              error: existing?.error,
            };
          }
          return {
            ...current,
            initialized: true,
            nodes,
          };
        });
      } catch (error) {
        setProjectState((current) => {
          const node = current.nodes[path] ?? createRootNode(cwd);
          return {
            ...current,
            nodes: {
              ...current.nodes,
              [path]: {
                ...node,
                loading: false,
                error: options?.silent
                  ? node.error
                  : toErrorMessage(error, t("projectTools.fileTree.readFailed")),
              },
            },
          };
        });
      }
    },
    [cwd, projectPathKey, setProjectState, t],
  );

  useEffect(() => {
    setQuery((current) => (current === syncState.query ? current : syncState.query));
  }, [syncState.query]);

  useEffect(() => {
    if (!initialized || !projectPathKey || query === syncState.query) return;
    const timer = window.setTimeout(() => {
      syncFileTreeState({ query, bumpStateVersion: true });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [initialized, projectPathKey, query, syncFileTreeState, syncState.query]);

  useEffect(() => {
    if (!projectPathKey) return;
    setProjectState((current) => {
      const nextExpanded = syncState.expandedPaths;
      const nextSelectedPath = syncState.selectedPath;
      if (
        current.selectedPath === nextSelectedPath &&
        sameStringArray(current.expanded, nextExpanded)
      ) {
        return current;
      }
      return {
        ...current,
        selectedPath: nextSelectedPath,
        expanded: nextExpanded,
      };
    });
  }, [projectPathKey, setProjectState, syncState.expandedPaths, syncState.selectedPath]);

  useEffect(() => {
    if (!initialized || !projectPathKey) return;
    for (const path of state.expanded) {
      void loadChildren(path);
    }
  }, [initialized, loadChildren, projectPathKey, state.expanded]);

  useEffect(() => {
    const previousRevision = lastRevisionRef.current;
    lastRevisionRef.current = syncState.revision;
    if (!initialized || !projectPathKey || previousRevision === syncState.revision) return;
    const pathsToReload = Array.from(new Set([ROOT_PATH, ...state.expanded]));
    for (const path of pathsToReload) {
      void loadChildren(path, { force: true });
    }
    setSearchRefreshKey((current) => current + 1);
  }, [initialized, loadChildren, projectPathKey, state.expanded, syncState.revision]);

  useEffect(() => {
    if (!initialized || !projectPathKey) return;
    void loadChildren(ROOT_PATH);
  }, [initialized, loadChildren, projectPathKey]);

  useEffect(() => {
    if (!initialized || !projectPathKey || !cwd.trim()) return;
    const interval = window.setInterval(() => {
      const snapshot = stateRef.current;
      const pathsToReload = Array.from(new Set([ROOT_PATH, ...snapshot.expanded])).filter(
        (path) => {
          const node = snapshot.nodes[path];
          return node?.kind === "dir" && node.loaded;
        },
      );
      for (const path of pathsToReload) {
        void loadChildren(path, { force: true, silent: true });
      }
      if (queryRef.current.trim()) {
        setSearchRefreshKey((current) => current + 1);
      }
    }, FILE_TREE_AUTO_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [cwd, initialized, loadChildren, projectPathKey]);

  useEffect(() => {
    void projectPathKey;
    setContextMenu(null);
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

  useEffect(() => {
    void searchRefreshKey;
    if (!query.trim() || !cwd.trim() || !initialized) {
      setSearchResults([]);
      setSearchError(null);
      setSearchLoading(false);
      setSearchTruncated(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      setSearchError(null);
      void invoke<MentionListResponse>("fs_mention_list", {
        workdir: cwd,
        query,
        max_results: SEARCH_MAX_RESULTS,
      })
        .then((response) => {
          if (cancelled) return;
          setSearchResults(Array.isArray(response.entries) ? response.entries : []);
          setSearchTruncated(Boolean(response.truncated));
        })
        .catch((error) => {
          if (cancelled) return;
          setSearchResults([]);
          setSearchError(toErrorMessage(error, t("projectTools.fileTree.searchFailed")));
        })
        .finally(() => {
          if (!cancelled) setSearchLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cwd, initialized, query, searchRefreshKey, t]);

  const revealPath = useCallback(
    async (path: string, kind: FileTreeKind) => {
      const parts = path.split("/").filter(Boolean);
      const dirs = kind === "dir" ? parts : parts.slice(0, -1);
      let current = ROOT_PATH;
      await loadChildren(ROOT_PATH);
      for (const part of dirs) {
        current = joinPath(current, part);
        await loadChildren(current);
      }
      const nextExpanded = Array.from(
        new Set([
          ...state.expanded,
          ROOT_PATH,
          ...dirs.map((_, index) => parts.slice(0, index + 1).join("/")),
        ]),
      );
      setProjectState((state) => ({
        ...state,
        selectedPath: path,
        expanded: nextExpanded,
      }));
      syncFileTreeState({
        selectedPath: path,
        expandedPaths: nextExpanded,
        bumpStateVersion: true,
      });
    },
    [loadChildren, setProjectState, state.expanded, syncFileTreeState],
  );

  const toggleDirectory = useCallback(
    (path: string, expanded: boolean) => {
      if (expanded) {
        const nextExpanded = state.expanded.filter((item) => item !== path);
        setProjectState((state) => ({
          ...state,
          expanded: nextExpanded,
        }));
        syncFileTreeState({ expandedPaths: nextExpanded, bumpStateVersion: true });
      } else {
        const nextExpanded = Array.from(new Set([...state.expanded, path]));
        setProjectState((state) => ({
          ...state,
          expanded: state.expanded.includes(path) ? state.expanded : [...state.expanded, path],
        }));
        void loadChildren(path);
        syncFileTreeState({ expandedPaths: nextExpanded, bumpStateVersion: true });
      }
    },
    [loadChildren, setProjectState, state.expanded, syncFileTreeState],
  );

  const openContextMenu = useCallback(
    (event: React.MouseEvent, path: string) => {
      event.preventDefault();
      event.stopPropagation();
      window.getSelection()?.removeAllRanges();
      const targetPath = state.nodes[path] ? path : ROOT_PATH;
      const targetKind = state.nodes[targetPath]?.kind ?? "dir";
      setProjectState((state) => ({ ...state, selectedPath: targetPath }));
      syncFileTreeState({ selectedPath: targetPath, bumpStateVersion: true });
      const rect = panelRef.current?.getBoundingClientRect();
      const menuWidth = 220;
      const menuHeight = targetKind === "file" ? 292 : 260;
      const panelLeft = rect?.left ?? 0;
      const panelTop = rect?.top ?? 0;
      const panelWidth = rect?.width ?? window.innerWidth;
      const panelHeight = rect?.height ?? window.innerHeight;
      const maxX = Math.max(8, panelWidth - menuWidth - 8);
      const maxY = Math.max(8, panelHeight - menuHeight - 8);
      const x = Math.max(8, Math.min(event.clientX - panelLeft, maxX));
      const y = Math.max(8, Math.min(event.clientY - panelTop, maxY));
      setContextMenu({ x, y, path: targetPath });
    },
    [setProjectState, state.nodes, syncFileTreeState],
  );

  const startAction = useCallback(
    (action: Exclude<PendingAction, null>, targetPath = selectedPath) => {
      const targetNode = state.nodes[targetPath] ?? state.nodes[ROOT_PATH];
      const normalizedTargetPath = targetNode?.path ?? ROOT_PATH;
      if (action === "rename" && !normalizedTargetPath) return;
      setProjectState((state) => ({ ...state, selectedPath: normalizedTargetPath }));
      syncFileTreeState({ selectedPath: normalizedTargetPath, bumpStateVersion: true });
      setPendingTargetPath(normalizedTargetPath);
      setPendingAction(action);
      setActionError(null);
      setDraftName(action === "rename" ? basename(normalizedTargetPath) : "");
    },
    [selectedPath, setProjectState, state.nodes, syncFileTreeState],
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
      const targetPath = pendingTargetPath ?? selectedPath;
      const targetNode = state.nodes[targetPath] ?? state.nodes[ROOT_PATH];
      const targetDir =
        targetNode?.kind === "dir" ? targetNode.path : dirname(targetNode?.path ?? targetPath);
      if (pendingAction === "file") {
        const nextPath = joinPath(targetDir, name);
        await invoke("fs_write_text", {
          workdir: cwd,
          path: nextPath,
          content: "",
          mode: "rewrite",
        });
        await loadChildren(targetDir, { force: true });
        setProjectState((state) => ({ ...state, selectedPath: nextPath }));
        syncFileTreeState({
          selectedPath: nextPath,
          expandedPaths: Array.from(new Set([...state.expanded, targetDir])),
          bumpRevision: true,
          bumpStateVersion: true,
        });
      } else if (pendingAction === "folder") {
        const nextPath = joinPath(targetDir, name);
        await invoke("fs_create_dir", {
          workdir: cwd,
          path: nextPath,
        });
        await loadChildren(targetDir, { force: true });
        await loadChildren(nextPath);
        const nextExpanded = Array.from(new Set([...state.expanded, targetDir, nextPath]));
        setProjectState((state) => ({
          ...state,
          selectedPath: nextPath,
          expanded: nextExpanded,
        }));
        syncFileTreeState({
          selectedPath: nextPath,
          expandedPaths: nextExpanded,
          bumpRevision: true,
          bumpStateVersion: true,
        });
      } else if (pendingAction === "rename" && targetPath) {
        const parent = dirname(targetPath);
        const nextPath = joinPath(parent, name);
        await invoke("fs_rename", {
          workdir: cwd,
          from_path: targetPath,
          to_path: nextPath,
        });
        await loadChildren(parent, { force: true });
        const nextExpanded = state.expanded
          .filter((item) => item !== targetPath && !item.startsWith(`${targetPath}/`))
          .map((item) =>
            item.startsWith(`${targetPath}/`) ? item.replace(targetPath, nextPath) : item,
          );
        setProjectState((state) => ({
          ...state,
          nodes: removeNodeSubtree(state.nodes, targetPath),
          selectedPath: nextPath,
          expanded: nextExpanded,
        }));
        syncFileTreeState({
          selectedPath: nextPath,
          expandedPaths: nextExpanded,
          bumpRevision: true,
          bumpStateVersion: true,
        });
      }
      setPendingAction(null);
      setPendingTargetPath(null);
      setDraftName("");
    } catch (error) {
      setActionError(toErrorMessage(error, t("projectTools.fileTree.actionFailed")));
    } finally {
      setBusyAction(false);
    }
  }, [
    busyAction,
    cwd,
    draftName,
    loadChildren,
    pendingAction,
    pendingTargetPath,
    selectedPath,
    setProjectState,
    state.expanded,
    state.nodes,
    syncFileTreeState,
    t,
  ]);

  const deletePath = useCallback(
    async (targetPath = selectedPath) => {
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
      const parent = dirname(targetPath);
      setBusyAction(true);
      setActionError(null);
      try {
        await invoke("fs_delete", { workdir: cwd, path: targetPath });
        const nextExpanded = state.expanded.filter(
          (item) => item !== targetPath && !item.startsWith(`${targetPath}/`),
        );
        setProjectState((state) => ({
          ...state,
          nodes: removeNodeSubtree(state.nodes, targetPath),
          selectedPath: parent,
          expanded: nextExpanded,
        }));
        await loadChildren(parent, { force: true });
        syncFileTreeState({
          selectedPath: parent,
          expandedPaths: nextExpanded,
          bumpRevision: true,
          bumpStateVersion: true,
        });
      } catch (error) {
        setActionError(toErrorMessage(error, t("projectTools.fileTree.deleteFailed")));
      } finally {
        setBusyAction(false);
      }
    },
    [
      busyAction,
      cwd,
      loadChildren,
      requestConfirmDialog,
      selectedPath,
      setProjectState,
      state.expanded,
      syncFileTreeState,
      t,
    ],
  );

  const copyPath = useCallback(
    (targetPath = selectedPath) => {
      if (!targetPath) return;
      void navigator.clipboard?.writeText(targetPath).then(() => {
        setCopiedPath(targetPath);
        window.setTimeout(() => setCopiedPath(""), 1200);
      });
    },
    [selectedPath],
  );

  const insertMention = useCallback(
    (targetPath = selectedPath) => {
      const targetNode = state.nodes[targetPath];
      if (!targetPath || !targetNode) return;
      onInsertFileMention?.(targetPath, targetNode.kind);
    },
    [onInsertFileMention, selectedPath, state.nodes],
  );

  const renderNode = useCallback(
    (path: string, depth: number): React.ReactNode => {
      const node = state.nodes[path];
      if (!node) return null;
      const expanded = state.expanded.includes(path);
      const selected = state.selectedPath === path;
      const TypeIcon = node.kind === "file" ? getFileTypeIcon(path, node.kind) : null;
      return (
        <div key={path || "__root__"}>
          <div
            role="treeitem"
            tabIndex={-1}
            className={cn(
              "group flex min-h-8 select-none items-center gap-1 rounded-md pr-2 text-xs leading-5 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
              selected && "bg-muted text-foreground",
            )}
            style={{ paddingLeft: 6 + depth * 14 }}
            onContextMenu={(event) => openContextMenu(event, path)}
          >
            {node.kind === "dir" ? (
              <button
                type="button"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-background"
                onClick={() => toggleDirectory(path, expanded)}
                title={
                  expanded ? t("projectTools.fileTree.collapse") : t("projectTools.fileTree.expand")
                }
              >
                {node.loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ChevronRight
                    className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")}
                  />
                )}
              </button>
            ) : (
              <span className="h-5 w-5 shrink-0" />
            )}
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 bg-transparent p-0 text-left text-inherit leading-5"
              title={path || cwd}
              onClick={() => {
                setProjectState((state) => ({ ...state, selectedPath: path }));
                syncFileTreeState({ selectedPath: path, bumpStateVersion: true });
              }}
              onDoubleClick={() => {
                if (node.kind === "dir") {
                  toggleDirectory(path, expanded);
                  return;
                }
                onOpenFile?.(path);
              }}
            >
              {node.kind === "dir" ? (
                expanded ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                )
              ) : TypeIcon ? (
                <TypeIcon className="h-3.5 w-3.5 shrink-0" />
              ) : null}
              <span className="min-w-0 truncate">{node.name}</span>
            </button>
          </div>
          {node.error ? (
            <div className="px-3 py-1 text-[11px] text-amber-600">{node.error}</div>
          ) : null}
          {node.kind === "dir" && expanded
            ? node.children.map((childPath) => renderNode(childPath, depth + 1))
            : null}
        </div>
      );
    },
    [
      cwd,
      onOpenFile,
      openContextMenu,
      setProjectState,
      state,
      syncFileTreeState,
      t,
      toggleDirectory,
    ],
  );

  const actionPlaceholder = useMemo(() => {
    if (pendingAction === "file") return t("projectTools.fileTree.newFilePlaceholder");
    if (pendingAction === "folder") return t("projectTools.fileTree.newFolderPlaceholder");
    if (pendingAction === "rename") return t("projectTools.fileTree.renamePlaceholder");
    return "";
  }, [pendingAction, t]);

  const contextNode = contextMenu
    ? (state.nodes[contextMenu.path] ?? state.nodes[ROOT_PATH])
    : null;
  const contextPath = contextNode?.path ?? ROOT_PATH;
  const contextKind = contextNode?.kind ?? "dir";
  const contextHasPathAction = Boolean(contextPath);

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
            onInitializedChange(true);
            void loadChildren(ROOT_PATH, { force: true });
          }}
        >
          {t("projectTools.newFileTree")}
        </Button>
      </div>
    );
  }

  return (
    <div ref={panelRef} className="relative flex h-full min-h-0 select-none flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("projectTools.fileTree.searchPlaceholder")}
            className="h-8 pl-7 text-xs"
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg"
          title={t("projectTools.fileTree.refresh")}
          onClick={() => {
            void loadChildren(ROOT_PATH, { force: true });
            syncFileTreeState({ bumpRevision: true });
          }}
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
            className="h-8 text-xs"
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
          {searchLoading ? (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("projectTools.fileTree.searching")}
            </div>
          ) : searchError ? (
            <div className="px-2 py-1 text-xs text-destructive">{searchError}</div>
          ) : searchResults.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {t("projectTools.fileTree.noMatches")}
            </div>
          ) : (
            searchResults.map((entry) => {
              const TypeIcon =
                entry.kind === "file" ? getFileTypeIcon(entry.path, entry.kind) : null;
              return (
                <button
                  key={`${entry.kind}:${entry.path}`}
                  type="button"
                  className="flex min-h-8 w-full select-none items-center gap-1.5 rounded-md px-2 text-left text-xs leading-5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={entry.path}
                  onClick={() => void revealPath(entry.path, entry.kind)}
                >
                  {entry.kind === "dir" ? (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                  ) : TypeIcon ? (
                    <TypeIcon className="h-3.5 w-3.5 shrink-0" />
                  ) : null}
                  <span className="min-w-0 truncate">{entry.path}</span>
                </button>
              );
            })
          )}
          {searchTruncated ? (
            <div className="px-2 pt-1 text-[11px] text-muted-foreground">
              {t("projectTools.fileTree.resultsTruncated")}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        role="tree"
        className="project-file-tree-panel-scroll min-h-0 flex-1 select-none overflow-auto px-2 py-2"
        onContextMenu={(event) => openContextMenu(event, selectedPath || ROOT_PATH)}
      >
        {renderNode(ROOT_PATH, 0)}
      </div>

      {contextMenu ? (
        <div
          role="menu"
          className="editor-context-menu absolute z-[80] min-w-52 select-none overflow-hidden rounded-xl border border-border/60 bg-popover/80 p-1 text-xs text-popover-foreground shadow-2xl ring-1 ring-black/[0.03] backdrop-blur-xl dark:ring-white/[0.06]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {contextKind === "file" ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45"
                disabled={!onOpenFile}
                onClick={() => {
                  onOpenFile?.(contextPath);
                  setContextMenu(null);
                }}
              >
                {isWorkspacePreviewPath(contextPath) ? (
                  <Eye className="h-3.5 w-3.5" />
                ) : (
                  <FilePenLine className="h-3.5 w-3.5" />
                )}
                {t(
                  isWorkspacePreviewPath(contextPath)
                    ? "projectTools.fileTree.previewFile"
                    : "projectTools.fileTree.openFile",
                )}
              </button>
              <div className="mx-1 my-1 h-px bg-border/60" />
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45"
            disabled={!canMutate}
            onClick={() => {
              startAction("file", contextPath);
              setContextMenu(null);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("projectTools.fileTree.newFile")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45"
            disabled={!canMutate}
            onClick={() => {
              startAction("folder", contextPath);
              setContextMenu(null);
            }}
          >
            <Folder className="h-3.5 w-3.5" />
            {t("projectTools.fileTree.newFolder")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45"
            disabled={!canMutate || !contextHasPathAction}
            onClick={() => {
              startAction("rename", contextPath);
              setContextMenu(null);
            }}
          >
            <Edit3 className="h-3.5 w-3.5" />
            {t("projectTools.fileTree.rename")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-45"
            disabled={!canMutate || !contextHasPathAction}
            onClick={() => {
              void deletePath(contextPath);
              setContextMenu(null);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("projectTools.fileTree.delete")}
          </button>
          <div className="mx-1 my-1 h-px bg-border/60" />
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45"
            disabled={!contextHasPathAction}
            onClick={() => {
              copyPath(contextPath);
              setContextMenu(null);
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {copiedPath === contextPath
              ? t("projectTools.fileTree.copiedPath")
              : t("projectTools.fileTree.copyPath")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45"
            disabled={!contextHasPathAction || !onInsertFileMention}
            onClick={() => {
              insertMention(contextPath);
              setContextMenu(null);
            }}
          >
            <span className="flex h-3.5 w-3.5 items-center justify-center text-[11px] font-semibold">
              @
            </span>
            {t("projectTools.fileTree.insertReference")}
          </button>
          <div className="mx-1 my-1 h-px bg-border/60" />
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45"
            disabled={!contextNode}
            onClick={() => {
              void loadChildren(contextKind === "dir" ? contextPath : dirname(contextPath), {
                force: true,
              });
              syncFileTreeState({ bumpRevision: true });
              setContextMenu(null);
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("projectTools.fileTree.refresh")}
          </button>
        </div>
      ) : null}

      {confirmDialog}
    </div>
  );
}
