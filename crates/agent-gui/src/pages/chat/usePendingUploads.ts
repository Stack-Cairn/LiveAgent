import { invoke } from "@tauri-apps/api/core";
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";

import type { MentionComposerHandle } from "../../components/chat/MentionComposer";
import type { NotifyItem } from "../../components/chat/NotifyToast";
import {
  mergePendingUploadedFiles,
  type PendingUploadedFile,
} from "../../lib/chat/messages/uploadedFiles";

type SystemPickReadableFilesResponse = {
  files: PendingUploadedFile[];
  skipped: string[];
};

type SystemUploadedReadableFileInput = {
  fileName: string;
  mimeType?: string;
  contentBase64: string;
};

type UsePendingUploadsParams = {
  isAgentMode: boolean;
  workdir: string;
  currentConversationIdRef: MutableRefObject<string>;
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  setErrorMessage: (message: string | null) => void;
  addNotify: (type: NotifyItem["type"], message: string) => void;
};

export const MAX_UPLOAD_FILES = 9;

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function fileToUploadInput(file: File): Promise<SystemUploadedReadableFileInput> {
  return {
    fileName: file.name,
    mimeType: file.type || undefined,
    contentBase64: arrayBufferToBase64(await file.arrayBuffer()),
  };
}

export function usePendingUploads(params: UsePendingUploadsParams) {
  const {
    isAgentMode,
    workdir,
    currentConversationIdRef,
    composerRef,
    setErrorMessage,
    addNotify,
  } = params;
  const [pendingUploadedFiles, setPendingUploadedFiles] = useState<PendingUploadedFile[]>([]);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const activeUploadTasksRef = useRef(0);
  const uploadContextRef = useRef<{ isAgentMode: boolean; workdir: string } | null>(null);
  const pendingUploadsByConversationRef = useRef(new Map<string, PendingUploadedFile[]>());

  const beginUploadTask = useCallback(() => {
    activeUploadTasksRef.current += 1;
    setIsUploadingFiles(true);
    return () => {
      activeUploadTasksRef.current = Math.max(0, activeUploadTasksRef.current - 1);
      if (activeUploadTasksRef.current === 0) {
        setIsUploadingFiles(false);
      }
    };
  }, []);

  useEffect(() => {
    const previous = uploadContextRef.current;
    uploadContextRef.current = { isAgentMode, workdir };
    if (!previous) return;
    if (previous.isAgentMode === isAgentMode && previous.workdir === workdir) return;
    pendingUploadsByConversationRef.current.clear();
    setPendingUploadedFiles([]);
  }, [isAgentMode, workdir]);

  const appendImportedFiles = useCallback(
    (result: SystemPickReadableFilesResponse, emptySelectionMessage: string) => {
      if (result.files.length === 0 && result.skipped.length === 0) {
        return;
      }
      if (result.files.length > 0) {
        setPendingUploadedFiles((prev) => {
          const merged = mergePendingUploadedFiles(prev, result.files);
          if (merged.length > MAX_UPLOAD_FILES) {
            addNotify("warning", `最多上传 ${MAX_UPLOAD_FILES} 个文件，已忽略多余文件`);
          }
          const next = merged.slice(0, MAX_UPLOAD_FILES);
          pendingUploadsByConversationRef.current.set(currentConversationIdRef.current, next);
          return next;
        });
        composerRef.current?.focus();
      }
      if (result.files.length === 0 && result.skipped.length > 0) {
        setErrorMessage(`${emptySelectionMessage}：\n${result.skipped.join("\n")}`);
        return;
      }
      if (result.skipped.length > 0) {
        addNotify("warning", `以下文件已跳过：\n${result.skipped.join("\n")}`);
      }
    },
    [addNotify, composerRef, currentConversationIdRef, setErrorMessage],
  );

  const pickReadableFiles = useCallback(async () => {
    if (activeUploadTasksRef.current > 0) {
      addNotify("warning", "当前正在上传文件，请稍候");
      return;
    }
    if (!isAgentMode) {
      setErrorMessage("文件上传仅在 tools 模式可用。");
      return;
    }
    if (!workdir) {
      setErrorMessage("请先在项目栏选择或创建项目后再上传文件。");
      return;
    }

    const remainingFileSlots = Math.max(0, MAX_UPLOAD_FILES - pendingUploadedFiles.length);
    if (remainingFileSlots === 0) {
      addNotify("warning", `最多上传 ${MAX_UPLOAD_FILES} 个文件，已忽略多余文件`);
      return;
    }

    const finishUploadTask = beginUploadTask();
    try {
      const result = await invoke<SystemPickReadableFilesResponse>("system_pick_readable_files", {
        workdir,
        maxFiles: remainingFileSlots,
      });
      appendImportedFiles(result, "所选文件均不受当前 Read 支持");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message || "导入文件失败");
    } finally {
      finishUploadTask();
    }
  }, [
    addNotify,
    appendImportedFiles,
    beginUploadTask,
    isAgentMode,
    pendingUploadedFiles.length,
    setErrorMessage,
    workdir,
  ]);

  const importReadableFilePaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      if (activeUploadTasksRef.current > 0) {
        addNotify("warning", "当前正在上传文件，请稍候");
        return;
      }
      if (!isAgentMode) {
        setErrorMessage("文件上传仅在 tools 模式可用。");
        return;
      }
      if (!workdir) {
        setErrorMessage("请先在项目栏选择或创建项目后再上传文件。");
        return;
      }

      const remainingFileSlots = Math.max(0, MAX_UPLOAD_FILES - pendingUploadedFiles.length);
      if (remainingFileSlots === 0) {
        addNotify("warning", `最多上传 ${MAX_UPLOAD_FILES} 个文件，已忽略多余文件`);
        return;
      }

      const finishUploadTask = beginUploadTask();
      try {
        const result = await invoke<SystemPickReadableFilesResponse>(
          "system_import_readable_file_paths",
          { workdir, paths, maxFiles: remainingFileSlots },
        );
        appendImportedFiles(result, "拖入文件均不受当前 Read 支持");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message || "导入文件失败");
      } finally {
        finishUploadTask();
      }
    },
    [
      addNotify,
      appendImportedFiles,
      beginUploadTask,
      isAgentMode,
      pendingUploadedFiles.length,
      setErrorMessage,
      workdir,
    ],
  );

  const importReadableFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      if (activeUploadTasksRef.current > 0) {
        addNotify("warning", "当前正在上传文件，请稍候");
        return;
      }
      if (!isAgentMode) {
        setErrorMessage("文件上传仅在 tools 模式可用。");
        return;
      }
      if (!workdir) {
        setErrorMessage("请先在项目栏选择或创建项目后再上传文件。");
        return;
      }

      const remainingFileSlots = Math.max(0, MAX_UPLOAD_FILES - pendingUploadedFiles.length);
      if (remainingFileSlots === 0) {
        addNotify("warning", `最多上传 ${MAX_UPLOAD_FILES} 个文件，已忽略多余文件`);
        return;
      }

      const importBatch = files.slice(0, remainingFileSlots);
      const ignoredForLimit = files.length - importBatch.length;
      const finishUploadTask = beginUploadTask();
      try {
        const uploadFiles = await Promise.all(importBatch.map(fileToUploadInput));
        const result = await invoke<SystemPickReadableFilesResponse>(
          "system_import_uploaded_readable_files",
          { workdir, files: uploadFiles, maxFiles: remainingFileSlots },
        );
        appendImportedFiles(result, "剪贴板文件均不受当前 Read 支持");
        if (ignoredForLimit > 0) {
          addNotify(
            "warning",
            `最多上传 ${MAX_UPLOAD_FILES} 个文件，已忽略 ${ignoredForLimit} 个额外文件`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message || "导入剪贴板文件失败");
      } finally {
        finishUploadTask();
      }
    },
    [
      addNotify,
      appendImportedFiles,
      beginUploadTask,
      isAgentMode,
      pendingUploadedFiles.length,
      setErrorMessage,
      workdir,
    ],
  );

  const removePendingUpload = useCallback(
    (relativePath: string) => {
      setPendingUploadedFiles((prev) => {
        const next = prev.filter((file) => file.relativePath !== relativePath);
        if (next.length > 0) {
          pendingUploadsByConversationRef.current.set(currentConversationIdRef.current, next);
        } else {
          pendingUploadsByConversationRef.current.delete(currentConversationIdRef.current);
        }
        return next;
      });
    },
    [currentConversationIdRef],
  );

  return {
    isUploadingFiles,
    pendingUploadedFiles,
    setPendingUploadedFiles,
    pendingUploadsByConversationRef,
    pickReadableFiles,
    importReadableFilePaths,
    importReadableFiles,
    removePendingUpload,
  };
}
