import { createUuid } from "@liveagent/ui/lib/shared/id";
import { sidebarScopeKey } from "@liveagent/ui/lib/sidebar/scope";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import type { SidebarScope } from "@liveagent/ui/lib/sidebar/types";
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";
import { invokeFs } from "@liveagent/ui/lib/tools/fsBackend";
import {
  assignWorkspaceProjectToGroup,
  createWorkspaceProjectFromPath,
  ensureWorktreeProjectGroup,
  fallbackWorkspaceProjectName,
  findWorkspaceProject,
  getDefaultWorkspaceProjectPath,
  mergeWorkspaceProjectsWithHistory,
} from "@liveagent/ui/lib/workspaceProjects";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type AppSettings,
  DEFAULT_WORKSPACE_PROJECT_ID,
  openRightDockSingletonTab,
  resolveWorkspaceProjects,
  updateCustomSettings,
  type WorkspaceProject,
  type WorkspaceProjectGroup,
  workspaceProjectPathKey,
} from "../../../lib/settings";
import { asErrorMessage } from "../chatPageUtils";
import { startWorkspaceCloneTask } from "./cloneTasks";

type UseWorkspaceProjectsParams = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  sidebarStore: SidebarStore;
  isAgentMode: boolean;
  workdir: string;
  t: (key: string) => string;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setActiveView: Dispatch<SetStateAction<"chat" | "skills-hub" | "mcp-hub">>;
  setRightDockOpen: Dispatch<SetStateAction<boolean>>;
  startNewConversationActionRef: MutableRefObject<(options?: { workdir?: string }) => void>;
  prepareComposerForConversationChangeActionRef: MutableRefObject<() => void>;
};

/**
 * Workspace-project domain state: the merged project list (settings +
 * history workdirs), active/missing/archived derivations, the sidebar scope
 * that follows the active project, and every non-destructive project action
 * (activate, select, browse, create, rename, pin, sidebar collapse).
 *
 * Destructive actions (remove/archive) live in useWorkspaceProjectRemoval —
 * they need conversation/terminal caches that are wired later in ChatPage.
 */
