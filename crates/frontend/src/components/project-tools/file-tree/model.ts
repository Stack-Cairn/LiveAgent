// Pure model helpers for the right-dock file tree panel.

import { hasSystemFileOpener } from "../../../lib/shell/capabilities";
import type { WorkspaceActivityEventPayload } from "../../../lib/workspace-activity/types";

export type FileTreeKind = "file" | "dir";

export type FileTreeEntry = { path: string; kind: FileTreeKind; hidden: boolean };

export type FileTreeNode = {
  path: string;
  name: string;
  kind: FileTreeKind;
  hidden: boolean;
  children: string[];
  loaded: boolean;
  loading: boolean;
  error?: string;
};

export type FileTreeNodes = Record<string, FileTreeNode>;

export type FileTreeRowModel =
  | { type: "node"; key: string; path: string; depth: number }
  | { type: "error"; key: string; path: string; depth: number; message: string };

export const ROOT_PATH = "";

// 「用系统程序打开 / 在文件管理器显示」(`fs_open_workspace_path`) 是壳能力：
// 它操作的是这台机器上的路径，浏览器连远程后端时没有对应物。同一份代码在两种
// 宿主里跑，靠运行时探测决定这些菜单项在不在（阶段 5 已删掉 WebUI 镜像树）。
export const FILE_TREE_HAS_OS_INTEGRATION = hasSystemFileOpener();

// 桌面壳沿用改版前的紧凑 28px 行高，浏览器沿用更适合触摸的 32px 行高。
export const FILE_TREE_ROW_HEIGHT = FILE_TREE_HAS_OS_INTEGRATION ? 28 : 32;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return "";
  return normalized.split("/").pop() || normalized;
}

export function dirname(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

export function joinPath(parent: string, name: string) {
  const cleanName = name.trim().replace(/^\/+|\/+$/g, "");
  return parent ? `${parent}/${cleanName}` : cleanName;
}

export function normalizeFileTreeRelativePath(path: string) {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

// "a/b/c" -> ["", "a", "a/b"]: every directory that must be expanded for the
// path's own row to become visible (the path itself is excluded).
export function ancestorDirsOfPath(path: string): string[] {
  const parts = normalizeFileTreeRelativePath(path).split("/").filter(Boolean);
  const dirs: string[] = [ROOT_PATH];
  for (let index = 0; index < parts.length - 1; index += 1) {
    dirs.push(parts.slice(0, index + 1).join("/"));
  }
  return dirs;
}

function rootName(cwd: string) {
  return basename(cwd) || cwd.trim() || "Project";
}

export function createRootNode(cwd: string): FileTreeNode {
  return {
    path: ROOT_PATH,
    name: rootName(cwd),
    kind: "dir",
    hidden: false,
    children: [],
    loaded: false,
    loading: false,
  };
}

export function sortFileTreeEntries(entries: FileTreeEntry[]): FileTreeEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
    const leftName = basename(left.path).toLowerCase();
    const rightName = basename(right.path).toLowerCase();
    if (leftName === rightName) return left.path.localeCompare(right.path);
    return leftName.localeCompare(rightName);
  });
}

export function sameStringArray(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function toFileTreeErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error ?? "").trim();
  return text || fallback;
}

// ---------------------------------------------------------------------------
// Node map updates (all return the previous reference when nothing changed so
// a no-op refresh causes zero re-renders)
// ---------------------------------------------------------------------------

export function markFileTreeNodeLoading(
  nodes: FileTreeNodes,
  path: string,
  cwd: string,
): FileTreeNodes {
  const node = nodes[path] ?? (path === ROOT_PATH ? createRootNode(cwd) : undefined);
  if (!node || node.kind !== "dir") return nodes;
  if (node.loading && node.error === undefined && nodes[path] !== undefined) return nodes;
  return { ...nodes, [path]: { ...node, loading: true, error: undefined } };
}

