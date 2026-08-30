import type { WorkspaceProject } from "@liveagent/app/lib/settings";
import type { WorkspaceProjectRootClient } from "@liveagent/ui/contracts/workspaceProjectRoots";
import { t as translate } from "@liveagent/ui/i18n/index";
import { buildMountedRootDrafts } from "@liveagent/ui/lib/chat/mountedRootDrafts";
import { type DragEvent, useCallback, useRef, useState } from "react";
import {
  collectDroppedPayload,
  type DroppedDirectory,
  MAX_DIRECTORY_UPLOAD_BYTES,
  MAX_DIRECTORY_UPLOAD_FILES,
  snapshotDroppedEntries,
} from "@/lib/directoryDrop";
import type { AppSettings } from "@/lib/settings";
import { importDirectory } from "@/lib/uploadDirectory";

import { asErrorMessage } from "../chatEventUtils";
import { dragEventHasFiles } from "../domUtils";
import { formatTranslation } from "../historyUtils";

type NotifyType = "success" | "warning" | "error";

type UseDirectoryDropActionsParams = {
  token: string;
  historyShareToken: string | null;
  locale: AppSettings["locale"];
  resolveAgentID: () => Promise<string>;
  addNotify: (type: NotifyType, message: string) => void;
  activeWorkspaceProject: WorkspaceProject | undefined;
  workspaceProjectRootClient: WorkspaceProjectRootClient | undefined;
  /** 上传完成后的工作空间激活（与目录选择器选中同一条路径的行为一致）。 */
  onWorkspaceCreated: (rootPath: string) => void;
  onWorkspaceDirectoriesMounted?: () => void;
};

function directoryErrorMessage(error: unknown, locale: AppSettings["locale"], fallback: string) {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("TOO_MANY_FILES:")) {
    return formatTranslation(translate("chat.workspaceDropTooManyFiles", locale), {
      max: MAX_DIRECTORY_UPLOAD_FILES,
    });
  }
  if (message.startsWith("TOO_LARGE:")) {
    return formatTranslation(translate("chat.workspaceDropTooLarge", locale), {
      max: Math.floor(MAX_DIRECTORY_UPLOAD_BYTES / 1024 / 1024),
    });
  }
  return asErrorMessage(error, fallback);
}

/**
 * 浏览器无法暴露拖入文件夹的本机路径，Web 端的“拖入创建工作空间/挂载附属
 * 目录”统一走：递归收集 → 上传到 Agent 宿主机 → 用返回的服务器路径完成
 * 激活或授权。
 */
