import { invoke } from "@liveagent/app/shims/tauriCore";
import {
  AlertTriangle,
  File,
  FolderOpen,
  HardDrive,
  Home,
  Loader2,
  Plus,
  X,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  IndividualTreeViewState,
  TreeItem,
  TreeItemIndex,
  TreeViewState,
} from "react-complex-tree";
import { ControlledTreeEnvironment, Tree } from "react-complex-tree";
import type { RemoteFsRoot } from "./remotePathPickerPaths";
import {
  basenameFromPath,
  findBestRootForPath,
  findRouteChild,
  joinChildPath,
  normalizePathForCompare,
  stripTrailingPathSeparators,
} from "./remotePathPickerPaths";

// WebUI-only global component: browses paths on the paired desktop (GUI)
// device over the gateway. Directory mode reuses the fs_roots/fs_list_dirs
// commands; file mode lists files alongside directories via fs_list.
// Path helpers live in remotePathPickerPaths.ts: the desktop may be Windows,
// so they handle POSIX and Windows shapes regardless of browser platform.

export type RemotePathPickerMode = "directory" | "file";

type FsRoot = RemoteFsRoot;

type FsRootsResponse = {
  roots: FsRoot[];
};

type FsListDirsResponse = {
  path: string;
  entries: Array<{ path: string; name: string }>;
  truncated: boolean;
};

type FsListResponse = {
  hasMore: boolean;
  entries: Array<{ path: string; kind: string; hidden: boolean }>;
};

type ChildEntry = {
  path: string;
  name: string;
  kind: "dir" | "file";
};

type LoadedChildren = {
  entries: ChildEntry[];
  truncated: boolean;
};

type NodeData = {
  path: string;
  label: string;
  kind: "synthetic-root" | "home" | "root" | "drive" | "dir" | "file";
  loaded: boolean;
  truncated?: boolean;
};

const TREE_ID = "remote-path-picker";
const ROOT_ID = "__remote_path_picker_roots__";
const DEFAULT_MAX_RESULTS = 10000;

function createNodeItem(path: string, label: string, kind: NodeData["kind"]): TreeItem<NodeData> {
  const isFolder = kind !== "file";
  return {
    index: path,
    isFolder,
    children: [],
    data: {
      path,
      label,
      kind,
      // Files have no children to load.
      loaded: kind === "file",
    },
  };
}

function toErrorMessage(err: unknown, fallback: string) {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  const text = String(err ?? "").trim();
  return text || fallback;
}

function mergeTreeIndexes(current: TreeItemIndex[] | undefined, additions: TreeItemIndex[]) {
  return Array.from(new Set([...(current ?? []), ...additions]));
}

type RemotePathPickerModalProps = {
  mode: RemotePathPickerMode;
  initialPath?: string;
  title?: string;
  description?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
};

