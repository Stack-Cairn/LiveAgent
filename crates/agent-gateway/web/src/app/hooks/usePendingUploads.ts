import { useCallback, useEffect, useRef, useState, type DragEvent, type RefObject } from "react";

import type { MentionComposerHandle } from "@/components/chat/MentionComposer";
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
import { t as translate } from "@/i18n";

import { asErrorMessage } from "../chatEventUtils";
import { MAX_UPLOAD_FILES } from "../constants";
import { dragEventHasFiles } from "../domUtils";
import { formatTranslation } from "../historyUtils";

type UsePendingUploadsParams = {
  token: string;
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
  setChatError: (message: string | null) => void;
};

export function usePendingUploads(params: UsePendingUploadsParams) {
  const {
    token,
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
    setChatError,
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

  const displayedConversationId = (selectedHistoryId || conversationId).trim();
  displayedConversationIdRef.current = displayedConversationId;

  const isDisplayedConversation = useCallback((targetConversationId: string) => {
    const conversationIdValue = targetConversationId.trim();
    return (
      conversationIdValue !== "" && displayedConversationIdRef.current === conversationIdValue
    );
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
    pendingUploadedFilesRef.current = pendingUploadedFiles;
  }, [pendingUploadedFiles]);

  useEffect(() => {
    const nextFiles = displayedConversationId
      ? (pendingUploadsByConversationRef.current.get(displayedConversationId) ?? [])
      : [];
    pendingUploadedFilesRef.current = nextFiles;
    setPendingUploadedFiles(nextFiles);
  }, [displayedConversationId]);

  useEffect(() => {
    isUploadingFilesRef.current = isUploadingFiles;
  }, [isUploadingFiles]);

  const handleImportReadableFiles = useCallback(
    async (filesToImport: File[]) => {
      if (filesToImport.length === 0) {
        return;
      }
      if (isUploadingFilesRef.current) {
        setChatError(translate("chat.upload.uploading", locale));
        return;
      }
      if (executionMode === "text") {
        setChatError(translate("chat.upload.onlyInTools", locale));
        return;
      }
      const workdir = displayedConversationWorkdirRef.current.trim();
      if (!workdir) {
        setChatError(translate("chat.upload.requireWorkdir", locale));
        return;
      }
      const targetConversationId = displayedConversationIdRef.current;
      if (!targetConversationId) {
        setChatError("请先选择或创建会话后再上传文件。");
        return;
      }

      const currentUploads = getPendingUploadsForConversation(targetConversationId);
      setPendingUploadsForConversation(targetConversationId, currentUploads);
      const remainingFileSlots = Math.max(0, MAX_UPLOAD_FILES - currentUploads.length);
      if (remainingFileSlots === 0) {
        setChatError(
          formatTranslation(translate("chat.upload.maxFilesIgnored", locale), {
            max: MAX_UPLOAD_FILES,
            count: filesToImport.length,
          }),
        );
        return;
      }

      const importBatch = filesToImport.slice(0, remainingFileSlots);
      const ignoredForLimit = filesToImport.length - importBatch.length;
      setChatError(null);
      isUploadingFilesRef.current = true;
      setIsUploadingFiles(true);
      try {
        const result = await importReadableFiles(token, workdir, importBatch);
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

        const warnings: string[] = [];
        if (result.files.length === 0 && result.skipped.length > 0) {
          warnings.push(`所选文件均无法导入：\n${result.skipped.join("\n")}`);
        } else if (result.skipped.length > 0) {
          warnings.push(`以下文件已跳过：\n${result.skipped.join("\n")}`);
        }
        if (ignoredForLimit > 0) {
          warnings.push(
            formatTranslation(translate("chat.upload.maxFilesIgnored", locale), {
              max: MAX_UPLOAD_FILES,
              count: ignoredForLimit,
            }),
          );
        }
        if (warnings.length > 0 && isDisplayedConversation(targetConversationId)) {
          setChatError(warnings.join("\n"));
        }
      } catch (error) {
        if (isDisplayedConversation(targetConversationId)) {
          setChatError(asErrorMessage(error, "导入文件失败"));
        }
      } finally {
        isUploadingFilesRef.current = false;
        setIsUploadingFiles(false);
      }
    },
    [
      composerRef,
      displayedConversationWorkdirRef,
      executionMode,
      getPendingUploadsForConversation,
      isDisplayedConversation,
      locale,
      setChatError,
      setPendingUploadsForConversation,
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
            setChatError("无法读取剪贴板中的文件，请尝试拖拽或点击上传。");
            return;
          }
          return handleImportReadableFiles(files);
        })
        .catch((error) => {
          setChatError(asErrorMessage(error, "读取剪贴板文件失败"));
        });
    };

    document.addEventListener("paste", handleDocumentPaste, true);
    return () => {
      document.removeEventListener("paste", handleDocumentPaste, true);
    };
  }, [
    activeView,
    handleImportReadableFiles,
    historyShareToken,
    settingsOpen,
    settingsSyncReady,
    setChatError,
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
        setChatError(options.disabledMessage);
        return;
      }
      void handleImportReadableFiles(files);
    },
    [handleImportReadableFiles, setChatError],
  );

  return {
    pendingUploadedFiles,
    pendingUploadedFilesRef,
    pendingUploadsByConversationRef,
    isUploadingFiles,
    isUploadingFilesRef,
    isFileDropActive,
    fileInputRef,
    setIsUploadingFiles,
    getPendingUploadsForConversation,
    setPendingUploadsForConversation,
    updatePendingUploadsForConversation,
    clearPendingUploads,
    handleImportReadableFiles,
    handleFileDragEnter,
    handleFileDragOver,
    handleFileDragLeave,
    handleFileDrop,
  };
}
