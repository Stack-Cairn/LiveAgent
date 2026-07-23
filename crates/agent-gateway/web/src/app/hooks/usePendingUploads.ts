import { type DragEvent, type RefObject, useCallback, useEffect, useRef, useState } from "react";

import type { MentionComposerHandle } from "@/components/chat/MentionComposer";
import type { NotifyItem } from "@/components/chat/NotifyToast";
import { t as translate } from "@/i18n";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";
import { mergePendingUploadedFiles } from "@/lib/chat/uploadedFiles";
import { registerLocalUploadedImagePreviews } from "@/lib/chat/uploadedImagePreview";
import {
  clipboardHasFileSignal,
  extractClipboardFiles,
  readClipboardFiles,
} from "@/lib/clipboardFiles";
import type { AppSettings } from "@/lib/settings";
import { importReadableFiles } from "@/lib/uploadReadableFiles";

import { asErrorMessage } from "../chatEventUtils";
import { MAX_UPLOAD_FILES } from "../constants";
import { dragEventHasFiles } from "../domUtils";
import { formatTranslation } from "../historyUtils";

type UsePendingUploadsParams = {
  token: string;
  resolveAgentID: () => Promise<string>;
  historyShareToken: string | null;
  settingsSyncReady: boolean;
  settingsOpen: boolean;
  activeView: "chat" | "skills-hub" | "mcp-hub";
  locale: AppSettings["locale"];
  executionMode: AppSettings["system"]["executionMode"];
  conversationId: string;
  selectedHistoryId: string;
  displayedConversationWorkdirRef: RefObject<string>;
  composerRef: RefObject<MentionComposerHandle | null>;
  // Upload feedback goes to the top-right toast stack, never into the
  // transcript area — a failed upload is not conversation output.
  addNotify: (type: NotifyItem["type"], message: string) => void;
};

