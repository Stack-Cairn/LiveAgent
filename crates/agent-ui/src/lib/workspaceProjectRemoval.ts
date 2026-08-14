import {
  type AppSettings,
  DEFAULT_WORKSPACE_PROJECT_ID,
  removeRightDockProjectState,
  resetWorkspaceResourceSettings,
  resolveWorkspaceProjects,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "@liveagent/app/lib/settings";
import { useCallback } from "react";
import { errorMessageWithFallback } from "./shared/value";
import {
  getDefaultWorkspaceProjectPath,
  removeWorkspaceProjectFromGroups,
} from "./workspaceProjects";

type WorkspaceProjectSettingsActionsParams = {
  setSettings: (updater: (previousSettings: AppSettings) => AppSettings) => void;
  workspaceProjects: readonly WorkspaceProject[];
  archivedWorkspaceProjectPathKeys: ReadonlySet<string>;
  activeWorkspaceProject: WorkspaceProject | undefined;
  activateWorkspaceProject: (project: WorkspaceProject) => void;
  setActiveWorkspaceProjectId: (updater: (current: string) => string) => void;
  t: (key: string) => string;
  setErrorMessage: (message: string | null) => void;
  beforeRemoveWorkspaceProject?: (project: WorkspaceProject) => void | Promise<void>;
};

export function workspaceProjectsMatch(
  left: WorkspaceProject | undefined,
  right: WorkspaceProject,
) {
  if (!left) return false;
  if (left.id === right.id) return true;
  const rightPathKey = workspaceProjectPathKey(right.path);
  return Boolean(rightPathKey && workspaceProjectPathKey(left.path) === rightPathKey);
}

export function findWorkspaceProjectByPath(
  workspaceProjects: readonly WorkspaceProject[],
  path: string,
) {
  const pathKey = workspaceProjectPathKey(path);
  if (!pathKey) return undefined;
  return workspaceProjects.find((project) => workspaceProjectPathKey(project.path) === pathKey);
}

export function findWorkspaceProjectArchiveFallback(
  project: WorkspaceProject,
  workspaceProjects: readonly WorkspaceProject[],
  archivedWorkspaceProjectPathKeys: ReadonlySet<string>,
) {
  const pathKey = workspaceProjectPathKey(project.path);
  if (!pathKey || archivedWorkspaceProjectPathKeys.has(pathKey)) return undefined;
  return workspaceProjects.find(
    (item) =>
      !workspaceProjectsMatch(item, project) &&
      !archivedWorkspaceProjectPathKeys.has(workspaceProjectPathKey(item.path)),
  );
}

export function archiveWorkspaceProjectInSettings(
  previousSettings: AppSettings,
  project: WorkspaceProject,
) {
  const path = project.path.trim();
  const pathKey = workspaceProjectPathKey(path);
  if (
    !pathKey ||
    previousSettings.system.archivedWorkspaceProjectPaths.some(
      (item) => workspaceProjectPathKey(item) === pathKey,
    )
  ) {
    return previousSettings;
  }
  return {
    ...previousSettings,
    system: {
      ...previousSettings.system,
      archivedWorkspaceProjectPaths: [
        ...previousSettings.system.archivedWorkspaceProjectPaths,
        path,
      ],
    },
  };
}

export function unarchiveWorkspaceProjectInSettings(
  previousSettings: AppSettings,
  project: WorkspaceProject,
) {
  const pathKey = workspaceProjectPathKey(project.path);
  if (!pathKey) return previousSettings;
  const archivedWorkspaceProjectPaths =
    previousSettings.system.archivedWorkspaceProjectPaths.filter(
      (item) => workspaceProjectPathKey(item) !== pathKey,
    );
  if (
    archivedWorkspaceProjectPaths.length ===
    previousSettings.system.archivedWorkspaceProjectPaths.length
  ) {
    return previousSettings;
  }
  return {
    ...previousSettings,
    system: {
      ...previousSettings.system,
      archivedWorkspaceProjectPaths,
    },
  };
}

export function useWorkspaceProjectSettingsActions(params: WorkspaceProjectSettingsActionsParams) {
  const {
    setSettings,
    workspaceProjects,
    archivedWorkspaceProjectPathKeys,
    activeWorkspaceProject,
    activateWorkspaceProject,
    setActiveWorkspaceProjectId,
    t,
    setErrorMessage,
    beforeRemoveWorkspaceProject,
  } = params;

  const handleRemoveWorkspaceProjectFromSettings = useCallback(
    (project: WorkspaceProject) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
      setActiveWorkspaceProjectId((current) =>
        resolveActiveWorkspaceProjectIdAfterRemoval(current, project, workspaceProjects),
      );
      setSettings((previousSettings) =>
        removeWorkspaceProjectFromSettings(
          previousSettings,
          project,
          workspaceProjects,
          archivedWorkspaceProjectPathKeys,
        ),
      );
    },
    [archivedWorkspaceProjectPathKeys, setActiveWorkspaceProjectId, setSettings, workspaceProjects],
  );

  const handleArchiveWorkspaceProject = useCallback(
    (project: WorkspaceProject) => {
      const fallbackProject = findWorkspaceProjectArchiveFallback(
        project,
        workspaceProjects,
        archivedWorkspaceProjectPathKeys,
      );
      if (!fallbackProject) return;
      if (workspaceProjectsMatch(activeWorkspaceProject, project)) {
        activateWorkspaceProject(fallbackProject);
      }
      setSettings((previousSettings) =>
        archiveWorkspaceProjectInSettings(previousSettings, project),
      );
    },
    [
      activateWorkspaceProject,
      activeWorkspaceProject,
      archivedWorkspaceProjectPathKeys,
      setSettings,
      workspaceProjects,
    ],
  );

  const removeWorkspaceProject = useCallback(
    async (project: WorkspaceProject) => {
      try {
        await beforeRemoveWorkspaceProject?.(project);
        handleRemoveWorkspaceProjectFromSettings(project);
        return true;
      } catch (error) {
        setErrorMessage(errorMessageWithFallback(error, t("chat.workspaceRootGrantsRevokeFailed")));
        return false;
      }
    },
    [beforeRemoveWorkspaceProject, handleRemoveWorkspaceProjectFromSettings, setErrorMessage, t],
  );

  const handleUnarchiveWorkspaceProject = useCallback(
    (project: WorkspaceProject) => {
      setSettings((previousSettings) =>
        unarchiveWorkspaceProjectInSettings(previousSettings, project),
      );
    },
    [setSettings],
  );

  const handleWorktreeRemoved = useCallback(
    async (worktree: { path: string }) => {
      const project = findWorkspaceProjectByPath(workspaceProjects, worktree.path);
      if (project) await removeWorkspaceProject(project);
    },
    [removeWorkspaceProject, workspaceProjects],
  );

  return {
    removeWorkspaceProjectFromSettings: handleRemoveWorkspaceProjectFromSettings,
    removeWorkspaceProject,
    handleArchiveWorkspaceProject,
    handleUnarchiveWorkspaceProject,
    handleWorktreeRemoved,
  };
}