export function RemotePathPickerModal(props: RemotePathPickerModalProps) {
  const { mode, initialPath = "", title, description, onClose, onSelect } = props;
  const { t } = useLocale();

  const [items, setItems] = useState<Record<TreeItemIndex, TreeItem<NodeData>>>(() => ({
    [ROOT_ID]: {
      index: ROOT_ID,
      isFolder: true,
      children: [],
      data: {
        path: "",
        label: "Roots",
        kind: "synthetic-root",
        loaded: true,
      },
    },
  }));
  const [viewState, setViewState] = useState<TreeViewState>(() => ({
    [TREE_ID]: {
      expandedItems: [ROOT_ID],
      selectedItems: [],
      focusedItem: ROOT_ID,
    },
  }));
  const [loadingRoots, setLoadingRoots] = useState(true);
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [createFolderError, setCreateFolderError] = useState<string | null>(null);
  const didExpandInitialPathRef = useRef(false);
  // Base UI 控制 open：先置 false 播放退场过渡，onOpenChangeComplete 再通知
  // 调用方卸载（onSelect 已先行 resolve，onClose 的 resolve(null) 为 no-op）。
  const [open, setOpen] = useState(true);

  const modalTitle =
    title ?? (mode === "file" ? t("settings.filePickerTitle") : t("settings.workdirPickerTitle"));
  const modalDescription =
    description ?? (mode === "file" ? t("settings.filePickerDesc") : t("settings.workdirDesc"));

  const selectedItem = viewState[TREE_ID]?.selectedItems?.[0] ?? null;
  const focusedItem = viewState[TREE_ID]?.focusedItem ?? null;
  const selectedPath =
    typeof selectedItem === "string" && selectedItem !== ROOT_ID ? selectedItem : "";
  const focusedPath = typeof focusedItem === "string" && focusedItem !== ROOT_ID ? focusedItem : "";
  const activePath = (selectedPath || focusedPath).trim();

  const headerPath = (selectedPath || initialPath || "").trim();

  const activeMeta = activePath ? (items[activePath]?.data ?? null) : null;
  const activeChildren = activePath ? (items[activePath]?.children ?? null) : null;
  const createFolderName = newFolderName.trim();
  const activeIsDirectory = Boolean(activeMeta && activeMeta.kind !== "file");
  const canCreateFolder = Boolean(
    activePath && activeIsDirectory && createFolderName && !creatingFolder,
  );

  const selectedMeta = selectedPath ? (items[selectedPath]?.data ?? null) : null;
  const canConfirm =
    mode === "file"
      ? selectedMeta?.kind === "file"
      : Boolean(selectedPath && selectedMeta?.kind !== "file");

  const statusLine = useMemo(() => {
    if (loadError) {
      return {
        kind: "error" as const,
        text: `${t("settings.dirLoadFailed")}${loadError}`,
      };
    }
    if (loadingRoots || loadingPaths.size > 0) {
      return {
        kind: "loading" as const,
        text: t("settings.loadingDirs"),
      };
    }
    if (
      activeIsDirectory &&
      activeMeta?.loaded &&
      Array.isArray(activeChildren) &&
      activeChildren.length === 0
    ) {
      return {
        kind: "empty" as const,
        text: mode === "file" ? t("settings.emptyDir") : t("settings.noSubdirs"),
      };
    }
    if (activeMeta?.truncated) {
      return {
        kind: "warn" as const,
        text: t("settings.tooManyDirs"),
      };
    }
    return null;
  }, [
    activeChildren,
    activeIsDirectory,
    activeMeta?.loaded,
    activeMeta?.truncated,
    loadError,
    loadingPaths.size,
    loadingRoots,
    mode,
    t,
  ]);

  function updateTreeViewState(
    treeId: string,
    updater: (prev: IndividualTreeViewState) => IndividualTreeViewState,
  ) {
    setViewState((prev) => {
      const treePrev = prev[treeId] ?? {};
      return {
        ...prev,
        [treeId]: updater(treePrev),
      };
    });
  }

  useEffect(() => {
    let cancelled = false;

    async function loadRoots() {
      setLoadingRoots(true);
      setLoadError(null);
      try {
        const resp = await invoke<FsRootsResponse>("fs_roots");
        const roots = Array.isArray(resp.roots) ? resp.roots : [];
        const rootChildren = roots.map((root) => root.path).filter(Boolean);

        setRoots(roots);
        setItems((prev) => {
          const next: Record<TreeItemIndex, TreeItem<NodeData>> = { ...prev };
          next[ROOT_ID] = {
            ...next[ROOT_ID],
            isFolder: true,
            children: rootChildren,
          };

          for (const root of roots) {
            const kind: NodeData["kind"] =
              root.kind === "home" ? "home" : root.kind === "drive" ? "drive" : "root";
            next[root.path] = createNodeItem(root.path, root.label || root.path, kind);
          }
          return next;
        });

        updateTreeViewState(TREE_ID, (treePrev) => ({
          ...treePrev,
          expandedItems: treePrev.expandedItems?.includes(ROOT_ID)
            ? treePrev.expandedItems
            : [ROOT_ID],
          selectedItems: treePrev.selectedItems ?? [],
          focusedItem: treePrev.focusedItem ?? ROOT_ID,
        }));
      } catch (err) {
        if (cancelled) return;
        setLoadError(toErrorMessage(err, "Failed to load roots"));
      } finally {
        if (!cancelled) setLoadingRoots(false);
      }
    }

    void loadRoots();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (loadingRoots || didExpandInitialPathRef.current) return;

    const targetPath = stripTrailingPathSeparators(initialPath);
    if (!targetPath || roots.length === 0) return;

    const root = findBestRootForPath(targetPath, roots);
    if (!root) return;

    didExpandInitialPathRef.current = true;
    let cancelled = false;

    async function expandInitialPath() {
      const route: string[] = [root.path];
      let currentPath = root.path;
      let reachedTarget =
        normalizePathForCompare(currentPath) === normalizePathForCompare(targetPath);
      let targetIsFile = false;

      try {
        for (let depth = 0; depth < 128 && !reachedTarget; depth += 1) {
          const resp = await loadDirectoryChildren(currentPath);
          if (cancelled) return;

          const child = findRouteChild(targetPath, resp.entries);
          if (!child?.path) break;

          currentPath = child.path;
          targetIsFile = child.kind === "file";
          if (!targetIsFile) {
            route.push(currentPath);
          }
          reachedTarget =
            normalizePathForCompare(currentPath) === normalizePathForCompare(targetPath);
          if (targetIsFile) break;
        }

        if (reachedTarget && !targetIsFile) {
          try {
            await loadDirectoryChildren(currentPath);
          } catch {
            // Keep the selected directory visible even if its children cannot be read.
          }
        }
      } catch {
        // The shared error banner is updated by loadDirectoryChildren.
      }

      if (cancelled) return;

      const selectedPathForState = reachedTarget
        ? currentPath
        : (route[route.length - 1] ?? root.path);
      const expandedRoute = [ROOT_ID, ...route];

      updateTreeViewState(TREE_ID, (treePrev) => ({
        ...treePrev,
        expandedItems: mergeTreeIndexes(treePrev.expandedItems, expandedRoute),
        selectedItems: [selectedPathForState],
        focusedItem: selectedPathForState,
      }));
    }

    void expandInitialPath();
    return () => {
      cancelled = true;
    };
  }, [initialPath, loadingRoots, roots]);

  async function fetchChildren(path: string): Promise<LoadedChildren> {
    if (mode === "directory") {
      const resp = await invoke<FsListDirsResponse>("fs_list_dirs", {
        path,
        max_results: DEFAULT_MAX_RESULTS,
      } as never);
      const entries = (Array.isArray(resp.entries) ? resp.entries : [])
        .filter((entry) => entry.path)
        .map((entry) => ({
          path: entry.path,
          name: entry.name || basenameFromPath(entry.path),
          kind: "dir" as const,
        }));
      return { entries, truncated: Boolean(resp.truncated) };
    }

    // File mode: list immediate children (directories + files) of `path`.
    const resp = await invoke<FsListResponse>("fs_list", {
      workdir: path,
      depth: 1,
      max_results: DEFAULT_MAX_RESULTS,
      show_hidden: false,
    } as never);
    const entries = (Array.isArray(resp.entries) ? resp.entries : [])
      .filter((entry) => entry.path && (entry.kind === "dir" || entry.kind === "file"))
      .map((entry) => ({
        path: joinChildPath(path, entry.path),
        name: basenameFromPath(entry.path) || entry.path,
        kind: entry.kind as "dir" | "file",
      }))
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
    return { entries, truncated: Boolean(resp.hasMore) };
  }

  async function loadDirectoryChildren(path: string): Promise<LoadedChildren> {
    setLoadingPaths((prev) => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
    setLoadError(null);

    try {
      const loaded = await fetchChildren(path);
      const childPaths = loaded.entries.map((entry) => entry.path);

      setItems((prev) => {
        const next: Record<TreeItemIndex, TreeItem<NodeData>> = { ...prev };
        const parent = next[path];
        if (!parent) return prev;

        next[path] = {
          ...parent,
          isFolder: true,
          children: childPaths,
          data: {
            ...parent.data,
            loaded: true,
            truncated: loaded.truncated,
          },
        };

        for (const entry of loaded.entries) {
          if (next[entry.path]) continue;
          next[entry.path] = createNodeItem(entry.path, entry.name, entry.kind);
        }

        return next;
      });

      return loaded;
    } catch (err) {
      setLoadError(toErrorMessage(err, "Failed to list directories"));
      throw err;
    } finally {
      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }

  async function loadChildren(path: string) {
    if (!path.trim()) return;
    const current = items[path];
    if (!current || !current.isFolder) return;
    if (current.data?.loaded) return;
    if (loadingPaths.has(path)) return;

    try {
      await loadDirectoryChildren(path);
    } catch {
      // The shared error banner is updated by loadDirectoryChildren.
    }
  }

  async function createFolderInActivePath() {
    const parent = activePath.trim();
    const name = createFolderName;
    if (!parent || !name || creatingFolder) return;

    setCreatingFolder(true);
    setCreateFolderError(null);
    try {
      const resp = await invoke<{ path: string }>("system_create_project_folder", {
        parent,
        name,
      });
      const createdPath = stripTrailingPathSeparators(resp.path);
      if (!createdPath) {
        throw new Error("Created folder path is empty");
      }

      try {
        await loadDirectoryChildren(parent);
      } catch {
        // Keep the newly created folder selectable even if refreshing the parent fails.
      }

      const createdLabel = name || basenameFromPath(createdPath) || createdPath;
      setItems((prev) => {
        const next: Record<TreeItemIndex, TreeItem<NodeData>> = { ...prev };
        const parentItem = next[parent];
        if (parentItem) {
          const children = Array.isArray(parentItem.children) ? parentItem.children : [];
          next[parent] = {
            ...parentItem,
            isFolder: true,
            children: mergeTreeIndexes(children, [createdPath]),
            data: {
              ...parentItem.data,
              loaded: true,
            },
          };
        }
        next[createdPath] = next[createdPath] ?? createNodeItem(createdPath, createdLabel, "dir");
        return next;
      });

      updateTreeViewState(TREE_ID, (treePrev) => ({
        ...treePrev,
        expandedItems: mergeTreeIndexes(treePrev.expandedItems, [ROOT_ID, parent]),
        selectedItems: [createdPath],
        focusedItem: createdPath,
      }));
      setNewFolderName("");
      setLoadError(null);
    } catch (err) {
      setCreateFolderError(toErrorMessage(err, t("settings.createFolderFailed")));
    } finally {
      setCreatingFolder(false);
    }
  }

  // 挂 z-[120]：需要压过新建 worktree 弹窗（z-[110]）等上层来源；作为嵌套
  // Base UI Dialog 打开时 DOM 顺序也保证在后。
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        className="remote-path-picker-panel flex h-[min(650px,92vh)] max-h-[92vh] max-w-4xl flex-col border-border/60 p-0 max-sm:max-h-[calc(100dvh-1rem)] max-sm:max-w-[calc(100vw-1rem)]"
        overlayClassName="z-[120] bg-black/60"
        viewportClassName="z-[120] items-stretch px-2 pb-[max(8px,env(safe-area-inset-bottom))] pt-[max(8px,env(safe-area-inset-top))] sm:items-center sm:p-4"
      >
        <div className="settings-modal-header flex items-center gap-3 border-b border-border/40 px-6 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            {mode === "file" ? <File className="h-5 w-5" /> : <FolderOpen className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle>{modalTitle}</DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">{modalDescription}</DialogDescription>
          </div>
          <DialogClose
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                title={t("settings.cancel")}
                aria-label={t("settings.cancel")}
              />
            }
          >
            <X className="h-4 w-4" />
          </DialogClose>
        </div>

        <div className="settings-modal-subheader border-b border-border/30 px-6 py-4">
          <div className="settings-field-row flex items-center gap-3">
            <div className="w-24 shrink-0 text-xs font-medium text-muted-foreground">
              {mode === "file" ? t("settings.pathPickerPathLabel") : t("settings.workdir")}
            </div>
            <Input value={headerPath} readOnly className="font-mono text-[13px]" />
          </div>
        </div>

        <div className="settings-modal-body flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Home className="h-3.5 w-3.5" />
              <span>~</span>
            </div>
            <span className="text-muted-foreground/40">·</span>
            <div className="flex items-center gap-1.5">
              <HardDrive className="h-3.5 w-3.5" />
              <span>Root</span>
            </div>
          </div>

          {mode === "directory" ? (
            <div className="rounded-xl border border-border/60 bg-background/70 p-2">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <Input
                  value={newFolderName}
                  onChange={(event) => {
                    setNewFolderName(event.currentTarget.value);
                    if (createFolderError) {
                      setCreateFolderError(null);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void createFolderInActivePath();
                  }}
                  placeholder={
                    activePath
                      ? t("settings.newFolderNamePlaceholder")
                      : t("settings.newFolderSelectParentFirst")
                  }
                  disabled={!activePath || creatingFolder}
                  className="h-9"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 gap-2"
                  onClick={() => void createFolderInActivePath()}
                  disabled={!canCreateFolder}
                >
                  {creatingFolder ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  {t("settings.createFolder")}
                </Button>
              </div>
              {createFolderError ? (
                <div className="mt-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">{createFolderError}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="workdir-picker-tree min-h-0 flex-1 overflow-auto rounded-xl border border-border/60 bg-muted/20 p-2">
            <ControlledTreeEnvironment
              items={items}
              getItemTitle={(item) => item.data.label}
              viewState={viewState}
              onExpandItem={(item, treeId) => {
                const index = typeof item.index === "string" ? item.index : "";
                if (!index || index === ROOT_ID) return;
                updateTreeViewState(treeId, (treePrev) => ({
                  ...treePrev,
                  expandedItems: treePrev.expandedItems?.includes(index)
                    ? treePrev.expandedItems
                    : [...(treePrev.expandedItems ?? []), index],
                }));
                void loadChildren(index);
              }}
              onCollapseItem={(item, treeId) => {
                const index = typeof item.index === "string" ? item.index : "";
                if (!index || index === ROOT_ID) return;
                updateTreeViewState(treeId, (treePrev) => ({
                  ...treePrev,
                  expandedItems: (treePrev.expandedItems ?? []).filter((entry) => entry !== index),
                }));
              }}
              onSelectItems={(selectedItems, treeId) => {
                updateTreeViewState(treeId, (treePrev) => ({
                  ...treePrev,
                  selectedItems,
                }));
              }}
              onFocusItem={(item, treeId) => {
                updateTreeViewState(treeId, (treePrev) => ({
                  ...treePrev,
                  focusedItem: item.index,
                }));
              }}
            >
              <Tree treeId={TREE_ID} rootItem={ROOT_ID} treeLabel="Remote paths" />
            </ControlledTreeEnvironment>
          </div>

          {statusLine ? (
            <div
              className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs ${
                statusLine.kind === "error"
                  ? "border-destructive/30 bg-destructive/5 text-destructive"
                  : statusLine.kind === "warn"
                    ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                    : "border-border/60 bg-background/70 text-muted-foreground"
              }`}
            >
              {statusLine.kind === "loading" ? (
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              ) : statusLine.kind === "error" ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <FolderOpen className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1">{statusLine.text}</span>
            </div>
          ) : null}
        </div>

        <DialogFooter className="settings-modal-footer border-t border-border/40 px-6 py-4">
          <DialogClose render={<Button variant="outline" />}>{t("settings.cancel")}</DialogClose>
          <DialogClose
            render={
              <Button
                disabled={!canConfirm}
                onClick={() => {
                  if (!canConfirm || !selectedPath) return;
                  onSelect(selectedPath);
                }}
              />
            }
          >
            {t("settings.select")}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type PickPathOptions = {
  mode: RemotePathPickerMode;
  initialPath?: string;
  title?: string;
  description?: string;
};

type PendingPick = PickPathOptions & {
  resolve: (path: string | null) => void;
};

/**
 * Promise-based entry point: `pickPath()` resolves with the chosen remote
 * path, or null when the picker is dismissed. Render `pathPickerElement`
 * once near the caller's root.
 */
export function useRemotePathPicker() {
  const [pending, setPending] = useState<PendingPick | null>(null);
  const selectedPathRef = useRef<string | null>(null);

  const pickPath = useCallback(
    (options: PickPathOptions) =>
      new Promise<string | null>((resolve) => {
        selectedPathRef.current = null;
        setPending({ ...options, resolve });
      }),
    [],
  );

  const pathPickerElement = pending ? (
    <RemotePathPickerModal
      mode={pending.mode}
      initialPath={pending.initialPath}
      title={pending.title}
      description={pending.description}
      onSelect={(path) => {
        selectedPathRef.current = path;
      }}
      onClose={() => {
        // Resolve only after the picker finishes its exit transition so a
        // suspended parent modal cannot reopen underneath the closing picker.
        pending.resolve(selectedPathRef.current);
        selectedPathRef.current = null;
        setPending(null);
      }}
    />
  ) : null;

  return { pickPath, pathPickerElement };
}
