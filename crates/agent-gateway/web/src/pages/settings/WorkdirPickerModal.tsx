import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, FolderOpen, HardDrive, Home, Loader2, Plus, X } from "../../components/icons";
import type { IndividualTreeViewState, TreeItem, TreeItemIndex, TreeViewState } from "react-complex-tree";
import { ControlledTreeEnvironment, Tree } from "react-complex-tree";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useLocale } from "../../i18n";
import { useModalMotion } from "../../lib/shared/modalMotion";

type FsRoot = {
  id: string;
  path: string;
  kind: "home" | "root" | "drive";
  label: string;
};

type FsRootsResponse = {
  roots: FsRoot[];
};

type FsListDirsResponse = {
  path: string;
  entries: Array<{ path: string; name: string }>;
  truncated: boolean;
};

type NodeData = {
  path: string;
  label: string;
  kind: "synthetic-root" | "home" | "root" | "drive" | "dir";
  loaded: boolean;
  truncated?: boolean;
};

const TREE_ID = "workdir-picker";
const ROOT_ID = "__workdir_roots__";
const DEFAULT_MAX_RESULTS = 10000;

function createDirItem(path: string, label: string, kind: NodeData["kind"]): TreeItem<NodeData> {
  return {
    index: path,
    isFolder: true,
    children: [],
    data: {
      path,
      label,
      kind,
      loaded: false,
    },
  };
}

function toErrorMessage(err: unknown, fallback: string) {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  const text = String(err ?? "").trim();
  return text || fallback;
}

function stripTrailingPathSeparators(path: string) {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/, "");
}