export function resolveActiveWorkspaceProjectIdAfterRemoval(
  currentProjectId: string,
  removedProject: WorkspaceProject,
  workspaceProjects: readonly WorkspaceProject[],
) {
  const removedPathKey = workspaceProjectPathKey(removedProject.path);
  const currentProject = workspaceProjects.find((project) => project.id === currentProjectId);
  return currentProjectId === removedProject.id ||
    (removedPathKey &&
      currentProject &&
      workspaceProjectPathKey(currentProject.path) === removedPathKey)
    ? DEFAULT_WORKSPACE_PROJECT_ID
    : currentProjectId;
}

export function removeWorkspaceProjectFromSettings(
  previousSettings: AppSettings,
  removedProject: WorkspaceProject,
  workspaceProjects: readonly WorkspaceProject[],
  archivedWorkspaceProjectPathKeys: ReadonlySet<string>,
) {
  if (removedProject.id === DEFAULT_WORKSPACE_PROJECT_ID) return previousSettings;

  const path = removedProject.path.trim();
  const pathKey = workspaceProjectPathKey(path);
  const hasOtherActiveProjects = workspaceProjects.some(
    (project) =>
      project.id !== removedProject.id &&
      workspaceProjectPathKey(project.path) !== pathKey &&
      !archivedWorkspaceProjectPathKeys.has(workspaceProjectPathKey(project.path)),
  );
  const hiddenWorkspaceProjectPaths =
    pathKey &&
    previousSettings.system.hiddenWorkspaceProjectPaths.some(
      (item) => workspaceProjectPathKey(item) === pathKey,
    )
      ? previousSettings.system.hiddenWorkspaceProjectPaths
      : path
        ? [...previousSettings.system.hiddenWorkspaceProjectPaths, path]
        : previousSettings.system.hiddenWorkspaceProjectPaths;
  const nextSettings = {
    ...previousSettings,
    system: resolveWorkspaceProjects(
      {
        ...previousSettings.system,
        workspaceProjects: previousSettings.system.workspaceProjects.filter(
          (project) =>
            project.id !== removedProject.id && workspaceProjectPathKey(project.path) !== pathKey,
        ),
        workspaceProjectGroups: removeWorkspaceProjectFromGroups(
          previousSettings.system.workspaceProjectGroups,
          path,
        ),
        hiddenWorkspaceProjectPaths,
        missingWorkspaceProjectPaths: previousSettings.system.missingWorkspaceProjectPaths.filter(
          (item) => workspaceProjectPathKey(item) !== pathKey,
        ),
        archivedWorkspaceProjectPaths: previousSettings.system.archivedWorkspaceProjectPaths.filter(
          (item) => {
            const itemKey = workspaceProjectPathKey(item);
            if (itemKey === pathKey) return false;
            return (
              hasOtherActiveProjects ||
              itemKey !==
                workspaceProjectPathKey(getDefaultWorkspaceProjectPath(previousSettings.system))
            );
          },
        ),
      },
      getDefaultWorkspaceProjectPath(previousSettings.system),
    ),
  };

  return removeRightDockProjectState(
    resetWorkspaceResourceSettings(nextSettings, pathKey),
    pathKey,
  );
}