// `error === undefined` means a silent (background) failure: stop any visible
// spinner but keep whatever error was already shown.
export function markFileTreeNodeLoadError(
  nodes: FileTreeNodes,
  path: string,
  cwd: string,
  error: string | undefined,
): FileTreeNodes {
  const node = nodes[path] ?? (path === ROOT_PATH ? createRootNode(cwd) : undefined);
  if (!node) return nodes;
  const nextError = error === undefined ? node.error : error;
  if (nodes[path] !== undefined && !node.loading && node.error === nextError) return nodes;
  return { ...nodes, [path]: { ...node, loading: false, error: nextError } };
}

// Merges one fs_list response into the node map. Children and entry nodes
// keep their previous object identity when unchanged; if the whole listing is
// unchanged the previous map reference is returned as-is.
export function applyFileTreeListResponse(
  nodes: FileTreeNodes,
  path: string,
  cwd: string,
  entries: FileTreeEntry[],
  listError: string | undefined,
): FileTreeNodes {
  const parent = nodes[path] ?? (path === ROOT_PATH ? createRootNode(cwd) : undefined);
  if (!parent || parent.kind !== "dir") return nodes;
  const next: FileTreeNodes = { ...nodes };
  let changed = nodes[path] === undefined;
  const childPaths: string[] = [];
  for (const entry of entries) {
    if (!entry.path) continue;
    childPaths.push(entry.path);
    const name = basename(entry.path) || entry.path;
    const hidden = parent.hidden || entry.hidden;
    const existing = nodes[entry.path];
    if (
      existing &&
      existing.kind === entry.kind &&
      existing.name === name &&
      existing.hidden === hidden
    ) {
      continue;
    }
    const sameKind = existing !== undefined && existing.kind === entry.kind;
    next[entry.path] = {
      path: entry.path,
      name,
      kind: entry.kind,
      hidden,
      children: sameKind ? existing.children : [],
      loaded: sameKind ? existing.loaded : false,
      loading: false,
      error: sameKind ? existing.error : undefined,
    };
    changed = true;
  }
  // Prune subtrees of children that disappeared so the map cannot grow
  // without bound across refreshes.
  const kept = new Set(childPaths);
  for (const previousChild of parent.children) {
    if (kept.has(previousChild) || next[previousChild] === undefined) continue;
    for (const key of Object.keys(next)) {
      if (key === previousChild || key.startsWith(`${previousChild}/`)) {
        delete next[key];
        changed = true;
      }
    }
  }
  const parentUnchanged =
    parent.loaded &&
    !parent.loading &&
    parent.error === listError &&
    sameStringArray(parent.children, childPaths);
  if (!parentUnchanged) {
    next[path] = {
      ...parent,
      children: childPaths,
      loaded: true,
      loading: false,
      error: listError,
    };
    changed = true;
  }
  return changed ? next : nodes;
}

export function removeFileTreeNodeSubtree(nodes: FileTreeNodes, path: string): FileTreeNodes {
  if (!path) return nodes;
  const next: FileTreeNodes = {};
  let removed = false;
  for (const [key, node] of Object.entries(nodes)) {
    if (key === path || key.startsWith(`${path}/`)) {
      removed = true;
      continue;
    }
    next[key] = node;
  }
  return removed ? next : nodes;
}

// ---------------------------------------------------------------------------
// Expanded-path list updates (persisted through settings as string arrays)
// ---------------------------------------------------------------------------

export function addExpandedPaths(expanded: string[], paths: readonly string[]): string[] {
  const seen = new Set(expanded);
  let next = expanded;
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    next = next === expanded ? [...expanded, path] : [...next, path];
  }
  return next;
}

export function removeExpandedPath(expanded: string[], target: string): string[] {
  const next = expanded.filter((item) => item !== target);
  return next.length === expanded.length ? expanded : next;
}

export function removeExpandedSubtree(expanded: string[], target: string): string[] {
  const next = expanded.filter((item) => item !== target && !item.startsWith(`${target}/`));
  return next.length === expanded.length ? expanded : next;
}

