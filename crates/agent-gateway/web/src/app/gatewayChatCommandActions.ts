import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";
import { normalizeLogicalLineEndings } from "@liveagent/ui/lib/chat/composerText";
import { queuedChatTurnHasContent } from "@liveagent/ui/lib/chat/queuedChatTurn";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { mergePendingUploadedFiles } from "@liveagent/ui/lib/chat/uploadedFiles";
import type { ScrollFollowHandle } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ActivityStore } from "@/lib/chat/stream/activityStore";
import type {
  ChatCommandOutcome,
  ChatCommandPipeline,
} from "@/lib/chat/stream/chatCommandPipeline";
import type { TranscriptStoreRegistry } from "@/lib/chat/stream/useConversationChat";
import { buildOptimisticConversationTitle } from "@/lib/chatUi";
import type { GatewayWebSocketClient } from "@/lib/gatewaySocket";
import type { ChatQueueSnapshot } from "@/lib/gatewayTypes";
import {
  type AppSettings,
  normalizeChatRuntimeControlsForProvider,
  type SelectedModel,
} from "@/lib/settings";

import { buildTextFromComposerDraft, importPastedTextsAsFiles } from "./chatDraft";
import {
  asErrorMessage,
  buildGatewaySelectedModel,
  buildGatewaySystemSettings,
  isAbortError,
} from "./chatEventUtils";
import { CHAT_RUNTIME_PREPARE_TIMEOUT_MS } from "./constants";
import { createLocalDraftConversationId } from "./gatewayLocalDraft";
import type { ModelProviderSource, SendChatFn, SendChatOptions } from "./types";

type QueuedEditSession = { itemId: string; revision: number };

type GatewayChatCommandActionOptions = {
  activeProviders: ModelProviderSource[];
  activeWorkspaceProjectPath: string;
  activityStore: ActivityStore;
  api: GatewayWebSocketClient | null;
  apiRef: MutableRefObject<GatewayWebSocketClient | null>;
  applyChatQueueSnapshot: (snapshot: ChatQueueSnapshot | null | undefined) => void;
  chatCommandPipeline: ChatCommandPipeline;
  chatQueueRevisionRef: MutableRefObject<number>;
  chatRuntimeControlsForCurrentProvider: AppSettings["chatRuntimeControls"];
  clearCachedComposerDraft: (conversationId?: string) => void;
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  conversationIdRef: MutableRefObject<string>;
  conversationWorkdirsRef: MutableRefObject<Map<string, string>>;
  displayedConversationWorkdirRef: MutableRefObject<string>;
  draftClientRequestsRef: MutableRefObject<Map<string, string>>;
  getDisplayedConversationId: () => string;
  getPendingUploadsForConversation: (conversationId: string) => PendingUploadedFile[];
  isAgentMode: boolean;
  isDisplayedConversation: (conversationId: string) => boolean;
  isImportingPastedTextRef: MutableRefObject<boolean>;
  isLocalDraftConversationId: (conversationId: string) => boolean;
  pendingUploadedFiles: PendingUploadedFile[];
  prepareChatRuntime: (
    reason: string,
    currentApi?: GatewayWebSocketClient | null,
    timeoutMs?: number,
  ) => Promise<unknown>;
  protectedConversationRef: MutableRefObject<string>;
  queuedChatEditSessionRef: MutableRefObject<QueuedEditSession | null>;
  refreshChatQueueSnapshot: (conversationId: string) => void;
  resolveActiveAgentID: () => Promise<string>;
  selectedHistoryIdRef: MutableRefObject<string>;
  selectionForConversation: (conversationId: string) => SelectedModel | undefined;
  sendChatRef: MutableRefObject<SendChatFn | null>;
  setChatError: Dispatch<SetStateAction<string | null>>;
  setConversationId: Dispatch<SetStateAction<string>>;
  setPendingUploadsForConversation: (conversationId: string, files: PendingUploadedFile[]) => void;
  setSelectedHistoryId: Dispatch<SetStateAction<string>>;
  setUploadingFiles: (active: boolean) => void;
  settings: AppSettings;
  sidebarStore: SidebarStore;
  token: string;
  transcriptFollow: ScrollFollowHandle;
  transcriptStoreRegistry: TranscriptStoreRegistry;
};

