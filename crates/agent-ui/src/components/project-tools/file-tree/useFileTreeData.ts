// Data layer for the right-dock file tree panel: fs_list loading with
// request de-duplication and out-of-order protection, per-project LRU state
// buckets, workspace-activity driven invalidation, search, and fs mutations.
//
// Shared implementation owned by @liveagent/ui. Host-specific icons, settings
// and backend capabilities resolve through the current application's contracts.

import { useLocale } from "@liveagent/ui/i18n/index";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invokeFs, isFsBackendError } from "../../../lib/tools/fsBackend";
import type { WorkspaceActivityClient } from "../../../lib/workspace-activity/types";
import {
  applyFileTreeExternalRoots,
  applyFileTreeListResponse,
  createFileTreeBuckets,
  createRootNode,
  dirname,
  externalRootChildPath,
  externalRootPathInfo,
  type FileTreeBuckets,
  type FileTreeEntry,
  type FileTreeExternalRoot,
  type FileTreeKind,
  type FileTreeNodes,
  getFileTreeNodes,
  initialFileTreeInvalidationState,
  joinPath,
  markFileTreeNodeLoadError,
  markFileTreeNodeLoading,
  planFileTreeInvalidationRefresh,
  ROOT_PATH,
  reduceFileTreeInvalidation,
  removeFileTreeNodeSubtree,
  sortFileTreeEntries,
  takeFileTreeInvalidation,
  toFileTreeErrorMessage,
  touchFileTreeBucket,
  updateFileTreeNodes,
} from "./model";

const FILE_TREE_LIST_MAX_RESULTS = 1000;
const FILE_TREE_SEARCH_MAX_RESULTS = 80;
const FILE_TREE_SEARCH_DEBOUNCE_MS = 180;
// Only used when the backend exposes no workspace-activity client (see the
// fallback-poll effect below).
const FILE_TREE_FALLBACK_POLL_MS = 10_000;

type FsListResponse = {
  path?: string | null;
  entries: FileTreeEntry[];
  hasMore?: boolean;
};

type MentionListResponse = {
  entries: FileTreeEntry[];
  truncated: boolean;
};

type LoadOptions = { force?: boolean; silent?: boolean };

// Per-project request bookkeeping. Living in a ref (never inside a setState
// updater) so duplicate requests are rejected synchronously even when React
// batches or replays state updaters.
type ProjectRequestTracker = {
  loading: Set<string>;
  epochByPath: Map<string, number>;
};

export type FileTreeSearchState = {
  loading: boolean;
  error: string | null;
  results: FileTreeEntry[];
  truncated: boolean;
};

export type UseFileTreeDataOptions = {
  projectPathKey: string;
  cwd: string;
  externalRoots: readonly FileTreeExternalRoot[];
  active: boolean;
  initialized: boolean;
  workspaceActivityClient: WorkspaceActivityClient | null;
  // Persisted expansion state (source of truth held by the panel).
  expandedPaths: string[];
  // Live search input (the panel debounces persistence separately).
  query: string;
  showHidden: boolean;
};

export type UseFileTreeDataResult = {
  nodes: FileTreeNodes;
  loadChildren: (path: string, options?: LoadOptions) => Promise<void>;
  refreshVisible: (options?: { silent?: boolean }) => void;
  ensureDirsLoaded: (dirs: readonly string[]) => Promise<void>;
  createEntry: (kind: FileTreeKind, targetDir: string, name: string) => Promise<string>;
  renameEntry: (fromPath: string, name: string) => Promise<string>;
  deleteEntry: (path: string) => Promise<void>;
  openWorkspacePath: (path: string, mode: "open" | "reveal") => Promise<void>;
  isExternalPath: (path: string) => boolean;
  getDisplayPath: (path: string) => string;
  search: FileTreeSearchState;
};

type ResolvedFileTreePath = {
  workdir: string;
  fsPath: string;
  external: boolean;
  rootId?: string;
};