function normalizePathForCompare(path: string) {
  const normalized = stripTrailingPathSeparators(path).replace(/\\/g, "/");
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isSameOrDescendantPath(path: string, ancestor: string) {
  const current = normalizePathForCompare(path);
  const parent = normalizePathForCompare(ancestor);
  if (!current || !parent) return false;
  if (current === parent) return true;
  if (parent === "/") return current.startsWith("/");
  if (/^[a-z]:\/?$/.test(parent)) {
    return current.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
  }
  return current.startsWith(`${parent}/`);
}

function findBestRootForPath(path: string, roots: FsRoot[]) {
  return roots
    .filter((root) => root.path && isSameOrDescendantPath(path, root.path))
    .sort(
      (left, right) =>
        normalizePathForCompare(right.path).length -
        normalizePathForCompare(left.path).length,
    )[0] ?? null;
}

function findRouteChild(targetPath: string, entries: FsListDirsResponse["entries"]) {
  return entries
    .filter((entry) => entry.path && isSameOrDescendantPath(targetPath, entry.path))
    .sort(
      (left, right) =>
        normalizePathForCompare(right.path).length -
        normalizePathForCompare(left.path).length,
    )[0] ?? null;
}

function mergeTreeIndexes(
  current: TreeItemIndex[] | undefined,
  additions: TreeItemIndex[],
) {
  return Array.from(new Set([...(current ?? []), ...additions]));
}

function basenameFromPath(path: string) {
  const normalized = stripTrailingPathSeparators(path);
  if (!normalized) return "";
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

type WorkdirPickerModalProps = {
  initialWorkdir: string;
  onClose: () => void;
  onSelect: (path: string) => void;
};

export function WorkdirPickerModal(props: WorkdirPickerModalProps) {
  const { initialWorkdir, onClose, onSelect } = props;
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
  const didExpandInitialWorkdirRef = useRef(false);
  const { modalState, requestClose } = useModalMotion(onClose);

  const selectedItem = viewState[TREE_ID]?.selectedItems?.[0] ?? null;
  const focusedItem = viewState[TREE_ID]?.focusedItem ?? null;
  const selectedPath =
    typeof selectedItem === "string" && selectedItem !== ROOT_ID ? selectedItem : "";
  const focusedPath =
    typeof focusedItem === "string" && focusedItem !== ROOT_ID ? focusedItem : "";
  const activePath = (selectedPath || focusedPath).trim();

  const headerPath = (selectedPath || initialWorkdir || "").trim();

  const activeMeta = activePath ? items[activePath]?.data ?? null : null;
  const activeChildren = activePath ? items[activePath]?.children ?? null : null;
  const createFolderName = newFolderName.trim();
  const canCreateFolder = Boolean(activePath && createFolderName && !creatingFolder);

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
    if (activeMeta?.loaded && Array.isArray(activeChildren) && activeChildren.length === 0) {
      return {
        kind: "empty" as const,
        text: t("settings.noSubdirs"),
      };
    }
    if (activeMeta?.truncated) {
      return {
        kind: "warn" as const,
        text: t("settings.tooManyDirs"),
      };
    }
    return null;
  }, [activeChildren, activeMeta?.loaded, activeMeta?.truncated, loadError, loadingPaths.size, loadingRoots, t]);

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
            next[root.path] = createDirItem(root.path, root.label || root.path, kind);
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
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      requestClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  useEffect(() => {
    if (loadingRoots || didExpandInitialWorkdirRef.current) return;

    const targetPath = stripTrailingPathSeparators(initialWorkdir);
    if (!targetPath || roots.length === 0) return;

    const root = findBestRootForPath(targetPath, roots);
    if (!root) return;

    didExpandInitialWorkdirRef.current = true;
    let cancelled = false;

    async function expandInitialWorkdir() {
      const route: string[] = [root.path];
      let currentPath = root.path;
      let reachedTarget =
        normalizePathForCompare(currentPath) === normalizePathForCompare(targetPath);

      try {
        for (let depth = 0; depth < 128 && !reachedTarget; depth += 1) {
          const resp = await loadDirectoryChildren(currentPath);
          if (cancelled) return;

          const child = findRouteChild(targetPath, resp.entries);
          if (!child?.path) break;

          currentPath = child.path;
          route.push(currentPath);
          reachedTarget =
            normalizePathForCompare(currentPath) === normalizePathForCompare(targetPath);
        }

        if (reachedTarget) {
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
        : route[route.length - 1] ?? root.path;
      const expandedRoute = [ROOT_ID, ...route];

      updateTreeViewState(TREE_ID, (treePrev) => ({
        ...treePrev,
        expandedItems: mergeTreeIndexes(treePrev.expandedItems, expandedRoute),
        selectedItems: [selectedPathForState],
        focusedItem: selectedPathForState,
      }));
    }

    void expandInitialWorkdir();
    return () => {
      cancelled = true;
    };
  }, [initialWorkdir, loadingRoots, roots]);

  async function loadDirectoryChildren(path: string) {
    setLoadingPaths((prev) => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
    setLoadError(null);

    try {
      const resp = await invoke<FsListDirsResponse>("fs_list_dirs", {
        path,
        max_results: DEFAULT_MAX_RESULTS,
      } as any);

      const entries = Array.isArray(resp.entries) ? resp.entries : [];
      const childPaths = entries.map((entry) => entry.path).filter(Boolean);

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
            truncated: Boolean(resp.truncated),
          },
        };

        for (const entry of entries) {
          if (!entry.path) continue;
          if (next[entry.path]) continue;
          next[entry.path] = createDirItem(entry.path, entry.name || entry.path, "dir");
        }

        return next;
      });

      return {
        ...resp,
        entries,
      };
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
        next[createdPath] = next[createdPath] ?? createDirItem(createdPath, createdLabel, "dir");
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

  const canConfirm = Boolean(selectedPath);

  const overlay = (
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={requestClose} />

      <div className="settings-modal-panel relative z-10 flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl">
        <div className="settings-modal-header flex items-center gap-3 border-b border-border/40 px-6 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <FolderOpen className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{t("settings.workdirPickerTitle")}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("settings.workdirDesc")}
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            title={t("settings.cancel")}
            aria-label={t("settings.cancel")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="settings-modal-subheader border-b border-border/30 px-6 py-4">
          <div className="settings-field-row flex items-center gap-3">
            <div className="w-24 shrink-0 text-xs font-medium text-muted-foreground">
              {t("settings.workdir")}
            </div>
            <Input
              value={headerPath}
              readOnly
              className="font-mono text-[13px]"
            />
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

          <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border/60 bg-muted/20 p-2">
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
                  expandedItems: (treePrev.expandedItems ?? []).filter(
                    (entry) => entry !== index,
                  ),
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
              <Tree treeId={TREE_ID} rootItem={ROOT_ID} treeLabel="Workdir" />
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

        <div className="settings-modal-footer flex items-center justify-end gap-2 border-t border-border/40 px-6 py-4">
          <Button variant="outline" onClick={requestClose}>
            {t("settings.cancel")}
          </Button>
          <Button
            disabled={!canConfirm}
            onClick={() => {
              if (!selectedPath) return;
              onSelect(selectedPath);
              requestClose();
            }}
          >
            {t("settings.select")}
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
