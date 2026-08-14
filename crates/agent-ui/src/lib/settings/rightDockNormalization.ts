import { normalizeIntegerInRange } from "./normalizers";
import {
  RIGHT_DOCK_TOOL_KINDS,
  type RightDockBackgroundTasksState,
  type RightDockFileTreeState,
  type RightDockProjectState,
  type RightDockSettings,
  type RightDockToolKind,
  type RightDockToolTab,
} from "./types";
import { normalizeRightDockFileTreePath, workspaceProjectPathKey } from "./workspaceProjects";

export const RIGHT_DOCK_SINGLETON_TAB_IDS = {
  fileTree: "tool:fileTree",
  gitReview: "tool:gitReview",
  tunnel: "tool:tunnel",
  sshTunnel: "tool:sshTunnel",
} as const satisfies Record<RightDockToolKind, string>;

const RIGHT_DOCK_TOOL_KIND_BY_TAB_ID = new Map<string, RightDockToolKind>(
  RIGHT_DOCK_TOOL_KINDS.map((kind) => [RIGHT_DOCK_SINGLETON_TAB_IDS[kind], kind]),
);

export function rightDockToolKindForTabId(tabId: string): RightDockToolKind | undefined {
  return RIGHT_DOCK_TOOL_KIND_BY_TAB_ID.get(tabId);
}

const RIGHT_DOCK_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_RIGHT_DOCK_PROJECTS = 100;

export const DEFAULT_RIGHT_DOCK_FILE_TREE_STATE: RightDockFileTreeState = {
  query: "",
  selectedPath: "",
  expandedPaths: [""],
  showHidden: false,
  revision: 0,
};

export function normalizeRightDockFileTreeSearchQuery(query: unknown): string {
  return typeof query === "string" ? query.slice(0, 200) : "";
}

export function normalizeRightDockFileTreeExpandedPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [""];
  const normalized = Array.from(
    new Set(
      paths
        .map((path) => normalizeRightDockFileTreePath(path))
        .filter((path) => path.length <= 1024),
    ),
  );
  return normalized.slice(0, 512);
}

export function normalizeRightDockFileTreeState(input: unknown): RightDockFileTreeState {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    query: normalizeRightDockFileTreeSearchQuery(obj.query),
    selectedPath: normalizeRightDockFileTreePath(obj.selectedPath),
    expandedPaths: normalizeRightDockFileTreeExpandedPaths(obj.expandedPaths),
    showHidden: obj.showHidden === true,
    revision: normalizeIntegerInRange(obj.revision, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

export function normalizeRightDockTabOrder(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const order: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || id.length > 160 || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    if (order.length >= 128) break;
  }
  return order;
}

function normalizeRightDockRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!key.trim() || key.length > 80) continue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      Array.isArray(value) ||
      (value && typeof value === "object")
    ) {
      output[key] = value;
    }
    if (Object.keys(output).length >= 64) break;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function normalizeRightDockToolUiState(
  kind: RightDockToolKind,
  input: unknown,
): Record<string, unknown> | undefined {
  if (kind === "fileTree") {
    return normalizeRightDockFileTreeState(input);
  }
  return normalizeRightDockRecord(input);
}

