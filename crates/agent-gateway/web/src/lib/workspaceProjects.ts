import {
  DEFAULT_WORKSPACE_PROJECT_ID,
  DEFAULT_WORKSPACE_PROJECT_NAME,
  type SystemSettings,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "./settings";
import type { SidebarWorkdirSummary } from "./sidebar/types";

type WorkspaceProjectActivitySource = {
  path?: string;
  cwd?: string;
  updatedAt?: number;
};

const MAX_PERSISTED_PROJECT_ACTIVITY_ENTRIES = 200;
const EMPTY_PROJECT_ACTIVITY_UPDATED_ATS = new Map<string, number>();
const EMPTY_RUNNING_PROJECT_PATH_KEYS = new Set<string>();

export function fallbackWorkspaceProjectName(path: string) {
  return (
    path
      .trim()
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() || "Project"
  );
}

function stableProjectIdForPath(path: string) {
  let hash = 2166136261;
  for (const ch of path) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `history-${(hash >>> 0).toString(16)}`;
}

function normalizeActivityUpdatedAt(updatedAt?: number | null) {
  return typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt > 0
    ? updatedAt
    : Date.now();
}

function readProjectLastConversationAt(project: WorkspaceProject) {
  return typeof project.lastConversationAt === "number" &&
    Number.isFinite(project.lastConversationAt) &&
    project.lastConversationAt > 0
    ? project.lastConversationAt
    : 0;
}

function readProjectPinnedAt(project: WorkspaceProject) {
  return project.isPinned === true &&
    typeof project.pinnedAt === "number" &&
    Number.isFinite(project.pinnedAt) &&
    project.pinnedAt > 0
    ? project.pinnedAt
    : 0;
}

function createHistoryWorkspaceProjectFromPath(path: string, updatedAt?: number | null) {
  const normalizedPath = path.trim();
  const activityUpdatedAt = normalizeActivityUpdatedAt(updatedAt);
  return {
    id: stableProjectIdForPath(normalizedPath),
    name: fallbackWorkspaceProjectName(normalizedPath),
    path: normalizedPath,
    kind: "history",
    createdAt: activityUpdatedAt,
    updatedAt: activityUpdatedAt,
    lastConversationAt: activityUpdatedAt,
  } satisfies WorkspaceProject;
}

export function mergeWorkspaceProjectsWithHistory(
  system: SystemSettings,
  historyWorkdirs: readonly SidebarWorkdirSummary[],
) {
  const hidden = new Set(system.hiddenWorkspaceProjectPaths.map(workspaceProjectPathKey));
  const historyActivity = buildWorkspaceProjectActivityUpdatedAts(historyWorkdirs);
  const projects: WorkspaceProject[] = [];
  const seenPaths = new Set<string>();

  for (const project of system.workspaceProjects) {
    const key = workspaceProjectPathKey(project.path);
    if (!key || seenPaths.has(key)) continue;
    seenPaths.add(key);
    const lastConversationAt = Math.max(
      readProjectLastConversationAt(project),
      historyActivity.get(key) ?? 0,
    );
    projects.push(
      lastConversationAt > readProjectLastConversationAt(project)
        ? {
            ...project,
            lastConversationAt,
          }
        : project,
    );
  }

  for (const item of historyWorkdirs) {
    const path = item.path.trim();
    const key = workspaceProjectPathKey(path);
    if (!path || !key || seenPaths.has(key) || hidden.has(key)) continue;
    seenPaths.add(key);
    projects.push(createHistoryWorkspaceProjectFromPath(path, item.updatedAt));
  }

  const defaultProjectIndex = projects.findIndex(
    (project) => project.id === DEFAULT_WORKSPACE_PROJECT_ID,
  );
  if (defaultProjectIndex > 0) {
    const [defaultProject] = projects.splice(defaultProjectIndex, 1);
    projects.unshift({
      ...defaultProject,
      id: DEFAULT_WORKSPACE_PROJECT_ID,
      name: DEFAULT_WORKSPACE_PROJECT_NAME,
      kind: "managed",
    });
  }

  return projects;
}

export function buildWorkspaceProjectActivityUpdatedAts(
  sources: readonly WorkspaceProjectActivitySource[],
) {
  const updatedAts = new Map<string, number>();

  for (const source of sources) {
    const path = (source.path ?? source.cwd ?? "").trim();
    const key = workspaceProjectPathKey(path);
    const updatedAt =
      typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt)
        ? source.updatedAt
        : 0;
    if (!key || updatedAt <= 0) {
      continue;
    }

    const existing = updatedAts.get(key) ?? 0;
    if (updatedAt > existing) {
      updatedAts.set(key, updatedAt);
    }
  }

  return updatedAts;
}

function applyWorkspaceProjectConversationActivity(
  projects: readonly WorkspaceProject[],
  workdir?: string | null,
  updatedAt?: number | null,
) {
  const path = (workdir ?? "").trim();
  const pathKey = workspaceProjectPathKey(path);
  if (!pathKey) {
    return null;
  }

  const nextUpdatedAt = normalizeActivityUpdatedAt(updatedAt);
  let matched = false;
  let changed = false;
  const nextProjects = projects.map((project) => {
    if (workspaceProjectPathKey(project.path) !== pathKey) {
      return project;
    }
    matched = true;
    if (readProjectLastConversationAt(project) >= nextUpdatedAt) {
      return project;
    }
    changed = true;
    return {
      ...project,
      lastConversationAt: nextUpdatedAt,
    };
  });

  if (!matched) {
    changed = true;
    nextProjects.push(createHistoryWorkspaceProjectFromPath(path, nextUpdatedAt));
  }

  return changed ? nextProjects : null;
}

