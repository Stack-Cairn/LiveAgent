import { createUuid } from "@liveagent/ui/lib/shared/id";
import type { WorkspaceProjectGroup } from "@liveagent/ui/lib/workspaceProjectTypes";
import { normalizeStringArray } from "./normalizers";
import {
  DEFAULT_WORKSPACE_PROJECT_ID,
  DEFAULT_WORKSPACE_PROJECT_NAME,
  type SystemSettings,
  type WorkspaceProject,
  type WorkspaceProjectKind,
  type WorkspaceResourceSettings,
  type WorkspaceResourceSettingsMode,
} from "./types";

export function normalizeWorkdir(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

export function normalizeWorkspaceProjectPath(path: unknown): string {
  return typeof path === "string" ? path.trim() : "";
}

function isWindowsProjectPathLike(path: string): boolean {
  if (/^[\\/]{2}\?[\\/]/.test(path)) return true;
  if (/^[A-Za-z]:(?:[\\/]|$)/.test(path)) return true;
  return /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(path);
}

function trimTrailingWindowsProjectSlashes(path: string): string {
  let minLength = 1;
  if (/^[A-Za-z]:\//.test(path)) {
    minLength = 3;
  } else if (path.startsWith("//")) {
    const uncRoot = /^\/\/[^/]+\/[^/]+/.exec(path);
    minLength = uncRoot?.[0].length ?? 2;
  }
  let next = path;
  while (next.length > minLength && next.endsWith("/")) {
    next = next.slice(0, -1);
  }
  return next;
}

function normalizeWindowsProjectPathKey(path: string): string {
  const stripped = path.replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, "//").replace(/^[\\/]{2}\?[\\/]/, "");
  return trimTrailingWindowsProjectSlashes(stripped.replace(/\\/g, "/")).toLowerCase();
}

function normalizePosixProjectPathKey(path: string): string {
  let next = path;
  while (next.length > 1 && next.endsWith("/")) {
    next = next.slice(0, -1);
  }
  return next;
}

export function workspaceProjectPathKey(path: unknown): string {
  const normalizedPath = normalizeWorkspaceProjectPath(path);
  if (!normalizedPath) return "";
  return isWindowsProjectPathLike(normalizedPath)
    ? normalizeWindowsProjectPathKey(normalizedPath)
    : normalizePosixProjectPathKey(normalizedPath);
}

function normalizeWorkspaceResourceSettingsMode(input: unknown): WorkspaceResourceSettingsMode {
  return input === "custom" || input === "off" ? input : "inherit";
}

export function normalizeWorkspaceResourceSettingsEntry(input: unknown): WorkspaceResourceSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const mode = normalizeWorkspaceResourceSettingsMode(obj.mode);
  const stateVersion = Number(obj.stateVersion);
  const updatedAt = Number(obj.updatedAt);
  return {
    mode,
    skillNames: mode === "custom" ? normalizeStringArray(obj.skillNames) : [],
    mcpServerIds: mode === "custom" ? normalizeStringArray(obj.mcpServerIds) : [],
    stateVersion: Number.isSafeInteger(stateVersion) && stateVersion > 0 ? stateVersion : 1,
    writerId: typeof obj.writerId === "string" ? obj.writerId.trim().slice(0, 64) : "",
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
  };
}

const WORKSPACE_RESOURCE_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const MAX_WORKSPACE_RESOURCE_SETTINGS = 256;