function normalizeRightDockToolTab(kind: RightDockToolKind, input: unknown): RightDockToolTab {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const uiState = normalizeRightDockToolUiState(kind, obj.uiState);
  return {
    openedAt: normalizeIntegerInRange(obj.openedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    ...(uiState ? { uiState } : {}),
  };
}

export function normalizeRightDockProjectState(input: unknown): RightDockProjectState {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const rawTools = (
    obj.tools && typeof obj.tools === "object" && !Array.isArray(obj.tools) ? obj.tools : {}
  ) as Record<string, unknown>;
  const legacyTabs = (
    obj.tabs && typeof obj.tabs === "object" && !Array.isArray(obj.tabs) ? obj.tabs : {}
  ) as Record<string, unknown>;
  const tools: Partial<Record<RightDockToolKind, RightDockToolTab>> = {};
  for (const kind of RIGHT_DOCK_TOOL_KINDS) {
    const raw = rawTools[kind] ?? legacyTabs[RIGHT_DOCK_SINGLETON_TAB_IDS[kind]];
    if (!raw || typeof raw !== "object") continue;
    const legacy = raw as Record<string, unknown>;
    tools[kind] = normalizeRightDockToolTab(
      kind,
      "openedAt" in legacy ? legacy : { ...legacy, openedAt: legacy.createdAt },
    );
  }
  const tabOrder = normalizeRightDockTabOrder(obj.tabOrder);
  for (const kind of RIGHT_DOCK_TOOL_KINDS) {
    const tabId = RIGHT_DOCK_SINGLETON_TAB_IDS[kind];
    if (tools[kind] && !tabOrder.includes(tabId)) tabOrder.push(tabId);
  }
  const rawActiveTabId = typeof obj.activeTabId === "string" ? obj.activeTabId.trim() : "";
  const activeTabId = rawActiveTabId && rawActiveTabId.length <= 160 ? rawActiveTabId : undefined;
  return {
    ...(activeTabId ? { activeTabId } : {}),
    tabOrder,
    tools,
    backgroundTasks: normalizeRightDockBackgroundTasksState(obj.backgroundTasks),
    openVersion: normalizeIntegerInRange(obj.openVersion, 0, Number.MAX_SAFE_INTEGER, 0),
    stateVersion: normalizeIntegerInRange(obj.stateVersion, 0, Number.MAX_SAFE_INTEGER, 0),
    writerId: typeof obj.writerId === "string" ? obj.writerId.trim().slice(0, 32) : "",
    lastUsedAt: normalizeIntegerInRange(obj.lastUsedAt, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

export function normalizeRightDockBackgroundTasksState(
  input: unknown,
): RightDockBackgroundTasksState {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const dismissedIds: string[] = [];
  if (Array.isArray(obj.dismissedIds)) {
    const seen = new Set<string>();
    for (const item of obj.dismissedIds) {
      if (typeof item !== "string") continue;
      const id = item.trim();
      if (!id || id.length > 160 || seen.has(id)) continue;
      seen.add(id);
      dismissedIds.push(id);
      if (dismissedIds.length >= 200) break;
    }
  }
  return {
    opened: obj.opened === true,
    dismissedIds,
  };
}

export function normalizeRightDockSettings(input: unknown): RightDockSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const rawProjects = (
    obj.projects && typeof obj.projects === "object" && !Array.isArray(obj.projects)
      ? obj.projects
      : {}
  ) as Record<string, unknown>;
  const now = Date.now();
  const projects: Record<string, RightDockProjectState> = {};
  for (const [pathKey, projectState] of Object.entries(rawProjects)) {
    const normalizedPathKey = workspaceProjectPathKey(pathKey);
    if (!normalizedPathKey || projects[normalizedPathKey]) continue;
    const project = normalizeRightDockProjectState(projectState);
    const isEmpty =
      Object.keys(project.tools).length === 0 &&
      !project.backgroundTasks.opened &&
      project.backgroundTasks.dismissedIds.length === 0;
    if (isEmpty && project.openVersion === 0 && project.stateVersion === 0) continue;
    if (isEmpty) {
      const tombstonedAt = project.lastUsedAt > 0 ? project.lastUsedAt : now;
      if (now - tombstonedAt > RIGHT_DOCK_TOMBSTONE_TTL_MS) continue;
      projects[normalizedPathKey] = { ...project, lastUsedAt: tombstonedAt };
      continue;
    }
    projects[normalizedPathKey] = project;
  }
  const keys = Object.keys(projects);
  if (keys.length > MAX_RIGHT_DOCK_PROJECTS) {
    keys.sort((a, b) => {
      const byRecency = (projects[b]?.lastUsedAt ?? 0) - (projects[a]?.lastUsedAt ?? 0);
      return byRecency !== 0 ? byRecency : a.localeCompare(b);
    });
    for (const key of keys.slice(MAX_RIGHT_DOCK_PROJECTS)) {
      delete projects[key];
    }
  }
  return {
    width: normalizeIntegerInRange(obj.width, 320, 1280, 420),
    projects,
  };
}