export function useDirectoryDropActions(params: UseDirectoryDropActionsParams) {
  const {
    token,
    historyShareToken,
    locale,
    resolveAgentID,
    addNotify,
    activeWorkspaceProject,
    workspaceProjectRootClient,
    onWorkspaceCreated,
    onWorkspaceDirectoriesMounted,
  } = params;

  const [workspaceFolderDropActive, setWorkspaceFolderDropActive] = useState(false);
  const workspaceDragDepthRef = useRef(0);
  const dropEnabled = Boolean(token) && !historyShareToken;

  const importWorkspaceDirectories = useCallback(
    async (directories: DroppedDirectory[]) => {
      const agentID = await resolveAgentID();
      for (const directory of directories) {
        if (directory.files.length === 0) {
          addNotify(
            "warning",
            formatTranslation(translate("chat.workspaceDropEmptyFolder", locale), {
              name: directory.name,
            }),
          );
          continue;
        }
        addNotify(
          "success",
          formatTranslation(translate("chat.workspaceDropUploading", locale), {
            name: directory.name,
            count: directory.files.length,
          }),
        );
        const result = await importDirectory(token, agentID, {
          name: directory.name,
          target: "workspace",
          files: directory.files,
        });
        onWorkspaceCreated(result.rootPath);
        addNotify(
          "success",
          formatTranslation(translate("chat.workspaceDropCreated", locale), {
            name: directory.name,
          }),
        );
      }
    },
    [addNotify, locale, onWorkspaceCreated, resolveAgentID, token],
  );

  const handleWorkspaceZoneDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      workspaceDragDepthRef.current = 0;
      setWorkspaceFolderDropActive(false);
      const entries = snapshotDroppedEntries(event.dataTransfer);
      if (entries.length === 0) return;
      if (entries.some((entry) => !entry.isDirectory)) {
        addNotify("warning", translate("chat.workspaceDropOnlyFolders", locale));
        return;
      }
      void (async () => {
        const payload = await collectDroppedPayload(entries);
        await importWorkspaceDirectories(payload.directories);
      })().catch((error) => {
        addNotify(
          "error",
          directoryErrorMessage(error, locale, translate("chat.workspaceDropFailed", locale)),
        );
      });
    },
    [addNotify, importWorkspaceDirectories, locale],
  );

  const workspaceFolderDropHandlers = dropEnabled
    ? {
        onDragEnter: (event: DragEvent<HTMLDivElement>) => {
          if (!dragEventHasFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          workspaceDragDepthRef.current += 1;
          setWorkspaceFolderDropActive(true);
        },
        onDragOver: (event: DragEvent<HTMLDivElement>) => {
          if (!dragEventHasFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          setWorkspaceFolderDropActive(true);
        },
        onDragLeave: (event: DragEvent<HTMLDivElement>) => {
          if (!dragEventHasFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          workspaceDragDepthRef.current = Math.max(0, workspaceDragDepthRef.current - 1);
          if (workspaceDragDepthRef.current === 0) {
            setWorkspaceFolderDropActive(false);
          }
        },
        onDrop: (event: DragEvent<HTMLDivElement>) => {
          if (!dragEventHasFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          handleWorkspaceZoneDrop(event);
        },
      }
    : undefined;

  const mountDroppedDirectories = useCallback(
    (directories: DroppedDirectory[]) => {
      const project = activeWorkspaceProject;
      if (!project?.path.trim() || !workspaceProjectRootClient) {
        addNotify("warning", translate("chat.workspaceMountDropNoProject", locale));
        return;
      }
      void (async () => {
        const agentID = await resolveAgentID();
        const uploadedRoots: string[] = [];
        for (const directory of directories) {
          if (directory.files.length === 0) {
            addNotify(
              "warning",
              formatTranslation(translate("chat.workspaceDropEmptyFolder", locale), {
                name: directory.name,
              }),
            );
            continue;
          }
          addNotify(
            "success",
            formatTranslation(translate("chat.workspaceDropUploading", locale), {
              name: directory.name,
              count: directory.files.length,
            }),
          );
          const result = await importDirectory(token, agentID, {
            name: directory.name,
            target: "project-root",
            files: directory.files,
          });
          uploadedRoots.push(result.rootPath);
        }
        if (uploadedRoots.length === 0) return;
        const existing = await workspaceProjectRootClient.list(project);
        const drafts = buildMountedRootDrafts({
          projectPath: project.path,
          existingGrants: existing,
          folderPaths: uploadedRoots,
        });
        if (drafts.addedPaths.length === 0) return;
        await workspaceProjectRootClient.save(project, drafts.drafts);
        onWorkspaceDirectoriesMounted?.();
        addNotify(
          "success",
          formatTranslation(translate("chat.workspaceMountDropSuccess", locale), {
            count: drafts.addedPaths.length,
          }),
        );
      })().catch((error) => {
        addNotify(
          "error",
          directoryErrorMessage(error, locale, translate("chat.workspaceMountDropFailed", locale)),
        );
      });
    },
    [
      activeWorkspaceProject,
      addNotify,
      locale,
      onWorkspaceDirectoriesMounted,
      resolveAgentID,
      token,
      workspaceProjectRootClient,
    ],
  );

  return {
    workspaceFolderDropActive,
    workspaceFolderDropHandlers,
    mountDroppedDirectories,
  };
}