export function usePendingUploads(params: UsePendingUploadsParams) {
  const {
    token,
    resolveAgentID,
    historyShareToken,
    settingsSyncReady,
    settingsOpen,
    activeView,
    locale,
    executionMode,
    conversationId,
    selectedHistoryId,
    displayedConversationWorkdirRef,
    composerRef,
    addNotify,
  } = params;

  const [pendingUploadedFiles, setPendingUploadedFiles] = useState<PendingUploadedFile[]>([]);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [isFileDropActive, setIsFileDropActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingUploadedFilesRef = useRef(pendingUploadedFiles);
  const pendingUploadsByConversationRef = useRef<Map<string, PendingUploadedFile[]>>(new Map());
  const isUploadingFilesRef = useRef(isUploadingFiles);
  const uploadDragDepthRef = useRef(0);
  const displayedConversationIdRef = useRef("");
  // Render-assigned mirror: an in-flight import settling between a render and
  // its effects must still see the latest mode when it decides whether its
  // result is stale.
  const executionModeRef = useRef(executionMode);
  executionModeRef.current = executionMode;

  const displayedConversationId = (selectedHistoryId || conversationId).trim();
  displayedConversationIdRef.current = displayedConversationId;

  const setUploadingFiles = useCallback((active: boolean) => {
    isUploadingFilesRef.current = active;
    setIsUploadingFiles(active);
  }, []);

  const isDisplayedConversation = useCallback((targetConversationId: string) => {
    const conversationIdValue = targetConversationId.trim();
    return conversationIdValue !== "" && displayedConversationIdRef.current === conversationIdValue;
  }, []);

  const getPendingUploadsForConversation = useCallback(
    (targetConversationId: string) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue || isDisplayedConversation(conversationIdValue)) {
        return pendingUploadedFilesRef.current;
      }
      return pendingUploadsByConversationRef.current.get(conversationIdValue) ?? [];
    },
    [isDisplayedConversation],
  );

  const setPendingUploadsForConversation = useCallback(
    (targetConversationId: string, nextFiles: PendingUploadedFile[]) => {
      const conversationIdValue = targetConversationId.trim();
      const normalizedFiles = nextFiles.slice();
      if (conversationIdValue) {
        if (normalizedFiles.length > 0) {
          pendingUploadsByConversationRef.current.set(conversationIdValue, normalizedFiles);
        } else {
          pendingUploadsByConversationRef.current.delete(conversationIdValue);
        }
      }
      if (!conversationIdValue || isDisplayedConversation(conversationIdValue)) {
        pendingUploadedFilesRef.current = normalizedFiles;
        setPendingUploadedFiles(normalizedFiles);
      }
    },
    [isDisplayedConversation],
  );

  const updatePendingUploadsForConversation = useCallback(
    (
      targetConversationId: string,
      updater: (current: PendingUploadedFile[]) => PendingUploadedFile[],
    ) => {
      const conversationIdValue = targetConversationId.trim();
      const currentFiles = getPendingUploadsForConversation(conversationIdValue);
      const nextFiles = updater(currentFiles);
      setPendingUploadsForConversation(conversationIdValue, nextFiles);
      return nextFiles;
    },
    [getPendingUploadsForConversation, setPendingUploadsForConversation],
  );

  // A draft conversation got its real id: re-key its stored uploads without
  // touching the rendered state — the displayed id flips to `nextId` in the
  // same commit, so the switch effect below re-reads the moved entry.
  const moveConversationUploads = useCallback((previousId: string, nextId: string) => {
    const previous = previousId.trim();
    const next = nextId.trim();
    if (!previous || !next || previous === next) {
      return;
    }
    const files = pendingUploadsByConversationRef.current.get(previous);
    if (files === undefined) {
      return;
    }
    pendingUploadsByConversationRef.current.delete(previous);
    pendingUploadsByConversationRef.current.set(next, files);
  }, []);

  const clearPendingUploads = useCallback(() => {
    pendingUploadedFilesRef.current = [];
    pendingUploadsByConversationRef.current.clear();
    isUploadingFilesRef.current = false;
    uploadDragDepthRef.current = 0;
    setPendingUploadedFiles([]);
    setIsUploadingFiles(false);
    setIsFileDropActive(false);
  }, []);

  useEffect(() => {
    const nextFiles = displayedConversationId
      ? (pendingUploadsByConversationRef.current.get(displayedConversationId) ?? [])
      : [];
    pendingUploadedFilesRef.current = nextFiles;
    setPendingUploadedFiles(nextFiles);
  }, [displayedConversationId]);

  const handleImportReadableFiles = useCallback(
    async (filesToImport: File[]) => {
      if (filesToImport.length === 0) {
        return;
      }
      if (isUploadingFilesRef.current) {
        addNotify("warning", translate("chat.upload.uploading", locale));
        return;
      }
      if (executionMode === "text") {
        addNotify("warning", translate("chat.upload.onlyInTools", locale));
        return;
      }
      const workdir = displayedConversationWorkdirRef.current.trim();
      if (!workdir) {
        addNotify("warning", translate("chat.upload.requireWorkdir", locale));
        return;
      }
      const targetConversationId = displayedConversationIdRef.current;
      if (!targetConversationId) {
        addNotify("warning", "请先选择或创建会话后再上传文件。");
        return;
      }

      const currentUploads = getPendingUploadsForConversation(targetConversationId);
      setPendingUploadsForConversation(targetConversationId, currentUploads);
      const remainingFileSlots = Math.max(0, MAX_UPLOAD_FILES - currentUploads.length);
      if (remainingFileSlots === 0) {
        addNotify(
          "warning",
          formatTranslation(translate("chat.upload.maxFilesIgnored", locale), {
            max: MAX_UPLOAD_FILES,
            count: filesToImport.length,
          }),
        );
        return;
      }

      const importBatch = filesToImport.slice(0, remainingFileSlots);
      const ignoredForLimit = filesToImport.length - importBatch.length;
      setUploadingFiles(true);
      try {
        const agentID = await resolveAgentID();
        const result = await importReadableFiles(token, agentID, workdir, importBatch);
        // An import that settles after its upload context was invalidated
        // must not resurrect cleared attachments: files picked inside the
        // old workspace are not readable from the new one.
        if (
          (await resolveAgentID()) !== agentID ||
          executionModeRef.current === "text" ||
          (isDisplayedConversation(targetConversationId) &&
            displayedConversationWorkdirRef.current.trim() !== workdir)
        ) {
          addNotify("warning", "上传目标已失效，已忽略本次导入的文件");
          return;
        }
        registerLocalUploadedImagePreviews({
          workspaceRoot: workdir,
          uploadedFiles: result.files,
          sourceFiles: importBatch,
        });

        if (result.files.length > 0) {
          updatePendingUploadsForConversation(targetConversationId, (current) =>
            mergePendingUploadedFiles(current, result.files).slice(0, MAX_UPLOAD_FILES),
          );
          if (isDisplayedConversation(targetConversationId)) {
            composerRef.current?.focus();
          }
        }

        if (result.files.length === 0 && result.skipped.length > 0) {
          addNotify("error", `所选文件均无法导入：\n${result.skipped.join("\n")}`);
        } else if (result.skipped.length > 0) {
          addNotify("warning", `以下文件已跳过：\n${result.skipped.join("\n")}`);
        }
        if (ignoredForLimit > 0) {
          addNotify(
            "warning",
            formatTranslation(translate("chat.upload.maxFilesIgnored", locale), {
              max: MAX_UPLOAD_FILES,
              count: ignoredForLimit,
            }),
          );
        }
      } catch (error) {
        addNotify("error", asErrorMessage(error, "导入文件失败"));
      } finally {
        setUploadingFiles(false);
      }
    },
    [
      addNotify,
      composerRef,
      displayedConversationWorkdirRef,
      executionMode,
      getPendingUploadsForConversation,
      isDisplayedConversation,
      locale,
      resolveAgentID,
      setPendingUploadsForConversation,
      setUploadingFiles,
      token,
      updatePendingUploadsForConversation,
    ],
  );

  useEffect(() => {
    if (
      !token ||
      historyShareToken ||
      !settingsSyncReady ||
      settingsOpen ||
      activeView !== "chat"
    ) {
      return;
    }

    const handleDocumentPaste = (event: globalThis.ClipboardEvent) => {
      if (event.defaultPrevented) return;
      const clipboardFiles = extractClipboardFiles(event.clipboardData);
      if (clipboardFiles.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        void handleImportReadableFiles(clipboardFiles);
        return;
      }
      if (!clipboardHasFileSignal(event.clipboardData)) return;

      event.preventDefault();
      event.stopPropagation();
      void readClipboardFiles()
        .then((files) => {
          if (files.length === 0) {
            addNotify("warning", "无法读取剪贴板中的文件，请尝试拖拽或点击上传。");
            return;
          }
          return handleImportReadableFiles(files);
        })
        .catch((error) => {
          addNotify("error", asErrorMessage(error, "读取剪贴板文件失败"));
        });
    };

    document.addEventListener("paste", handleDocumentPaste, true);
    return () => {
      document.removeEventListener("paste", handleDocumentPaste, true);
    };
  }, [
    activeView,
    addNotify,
    handleImportReadableFiles,
    historyShareToken,
    settingsOpen,
    settingsSyncReady,
    token,
  ]);

  const handleFileDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    uploadDragDepthRef.current += 1;
    setIsFileDropActive(true);
  }, []);

  const handleFileDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>, canDropUpload: boolean) => {
      if (!dragEventHasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = canDropUpload ? "copy" : "none";
      setIsFileDropActive(true);
    },
    [],
  );

  const handleFileDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    uploadDragDepthRef.current = Math.max(0, uploadDragDepthRef.current - 1);
    if (uploadDragDepthRef.current === 0) {
      setIsFileDropActive(false);
    }
  }, []);

  const handleFileDrop = useCallback(
    (
      event: DragEvent<HTMLDivElement>,
      options: {
        canDropUpload: boolean;
        disabledMessage: string;
      },
    ) => {
      if (!dragEventHasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      uploadDragDepthRef.current = 0;
      setIsFileDropActive(false);

      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length === 0) return;
      if (!options.canDropUpload) {
        addNotify("warning", options.disabledMessage);
        return;
      }
      void handleImportReadableFiles(files);
    },
    [addNotify, handleImportReadableFiles],
  );

  return {
    pendingUploadedFiles,
    isUploadingFiles,
    isFileDropActive,
    fileInputRef,
    setUploadingFiles,
    getPendingUploadsForConversation,
    setPendingUploadsForConversation,
    updatePendingUploadsForConversation,
    moveConversationUploads,
    clearPendingUploads,
    handleImportReadableFiles,
    handleFileDragEnter,
    handleFileDragOver,
    handleFileDragLeave,
    handleFileDrop,
  };
}
