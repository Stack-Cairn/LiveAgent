import { buildMountedRootDrafts } from "@liveagent/ui/lib/chat/mountedRootDrafts";
import { invoke } from "@tauri-apps/api/core";
import { type Dispatch, type SetStateAction, useCallback } from "react";
import { desktopWorkspaceProjectRootClient } from "../../../agent-ui-adapters/workspaceProjectRoots";
import type { WorkspaceProject } from "../../../lib/settings";
import { asErrorMessage } from "../chatPageUtils";

type SystemClassifiedDroppedPaths = {
  files: string[];
  dirs: string[];
};

type UseUploadZoneDropParams = {
  canDropUpload: boolean;
  fileDropTitle: string;
  activeWorkspaceProject: WorkspaceProject | undefined;
  importReadableFilePaths: (paths: string[]) => Promise<void>;
  addNotify: (type: "success" | "warning" | "error", message: string) => void;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  t: (key: string) => string;
};

/**
 * 上传区拖入内容的分发器：原生路径先经 Rust 分类，文件走附件导入管线，
 * 文件夹挂载为当前工作空间的附属目录（只读，可在项目设置中调整）。
 */
export function useUploadZoneDrop(params: UseUploadZoneDropParams) {
  const {
    canDropUpload,
    fileDropTitle,
    activeWorkspaceProject,
    importReadableFilePaths,
    addNotify,
    setErrorMessage,
    t,
  } = params;

  const mountDroppedFolders = useCallback(
    async (dirs: string[]) => {
      const project = activeWorkspaceProject;
      if (!project?.path.trim()) {
        addNotify("warning", t("chat.workspaceMountDropNoProject"));
        return;
      }
      const existing = await desktopWorkspaceProjectRootClient.list(project);
      const result = buildMountedRootDrafts({
        projectPath: project.path,
        existingGrants: existing,
        folderPaths: dirs,
      });
      if (result.skippedInsideWorkspace.length > 0) {
        addNotify(
          "warning",
          t("chat.workspaceMountDropSkippedInside").replace(
            "{count}",
            String(result.skippedInsideWorkspace.length),
          ),
        );
      }
      if (result.skippedOverlapping.length > 0) {
        addNotify(
          "warning",
          t("chat.workspaceMountDropSkippedOverlap").replace(
            "{count}",
            String(result.skippedOverlapping.length),
          ),
        );
      }
      if (result.addedPaths.length === 0) return;
      await desktopWorkspaceProjectRootClient.save(project, result.drafts);
      addNotify(
        "success",
        t("chat.workspaceMountDropSuccess").replace("{count}", String(result.addedPaths.length)),
      );
    },
    [activeWorkspaceProject, addNotify, t],
  );

  const importUploadZonePaths = useCallback(
    async (paths: string[]) => {
      try {
        const classified = await invoke<SystemClassifiedDroppedPaths>(
          "system_classify_dropped_paths",
          { paths },
        );
        if (classified.dirs.length > 0) {
          await mountDroppedFolders(classified.dirs);
        }
        if (classified.files.length === 0) return;
        if (!canDropUpload) {
          setErrorMessage(fileDropTitle);
          return;
        }
        await importReadableFilePaths(classified.files);
      } catch (error) {
        setErrorMessage(asErrorMessage(error, t("chat.workspaceMountDropFailed")));
      }
    },
    [
      canDropUpload,
      fileDropTitle,
      importReadableFilePaths,
      mountDroppedFolders,
      setErrorMessage,
      t,
    ],
  );

  return { importUploadZonePaths };
}