export function resolveConversationRuntimeControls(input: {
  activeProviders: ModelProviderSource[];
  selectedModel: SelectedModel | undefined;
  runtimeControls: AppSettings["chatRuntimeControls"];
}) {
  const provider = input.activeProviders.find(
    (entry) => entry.id === input.selectedModel?.customProviderId,
  );
  return normalizeChatRuntimeControlsForProvider(input.runtimeControls, {
    providerId: provider?.type,
    requestFormat: provider?.requestFormat,
    modelId: input.selectedModel?.model,
  });
}

export function createGatewayChatCommandActions(options: GatewayChatCommandActionOptions) {
  const {
    activeProviders,
    activeWorkspaceProjectPath,
    activityStore,
    api,
    apiRef,
    applyChatQueueSnapshot,
    chatCommandPipeline,
    chatQueueRevisionRef,
    chatRuntimeControlsForCurrentProvider,
    clearCachedComposerDraft,
    composerRef,
    conversationIdRef,
    conversationWorkdirsRef,
    displayedConversationWorkdirRef,
    draftClientRequestsRef,
    getDisplayedConversationId,
    getPendingUploadsForConversation,
    isAgentMode,
    isDisplayedConversation,
    isImportingPastedTextRef,
    isLocalDraftConversationId,
    pendingUploadedFiles,
    prepareChatRuntime,
    protectedConversationRef,
    queuedChatEditSessionRef,
    refreshChatQueueSnapshot,
    resolveActiveAgentID,
    selectedHistoryIdRef,
    selectionForConversation,
    sendChatRef,
    setChatError,
    setConversationId,
    setPendingUploadsForConversation,
    setSelectedHistoryId,
    setUploadingFiles,
    settings,
    sidebarStore,
    token,
    transcriptFollow,
    transcriptStoreRegistry,
  } = options;

  const reportChatQueueActionError = (conversationId: string, error: unknown, fallback: string) => {
    const key = conversationId.trim();
    if (key && isDisplayedConversation(key)) {
      setChatError(asErrorMessage(error, fallback));
    }
  };

  const sendChat = async (
    message: string,
    sendOptions?: SendChatOptions,
  ): Promise<ChatCommandOutcome | null> => {
    if (!api) return null;
    const uploadedFiles = sendOptions?.uploadedFiles ?? [];
    let activeConversationId =
      sendOptions?.conversationId?.trim() || conversationIdRef.current.trim();
    if (!activeConversationId) {
      activeConversationId = createLocalDraftConversationId();
      conversationIdRef.current = activeConversationId;
      selectedHistoryIdRef.current = activeConversationId;
      setConversationId(activeConversationId);
      setSelectedHistoryId(activeConversationId);
    }
    const startedAsDraftConversation = isLocalDraftConversationId(activeConversationId);
    if (chatCommandPipeline.hasPending(activeConversationId)) return null;
    clearCachedComposerDraft(activeConversationId);

    const clientRequestId = sendOptions?.clientRequestId?.trim() || createUuid();
    const startedAt = Date.now();
    const persistedWorkdir = sidebarStore.peek(activeConversationId)?.cwd?.trim() || "";
    const runtimeWorkdir = conversationWorkdirsRef.current.get(activeConversationId)?.trim() || "";
    const effectiveWorkdir = isAgentMode
      ? sendOptions?.workdir?.trim() ||
        persistedWorkdir ||
        runtimeWorkdir ||
        activeWorkspaceProjectPath ||
        settings.system.workdir.trim()
      : "";
    if (effectiveWorkdir)
      conversationWorkdirsRef.current.set(activeConversationId, effectiveWorkdir);
    protectedConversationRef.current = activeConversationId;
    setChatError(null);
    if (isDisplayedConversation(activeConversationId)) transcriptFollow.stickToBottom();
    const turnSelectedModel = selectionForConversation(activeConversationId);
    if (startedAsDraftConversation) {
      draftClientRequestsRef.current.set(clientRequestId, activeConversationId);
      sidebarStore.upsertLocal({
        id: activeConversationId,
        title: buildOptimisticConversationTitle(message),
        providerId: turnSelectedModel?.customProviderId ?? "",
        model: turnSelectedModel?.model ?? "",
        cwd: effectiveWorkdir || undefined,
        messageCount: 1,
        createdAt: startedAt,
        updatedAt: startedAt,
        isPending: true,
      });
    }

    const runtimeControls = resolveConversationRuntimeControls({
      activeProviders,
      selectedModel: turnSelectedModel,
      runtimeControls: sendOptions?.runtimeControls ?? settings.chatRuntimeControls,
    });
    const outcome = await chatCommandPipeline.submit({
      conversationId: activeConversationId,
      clientRequestId,
      message,
      attachments: uploadedFiles,
      isEditResend: Boolean(sendOptions?.editMessageRef),
      baseMessageRef: sendOptions?.editMessageRef,
      optimistic: sendOptions?.optimisticEcho !== false,
      submit: async () => {
        await prepareChatRuntime("send", api, CHAT_RUNTIME_PREPARE_TIMEOUT_MS);
        return api.chatCommand({
          type: sendOptions?.editMessageRef ? "chat.edit_resend" : "chat.submit",
          message,
          conversationId: startedAsDraftConversation ? undefined : activeConversationId,
          selectedModel: buildGatewaySelectedModel(turnSelectedModel, activeProviders),
          systemSettings: buildGatewaySystemSettings(settings, effectiveWorkdir),
          uploadedFiles,
          clientRequestId,
          runtimeControls,
          baseMessageRef: sendOptions?.editMessageRef,
          queuePolicy: sendOptions?.queuePolicy ?? "auto",
        });
      },
    });
    if (outcome.kind === "accepted") {
      const acceptedId = outcome.accepted.conversationId.trim();
      if (
        startedAsDraftConversation &&
        acceptedId &&
        acceptedId !== activeConversationId &&
        !isLocalDraftConversationId(acceptedId)
      ) {
        chatCommandPipeline.handleCommandUpdate({
          runId: outcome.accepted.runId,
          clientRequestId,
          conversationId: acceptedId,
          phase: "bound",
          errorCode: null,
          message: null,
        });
      }
    } else if (outcome.kind === "failed") {
      draftClientRequestsRef.current.delete(clientRequestId);
    }
    return outcome;
  };
  sendChatRef.current = sendChat;

  const cancelChat = async (targetConversationId?: string) => {
    const activeConversationId = targetConversationId?.trim() || getDisplayedConversationId();
    if (!api || !activeConversationId || isLocalDraftConversationId(activeConversationId)) return;
    const runId =
      transcriptStoreRegistry.peek(activeConversationId)?.getSnapshot().activeRun?.runId ??
      activityStore.get(activeConversationId)?.runId ??
      undefined;
    try {
      await api.cancelChat(activeConversationId, runId);
    } catch (error) {
      if (!isAbortError(error)) setChatError(asErrorMessage(error, "cancel chat request failed"));
    }
  };

  const materializeComposerDraftForSend = async (
    draft: MentionComposerDraft,
    files: PendingUploadedFile[],
    workdir: string,
  ) => {
    let text = normalizeLogicalLineEndings(
      isAgentMode && draft.largePastes.length > 0
        ? draft.textWithoutLargePastes
        : buildTextFromComposerDraft(draft),
    );
    let uploadedFiles = files;
    if (isAgentMode && draft.largePastes.length > 0) {
      setChatError(null);
      isImportingPastedTextRef.current = true;
      setUploadingFiles(true);
      try {
        const agentID = await resolveActiveAgentID();
        const imported = await importPastedTextsAsFiles({
          token,
          agentId: agentID,
          workdir,
          pastes: draft.largePastes,
        });
        if (apiRef.current?.getActiveAgent().trim() !== agentID) {
          throw new Error("Agent 已切换，已取消发送本次大段粘贴内容。");
        }
        text = buildTextFromComposerDraft(draft, imported.fileByPasteId);
        uploadedFiles = mergePendingUploadedFiles(files, imported.files);
      } finally {
        isImportingPastedTextRef.current = false;
        setUploadingFiles(false);
      }
    }
    return { text, uploadedFiles };
  };

  const clearCurrentComposerDraftForQueuedTurn = (conversationId: string) => {
    const key = conversationId.trim();
    if (!key || getDisplayedConversationId() !== key) return;
    composerRef.current?.clear();
    setPendingUploadsForConversation(key, []);
    clearCachedComposerDraft(key);
  };

  const submitCurrentComposerToGuiQueue = async (queuePolicy: "append" | "interrupt") => {
    const conversationId = getDisplayedConversationId();
    const draft = composerRef.current?.getDraft() ?? null;
    const uploadedFiles = pendingUploadedFiles.slice();
    let clearedComposer = false;
    if (!api || !conversationId || !queuedChatTurnHasContent(draft, uploadedFiles)) return false;
    const workdir = (
      conversationWorkdirsRef.current.get(conversationId) ??
      displayedConversationWorkdirRef.current ??
      activeWorkspaceProjectPath ??
      settings.system.workdir
    ).trim();
    try {
      const materialized = await materializeComposerDraftForSend(draft, uploadedFiles, workdir);
      if (!materialized.text && materialized.uploadedFiles.length === 0) return false;
      clearCurrentComposerDraftForQueuedTurn(conversationId);
      clearedComposer = true;
      if (chatCommandPipeline.hasPending(conversationId)) {
        await prepareChatRuntime("send", api, CHAT_RUNTIME_PREPARE_TIMEOUT_MS);
        await api.chatCommand({
          type: "chat.submit",
          message: materialized.text,
          conversationId: isLocalDraftConversationId(conversationId) ? undefined : conversationId,
          selectedModel: buildGatewaySelectedModel(
            selectionForConversation(conversationId),
            activeProviders,
          ),
          systemSettings: buildGatewaySystemSettings(settings, workdir),
          uploadedFiles: materialized.uploadedFiles,
          clientRequestId: createUuid(),
          runtimeControls: chatRuntimeControlsForCurrentProvider,
          queuePolicy,
        });
        refreshChatQueueSnapshot(conversationId);
        return true;
      }
      const outcome = await sendChat(materialized.text, {
        conversationId,
        uploadedFiles: materialized.uploadedFiles,
        runtimeControls: chatRuntimeControlsForCurrentProvider,
        workdir,
        queuePolicy,
        optimisticEcho: false,
      });
      if (!outcome) {
        if (getDisplayedConversationId() === conversationId) {
          if (!composerRef.current?.hasContent()) composerRef.current?.setDraft(draft);
          if (getPendingUploadsForConversation(conversationId).length === 0) {
            setPendingUploadsForConversation(conversationId, uploadedFiles);
          }
        }
        return false;
      }
      if (outcome.kind === "failed") throw new Error(outcome.message);
      return true;
    } catch (error) {
      if (clearedComposer && getDisplayedConversationId() === conversationId) {
        if (!composerRef.current?.hasContent()) composerRef.current?.setDraft(draft);
        if (getPendingUploadsForConversation(conversationId).length === 0) {
          setPendingUploadsForConversation(conversationId, uploadedFiles);
        }
      }
      reportChatQueueActionError(conversationId, error, "queued chat request failed");
      return false;
    }
  };

  const commitQueuedChatEdit = async () => {
    const session = queuedChatEditSessionRef.current;
    const conversationId = getDisplayedConversationId();
    if (!session || !api || !conversationId) return false;
    const draft = composerRef.current?.getDraft() ?? null;
    const uploadedFiles = pendingUploadedFiles.slice();
    if (!queuedChatTurnHasContent(draft, uploadedFiles)) return false;
    try {
      const response = await api.chatQueueEditCommit({
        conversationId,
        itemId: session.itemId,
        revision: session.revision,
        draftJson: JSON.stringify(draft),
        uploadedFilesJson: JSON.stringify(uploadedFiles),
      });
      if (!response.accepted) {
        reportChatQueueActionError(
          conversationId,
          response.message || "queued edit failed",
          "queued edit failed",
        );
        return false;
      }
      queuedChatEditSessionRef.current = null;
      composerRef.current?.clear();
      setPendingUploadsForConversation(conversationId, []);
      clearCachedComposerDraft(conversationId);
      applyChatQueueSnapshot(response.snapshot);
      return true;
    } catch (error) {
      reportChatQueueActionError(conversationId, error, "queued edit failed");
      return false;
    }
  };

  const runQueuedTurnNow = (id: string) => {
    const conversationId = getDisplayedConversationId();
    if (!api || !conversationId) return;
    void api
      .chatQueueRunNow(conversationId, id)
      .then((response) => {
        applyChatQueueSnapshot(response.snapshot);
        for (const delayMs of [250, 1000]) {
          window.setTimeout(() => {
            void api
              .chatQueueGet(conversationId)
              .then((nextResponse) => applyChatQueueSnapshot(nextResponse.snapshot))
              .catch(() => undefined);
          }, delayMs);
        }
      })
      .catch((error) =>
        reportChatQueueActionError(conversationId, error, "queued chat run failed"),
      );
  };
  const moveQueuedTurnUp = (id: string) => {
    const conversationId = getDisplayedConversationId();
    if (!api || !conversationId) return;
    void api
      .chatQueueMove(conversationId, id, "up")
      .then((response) => applyChatQueueSnapshot(response.snapshot))
      .catch((error) =>
        reportChatQueueActionError(conversationId, error, "queued chat move failed"),
      );
  };
  const removeQueuedTurn = (id: string) => {
    const conversationId = getDisplayedConversationId();
    if (!api || !conversationId) return;
    void api
      .chatQueueRemove(conversationId, id)
      .then((response) => applyChatQueueSnapshot(response.snapshot))
      .catch((error) =>
        reportChatQueueActionError(conversationId, error, "queued chat remove failed"),
      );
  };
  const editQueuedTurn = (id: string) => {
    const conversationId = getDisplayedConversationId();
    if (!api || !conversationId) return;
    void (async () => {
      if (queuedChatEditSessionRef.current) {
        if (!(await commitQueuedChatEdit())) return;
      } else {
        const currentDraft = composerRef.current?.getDraft() ?? null;
        const currentUploads = pendingUploadedFiles.slice();
        if (
          queuedChatTurnHasContent(currentDraft, currentUploads) &&
          !(await submitCurrentComposerToGuiQueue("append"))
        ) {
          return;
        }
      }
      const response = await api.chatQueueEditBegin(conversationId, id);
      if (!response.accepted || !response.item) {
        if (!response.accepted) {
          reportChatQueueActionError(
            conversationId,
            response.message || "queued edit failed",
            "queued edit failed",
          );
        }
        return;
      }
      try {
        const draft = JSON.parse(response.item.draftJson) as MentionComposerDraft;
        const uploadedFiles = JSON.parse(response.item.uploadedFilesJson) as PendingUploadedFile[];
        queuedChatEditSessionRef.current = {
          itemId: response.item.id,
          revision: response.snapshot?.revision ?? chatQueueRevisionRef.current,
        };
        composerRef.current?.setDraft(draft);
        setPendingUploadsForConversation(
          conversationId,
          Array.isArray(uploadedFiles) ? uploadedFiles : [],
        );
        clearCachedComposerDraft(conversationId);
        applyChatQueueSnapshot(response.snapshot);
        window.requestAnimationFrame(() => composerRef.current?.focus());
      } catch (error) {
        throw new Error(asErrorMessage(error, "invalid queued edit payload"));
      }
    })().catch((error) =>
      reportChatQueueActionError(conversationId, error, "queued chat edit failed"),
    );
  };

  return {
    cancelChat,
    commitQueuedChatEdit,
    editQueuedTurn,
    materializeComposerDraftForSend,
    moveQueuedTurnUp,
    removeQueuedTurn,
    runQueuedTurnNow,
    sendChat,
    submitCurrentComposerToGuiQueue,
  };
}