export function normalizeWorkspaceResourceSettings(
  input: unknown,
): Record<string, WorkspaceResourceSettings> {
  const source = (
    input && typeof input === "object" && !Array.isArray(input) ? input : {}
  ) as Record<string, unknown>;
  const entries: Record<string, WorkspaceResourceSettings> = {};
  const canonicalKeys = new Set<string>();
  for (const [rawPathKey, rawEntry] of Object.entries(source)) {
    const pathKey = workspaceProjectPathKey(rawPathKey);
    if (!pathKey) continue;
    assignNormalizedProjectKeyValue(
      entries,
      canonicalKeys,
      rawPathKey,
      normalizeWorkspaceResourceSettingsEntry(rawEntry),
    );
  }
  const now = Date.now();
  for (const [pathKey, entry] of Object.entries(entries)) {
    if (
      entry.mode === "inherit" &&
      entry.updatedAt > 0 &&
      now - entry.updatedAt > WORKSPACE_RESOURCE_TOMBSTONE_TTL_MS
    ) {
      delete entries[pathKey];
    }
  }
  const pathKeys = Object.keys(entries);
  if (pathKeys.length > MAX_WORKSPACE_RESOURCE_SETTINGS) {
    pathKeys.sort((a, b) => {
      const aEntry = entries[a];
      const bEntry = entries[b];
      const byActiveMode = Number(bEntry.mode !== "inherit") - Number(aEntry.mode !== "inherit");
      if (byActiveMode !== 0) return byActiveMode;
      const byUpdatedAt = bEntry.updatedAt - aEntry.updatedAt;
      if (byUpdatedAt !== 0) return byUpdatedAt;
      const byVersion = bEntry.stateVersion - aEntry.stateVersion;
      return byVersion !== 0 ? byVersion : compareWorkspaceResourcePathKeys(a, b);
    });
    for (const pathKey of pathKeys.slice(MAX_WORKSPACE_RESOURCE_SETTINGS)) {
      delete entries[pathKey];
    }
  }
  return entries;
}

function compareWorkspaceResourcePathKeys(a: string, b: string): number {
  const aCodePoints = Array.from(a, (value) => value.codePointAt(0) ?? 0);
  const bCodePoints = Array.from(b, (value) => value.codePointAt(0) ?? 0);
  const length = Math.min(aCodePoints.length, bCodePoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = aCodePoints[index] - bCodePoints[index];
    if (difference !== 0) return difference;
  }
  return aCodePoints.length - bCodePoints.length;
}

export function assignNormalizedProjectKeyValue<T>(
  target: Record<string, T>,
  canonicalKeys: Set<string>,
  rawPathKey: string,
  value: T,
): void {
  const normalizedPathKey = workspaceProjectPathKey(rawPathKey);
  if (!normalizedPathKey) return;
  const isCanonicalKey = rawPathKey.trim() === normalizedPathKey;
  const existingIsCanonical = canonicalKeys.has(normalizedPathKey);
  if (isCanonicalKey || !existingIsCanonical) {
    target[normalizedPathKey] = value;
  }
  if (isCanonicalKey) {
    canonicalKeys.add(normalizedPathKey);
  }
}

export function normalizeRightDockFileTreePath(path: unknown): string {
  if (typeof path !== "string") return "";
  return path
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function normalizeWorkspaceProjectKind(input: unknown): WorkspaceProjectKind {
  switch (input) {
    case "managed":
    case "folder":
    case "history":
      return input;
    default:
      return "folder";
  }
}

function normalizeWorkspaceProjectWorktree(
  input: unknown,
): WorkspaceProject["worktree"] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  const repositoryPath = normalizeWorkspaceProjectPath(obj.repositoryPath);
  if (!repositoryPath) return undefined;
  const branch = typeof obj.branch === "string" ? obj.branch.trim() : "";
  return {
    repositoryPath,
    ...(branch ? { branch } : {}),
  };
}

function normalizeWorkspaceProject(input: unknown): WorkspaceProject | null {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const path = normalizeWorkspaceProjectPath(obj.path);
  if (!path) return null;
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : createUuid();
  const name =
    typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : path
          .split(/[\\/]+/)
          .filter(Boolean)
          .pop() || "Project";
  const createdAt =
    typeof obj.createdAt === "number" && Number.isFinite(obj.createdAt) && obj.createdAt > 0
      ? obj.createdAt
      : Date.now();
  const updatedAt =
    typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt) && obj.updatedAt > 0
      ? obj.updatedAt
      : createdAt;
  const lastConversationAt =
    typeof obj.lastConversationAt === "number" &&
    Number.isFinite(obj.lastConversationAt) &&
    obj.lastConversationAt > 0
      ? obj.lastConversationAt
      : undefined;
  const isPinned = obj.isPinned === true;
  const pinnedAt =
    typeof obj.pinnedAt === "number" && Number.isFinite(obj.pinnedAt) && obj.pinnedAt > 0
      ? obj.pinnedAt
      : undefined;
  const worktree = normalizeWorkspaceProjectWorktree(obj.worktree);
  return {
    id,
    name,
    path,
    kind: normalizeWorkspaceProjectKind(obj.kind),
    ...(worktree ? { worktree } : {}),
    createdAt,
    updatedAt,
    ...(lastConversationAt ? { lastConversationAt } : {}),
    ...(isPinned ? { isPinned: true, pinnedAt: pinnedAt ?? updatedAt } : {}),
  };
}

