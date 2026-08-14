import type { ApplicationViewId } from "@liveagent/ui/application/ApplicationView";
import type { WorkspaceCloneTask } from "@liveagent/ui/components/chat/WorkspaceCloneTaskOverlay";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import type { SidebarWorkdirSummary } from "@liveagent/ui/lib/sidebar/types";
import {
  assignWorkspaceProjectToGroup,
  createWorkspaceProjectFromPath,
  ensureWorktreeProjectGroup,
  fallbackWorkspaceProjectName,
  findWorkspaceProject,
  getDefaultWorkspaceProjectPath,
  mergeWorkspaceProjectsWithHistory,
} from "@liveagent/ui/lib/workspaceProjects";
import type { WorkspaceProjectGroup } from "@liveagent/ui/lib/workspaceProjectTypes";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";
import {
  type AppSettings,
  DEFAULT_WORKSPACE_PROJECT_ID,
  openRightDockSingletonTab,
  resolveWorkspaceProjects,
  updateCustomSettings,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "@/lib/settings";

import { isMobileSidebarLayout } from "../historyUtils";

type StartNewConversation = (options?: {
  workdir?: string;
  preserveCurrentComposerDraft?: boolean;
}) => void;

type UseGatewayWorkspaceProjectsOptions = {
  api: GatewayWebSocketClientLike | null;
  displayedConversationWorkdirRef: MutableRefObject<string>;
  setActiveView: Dispatch<SetStateAction<ApplicationViewId>>;
  setRightDockOpen: Dispatch<SetStateAction<boolean>>;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  settings: AppSettings;
  sidebarStore: SidebarStore;
  sidebarWorkdirs: readonly SidebarWorkdirSummary[];
  startNewConversationRef: MutableRefObject<StartNewConversation>;
};

export function useGatewayWorkspaceProjects({
  api,
  displayedConversationWorkdirRef,
  setActiveView,
  setRightDockOpen,
  setSettings,
  setSidebarOpen,
  settings,
  sidebarStore,
  sidebarWorkdirs,
  startNewConversationRef,
}: UseGatewayWorkspaceProjectsOptions) {
  const [workspaceCloneTasks, setWorkspaceCloneTasks] = useState<WorkspaceCloneTask[]>([]);
  const dismissedWorkspaceCloneTaskIds = useRef(new Set<string>());
  const [activeWorkspaceProjectId, setActiveWorkspaceProjectId] = useState<string>(
    () => settings.system.activeWorkspaceProjectId?.trim() || DEFAULT_WORKSPACE_PROJECT_ID,
  );
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [workspaceCreateModalOpen, setWorkspaceCreateModalOpen] = useState(false);
  const [projectRenamingId, setProjectRenamingId] = useState<string | null>(null);
  const [projectRenameDraft, setProjectRenameDraft] = useState("");

  const missingWorkspaceProjectPathKeys = useMemo(
    () => new Set(settings.system.missingWorkspaceProjectPaths.map(workspaceProjectPathKey)),
    [settings.system.missingWorkspaceProjectPaths],
  );
  const workspaceProjects = useMemo(
    () => mergeWorkspaceProjectsWithHistory(settings.system, sidebarWorkdirs),
    [settings.system, sidebarWorkdirs],
  );
  const archivedWorkspaceProjectPathKeys = useMemo(
    () => new Set(settings.system.archivedWorkspaceProjectPaths.map(workspaceProjectPathKey)),
    [settings.system.archivedWorkspaceProjectPaths],
  );
  const selectableWorkspaceProjects = useMemo(() => {
    const active = workspaceProjects.filter(
      (project) => !archivedWorkspaceProjectPathKeys.has(workspaceProjectPathKey(project.path)),
    );
    return active.length > 0 ? active : workspaceProjects;
  }, [archivedWorkspaceProjectPathKeys, workspaceProjects]);
  const activeWorkspaceProject = useMemo(
    () => findWorkspaceProject(selectableWorkspaceProjects, activeWorkspaceProjectId),
    [activeWorkspaceProjectId, selectableWorkspaceProjects],
  );
  const activeWorkspaceProjectPath = activeWorkspaceProject?.path.trim() ?? "";

  useEffect(() => {
    if (activeWorkspaceProject?.id && activeWorkspaceProject.id !== activeWorkspaceProjectId) {
      setActiveWorkspaceProjectId(activeWorkspaceProject.id);
    }
  }, [activeWorkspaceProject?.id, activeWorkspaceProjectId]);

  useEffect(() => {
    sidebarStore.setScope(
      settings.system.executionMode !== "text"
        ? activeWorkspaceProjectPath
          ? { kind: "workdir", cwd: activeWorkspaceProjectPath }
          : { kind: "none" }
        : { kind: "unscoped" },
    );
  }, [activeWorkspaceProjectPath, settings.system.executionMode, sidebarStore]);

  const setWorkspaceProjectDirectoryMissing = useCallback(
    (project: WorkspaceProject, missing: boolean) => {
      const key = workspaceProjectPathKey(project.path);
      const path = project.path.trim();
      if (!key || !path) return;
      setSettings((prev) => {
        const hasMissingPath = prev.system.missingWorkspaceProjectPaths.some(
          (item) => workspaceProjectPathKey(item) === key,
        );
        if (hasMissingPath === missing) return prev;
        const missingWorkspaceProjectPaths = missing
          ? [...prev.system.missingWorkspaceProjectPaths, path]
          : prev.system.missingWorkspaceProjectPaths.filter(
              (item) => workspaceProjectPathKey(item) !== key,
            );
        return {
          ...prev,
          system: resolveWorkspaceProjects(
            { ...prev.system, missingWorkspaceProjectPaths },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const checkWorkspaceProjectDirectory = useCallback(
    async (project: WorkspaceProject, currentApi = api) => {
      const path = project.path.trim();
      if (!path) {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
      if (!currentApi) {
        return !missingWorkspaceProjectPathKeys.has(workspaceProjectPathKey(path));
      }
      try {
        await currentApi.listDirs(path, 1);
        setWorkspaceProjectDirectoryMissing(project, false);
        return true;
      } catch {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
    },
    [api, missingWorkspaceProjectPathKeys, setWorkspaceProjectDirectoryMissing],
  );

  const activateWorkspaceProject = useCallback(
    (project: WorkspaceProject, options?: { startConversation?: boolean }) => {
      const pathKey = project.path.trim();
      if (!pathKey) return;
      const normalizedPathKey = workspaceProjectPathKey(pathKey);
      const matchedProject = workspaceProjects.find(
        (item) =>
          workspaceProjectPathKey(item.path) === normalizedPathKey || item.id === project.id,
      );
      const targetProject = matchedProject
        ? { ...matchedProject, ...(project.worktree ? { worktree: project.worktree } : {}) }
        : project;
      setActiveWorkspaceProjectId(targetProject.id);
      setSettings((prev) => {
        const existing = prev.system.workspaceProjects.find(
          (item) =>
            workspaceProjectPathKey(item.path) === normalizedPathKey || item.id === project.id,
        );
        const nextProject = existing ? { ...targetProject, id: existing.id } : targetProject;
        const nextProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id
                ? {
                    ...item,
                    name: item.id === DEFAULT_WORKSPACE_PROJECT_ID ? item.name : nextProject.name,
                    path: nextProject.path,
                    kind:
                      item.id === DEFAULT_WORKSPACE_PROJECT_ID
                        ? "managed"
                        : nextProject.kind === "history"
                          ? item.kind
                          : nextProject.kind,
                    worktree: nextProject.worktree ?? item.worktree,
                    updatedAt: item.updatedAt,
                    lastConversationAt:
                      Math.max(item.lastConversationAt ?? 0, nextProject.lastConversationAt ?? 0) ||
                      undefined,
                  }
                : item,
            )
          : [...prev.system.workspaceProjects, nextProject];
        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects: nextProjects,
              activeWorkspaceProjectId: existing?.id ?? nextProject.id,
              hiddenWorkspaceProjectPaths: prev.system.hiddenWorkspaceProjectPaths.filter(
                (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
              ),
              missingWorkspaceProjectPaths: prev.system.missingWorkspaceProjectPaths.filter(
                (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
              ),
              archivedWorkspaceProjectPaths: prev.system.archivedWorkspaceProjectPaths.filter(
                (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
              ),
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
      if (options?.startConversation) {
        setActiveView("chat");
        startNewConversationRef.current({
          workdir: targetProject.path,
          preserveCurrentComposerDraft: true,
        });
      }
    },
    [setActiveView, setSettings, startNewConversationRef, workspaceProjects],
  );

  const handleSelectWorkspaceProject = useCallback(
    async (project: WorkspaceProject) => {
      if (await checkWorkspaceProjectDirectory(project)) activateWorkspaceProject(project);
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory],
  );

  const handleNewConversationForProject = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) return;
      if (isMobileSidebarLayout()) setSidebarOpen(false);
      activateWorkspaceProject(project, { startConversation: true });
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory, setSidebarOpen],
  );

  const handleBrowseWorkspaceProjectInFileTree = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) return;
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey) return;
      if (isMobileSidebarLayout()) setSidebarOpen(false);
      setActiveView("chat");
      setRightDockOpen(true);
      activateWorkspaceProject(project);
      setSettings((prev) => openRightDockSingletonTab(prev, pathKey, "fileTree"));
    },
    [
      activateWorkspaceProject,
      checkWorkspaceProjectDirectory,
      setActiveView,
      setRightDockOpen,
      setSettings,
      setSidebarOpen,
    ],
  );

  const handleOpenCreateWorkspaceProject = useCallback(() => {
    setWorkspaceCreateModalOpen(true);
  }, []);
  const handleOpenWorkspaceFolder = useCallback(() => {
    setWorkspaceCreateModalOpen(false);
    setProjectPickerOpen(true);
  }, []);

  const handleCloneWorkspaceProject = useCallback(
    async (remoteUrl: string, parent: string, name: string, branch: string) => {
      if (!api) throw new Error("网关未连接。");
      const task = await api.gitRequest<WorkspaceCloneTask>("clone_start", parent, {
        name,
        remoteUrl,
        branch: branch || undefined,
      });
      dismissedWorkspaceCloneTaskIds.current.delete(task.id);
      setWorkspaceCloneTasks((tasks) => [task, ...tasks.filter((item) => item.id !== task.id)]);
    },
    [api],
  );

  const refreshWorkspaceCloneTasks = useCallback(async () => {
    if (!api) return;
    const tasks = await api.gitRequest<WorkspaceCloneTask[]>("clone_tasks", "");
    setWorkspaceCloneTasks(
      tasks.filter((task) => !dismissedWorkspaceCloneTaskIds.current.has(task.id)),
    );
  }, [api]);

  useEffect(() => {
    void refreshWorkspaceCloneTasks().catch(() => undefined);
  }, [refreshWorkspaceCloneTasks]);

  const hasActiveWorkspaceCloneTask = workspaceCloneTasks.some(
    (task) => task.status === "running" || task.status === "cancelling",
  );
  useEffect(() => {
    if (!hasActiveWorkspaceCloneTask) return;
    const timer = window.setInterval(() => {
      void refreshWorkspaceCloneTasks().catch(() => undefined);
    }, 750);
    return () => window.clearInterval(timer);
  }, [hasActiveWorkspaceCloneTask, refreshWorkspaceCloneTasks]);

  const handleCancelWorkspaceCloneTask = useCallback(
    (taskId: string) => {
      if (!api) return;
      void api
        .gitRequest<WorkspaceCloneTask>("clone_cancel", "", { taskId })
        .then((task) =>
          setWorkspaceCloneTasks((tasks) =>
            tasks.map((item) => (item.id === task.id ? task : item)),
          ),
        )
        .catch(() => undefined);
    },
    [api],
  );

  const handleDismissWorkspaceCloneTask = useCallback(
    (taskId: string) => {
      dismissedWorkspaceCloneTaskIds.current.add(taskId);
      setWorkspaceCloneTasks((tasks) => tasks.filter((task) => task.id !== taskId));
      if (!api) return;
      void api
        .gitRequest<WorkspaceCloneTask[]>("clone_dismiss", "", { taskId })
        .then((tasks) => {
          dismissedWorkspaceCloneTaskIds.current.delete(taskId);
          setWorkspaceCloneTasks(
            tasks.filter((task) => !dismissedWorkspaceCloneTaskIds.current.has(task.id)),
          );
        })
        .catch(() => undefined);
    },
    [api],
  );

  const handleOpenClonedWorkspace = useCallback(
    (path: string) => {
      activateWorkspaceProject(createWorkspaceProjectFromPath(path, "managed"));
      void sidebarStore.refreshWorkdirs("new-workdir");
    },
    [activateWorkspaceProject, sidebarStore],
  );
  const handleLoadWorkspaceRemoteBranches = useCallback(
    (remoteUrl: string) =>
      api?.gitRequest<{ defaultBranch: string; branches: string[] }>("list_remote_branches", "", {
        remoteUrl,
      }) ?? Promise.reject(new Error("网关未连接。")),
    [api],
  );
  const handleWorkdirPickerSelect = useCallback(
    (path: string) => {
      const normalizedPath = path.trim();
      if (!normalizedPath) return;
      activateWorkspaceProject(createWorkspaceProjectFromPath(normalizedPath, "managed"));
      void sidebarStore.refreshWorkdirs("new-workdir");
    },
    [activateWorkspaceProject, sidebarStore],
  );

  const handleOpenWorktree = useCallback(
    (worktree: { path: string; repositoryPath: string; branch: string }) => {
      const path = worktree.path.trim();
      const repositoryPath = worktree.repositoryPath.trim();
      const worktreeKey = workspaceProjectPathKey(path);
      const currentProjectPath = displayedConversationWorkdirRef.current.trim();
      if (!path || !repositoryPath || !worktreeKey) return;
      const branch = worktree.branch.trim();
      const nextProject: WorkspaceProject = {
        ...createWorkspaceProjectFromPath(path, "managed"),
        worktree: { repositoryPath, ...(branch ? { branch } : {}) },
      };
      activateWorkspaceProject(nextProject);
      setSettings((prev) => {
        const sourceProject = prev.system.workspaceProjects.find(
          (project) =>
            workspaceProjectPathKey(project.path) === workspaceProjectPathKey(repositoryPath),
        );
        const ensured = ensureWorktreeProjectGroup(prev.system.workspaceProjectGroups, {
          name: sourceProject?.name || fallbackWorkspaceProjectName(repositoryPath),
          sourceProjectPath: repositoryPath,
        });
        let groups = assignWorkspaceProjectToGroup(ensured.groups, ensured.groupId, repositoryPath);
        if (currentProjectPath) {
          groups = assignWorkspaceProjectToGroup(groups, ensured.groupId, currentProjectPath);
        }
        groups = assignWorkspaceProjectToGroup(groups, ensured.groupId, path);
        return { ...prev, system: { ...prev.system, workspaceProjectGroups: groups } };
      });
      void sidebarStore.refreshWorkdirs("new-workdir");
    },
    [activateWorkspaceProject, displayedConversationWorkdirRef, setSettings, sidebarStore],
  );

  const updateWorkspaceProjectGroups = useCallback(
    (updater: (groups: WorkspaceProjectGroup[]) => WorkspaceProjectGroup[]) => {
      setSettings((prev) => {
        const next = updater(prev.system.workspaceProjectGroups);
        if (next === prev.system.workspaceProjectGroups) return prev;
        return { ...prev, system: { ...prev.system, workspaceProjectGroups: next } };
      });
    },
    [setSettings],
  );
  const handleCreateWorkspaceGroup = useCallback(
    (nameInput: string) => {
      const name = nameInput.trim();
      if (!name) return;
      const now = Date.now();
      updateWorkspaceProjectGroups((groups) => [
        ...groups,
        { id: createUuid(), name, projectPaths: [], createdAt: now, updatedAt: now },
      ]);
    },
    [updateWorkspaceProjectGroups],
  );
  const handleRenameWorkspaceGroup = useCallback(
    (groupId: string, nameInput: string) => {
      const name = nameInput.trim();
      if (!name) return;
      updateWorkspaceProjectGroups((groups) =>
        groups.map((group) =>
          group.id === groupId ? { ...group, name, updatedAt: Date.now() } : group,
        ),
      );
    },
    [updateWorkspaceProjectGroups],
  );
  const handleDeleteWorkspaceGroup = useCallback(
    (groupId: string) => {
      updateWorkspaceProjectGroups((groups) => groups.filter((group) => group.id !== groupId));
    },
    [updateWorkspaceProjectGroups],
  );
  const handleMoveWorkspaceProjectToGroup = useCallback(
    (projectPath: string, groupId: string | null) => {
      const pathKey = workspaceProjectPathKey(projectPath);
      if (!pathKey) return;
      updateWorkspaceProjectGroups((groups) => {
        if (groupId === null) {
          return groups.map((group) => {
            const projectPaths = group.projectPaths.filter(
              (path) => workspaceProjectPathKey(path) !== pathKey,
            );
            return projectPaths.length === group.projectPaths.length
              ? group
              : { ...group, projectPaths, updatedAt: Date.now() };
          });
        }
        return assignWorkspaceProjectToGroup(groups, groupId, projectPath);
      });
    },
    [updateWorkspaceProjectGroups],
  );
  const handleToggleWorkspaceGroupCollapsed = useCallback(
    (groupId: string) => {
      updateWorkspaceProjectGroups((groups) =>
        groups.map((group) =>
          group.id === groupId
            ? { ...group, collapsed: !group.collapsed, updatedAt: Date.now() }
            : group,
        ),
      );
    },
    [updateWorkspaceProjectGroups],
  );

  const commitWorkspaceProjectRename = useCallback(
    (project: WorkspaceProject, nextNameInput: string) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
      const nextName = nextNameInput.trim();
      if (!nextName || nextName === project.name) return;
      setSettings((prev) => {
        const pathKey = workspaceProjectPathKey(project.path);
        const existing = prev.system.workspaceProjects.find(
          (item) => item.id === project.id || workspaceProjectPathKey(item.path) === pathKey,
        );
        const updatedProject: WorkspaceProject = {
          ...(existing ?? project),
          id: existing?.id ?? project.id,
          name: nextName,
          kind: (existing ?? project).kind === "history" ? "folder" : (existing ?? project).kind,
          updatedAt: Date.now(),
        };
        const nextProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id || workspaceProjectPathKey(item.path) === pathKey
                ? updatedProject
                : item,
            )
          : [...prev.system.workspaceProjects, updatedProject];
        return {
          ...prev,
          system: resolveWorkspaceProjects(
            { ...prev.system, workspaceProjects: nextProjects },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );
  const handleStartRenamingWorkspaceProject = useCallback((project: WorkspaceProject) => {
    if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
    setProjectRenamingId(project.id);
    setProjectRenameDraft(project.name);
  }, []);
  const handleCommitWorkspaceProjectRename = useCallback(() => {
    if (!projectRenamingId) return;
    const project = workspaceProjects.find((item) => item.id === projectRenamingId);
    if (project) commitWorkspaceProjectRename(project, projectRenameDraft);
    setProjectRenamingId(null);
    setProjectRenameDraft("");
  }, [commitWorkspaceProjectRename, projectRenameDraft, projectRenamingId, workspaceProjects]);
  const handleCancelWorkspaceProjectRename = useCallback(() => {
    setProjectRenamingId(null);
    setProjectRenameDraft("");
  }, []);
  const handleSetWorkspaceProjectPinned = useCallback(
    (project: WorkspaceProject, isPinned: boolean) => {
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey) return;
      setSettings((prev) => {
        const existing = prev.system.workspaceProjects.find(
          (item) => item.id === project.id || workspaceProjectPathKey(item.path) === pathKey,
        );
        if (!existing && !isPinned) return prev;
        const now = Date.now();
        const source = existing ?? project;
        const updatedProject: WorkspaceProject = {
          ...source,
          id: existing?.id ?? source.id,
          kind: source.id === DEFAULT_WORKSPACE_PROJECT_ID ? "managed" : source.kind,
          updatedAt: now,
          isPinned,
          pinnedAt: isPinned ? now : null,
        };
        const nextProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id || workspaceProjectPathKey(item.path) === pathKey
                ? updatedProject
                : item,
            )
          : [...prev.system.workspaceProjects, updatedProject];
        return {
          ...prev,
          system: resolveWorkspaceProjects(
            { ...prev.system, workspaceProjects: nextProjects },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );
  const handleSidebarProjectsCollapsedChange = useCallback(
    (projectsCollapsed: boolean) => {
      setSettings((prev) =>
        updateCustomSettings(prev, {
          chatSidebar: { ...prev.customSettings.chatSidebar, projectsCollapsed },
        }),
      );
    },
    [setSettings],
  );
  const handleSidebarRecentCollapsedChange = useCallback(
    (recentCollapsed: boolean) => {
      setSettings((prev) =>
        updateCustomSettings(prev, {
          chatSidebar: { ...prev.customSettings.chatSidebar, recentCollapsed },
        }),
      );
    },
    [setSettings],
  );

  return {
    activateWorkspaceProject,
    activeWorkspaceProject,
    activeWorkspaceProjectPath,
    archivedWorkspaceProjectPathKeys,
    handleBrowseWorkspaceProjectInFileTree,
    handleCancelWorkspaceCloneTask,
    handleCancelWorkspaceProjectRename,
    handleCloneWorkspaceProject,
    handleCommitWorkspaceProjectRename,
    handleCreateWorkspaceGroup,
    handleDeleteWorkspaceGroup,
    handleDismissWorkspaceCloneTask,
    handleLoadWorkspaceRemoteBranches,
    handleMoveWorkspaceProjectToGroup,
    handleNewConversationForProject,
    handleOpenClonedWorkspace,
    handleOpenCreateWorkspaceProject,
    handleOpenWorkspaceFolder,
    handleOpenWorktree,
    handleRenameWorkspaceGroup,
    handleSelectWorkspaceProject,
    handleSetWorkspaceProjectPinned,
    handleSidebarProjectsCollapsedChange,
    handleSidebarRecentCollapsedChange,
    handleStartRenamingWorkspaceProject,
    handleToggleWorkspaceGroupCollapsed,
    handleWorkdirPickerSelect,
    missingWorkspaceProjectPathKeys,
    projectPickerOpen,
    projectRenameDraft,
    projectRenamingId,
    setActiveWorkspaceProjectId,
    setProjectPickerOpen,
    setProjectRenameDraft,
    setProjectRenamingId,
    setWorkspaceCreateModalOpen,
    workspaceCloneTasks,
    workspaceCreateModalOpen,
    workspaceProjects,
  };
}