export function useWorkspaceProjects(params: UseWorkspaceProjectsParams) {
  const {
    settings,
    setSettings,
    sidebarStore,
    isAgentMode,
    workdir,
    t,
    setErrorMessage,
    setActiveView,
    setRightDockOpen,
    startNewConversationActionRef,
    prepareComposerForConversationChangeActionRef,
  } = params;

  const sidebarWorkdirs = useSidebarSelector(sidebarStore, (s) => s.workdirs);
  const workspaceProjects = useMemo(
    () => mergeWorkspaceProjectsWithHistory(settings.system, sidebarWorkdirs),
    [sidebarWorkdirs, settings.system],
  );
  const [activeWorkspaceProjectId, setActiveWorkspaceProjectId] = useState<string>(
    () => settings.system.activeWorkspaceProjectId?.trim() || DEFAULT_WORKSPACE_PROJECT_ID,
  );
  const missingWorkspaceProjectPathKeys = useMemo(
    () => new Set(settings.system.missingWorkspaceProjectPaths.map(workspaceProjectPathKey)),
    [settings.system.missingWorkspaceProjectPaths],
  );
  const archivedWorkspaceProjectPathKeys = useMemo(
    () => new Set(settings.system.archivedWorkspaceProjectPaths.map(workspaceProjectPathKey)),
    [settings.system.archivedWorkspaceProjectPaths],
  );
  // Archived workspaces can never be active. Falling back to the full list
  // only guards a transient synced state where everything is archived.
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
  useEffect(() => {
    if (activeWorkspaceProject?.id && activeWorkspaceProject.id !== activeWorkspaceProjectId) {
      setActiveWorkspaceProjectId(activeWorkspaceProject.id);
    }
  }, [activeWorkspaceProject?.id, activeWorkspaceProjectId]);
  const activeWorkspaceProjectPath = activeWorkspaceProject?.path.trim() ?? "";
  const sidebarScope = useMemo<SidebarScope>(
    () =>
      isAgentMode
        ? activeWorkspaceProjectPath
          ? { kind: "workdir", cwd: activeWorkspaceProjectPath }
          : { kind: "none" }
        : { kind: "unscoped" },
    [activeWorkspaceProjectPath, isAgentMode],
  );
  useEffect(() => {
    sidebarStore.setScope(sidebarScope);
  }, [sidebarScope, sidebarStore]);
  const historyScopeKey = sidebarScopeKey(sidebarScope);
  const [workspaceCreateModalOpen, setWorkspaceCreateModalOpen] = useState(false);

  const setWorkspaceProjectDirectoryMissing = useCallback(
    (project: WorkspaceProject, missing: boolean) => {
      const key = workspaceProjectPathKey(project.path);
      const path = project.path.trim();
      if (!key || !path) return;
      setSettings((prev) => {
        const hasMissingPath = prev.system.missingWorkspaceProjectPaths.some(
          (item) => workspaceProjectPathKey(item) === key,
        );
        if (hasMissingPath === missing) {
          return prev;
        }
        const missingWorkspaceProjectPaths = missing
          ? [...prev.system.missingWorkspaceProjectPaths, path]
          : prev.system.missingWorkspaceProjectPaths.filter(
              (item) => workspaceProjectPathKey(item) !== key,
            );
        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              missingWorkspaceProjectPaths,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const checkWorkspaceProjectDirectory = useCallback(
    async (project: WorkspaceProject) => {
      const path = project.path.trim();
      if (!path) {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
      try {
        await invokeFs("fs_list", {
          workdir: path,
          path: null,
          depth: 1,
          offset: 0,
          max_results: 1,
        });
        setWorkspaceProjectDirectoryMissing(project, false);
        return true;
      } catch {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
    },
    [setWorkspaceProjectDirectoryMissing],
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
        ? {
            ...matchedProject,
            ...(project.worktree ? { worktree: project.worktree } : {}),
          }
        : project;
      // 目标工作区已完全激活时提前返回，避免流式进行中触发无谓的 settings 写入与重渲染
      if (
        !options?.startConversation &&
        targetProject.id === activeWorkspaceProjectId &&
        settings.system.activeWorkspaceProjectId === targetProject.id &&
        settings.system.workspaceProjects.some((item) => item.id === targetProject.id) &&
        !settings.system.hiddenWorkspaceProjectPaths.some(
          (path) => workspaceProjectPathKey(path) === normalizedPathKey,
        ) &&
        !settings.system.missingWorkspaceProjectPaths.some(
          (path) => workspaceProjectPathKey(path) === normalizedPathKey,
        ) &&
        !settings.system.archivedWorkspaceProjectPaths.some(
          (path) => workspaceProjectPathKey(path) === normalizedPathKey,
        )
      ) {
        return;
      }
      setActiveWorkspaceProjectId(targetProject.id);
      setSettings((prev) => {
        const existing = prev.system.workspaceProjects.find(
          (item) =>
            workspaceProjectPathKey(item.path) === normalizedPathKey || item.id === project.id,
        );
        const nextProject = existing ? { ...targetProject, id: existing.id } : targetProject;
        const workspaceProjects = existing
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
        const nextSystem = resolveWorkspaceProjects(
          {
            ...prev.system,
            workspaceProjects,
            activeWorkspaceProjectId: existing?.id ?? nextProject.id,
            hiddenWorkspaceProjectPaths: prev.system.hiddenWorkspaceProjectPaths.filter(
              (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
            ),
            missingWorkspaceProjectPaths: prev.system.missingWorkspaceProjectPaths.filter(
              (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
            ),
            // Activating a workspace always brings it back from the archive.
            archivedWorkspaceProjectPaths: prev.system.archivedWorkspaceProjectPaths.filter(
              (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
            ),
          },
          getDefaultWorkspaceProjectPath(prev.system),
        );
        return {
          ...prev,
          system: nextSystem,
        };
      });
      if (options?.startConversation) {
        prepareComposerForConversationChangeActionRef.current();
        startNewConversationActionRef.current({ workdir: targetProject.path });
      }
    },
    [setSettings, workspaceProjects, activeWorkspaceProjectId, settings.system],
  );

  const handleSelectWorkspaceProject = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }
      activateWorkspaceProject(project);
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory],
  );

  const handleNewConversationForProject = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }
      setActiveView("chat");
      activateWorkspaceProject(project, { startConversation: true });
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory],
  );

  const handleBrowseWorkspaceProjectInFileTree = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey) {
        return;
      }

      setActiveView("chat");
      setRightDockOpen(true);
      activateWorkspaceProject(project);
      setSettings((prev) => openRightDockSingletonTab(prev, pathKey, "fileTree"));
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory, setSettings],
  );

  const ensureTunnelToolTab = useCallback(
    (projectPathKey?: string) => {
      const targetProjectPathKey =
        workspaceProjectPathKey(projectPathKey) ||
        workspaceProjectPathKey(activeWorkspaceProjectPath);
      if (!targetProjectPathKey) return;
      setSettings((prev) => openRightDockSingletonTab(prev, targetProjectPathKey, "tunnel"));
    },
    [activeWorkspaceProjectPath, setSettings],
  );

  const ensureSshTunnelToolTab = useCallback(
    (projectPathKey?: string) => {
      const targetProjectPathKey =
        workspaceProjectPathKey(projectPathKey) ||
        workspaceProjectPathKey(activeWorkspaceProjectPath);
      if (!targetProjectPathKey) return;
      setSettings((prev) => openRightDockSingletonTab(prev, targetProjectPathKey, "sshTunnel"));
    },
    [activeWorkspaceProjectPath, setSettings],
  );

  const handleBrowseWorkspaceProjectInSystemFileManager = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }

      try {
        await revealItemInDir(project.path.trim());
      } catch (error) {
        setErrorMessage(asErrorMessage(error, t("chat.workspaceOpenSystemFileManagerFailed")));
      }
    },
    [checkWorkspaceProjectDirectory, setErrorMessage, t],
  );

  const handleOpenCreateWorkspaceProject = useCallback(() => {
    setWorkspaceCreateModalOpen(true);
  }, []);

  const handleOpenWorkspaceFolder = useCallback(async () => {
    try {
      const picked = await invoke<string | null>("system_pick_folder", {
        initial_workdir: activeWorkspaceProjectPath || workdir,
      });
      const path = picked?.trim();
      if (!path) return;
      activateWorkspaceProject(createWorkspaceProjectFromPath(path, "managed"));
    } catch (error) {
      setErrorMessage(asErrorMessage(error, "选择项目目录失败"));
    }
  }, [activateWorkspaceProject, activeWorkspaceProjectPath, workdir, setErrorMessage]);

  const handleCloneWorkspaceProject = useCallback(
    async (remoteUrl: string, parent: string, name: string, branch: string) => {
      await startWorkspaceCloneTask({
        remoteUrl,
        parent,
        name,
        branch,
      });
    },
    [],
  );

  const handleOpenClonedWorkspace = useCallback(
    (path: string) => activateWorkspaceProject(createWorkspaceProjectFromPath(path, "managed")),
    [activateWorkspaceProject],
  );

  // 后端返回主工作树作为稳定仓库身份；即使从 linked worktree 再创建，
  // 新项目也会归到同一个源仓库分组并持久化真实关联分支。
  const handleOpenWorktree = useCallback(
    (worktree: { path: string; repositoryPath: string; branch: string }) => {
      const path = worktree.path.trim();
      const repositoryPath = worktree.repositoryPath.trim();
      const worktreeKey = workspaceProjectPathKey(path);
      if (!path || !repositoryPath || !worktreeKey || !activeWorkspaceProject) return;
      const branch = worktree.branch.trim();
      const nextProject: WorkspaceProject = {
        ...createWorkspaceProjectFromPath(path, "managed"),
        worktree: {
          repositoryPath,
          ...(branch ? { branch } : {}),
        },
      };
      activateWorkspaceProject(nextProject);
      setSettings((prev) => {
        const sourceProject = prev.system.workspaceProjects.find(
          (item) => workspaceProjectPathKey(item.path) === workspaceProjectPathKey(repositoryPath),
        );
        const ensured = ensureWorktreeProjectGroup(prev.system.workspaceProjectGroups, {
          name: sourceProject?.name || fallbackWorkspaceProjectName(repositoryPath),
          sourceProjectPath: repositoryPath,
        });
        let workspaceProjectGroups = assignWorkspaceProjectToGroup(
          ensured.groups,
          ensured.groupId,
          repositoryPath,
        );
        workspaceProjectGroups = assignWorkspaceProjectToGroup(
          workspaceProjectGroups,
          ensured.groupId,
          activeWorkspaceProject.path,
        );
        workspaceProjectGroups = assignWorkspaceProjectToGroup(
          workspaceProjectGroups,
          ensured.groupId,
          path,
        );
        return {
          ...prev,
          system: {
            ...prev.system,
            workspaceProjectGroups,
          },
        };
      });
    },
    [activateWorkspaceProject, activeWorkspaceProject, setSettings],
  );

  const handleLoadWorkspaceRemoteBranches = useCallback(
    (remoteUrl: string) =>
      invoke<{ defaultBranch: string; branches: string[] }>("git_list_remote_branches", {
        remote_url: remoteUrl,
      }),
    [],
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
        {
          id: createUuid(),
          name,
          projectPaths: [],
          createdAt: now,
          updatedAt: now,
        },
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
      // 删除分组只解除成员归属，项目保留在列表中。
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
          // 移出所有分组
          return groups.map((group) =>
            group.projectPaths.some((path) => workspaceProjectPathKey(path) === pathKey)
              ? {
                  ...group,
                  updatedAt: Date.now(),
                  projectPaths: group.projectPaths.filter(
                    (path) => workspaceProjectPathKey(path) !== pathKey,
                  ),
                }
              : group,
          );
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
        const workspaceProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id || workspaceProjectPathKey(item.path) === pathKey
                ? updatedProject
                : item,
            )
          : [...prev.system.workspaceProjects, updatedProject];

        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const handleSetWorkspaceProjectPinned = useCallback(
    (project: WorkspaceProject, isPinned: boolean) => {
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey) return;

      setSettings((prev) => {
        const existing = prev.system.workspaceProjects.find(
          (item) => item.id === project.id || workspaceProjectPathKey(item.path) === pathKey,
        );
        if (!existing && !isPinned) {
          return prev;
        }

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
        const workspaceProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id || workspaceProjectPathKey(item.path) === pathKey
                ? updatedProject
                : item,
            )
          : [...prev.system.workspaceProjects, updatedProject];

        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects,
            },
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
          chatSidebar: {
            ...prev.customSettings.chatSidebar,
            projectsCollapsed,
          },
        }),
      );
    },
    [setSettings],
  );

  const handleSidebarRecentCollapsedChange = useCallback(
    (recentCollapsed: boolean) => {
      setSettings((prev) =>
        updateCustomSettings(prev, {
          chatSidebar: {
            ...prev.customSettings.chatSidebar,
            recentCollapsed,
          },
        }),
      );
    },
    [setSettings],
  );

  return {
    workspaceProjects,
    activeWorkspaceProjectId,
    setActiveWorkspaceProjectId,
    missingWorkspaceProjectPathKeys,
    archivedWorkspaceProjectPathKeys,
    selectableWorkspaceProjects,
    activeWorkspaceProject,
    activeWorkspaceProjectPath,
    sidebarScope,
    historyScopeKey,
    checkWorkspaceProjectDirectory,
    activateWorkspaceProject,
    handleSelectWorkspaceProject,
    handleNewConversationForProject,
    handleBrowseWorkspaceProjectInFileTree,
    ensureTunnelToolTab,
    ensureSshTunnelToolTab,
    handleBrowseWorkspaceProjectInSystemFileManager,
    handleOpenCreateWorkspaceProject,
    workspaceCreateModalOpen,
    setWorkspaceCreateModalOpen,
    handleOpenWorkspaceFolder,
    handleCloneWorkspaceProject,
    handleOpenClonedWorkspace,
    handleOpenWorktree,
    workspaceProjectGroups: settings.system.workspaceProjectGroups,
    handleCreateWorkspaceGroup,
    handleRenameWorkspaceGroup,
    handleDeleteWorkspaceGroup,
    handleMoveWorkspaceProjectToGroup,
    handleToggleWorkspaceGroupCollapsed,
    handleLoadWorkspaceRemoteBranches,
    commitWorkspaceProjectRename,
    handleSetWorkspaceProjectPinned,
    handleSidebarProjectsCollapsedChange,
    handleSidebarRecentCollapsedChange,
  };
}