export function normalizeWorkspaceProjectGroups(input: unknown): WorkspaceProjectGroup[] {
  if (!Array.isArray(input)) return [];
  const out: WorkspaceProjectGroup[] = [];
  const seenIds = new Set<string>();
  for (const raw of input) {
    const group = normalizeWorkspaceProjectGroup(raw);
    if (!group) continue;
    if (seenIds.has(group.id)) continue;
    seenIds.add(group.id);
    out.push(group);
  }
  return out;
}

function normalizeWorkspaceProjectGroup(input: unknown): WorkspaceProjectGroup | null {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : createUuid();
  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : "未命名分组";
  const projectPaths: string[] = [];
  const seenPaths = new Set<string>();
  for (const raw of normalizeStringArray(obj.projectPaths)) {
    const path = normalizeWorkspaceProjectPath(raw);
    if (!path) continue;
    const key = workspaceProjectPathKey(path);
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);
    projectPaths.push(path);
  }
  const sourceProjectPath = normalizeWorkspaceProjectPath(obj.sourceProjectPath);
  const createdAt =
    typeof obj.createdAt === "number" && Number.isFinite(obj.createdAt) && obj.createdAt > 0
      ? obj.createdAt
      : Date.now();
  const updatedAt =
    typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt) && obj.updatedAt > 0
      ? obj.updatedAt
      : createdAt;
  return {
    id,
    name,
    projectPaths,
    ...(sourceProjectPath ? { sourceProjectPath } : {}),
    ...(obj.collapsed === true ? { collapsed: true } : {}),
    createdAt,
    updatedAt,
  };
}

export function normalizeWorkspaceProjects(input: unknown): WorkspaceProject[] {
  if (!Array.isArray(input)) return [];
  const out: WorkspaceProject[] = [];
  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();
  for (const raw of input) {
    const project = normalizeWorkspaceProject(raw);
    if (!project) continue;
    const pathKey = workspaceProjectPathKey(project.path);
    if (!pathKey || seenPaths.has(pathKey)) continue;
    seenPaths.add(pathKey);
    let id = project.id;
    if (seenIds.has(id)) {
      id = createUuid();
    }
    seenIds.add(id);
    out.push({ ...project, id });
  }
  return out;
}