// Correct rename remap: an exact match maps to `next`; descendants swap only
// the leading `target + "/"` prefix. (The previous implementation filtered
// the target subtree away before mapping — making the map dead code — and
// used String.replace, which substitutes the first occurrence anywhere in
// the string instead of the path prefix.)
export function remapExpandedPathsForRename(
  expanded: string[],
  target: string,
  next: string,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of expanded) {
    let mapped = item;
    if (item === target) {
      mapped = next;
    } else if (item.startsWith(`${target}/`)) {
      mapped = next + item.slice(target.length);
    }
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    result.push(mapped);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Visible-row flattening (expanded set -> flat array for the virtual list)
// ---------------------------------------------------------------------------

export function flattenFileTreeRows(
  nodes: FileTreeNodes,
  expanded: ReadonlySet<string>,
): FileTreeRowModel[] {
  const rows: FileTreeRowModel[] = [];
  const visited = new Set<string>();
  const visit = (path: string, depth: number) => {
    const node = nodes[path];
    if (!node || visited.has(path)) return;
    visited.add(path);
    rows.push({ type: "node", key: path === ROOT_PATH ? "__root__" : path, path, depth });
    if (node.error) {
      rows.push({ type: "error", key: `${path}\u0000error`, path, depth, message: node.error });
    }
    if (node.kind !== "dir" || !expanded.has(path)) return;
    for (const childPath of node.children) {
      visit(childPath, depth + 1);
    }
  };
  visit(ROOT_PATH, 0);
  return rows;
}

// ---------------------------------------------------------------------------
// Per-project LRU state buckets
// ---------------------------------------------------------------------------

export type FileTreeProjectBucket = { nodes: FileTreeNodes };

export type FileTreeBuckets = {
  // Most-recently-used first, capped at FILE_TREE_PROJECT_BUCKET_LIMIT.
  order: string[];
  byProject: Record<string, FileTreeProjectBucket>;
};

export const FILE_TREE_PROJECT_BUCKET_LIMIT = 8;

export function createFileTreeBuckets(): FileTreeBuckets {
  return { order: [], byProject: {} };
}

export function getFileTreeNodes(
  buckets: FileTreeBuckets,
  projectPathKey: string,
  cwd: string,
): FileTreeNodes {
  return buckets.byProject[projectPathKey]?.nodes ?? { [ROOT_PATH]: createRootNode(cwd) };
}

export function updateFileTreeNodes(
  buckets: FileTreeBuckets,
  projectPathKey: string,
  cwd: string,
  update: (nodes: FileTreeNodes) => FileTreeNodes,
): FileTreeBuckets {
  if (!projectPathKey) return buckets;
  const existing = buckets.byProject[projectPathKey];
  const currentNodes = existing?.nodes ?? { [ROOT_PATH]: createRootNode(cwd) };
  const nextNodes = update(currentNodes);
  if (existing && nextNodes === existing.nodes && buckets.order[0] === projectPathKey) {
    return buckets;
  }
  const order = [projectPathKey, ...buckets.order.filter((key) => key !== projectPathKey)];
  const byProject: Record<string, FileTreeProjectBucket> = {
    ...buckets.byProject,
    [projectPathKey]: existing && nextNodes === existing.nodes ? existing : { nodes: nextNodes },
  };
  // LRU eviction: drop the least recently used buckets beyond the cap so the
  // per-project cache cannot grow monotonically over a long session.
  for (const evicted of order.splice(FILE_TREE_PROJECT_BUCKET_LIMIT)) {
    delete byProject[evicted];
  }
  return { order, byProject };
}

export function touchFileTreeBucket(
  buckets: FileTreeBuckets,
  projectPathKey: string,
  cwd: string,
): FileTreeBuckets {
  return updateFileTreeNodes(buckets, projectPathKey, cwd, (nodes) => nodes);
}

// ---------------------------------------------------------------------------
// Workspace-activity invalidation
//
// The shared useWorkspaceInvalidation hook reduces activity events to boolean
// fs/git hints, which is too coarse here: precise subtree refreshes need the
// event's changedPaths. The same dirty-tracking semantics (reset/regression
// => refresh everything, duplicate revisions ignored, inactive panels only
// accumulate dirt) are therefore reimplemented as pure reducers with
// changedPaths accumulation on top.
// ---------------------------------------------------------------------------

export type FileTreeInvalidationState = {
  revision: number | null;
  dirty: boolean;
  refreshAll: boolean;
  changedPaths: string[];
};

export const initialFileTreeInvalidationState: FileTreeInvalidationState = {
  revision: null,
  dirty: false,
  refreshAll: false,
  changedPaths: [],
};

export const FILE_TREE_INVALIDATION_MAX_CHANGED_PATHS = 256;

export function reduceFileTreeInvalidation(
  state: FileTreeInvalidationState,
  payload: WorkspaceActivityEventPayload,
): FileTreeInvalidationState {
  if ("kind" in payload) {
    return { revision: null, dirty: true, refreshAll: true, changedPaths: [] };
  }
  if (state.revision !== null && payload.revision === state.revision) return state;
  const regressed = state.revision !== null && payload.revision < state.revision;
  if (!payload.fs && !regressed) {
    return { ...state, revision: payload.revision };
  }
  let refreshAll = state.refreshAll || regressed || (payload.fs && payload.truncated);
  let changedPaths = state.changedPaths;
  if (refreshAll) {
    changedPaths = [];
  } else {
    changedPaths = [...state.changedPaths];
    for (const changed of payload.changedPaths) {
      changedPaths.push(normalizeFileTreeRelativePath(changed));
    }
    if (changedPaths.length > FILE_TREE_INVALIDATION_MAX_CHANGED_PATHS) {
      refreshAll = true;
      changedPaths = [];
    }
  }
  return { revision: payload.revision, dirty: true, refreshAll, changedPaths };
}

export type FileTreeInvalidationBatch = { refreshAll: boolean; changedPaths: string[] };

export function takeFileTreeInvalidation(state: FileTreeInvalidationState): {
  state: FileTreeInvalidationState;
  batch: FileTreeInvalidationBatch | null;
} {
  if (!state.dirty) return { state, batch: null };
  return {
    state: { revision: state.revision, dirty: false, refreshAll: false, changedPaths: [] },
    batch: { refreshAll: state.refreshAll, changedPaths: state.changedPaths },
  };
}

// Maps an invalidation batch to the set of directories that must be
// force-reloaded. Only directories that are expanded *and* loaded matter: a
// collapsed or never-loaded listing is refetched lazily when it is opened.
export function planFileTreeInvalidationRefresh(
  batch: FileTreeInvalidationBatch,
  nodes: FileTreeNodes,
  expanded: ReadonlySet<string>,
): string[] {
  const refreshable = (path: string) => {
    const node = nodes[path];
    return node !== undefined && node.kind === "dir" && node.loaded && expanded.has(path);
  };
  const allExpandedLoadedDirs = () => {
    const paths: string[] = [];
    for (const path of expanded) {
      if (refreshable(path)) paths.push(path);
    }
    return paths;
  };
  if (batch.refreshAll) return allExpandedLoadedDirs();
  const targets = new Set<string>();
  for (const changed of batch.changedPaths) {
    if (!changed) {
      if (refreshable(ROOT_PATH)) targets.add(ROOT_PATH);
      continue;
    }
    const parent = dirname(changed);
    if (parent !== ROOT_PATH && nodes[parent] === undefined) {
      // Unknown parent: our picture of the hierarchy is stale, so we cannot
      // tell which visible listing this change affects. Fall back to
      // refreshing every expanded directory.
      return allExpandedLoadedDirs();
    }
    if (refreshable(parent)) targets.add(parent);
    // The changed path may itself be a visible directory whose contents were
    // rewritten (collapsed watcher events); refresh it too when on screen.
    if (refreshable(changed)) targets.add(changed);
  }
  return [...targets];
}