export function applyWorkspaceProjectConversationActivityMap(
  projects: readonly WorkspaceProject[],
  projectActivityUpdatedAts: ReadonlyMap<string, number>,
  options?: {
    hiddenProjectPathKeys?: ReadonlySet<string>;
  },
) {
  let nextProjects: WorkspaceProject[] = [...projects];
  let changed = false;

  for (const [pathKey, updatedAt] of projectActivityUpdatedAts) {
    if (options?.hiddenProjectPathKeys?.has(workspaceProjectPathKey(pathKey))) {
      continue;
    }
    const applied = applyWorkspaceProjectConversationActivity(nextProjects, pathKey, updatedAt);
    if (applied) {
      nextProjects = applied;
      changed = true;
    }
  }

  return changed ? nextProjects : null;
}

export function mergeWorkspaceProjectActivityUpdatedAts(
  ...sources: Array<ReadonlyMap<string, number> | undefined>
) {
  const updatedAts = new Map<string, number>();

  for (const source of sources) {
    if (!source) continue;
    for (const [path, updatedAt] of source) {
      const key = workspaceProjectPathKey(path);
      if (!key || !Number.isFinite(updatedAt) || updatedAt <= 0) {
        continue;
      }
      if (updatedAt > (updatedAts.get(key) ?? 0)) {
        updatedAts.set(key, updatedAt);
      }
    }
  }

  return trimWorkspaceProjectActivityUpdatedAts(updatedAts);
}

export function workspaceProjectActivityUpdatedAtsEqual(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
) {
  if (left.size !== right.size) {
    return false;
  }
  for (const [pathKey, updatedAt] of left) {
    if (right.get(pathKey) !== updatedAt) {
      return false;
    }
  }
  return true;
}

function trimWorkspaceProjectActivityUpdatedAts(
  source: ReadonlyMap<string, number>,
  limit = MAX_PERSISTED_PROJECT_ACTIVITY_ENTRIES,
) {
  const maxEntries = Math.max(0, Math.floor(limit));
  if (maxEntries === 0) {
    return new Map<string, number>();
  }

  return new Map(
    Array.from(source.entries())
      .filter(([path, updatedAt]) => {
        const key = workspaceProjectPathKey(path);
        return Boolean(key) && Number.isFinite(updatedAt) && updatedAt > 0;
      })
      .sort((left, right) => {
        const updatedAtDelta = right[1] - left[1];
        if (updatedAtDelta !== 0) {
          return updatedAtDelta;
        }
        return left[0].localeCompare(right[0]);
      })
      .slice(0, maxEntries)
      .map(([path, updatedAt]) => [workspaceProjectPathKey(path), updatedAt]),
  );
}

export function sortWorkspaceProjectsByActivity(
  projects: readonly WorkspaceProject[],
  options?: {
    projectActivityUpdatedAts?: ReadonlyMap<string, number>;
    runningProjectPathKeys?: ReadonlySet<string>;
  },
) {
  if (projects.length < 2) {
    return [...projects];
  }

  const projectActivityUpdatedAts =
    options?.projectActivityUpdatedAts ?? EMPTY_PROJECT_ACTIVITY_UPDATED_ATS;
  const runningProjectPathKeys = options?.runningProjectPathKeys ?? EMPTY_RUNNING_PROJECT_PATH_KEYS;

  return [...projects]
    .map((project, index) => {
      const pathKey = workspaceProjectPathKey(project.path);
      const activityUpdatedAt = Math.max(
        projectActivityUpdatedAts.get(pathKey) ?? 0,
        readProjectLastConversationAt(project),
      );
      return {
        project,
        pathKey,
        index,
        isRunning: runningProjectPathKeys.has(pathKey),
        activityUpdatedAt,
      };
    })
    .sort((left, right) => {
      const leftIsPinned = left.project.isPinned === true;
      const rightIsPinned = right.project.isPinned === true;
      if (leftIsPinned !== rightIsPinned) {
        return leftIsPinned ? -1 : 1;
      }
      if (leftIsPinned && rightIsPinned) {
        const pinnedDelta = readProjectPinnedAt(right.project) - readProjectPinnedAt(left.project);
        if (pinnedDelta !== 0) {
          return pinnedDelta;
        }
      }
      if (left.isRunning !== right.isRunning) {
        return left.isRunning ? -1 : 1;
      }
      const activityDelta = right.activityUpdatedAt - left.activityUpdatedAt;
      if (activityDelta !== 0) {
        return activityDelta;
      }
      const leftIsDefault = left.project.id === DEFAULT_WORKSPACE_PROJECT_ID;
      const rightIsDefault = right.project.id === DEFAULT_WORKSPACE_PROJECT_ID;
      if (leftIsDefault !== rightIsDefault && left.activityUpdatedAt === 0) {
        return leftIsDefault ? -1 : 1;
      }
      const pathDelta = left.pathKey.localeCompare(right.pathKey);
      if (pathDelta !== 0) {
        return pathDelta;
      }
      return left.index - right.index;
    })
    .map(({ project }) => project);
}

export function findWorkspaceProject(
  projects: readonly WorkspaceProject[],
  projectId: string | undefined,
) {
  return (
    projects.find((project) => project.id === projectId) ??
    projects.find((project) => project.id === DEFAULT_WORKSPACE_PROJECT_ID) ??
    projects[0]
  );
}