export function normalizeHiddenWorkspaceProjectPaths(input: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of normalizeStringArray(input)) {
    const key = workspaceProjectPathKey(path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

export function normalizeMissingWorkspaceProjectPaths(input: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of normalizeStringArray(input)) {
    const key = workspaceProjectPathKey(path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

export function normalizeArchivedWorkspaceProjectPaths(input: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of normalizeStringArray(input)) {
    const key = workspaceProjectPathKey(path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

export function resolveWorkspaceProjects(
  system: SystemSettings,
  defaultWorkdir: string,
): SystemSettings {
  const defaultPath = normalizeWorkspaceProjectPath(defaultWorkdir || system.workdir);
  if (!defaultPath) return system;

  const now = Date.now();
  const defaultKey = workspaceProjectPathKey(defaultPath);
  const configured = normalizeWorkspaceProjects(system.workspaceProjects);
  const defaultExisting = configured.find(
    (project) =>
      project.id === DEFAULT_WORKSPACE_PROJECT_ID ||
      workspaceProjectPathKey(project.path) === defaultKey,
  );
  const defaultProject: WorkspaceProject = {
    id: DEFAULT_WORKSPACE_PROJECT_ID,
    name: DEFAULT_WORKSPACE_PROJECT_NAME,
    path: defaultPath,
    kind: "managed",
    createdAt: defaultExisting?.createdAt ?? now,
    updatedAt: defaultExisting?.updatedAt ?? now,
    ...(defaultExisting?.worktree ? { worktree: defaultExisting.worktree } : {}),
    ...(defaultExisting?.lastConversationAt
      ? { lastConversationAt: defaultExisting.lastConversationAt }
      : {}),
    ...(defaultExisting?.isPinned
      ? { isPinned: true, pinnedAt: defaultExisting.pinnedAt ?? defaultExisting.updatedAt }
      : {}),
  };

  const projects: WorkspaceProject[] = [defaultProject];
  const seenPaths = new Set<string>([defaultKey]);
  const seenIds = new Set<string>([DEFAULT_WORKSPACE_PROJECT_ID]);
  for (const project of configured) {
    const pathKey = workspaceProjectPathKey(project.path);
    if (!pathKey || seenPaths.has(pathKey)) continue;
    seenPaths.add(pathKey);
    let id = project.id;
    if (!id || id === DEFAULT_WORKSPACE_PROJECT_ID || seenIds.has(id)) {
      id = createUuid();
    }
    seenIds.add(id);
    projects.push({
      ...project,
      id,
      name:
        project.name.trim() ||
        project.path
          .split(/[\\/]+/)
          .filter(Boolean)
          .pop() ||
        "Project",
      kind: project.kind,
    });
  }

  const hiddenWorkspaceProjectPaths = normalizeHiddenWorkspaceProjectPaths(
    system.hiddenWorkspaceProjectPaths,
  ).filter((path) => workspaceProjectPathKey(path) !== defaultKey);
  const hiddenWorkspaceProjectPathKeys = new Set(
    hiddenWorkspaceProjectPaths.map(workspaceProjectPathKey),
  );
  const missingWorkspaceProjectPaths = normalizeMissingWorkspaceProjectPaths(
    system.missingWorkspaceProjectPaths,
  ).filter((path) => !hiddenWorkspaceProjectPathKeys.has(workspaceProjectPathKey(path)));
  // Hidden means removed — a removed workspace has nothing left to archive.
  const normalizedArchivedWorkspaceProjectPaths = normalizeArchivedWorkspaceProjectPaths(
    system.archivedWorkspaceProjectPaths,
  ).filter((path) => !hiddenWorkspaceProjectPathKeys.has(workspaceProjectPathKey(path)));
  const normalizedArchivedWorkspaceProjectPathKeys = new Set(
    normalizedArchivedWorkspaceProjectPaths.map(workspaceProjectPathKey),
  );
  const archivedWorkspaceProjectPaths = projects.every((project) =>
    normalizedArchivedWorkspaceProjectPathKeys.has(workspaceProjectPathKey(project.path)),
  )
    ? normalizedArchivedWorkspaceProjectPaths.filter(
        (path) => workspaceProjectPathKey(path) !== defaultKey,
      )
    : normalizedArchivedWorkspaceProjectPaths;
  const archivedWorkspaceProjectPathKeys = new Set(
    archivedWorkspaceProjectPaths.map(workspaceProjectPathKey),
  );
  const selectableProjects = projects.filter(
    (project) => !archivedWorkspaceProjectPathKeys.has(workspaceProjectPathKey(project.path)),
  );
  const activeProjectId = selectableProjects.some(
    (project) => project.id === system.activeWorkspaceProjectId,
  )
    ? system.activeWorkspaceProjectId
    : (selectableProjects.find((project) => project.id === DEFAULT_WORKSPACE_PROJECT_ID)?.id ??
      selectableProjects[0]?.id ??
      DEFAULT_WORKSPACE_PROJECT_ID);
  const activeProject =
    selectableProjects.find((project) => project.id === activeProjectId) ?? defaultProject;
  const workdir = normalizeWorkdir(system.workdir) || defaultPath;

  return {
    ...system,
    workdir,
    workspaceProjects: projects,
    activeWorkspaceProjectId: activeProject.id,
    hiddenWorkspaceProjectPaths,
    missingWorkspaceProjectPaths,
    archivedWorkspaceProjectPaths,
  };
}