export function useFileTreeData(options: UseFileTreeDataOptions): UseFileTreeDataResult {
  const {
    projectPathKey,
    cwd,
    externalRoots,
    active,
    initialized,
    workspaceActivityClient,
    expandedPaths,
    query,
    showHidden,
  } = options;
  const { t } = useLocale();

  const externalRootsById = useMemo(() => {
    const roots = new Map<string, FileTreeExternalRoot>();
    for (const root of externalRoots) {
      const id = root.id.trim();
      const workdir = root.cwd.trim();
      if (!id || !workdir || roots.has(id)) continue;
      roots.set(id, { ...root, id, cwd: workdir });
    }
    return roots;
  }, [externalRoots]);

  const withExternalRoots = useCallback(
    (current: FileTreeNodes) => applyFileTreeExternalRoots(current, externalRoots),
    [externalRoots],
  );

  const resolveTreePath = useCallback(
    (path: string): ResolvedFileTreePath | null => {
      const external = externalRootPathInfo(path);
      if (!external) {
        return { workdir: cwd, fsPath: path, external: false };
      }
      const root = externalRootsById.get(external.rootId);
      if (!root) return null;
      return {
        workdir: root.cwd,
        fsPath: external.relativePath,
        external: true,
        rootId: root.id,
      };
    },
    [cwd, externalRootsById],
  );

  const [buckets, setBuckets] = useState<FileTreeBuckets>(createFileTreeBuckets);
  const bucketsRef = useRef(buckets);
  const trackersRef = useRef(new Map<string, ProjectRequestTracker>());

  const [searchResults, setSearchResults] = useState<FileTreeEntry[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchRefreshKey, setSearchRefreshKey] = useState(0);

  const nodes = useMemo(
    () => withExternalRoots(getFileTreeNodes(buckets, projectPathKey, cwd)),
    [buckets, cwd, projectPathKey, withExternalRoots],
  );

  const expandedRef = useRef(expandedPaths);
  useEffect(() => {
    expandedRef.current = expandedPaths;
  }, [expandedPaths]);

  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const showHiddenRef = useRef(showHidden);

  const activeRef = useRef(active);

  // All bucket mutations go through here: pure computation first, then a
  // plain-value setState. No side effects ever run inside a state updater.
  const commitBuckets = useCallback((next: FileTreeBuckets) => {
    if (next === bucketsRef.current) return;
    bucketsRef.current = next;
    setBuckets(next);
  }, []);

  const updateNodes = useCallback(
    (key: string, workdir: string, update: (nodes: FileTreeNodes) => FileTreeNodes) => {
      commitBuckets(
        updateFileTreeNodes(bucketsRef.current, key, workdir, (current) =>
          withExternalRoots(update(withExternalRoots(current))),
        ),
      );
    },
    [commitBuckets, withExternalRoots],
  );

  const currentNodesForProject = useCallback(
    (key: string, workdir: string) =>
      withExternalRoots(getFileTreeNodes(bucketsRef.current, key, workdir)),
    [withExternalRoots],
  );

  const trackerFor = useCallback((key: string): ProjectRequestTracker => {
    let tracker = trackersRef.current.get(key);
    if (!tracker) {
      tracker = { loading: new Set(), epochByPath: new Map() };
      trackersRef.current.set(key, tracker);
    }
    return tracker;
  }, []);

  // Keep the current project bucket most-recently-used and drop request
  // trackers for buckets the LRU evicted.
  useEffect(() => {
    if (!projectPathKey) return;
    commitBuckets(
      updateFileTreeNodes(
        touchFileTreeBucket(bucketsRef.current, projectPathKey, cwd),
        projectPathKey,
        cwd,
        withExternalRoots,
      ),
    );
    const keep = new Set(bucketsRef.current.order);
    for (const key of [...trackersRef.current.keys()]) {
      if (!keep.has(key)) trackersRef.current.delete(key);
    }
  }, [commitBuckets, cwd, projectPathKey, withExternalRoots]);

  const loadChildren = useCallback(
    async (path: string, loadOptions?: LoadOptions) => {
      const key = projectPathKey;
      const target = resolveTreePath(path);
      if (!key || !target?.workdir.trim()) return;
      const { workdir } = target;
      const tracker = trackerFor(key);
      const currentNodes = currentNodesForProject(key, cwd);
      const node = currentNodes[path] ?? (path === ROOT_PATH ? createRootNode(workdir) : undefined);
      if (!node || node.kind !== "dir") return;
      // De-duplication happens synchronously against the ref-held tracker —
      // never as a side effect inside a setState updater, which React
      // batching may skip or replay (the old panel's request amplification).
      if (tracker.loading.has(path)) {
        if (!loadOptions?.force) return;
        // Forced refresh while a request is in flight: the epoch bump below
        // makes the in-flight response stale so it is discarded on arrival.
      } else if (node.loaded && !loadOptions?.force) {
        return;
      }
      const epoch = (tracker.epochByPath.get(path) ?? 0) + 1;
      tracker.epochByPath.set(path, epoch);
      tracker.loading.add(path);
      if (!loadOptions?.silent) {
        updateNodes(key, cwd, (current) => markFileTreeNodeLoading(current, path, workdir));
      }
      try {
        const response = await invokeFs<FsListResponse>("fs_list", {
          workdir,
          path: target.fsPath || undefined,
          depth: 1,
          offset: 0,
          max_results: FILE_TREE_LIST_MAX_RESULTS,
          show_hidden: showHiddenRef.current,
        });
        // Out-of-order protection: a response only lands if it belongs to the
        // newest request issued for this path.
        if (tracker.epochByPath.get(path) !== epoch) return;
        const entries = sortFileTreeEntries(
          (Array.isArray(response.entries) ? response.entries : []).map((entry) =>
            target.external && target.rootId
              ? { ...entry, path: externalRootChildPath(target.rootId, entry.path) }
              : entry,
          ),
        );
        const listError = response.hasMore ? t("projectTools.fileTree.tooManyItems") : undefined;
        updateNodes(key, cwd, (current) =>
          applyFileTreeListResponse(current, path, workdir, entries, listError),
        );
      } catch (error) {
        if (tracker.epochByPath.get(path) !== epoch) return;
        updateNodes(key, cwd, (current) =>
          markFileTreeNodeLoadError(
            current,
            path,
            workdir,
            loadOptions?.silent
              ? undefined
              : toFileTreeErrorMessage(error, t("projectTools.fileTree.readFailed")),
          ),
        );
      } finally {
        if (tracker.epochByPath.get(path) === epoch) tracker.loading.delete(path);
      }
    },
    [currentNodesForProject, cwd, projectPathKey, resolveTreePath, t, trackerFor, updateNodes],
  );

  // Initial root load once the tool is initialized for a project.
  useEffect(() => {
    if (!initialized || !projectPathKey || !cwd.trim()) return;
    void loadChildren(ROOT_PATH);
  }, [cwd, initialized, loadChildren, projectPathKey]);

  // Keep every persisted-expanded directory loaded. Nodes that errored wait
  // for an explicit user retry (expand/refresh) so this cannot become a retry
  // loop; loadChildren itself de-duplicates in-flight requests.
  useEffect(() => {
    if (!initialized || !projectPathKey || !cwd.trim()) return;
    for (const path of expandedPaths) {
      const node = nodes[path];
      if (node?.kind === "dir" && !node.loaded && !node.loading && node.error === undefined) {
        void loadChildren(path);
      }
    }
  }, [cwd, expandedPaths, initialized, loadChildren, nodes, projectPathKey]);

  const bumpSearchRefresh = useCallback(() => {
    if (queryRef.current.trim()) {
      setSearchRefreshKey((current) => current + 1);
    }
  }, []);

  // Force-reload every visible listing (root + expanded loaded directories).
  const refreshVisible = useCallback(
    (refreshOptions?: { silent?: boolean }) => {
      if (!projectPathKey || !cwd.trim()) return;
      const currentNodes = currentNodesForProject(projectPathKey, cwd);
      const paths = new Set<string>([ROOT_PATH, ...expandedRef.current]);
      for (const path of paths) {
        const node = currentNodes[path];
        if (path === ROOT_PATH || (node?.kind === "dir" && node.loaded)) {
          void loadChildren(path, { force: true, silent: refreshOptions?.silent });
        }
      }
      bumpSearchRefresh();
    },
    [bumpSearchRefresh, currentNodesForProject, cwd, loadChildren, projectPathKey],
  );

  useEffect(() => {
    if (showHiddenRef.current === showHidden) return;
    showHiddenRef.current = showHidden;
    refreshVisible();
  }, [refreshVisible, showHidden]);

  // ---------------------------------------------------------------------
  // Workspace-activity invalidation (replaces the old 3s full polling)
  // ---------------------------------------------------------------------

  const invalidationRef = useRef(initialFileTreeInvalidationState);

  const flushInvalidation = useCallback(() => {
    const { state, batch } = takeFileTreeInvalidation(invalidationRef.current);
    invalidationRef.current = state;
    if (!batch || !projectPathKey || !cwd.trim()) return;
    const currentNodes = currentNodesForProject(projectPathKey, cwd);
    const expanded = new Set(expandedRef.current);
    for (const path of planFileTreeInvalidationRefresh(batch, currentNodes, expanded)) {
      void loadChildren(path, { force: true, silent: true });
    }
    bumpSearchRefresh();
  }, [bumpSearchRefresh, currentNodesForProject, cwd, loadChildren, projectPathKey]);

  const flushInvalidationRef = useRef(flushInvalidation);
  useEffect(() => {
    flushInvalidationRef.current = flushInvalidation;
  }, [flushInvalidation]);

  // While the tab is hidden, events only accumulate dirt; flipping back to
  // active flushes the accumulated batch once.
  useEffect(() => {
    activeRef.current = active;
    if (active) flushInvalidationRef.current();
  }, [active]);

  useEffect(() => {
    if (!workspaceActivityClient || !cwd.trim()) return undefined;
    // A fresh subscription cannot prove continuity with anything observed
    // before it: drop stale dirt and the old revision cursor. (Same
    // semantics as lib/workspace-activity/useWorkspaceInvalidation; see
    // model.ts for why the file tree keeps its own path-aware reducer.)
    invalidationRef.current = initialFileTreeInvalidationState;
    return workspaceActivityClient.subscribe(cwd, (payload) => {
      invalidationRef.current = reduceFileTreeInvalidation(invalidationRef.current, payload);
      if (activeRef.current) flushInvalidationRef.current();
    });
  }, [cwd, workspaceActivityClient]);

  // Fallback for backends without a workspace-activity client: a low
  // frequency poll (10s), and only while the tab is actually visible. The
  // pre-rewrite panel polled every 3s even while hidden.
  useEffect(() => {
    if (workspaceActivityClient) return undefined;
    if (!active || !initialized || !projectPathKey || !cwd.trim()) return undefined;
    const interval = window.setInterval(() => {
      refreshVisible({ silent: true });
    }, FILE_TREE_FALLBACK_POLL_MS);
    return () => window.clearInterval(interval);
  }, [active, cwd, initialized, projectPathKey, refreshVisible, workspaceActivityClient]);

  // ---------------------------------------------------------------------
  // Search (fs_mention_list)
  // ---------------------------------------------------------------------

  useEffect(() => {
    void searchRefreshKey;
    if (!query.trim() || !cwd.trim() || !initialized) {
      setSearchResults([]);
      setSearchError(null);
      setSearchLoading(false);
      setSearchTruncated(false);
      return undefined;
    }
    // Hidden panels keep their previous results; the effect re-runs (and
    // refetches) as soon as the tab becomes active again.
    if (!active) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      setSearchError(null);
      void invokeFs<MentionListResponse>("fs_mention_list", {
        workdir: cwd,
        query,
        max_results: FILE_TREE_SEARCH_MAX_RESULTS,
        show_hidden: showHiddenRef.current,
      })
        .then((response) => {
          if (cancelled) return;
          setSearchResults(Array.isArray(response.entries) ? response.entries : []);
          setSearchTruncated(Boolean(response.truncated));
        })
        .catch((error) => {
          if (cancelled) return;
          setSearchResults([]);
          setSearchError(toFileTreeErrorMessage(error, t("projectTools.fileTree.searchFailed")));
        })
        .finally(() => {
          if (!cancelled) setSearchLoading(false);
        });
    }, FILE_TREE_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, cwd, initialized, query, searchRefreshKey, t]);

  // ---------------------------------------------------------------------
  // Mutations (errors are re-thrown with user-facing messages)
  // ---------------------------------------------------------------------

  const entryExists = useCallback(
    (path: string) => currentNodesForProject(projectPathKey, cwd)[path] !== undefined,
    [currentNodesForProject, cwd, projectPathKey],
  );

  const describeConflictError = useCallback(
    (error: unknown, fallback: string) => {
      // Rename / create-dir conflicts surface as FsError::Other with a
      // "... already exists" message; creating a file over an existing one
      // trips the read-before-write guard instead. Map both to the friendly
      // conflict copy, everything else keeps the backend message.
      if (isFsBackendError(error)) {
        if (
          error.code === "requires_full_read" ||
          error.code === "stale_file" ||
          /already exists/i.test(error.message)
        ) {
          return t("projectTools.fileTree.nameExists");
        }
      }
      return toFileTreeErrorMessage(error, fallback);
    },
    [t],
  );

  const createEntry = useCallback(
    async (kind: FileTreeKind, targetDir: string, name: string) => {
      const target = resolveTreePath(targetDir);
      if (!target || target.external) {
        throw new Error(t("projectTools.fileTree.actionFailed"));
      }
      const nextPath = joinPath(targetDir, name);
      if (entryExists(nextPath)) {
        throw new Error(t("projectTools.fileTree.nameExists"));
      }
      try {
        if (kind === "dir") {
          await invokeFs("fs_create_dir", { workdir: target.workdir, path: joinPath(target.fsPath, name) });
        } else {
          await invokeFs("fs_write_text", {
            workdir: target.workdir,
            path: joinPath(target.fsPath, name),
            content: "",
            mode: "rewrite",
          });
        }
      } catch (error) {
        throw new Error(describeConflictError(error, t("projectTools.fileTree.actionFailed")));
      }
      await loadChildren(targetDir, { force: true });
      if (kind === "dir") await loadChildren(nextPath);
      return nextPath;
    },
    [describeConflictError, entryExists, loadChildren, resolveTreePath, t],
  );

  const renameEntry = useCallback(
    async (fromPath: string, name: string) => {
      const target = resolveTreePath(fromPath);
      if (!target || target.external) {
        throw new Error(t("projectTools.fileTree.actionFailed"));
      }
      const parent = dirname(fromPath);
      const nextPath = joinPath(parent, name);
      if (nextPath === fromPath) return nextPath;
      if (entryExists(nextPath)) {
        throw new Error(t("projectTools.fileTree.nameExists"));
      }
      try {
        await invokeFs("fs_rename", {
          workdir: target.workdir,
          from_path: target.fsPath,
          to_path: joinPath(dirname(target.fsPath), name),
        });
      } catch (error) {
        throw new Error(describeConflictError(error, t("projectTools.fileTree.actionFailed")));
      }
      updateNodes(projectPathKey, cwd, (current) => removeFileTreeNodeSubtree(current, fromPath));
      await loadChildren(parent, { force: true });
      return nextPath;
    },
    [cwd, describeConflictError, entryExists, loadChildren, projectPathKey, resolveTreePath, t, updateNodes],
  );

  const deleteEntry = useCallback(
    async (path: string) => {
      const target = resolveTreePath(path);
      if (!target || target.external) {
        throw new Error(t("projectTools.fileTree.deleteFailed"));
      }
      try {
        await invokeFs("fs_delete", { workdir: target.workdir, path: target.fsPath });
      } catch (error) {
        throw new Error(toFileTreeErrorMessage(error, t("projectTools.fileTree.deleteFailed")));
      }
      updateNodes(projectPathKey, cwd, (current) => removeFileTreeNodeSubtree(current, path));
      await loadChildren(dirname(path), { force: true });
    },
    [cwd, loadChildren, projectPathKey, resolveTreePath, t, updateNodes],
  );

  // Desktop-only (see FILE_TREE_HAS_OS_INTEGRATION); callers hide the entry
  // points on the web where the command does not exist.
  const openWorkspacePath = useCallback(
    async (path: string, mode: "open" | "reveal") => {
      const target = resolveTreePath(path);
      if (!target) {
        throw new Error(t("projectTools.fileTree.readFailed"));
      }
      try {
        await invokeFs("fs_open_workspace_path", {
          workdir: target.workdir,
          path: target.fsPath,
          mode,
        });
      } catch (error) {
        throw new Error(
          toFileTreeErrorMessage(
            error,
            t(
              mode === "open"
                ? "projectTools.fileTree.openExternalFailed"
                : "projectTools.fileTree.openContainingDirectoryFailed",
            ),
          ),
        );
      }
    },
    [resolveTreePath, t],
  );

  const isExternalPath = useCallback(
    (path: string) => Boolean(resolveTreePath(path)?.external),
    [resolveTreePath],
  );

  const getDisplayPath = useCallback(
    (path: string) => {
      const target = resolveTreePath(path);
      if (!target) return path;
      if (!target.external) return path || cwd;
      if (!target.fsPath) return target.workdir;
      const separator = target.workdir.includes("\\") ? "\\" : "/";
      return `${target.workdir.replace(/[\\/]+$/, "")}${separator}${target.fsPath}`;
    },
    [cwd, resolveTreePath],
  );

  // Sequentially loads a chain of directories (used by reveal flows). Loaded
  // directories resolve immediately via loadChildren's de-duplication.
  const ensureDirsLoaded = useCallback(
    async (dirs: readonly string[]) => {
      for (const dir of dirs) {
        await loadChildren(dir);
      }
    },
    [loadChildren],
  );

  const search = useMemo<FileTreeSearchState>(
    () => ({
      loading: searchLoading,
      error: searchError,
      results: searchResults,
      truncated: searchTruncated,
    }),
    [searchError, searchLoading, searchResults, searchTruncated],
  );

  return {
    nodes,
    loadChildren,
    refreshVisible,
    ensureDirsLoaded,
    createEntry,
    renameEntry,
    deleteEntry,
    openWorkspacePath,
    isExternalPath,
    getDisplayPath,
    search,
  };
}
