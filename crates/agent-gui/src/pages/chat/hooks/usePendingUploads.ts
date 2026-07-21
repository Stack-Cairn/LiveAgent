import { invoke } from "@tauri-apps/api/core";
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";

import type { MentionComposerHandle } from "../../../components/chat/MentionComposer";
import type { NotifyItem } from "../../../components/chat/NotifyToast";
import {
  mergePendingUploadedFiles,
  type PendingUploadedFile,
} from "../../../lib/chat/messages/uploadedFiles";

type SystemPickReadableFilesResponse = {
  files: PendingUploadedFile[];
  skipped: string[];
};

type SystemUploadedReadableFileInput = {
  fileName: string;
  mimeType?: string;
  contentBase64: string;
};

type UploadTarget = {
  targetConversationId: string;
  targetWorkdir: string;
  remainingFileSlots: number;
};

type UsePendingUploadsParams = {
  isAgentMode: boolean;
  workdir: string;
  conversationId: string;
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
    conversationId,
    currentConversationIdRef,
    composerRef,
    setErrorMessage,
    addNotify,
  } = params;
  const [pendingUploadedFiles, setPendingUploadedFiles] = useState<PendingUploadedFile[]>([]);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const uploadTaskActiveRef = useRef(false);
  const pendingUploadsByConversationRef = useRef(new Map<string, PendingUploadedFile[]>());
  const pendingUploadedFilesRef = useRef(pendingUploadedFiles);
  // Render-assigned mirrors: an in-flight import settling between a render
  // and its effects must still see the latest mode/workdir when it decides
  // whether its result is stale.
  const isAgentModeRef = useRef(isAgentMode);
  isAgentModeRef.current = isAgentMode;
  const workdirRef = useRef(workdir);
  workdirRef.current = workdir;
  const uploadContextRef = useRef<{
    isAgentMode: boolean;
    workdir: string;
    conversationId: string;
  } | null>(null);

  const getPendingUploadsForConversation = useCallback(
    (conversationId: string) => {
      const targetConversationId = conversationId.trim();
      if (
        !targetConversationId ||
        currentConversationIdRef.current.trim() === targetConversationId
      ) {
        return pendingUploadedFilesRef.current;
      }
      return pendingUploadsByConversationRef.current.get(targetConversationId) ?? [];
    },
    [currentConversationIdRef],
  );

  // The single write path: keeps the per-conversation map, the synchronous
  // read ref, and the rendered state in step within the same tick. Every
  // pending-uploads mutation (including the consumers') must go through it.
  const setPendingUploadsForConversation = useCallback(
    (conversationId: string, nextFiles: PendingUploadedFile[]) => {
      const targetConversationId = conversationId.trim();
      const normalizedFiles = nextFiles.slice();
      if (targetConversationId) {
        if (normalizedFiles.length > 0) {
          pendingUploadsByConversationRef.current.set(targetConversationId, normalizedFiles);
        } else {
          pendingUploadsByConversationRef.current.delete(targetConversationId);
        }
      }
      if (
        !targetConversationId ||
        currentConversationIdRef.current.trim() === targetConversationId
      ) {
        pendingUploadedFilesRef.current = normalizedFiles;
        setPendingUploadedFiles(normalizedFiles);
      }
    },
    [currentConversationIdRef],
  );

  useEffect(() => {
    const targetConversationId = conversationId.trim();
    const nextFiles = targetConversationId
      ? (pendingUploadsByConversationRef.current.get(targetConversationId) ?? [])
      : [];
    pendingUploadedFilesRef.current = nextFiles;
    setPendingUploadedFiles(nextFiles);
  }, [conversationId]);

  useEffect(() => {
    const previous = uploadContextRef.current;
    uploadContextRef.current = { isAgentMode, workdir, conversationId };
    if (!previous) return;
    if (previous.isAgentMode !== isAgentMode) {
      // Attachments are only usable in tools mode; a mode flip invalidates
      // every conversation's pending uploads.
      pendingUploadsByConversationRef.current.clear();
      pendingUploadedFilesRef.current = [];
      setPendingUploadedFiles([]);
      return;
    }
    // Switching conversations must not invalidate any conversation's
    // uploads. Only a workdir change within the same conversation (a draft
    // switching projects) invalidates them: staged uploads stay readable,
    // but files picked inside the old workspace are not.
    if (previous.conversationId !== conversationId) return;
    if (previous.workdir === workdir) return;
    setPendingUploadsForConversation(conversationId, []);
  }, [isAgentMode, workdir, conversationId, setPendingUploadsForConversation]);

  const captureUploadTarget = useCallback((): UploadTarget | null => {
    const targetConversationId = currentConversationIdRef.current.trim();
    if (!targetConversationId) {
      setErrorMessage("请先选择或创建会话后再上传文件。");
      return null;
    }

    const currentTargetUploads = getPendingUploadsForConversation(targetConversationId);
    const remainingFileSlots = Math.max(0, MAX_UPLOAD_FILES - currentTargetUploads.length);
    if (remainingFileSlots === 0) {
      addNotify("warning", `最多上传 ${MAX_UPLOAD_FILES} 个文件，已忽略多余文件`);
      return null;
    }

    return {
      targetConversationId,
      targetWorkdir: workdir,
      remainingFileSlots,
    };
  }, [
    addNotify,
    currentConversationIdRef,
    getPendingUploadsForConversation,
    setErrorMessage,
    workdir,
  ]);

  const appendImportedFiles = useCallback(
    (
      target: UploadTarget,
      result: SystemPickReadableFilesResponse,
      emptySelectionMessage: string,
    ) => {
      const { targetConversationId, targetWorkdir } = target;
      const isTargetDisplayed = currentConversationIdRef.current.trim() === targetConversationId;
      // An import that settles after its upload context was invalidated must
      // not resurrect cleared attachments: files picked inside the old
      // workspace are not readable from the new one.
      if (!isAgentModeRef.current || (isTargetDisplayed && workdirRef.current !== targetWorkdir)) {
        addNotify("warning", "上传目标已失效，已忽略本次导入的文件");
        return;
      }
      if (result.files.length === 0 && result.skipped.length === 0) {
        return;
      }
      if (result.files.length > 0) {
        const previous = getPendingUploadsForConversation(targetConversationId);
        const merged = mergePendingUploadedFiles(previous, result.files);
        if (merged.length > MAX_UPLOAD_FILES) {
          addNotify("warning", `最多上传 ${MAX_UPLOAD_FILES} 个文件，已忽略多余文件`);
        }
        setPendingUploadsForConversation(targetConversationId, merged.slice(0, MAX_UPLOAD_FILES));
        if (isTargetDisplayed) {
          composerRef.current?.focus();
        }
      }
      if (result.files.length === 0 && result.skipped.length > 0) {
        if (isTargetDisplayed) {
          setErrorMessage(`${emptySelectionMessage}：\n${result.skipped.join("\n")}`);
        } else {
          addNotify("warning", `${emptySelectionMessage}：\n${result.skipped.join("\n")}`);
        }
        return;
      }
      if (result.skipped.length > 0) {
        addNotify("warning", `以下文件已跳过：\n${result.skipped.join("\n")}`);
      }
    },
    [
      addNotify,
      composerRef,
      currentConversationIdRef,
      getPendingUploadsForConversation,
      setErrorMessage,
      setPendingUploadsForConversation,
    ],
  );

  // Shared import skeleton: single-flight guard, mode/workdir preconditions,
  // busy state, result merge, and error routing to the owning conversation.
  const runUploadTask = useCallback(
    async (task: {
      emptySelectionMessage: string;
      errorFallback: string;
      importer: (target: UploadTarget) => Promise<SystemPickReadableFilesResponse>;
    }) => {
      if (uploadTaskActiveRef.current) {
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

      const uploadTarget = captureUploadTarget();
      if (!uploadTarget) {
        return;
      }

      uploadTaskActiveRef.current = true;
      setIsUploadingFiles(true);
      try {
        const result = await task.importer(uploadTarget);
        appendImportedFiles(uploadTarget, result, task.emptySelectionMessage);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (currentConversationIdRef.current.trim() === uploadTarget.targetConversationId) {
          setErrorMessage(message || task.errorFallback);
        } else {
          addNotify("warning", message || task.errorFallback);
        }
      } finally {
        uploadTaskActiveRef.current = false;
        setIsUploadingFiles(false);
      }
    },
    [
      addNotify,
      appendImportedFiles,
      captureUploadTarget,
      currentConversationIdRef,
      isAgentMode,
      setErrorMessage,
      workdir,
    ],
  );

  const pickReadableFiles = useCallback(
    () =>
      runUploadTask({
        emptySelectionMessage: "所选文件均不受当前 Read 支持",
        errorFallback: "导入文件失败",
        importer: ({ targetWorkdir, remainingFileSlots }) =>
          invoke<SystemPickReadableFilesResponse>("system_pick_readable_files", {
            workdir: targetWorkdir,
            maxFiles: remainingFileSlots,
          }),
      }),
    [runUploadTask],
  );

  const importReadableFilePaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      await runUploadTask({
        emptySelectionMessage: "拖入文件均不受当前 Read 支持",
        errorFallback: "导入文件失败",
        importer: ({ targetWorkdir, remainingFileSlots }) =>
          invoke<SystemPickReadableFilesResponse>("system_import_readable_file_paths", {
            workdir: targetWorkdir,
            paths,
            maxFiles: remainingFileSlots,
          }),
      });
    },
    [runUploadTask],
  );

  const importReadableFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      await runUploadTask({
        emptySelectionMessage: "剪贴板文件均不受当前 Read 支持",
        errorFallback: "导入剪贴板文件失败",
        importer: async ({ targetWorkdir, remainingFileSlots }) => {
          const importBatch = files.slice(0, remainingFileSlots);
          const ignoredForLimit = files.length - importBatch.length;
          if (ignoredForLimit > 0) {
            addNotify(
              "warning",
              `最多上传 ${MAX_UPLOAD_FILES} 个文件，已忽略 ${ignoredForLimit} 个额外文件`,
            );
          }
          const uploadFiles = await Promise.all(importBatch.map(fileToUploadInput));
          return invoke<SystemPickReadableFilesResponse>("system_import_uploaded_readable_files", {
            workdir: targetWorkdir,
            files: uploadFiles,
            maxFiles: remainingFileSlots,
          });
        },
      });
    },
    [addNotify, runUploadTask],
  );

  const removePendingUpload = useCallback(
    (relativePath: string) => {
      const targetConversationId = currentConversationIdRef.current.trim();
      const next = getPendingUploadsForConversation(targetConversationId).filter(
        (file) => file.relativePath !== relativePath,
      );
      setPendingUploadsForConversation(targetConversationId, next);
    },
    [currentConversationIdRef, getPendingUploadsForConversation, setPendingUploadsForConversation],
  );

  return {
    isUploadingFiles,
    pendingUploadedFiles,
    getPendingUploadsForConversation,
    setPendingUploadsForConversation,
    pickReadableFiles,
    importReadableFilePaths,
    importReadableFiles,
    removePendingUpload,
  };
}
