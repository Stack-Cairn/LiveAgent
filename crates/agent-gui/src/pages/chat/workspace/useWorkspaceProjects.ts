import { invoke, isTauri } from "../../../lib/tauriBridge";
import { revealItemInDir } from "../../../lib/tauriBridge";
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
  workspaceProjectPathKey,
} from "../../../lib/settings";
import { sidebarScopeKey } from "../../../lib/sidebar/scope";
import type { SidebarStore } from "../../../lib/sidebar/store";
import type { SidebarScope } from "../../../lib/sidebar/types";
import { useSidebarSelector } from "../../../lib/sidebar/useSidebarSelector";
import { invokeFs } from "../../../lib/tools/fsBackend";
import {
  findWorkspaceProject,
  mergeWorkspaceProjectsWithHistory,
} from "../../../lib/workspaceProjects";
import { asErrorMessage } from "../chatPageUtils";
import { startWorkspaceCloneTask } from "./cloneTasks";
import {
  createWorkspaceProjectFromPath,
  getDefaultWorkspaceProjectPath,
} from "./workspaceProjectsModel";

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
  const [projectRenamingId, setProjectRenamingId] = useState<string | null>(null);
  const [projectRenameDraft, setProjectRenameDraft] = useState("");
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
      const targetProject =
        workspaceProjects.find(
          (item) =>
            workspaceProjectPathKey(item.path) === normalizedPathKey || item.id === project.id,
        ) ?? project;
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
        const nextProject = existing ?? targetProject;
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
      let picked: string | null;
      if (isTauri()) {
        // Desktop: native file dialog
        picked = await invoke<string | null>("system_pick_folder", {
          initial_workdir: activeWorkspaceProjectPath || workdir,
        });
      } else {
        // Headless: inline input dialog (window.prompt blocked in non-user-gesture contexts)
        const defaultValue = activeWorkspaceProjectPath || workdir || "/home";
        const input = await new Promise<string | null>((resolve) => {
          const backdrop = document.createElement("div");
          Object.assign(backdrop.style, {
            position: "fixed", inset: "0", zIndex: "99999",
            background: "rgba(0,0,0,0.5)", display: "flex",
            alignItems: "center", justifyContent: "center",
          });
          backdrop.innerHTML = `
            <div style="background:#fff;border-radius:12px;padding:24px;width:420px;box-shadow:0 8px 32px rgba(0,0,0,0.2);font-family:system-ui,sans-serif">
              <div style="font-size:16px;font-weight:600;margin-bottom:8px">输入工作空间路径</div>
              <div style="font-size:13px;color:#666;margin-bottom:16px">请输入要添加的工作空间的绝对路径</div>
              <input id="__ws-path-input" type="text" value="${defaultValue}"
                style="width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box;outline:none" />
              <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
                <button id="__ws-cancel" style="padding:8px 16px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer;font-size:14px">取消</button>
                <button id="__ws-ok" style="padding:8px 16px;border:none;border-radius:8px;background:#1a73e8;color:#fff;cursor:pointer;font-size:14px">确定</button>
              </div>
            </div>`;
          document.body.appendChild(backdrop);
          const inputEl = backdrop.querySelector("#__ws-path-input") as HTMLInputElement;
          inputEl.focus();
          inputEl.select();
          const cleanup = (val: string | null) => { backdrop.remove(); resolve(val); };
          backdrop.querySelector("#__ws-cancel")!.addEventListener("click", () => cleanup(null));
          backdrop.querySelector("#__ws-ok")!.addEventListener("click", () => cleanup(inputEl.value || null));
          inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") cleanup(inputEl.value || null);
            if (e.key === "Escape") cleanup(null);
          });
        });
        if (!input) return;
        picked = await invoke<string | null>("system_pick_folder", { path: input });
      }
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

  const handleLoadWorkspaceRemoteBranches = useCallback(
    (remoteUrl: string) =>
      invoke<{ defaultBranch: string; branches: string[] }>("git_list_remote_branches", {
        remote_url: remoteUrl,
      }),
    [],
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

  const handleStartRenamingWorkspaceProject = useCallback((project: WorkspaceProject) => {
    if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
    setProjectRenamingId(project.id);
    setProjectRenameDraft(project.name);
  }, []);

  const handleCommitWorkspaceProjectRename = useCallback(() => {
    if (!projectRenamingId) {
      return;
    }
    const project = workspaceProjects.find((item) => item.id === projectRenamingId);
    if (project) {
      commitWorkspaceProjectRename(project, projectRenameDraft);
    }
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
    projectRenamingId,
    setProjectRenamingId,
    projectRenameDraft,
    setProjectRenameDraft,
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
    handleLoadWorkspaceRemoteBranches,
    handleStartRenamingWorkspaceProject,
    handleCommitWorkspaceProjectRename,
    handleCancelWorkspaceProjectRename,
    handleSetWorkspaceProjectPinned,
    handleSidebarProjectsCollapsedChange,
    handleSidebarRecentCollapsedChange,
  };
}
