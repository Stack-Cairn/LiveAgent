import {
  DEFAULT_WORKSPACE_PROJECT_ID,
  DEFAULT_WORKSPACE_PROJECT_NAME,
  type SystemSettings,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "@liveagent/app/lib/settings";
import { createUuid } from "./shared/id";
import type { SidebarWorkdirSummary } from "./sidebar/types";
import type { WorkspaceProjectGroup } from "./workspaceProjectTypes";

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

export function getDefaultWorkspaceProjectPath(system: SystemSettings) {
  return (
    system.workspaceProjects.find((project) => project.id === DEFAULT_WORKSPACE_PROJECT_ID)?.path ||
    system.workdir
  );
}

export function createWorkspaceProjectFromPath(path: string, kind: WorkspaceProject["kind"]) {
  const now = Date.now();
  return {
    id: `${kind}-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: fallbackWorkspaceProjectName(path),
    path,
    kind,
    createdAt: now,
    updatedAt: now,
  } satisfies WorkspaceProject;
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

// ---------------------------------------------------------------------------
// 侧边栏项目分组（纯函数）：分组定义存 settings.system.workspaceProjectGroups，
// 成员用原始路径存储，匹配时经 workspaceProjectPathKey 归一化。
// ---------------------------------------------------------------------------

/** 把项目移入目标分组：先解除其他分组的归属，再幂等加入目标组。 */
export function assignWorkspaceProjectToGroup(
  groups: readonly WorkspaceProjectGroup[],
  groupId: string,
  projectPath: string,
): WorkspaceProjectGroup[] {
  const targetKey = workspaceProjectPathKey(projectPath);
  if (!targetKey) return [...groups];
  let touched = false;
  const next = groups.map((group) => {
    const keys = group.projectPaths.map(workspaceProjectPathKey);
    const hasTarget = keys.includes(targetKey);
    const isTargetGroup = group.id === groupId;
    if (isTargetGroup && hasTarget) return group;
    if (!isTargetGroup && !hasTarget) return group;
    touched = true;
    return {
      ...group,
      updatedAt: Date.now(),
      projectPaths: isTargetGroup
        ? [...group.projectPaths, projectPath]
        : group.projectPaths.filter((path) => workspaceProjectPathKey(path) !== targetKey),
    };
  });
  // 无变化时返回原引用，让调用方的 `next === prev` 短路生效，
  // 避免幂等操作触发多余的 settings 写入/同步。参数虽声明 readonly，
  // 实际调用方（settings 系统）传入的都是可变数组，原样返回满足契约。
  return touched ? next : (groups as WorkspaceProjectGroup[]);
}

/** 从所有分组移除项目路径，避免删除工作空间后留下不可见的陈旧成员。 */
export function removeWorkspaceProjectFromGroups(
  groups: readonly WorkspaceProjectGroup[],
  projectPath: string,
): WorkspaceProjectGroup[] {
  const targetKey = workspaceProjectPathKey(projectPath);
  if (!targetKey) return groups as WorkspaceProjectGroup[];
  let touched = false;
  const updatedAt = Date.now();
  const next = groups.map((group) => {
    const projectPaths = group.projectPaths.filter(
      (path) => workspaceProjectPathKey(path) !== targetKey,
    );
    if (projectPaths.length === group.projectPaths.length) return group;
    touched = true;
    return {
      ...group,
      projectPaths,
      updatedAt,
    };
  });
  return touched ? next : (groups as WorkspaceProjectGroup[]);
}

/**
 * 为 worktree 派生工作区创建/复用自动分组：按 `sourceProjectPath` 匹配
 * （而非名称），用户重命名分组后仍能复用同一个组。
 */
export function ensureWorktreeProjectGroup(
  groups: readonly WorkspaceProjectGroup[],
  options: { name: string; sourceProjectPath: string; now?: number },
): { groups: readonly WorkspaceProjectGroup[]; groupId: string } {
  const sourceKey = workspaceProjectPathKey(options.sourceProjectPath);
  if (!sourceKey) {
    throw new Error("ensureWorktreeProjectGroup requires a valid source project path");
  }
  const existing = groups.find(
    (group) =>
      group.sourceProjectPath && workspaceProjectPathKey(group.sourceProjectPath) === sourceKey,
  );
  if (existing) return { groups, groupId: existing.id };
  const now = options.now ?? Date.now();
  const group: WorkspaceProjectGroup = {
    id: createUuid(),
    name: options.name,
    projectPaths: [],
    sourceProjectPath: options.sourceProjectPath,
    createdAt: now,
    updatedAt: now,
  };
  return { groups: [...groups, group], groupId: group.id };
}

/**
 * 把已按活动排序的项目列表组装成侧边栏区块：分组区块 + 未分组项目。
 *
 * - 组内成员按输入排序保持顺序；组间按组内最早成员的下标排序，
 *   让 pinned/running 成员把整组提前。
 * - 组内路径在列表中不存在时被忽略；空组仍保留（用户可从 UI 删除）。
 */
export type WorkspaceProjectSection = {
  group: WorkspaceProjectGroup;
  projects: WorkspaceProject[];
};

export type WorkspaceProjectSections = {
  grouped: WorkspaceProjectSection[];
  ungrouped: WorkspaceProject[];
};

/** 返回未分组项目中 pinned 区块与普通区块之间的分隔位置。 */
export function firstUnpinnedWorkspaceProjectIndex(projects: readonly WorkspaceProject[]) {
  if (projects[0]?.isPinned !== true) return -1;
  const index = projects.findIndex((project) => project.isPinned !== true);
  return index >= 0 ? index : -1;
}

export function buildWorkspaceProjectSections(
  projects: readonly WorkspaceProject[],
  groups: readonly WorkspaceProjectGroup[],
): WorkspaceProjectSections {
  const indexByPathKey = new Map<string, number>();
  const byPathKey = new Map<string, WorkspaceProject>();
  projects.forEach((project, index) => {
    const key = workspaceProjectPathKey(project.path);
    if (!key) return;
    indexByPathKey.set(key, index);
    byPathKey.set(key, project);
  });

  const groupedPathKeys = new Set<string>();
  const grouped: WorkspaceProjectSection[] = groups.map((group) => {
    const members: WorkspaceProject[] = [];
    const seen = new Set<string>();
    for (const path of group.projectPaths) {
      const key = workspaceProjectPathKey(path);
      const project = key ? byPathKey.get(key) : undefined;
      if (!project || seen.has(key)) continue;
      seen.add(key);
      members.push(project);
      groupedPathKeys.add(key);
    }
    return { group, projects: members };
  });
  const sectionMinIndex = (section: WorkspaceProjectSection) =>
    section.projects.reduce(
      (min, project) =>
        Math.min(
          min,
          indexByPathKey.get(workspaceProjectPathKey(project.path)) ?? Number.MAX_SAFE_INTEGER,
        ),
      Number.MAX_SAFE_INTEGER,
    );
  grouped.sort((left, right) => sectionMinIndex(left) - sectionMinIndex(right));
  const ungrouped = projects.filter(
    (project) => !groupedPathKeys.has(workspaceProjectPathKey(project.path)),
  );
  return { grouped, ungrouped };
}

/** 折叠视图按区块切片（绝不拆开分组）；hiddenProjectCount 为被隐藏的成员数。
 * 上限是项目总数：分组整组纳入直到容量耗尽，剩余容量分给未分组项目，
 * 保证未分组项目（常见场景）也受渲染上限约束。
 */
export function sliceWorkspaceProjectSections(
  sections: WorkspaceProjectSections,
  maxGrouped: number,
): { sections: WorkspaceProjectSections; hiddenProjectCount: number } {
  const grouped: WorkspaceProjectSection[] = [];
  let usedMembers = 0;
  for (const section of sections.grouped) {
    if (usedMembers + section.projects.length > maxGrouped) break;
    grouped.push(section);
    usedMembers += section.projects.length;
  }
  const ungrouped = sections.ungrouped.slice(0, Math.max(0, maxGrouped - usedMembers));
  const totalMembers =
    sections.ungrouped.length +
    sections.grouped.reduce((sum, section) => sum + section.projects.length, 0);
  const visibleMembers = usedMembers + ungrouped.length;
  return {
    sections: { grouped, ungrouped },
    hiddenProjectCount: Math.max(0, totalMembers - visibleMembers),
  };
}
