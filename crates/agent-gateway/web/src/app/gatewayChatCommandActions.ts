import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";
import { normalizeLogicalLineEndings } from "@liveagent/ui/lib/chat/composerText";
import { normalizeConversationMentionReferences } from "@liveagent/ui/lib/chat/mentionReferences";
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
  applyConversationThinking,
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

export type QueuedEditSession = {
  conversationId: string;
  itemId: string;
  revision: number;
  composerRevision: number | null;
  operation?: "commit" | "cancel";
};

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
  queuedChatEditPendingRef: MutableRefObject<boolean>;
  visibleConversationRevisionRef: MutableRefObject<number>;
  refreshChatQueueSnapshot: (conversationId: string) => void;
  resolveActiveAgentID: () => Promise<string>;
  selectedHistoryIdRef: MutableRefObject<string>;
  selectionForConversation: (conversationId: string) => SelectedModel | undefined;
  sendChatRef: MutableRefObject<SendChatFn | null>;
  setChatError: Dispatch<SetStateAction<string | null>>;
  setConversationId: Dispatch<SetStateAction<string>>;
  setPendingUploadsForConversation: (conversationId: string, files: PendingUploadedFile[]) => void;
  setSelectedHistoryId: Dispatch<SetStateAction<string>>;
  setUploadingFiles: (active: boolean, targetConversationId?: string) => void;
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
  return normalizeChatRuntimeControlsForProvider(
    applyConversationThinking(input.runtimeControls, input.selectedModel),
    {
      providerId: provider?.type,
      requestFormat: provider?.requestFormat,
      modelId: input.selectedModel?.model,
    },
  );
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
    queuedChatEditPendingRef,
    visibleConversationRevisionRef,
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
      referencedConversations: sendOptions?.referencedConversations,
      isEditResend: Boolean(sendOptions?.editMessageRef),
      baseMessageRef: sendOptions?.editMessageRef,
      optimistic: sendOptions?.optimisticEcho !== false,
      waitForStart: sendOptions?.waitForStart,
      submit: async () => {
        await prepareChatRuntime("send", api, CHAT_RUNTIME_PREPARE_TIMEOUT_MS);
        return api.chatCommand({
          type: sendOptions?.editMessageRef ? "chat.edit_resend" : "chat.submit",
          message,
          conversationId: startedAsDraftConversation ? undefined : activeConversationId,
          selectedModel: buildGatewaySelectedModel(turnSelectedModel, activeProviders),
          systemSettings: buildGatewaySystemSettings(settings, effectiveWorkdir),
          uploadedFiles,
          referencedConversations: sendOptions?.referencedConversations,
          clientRequestId,
          runtimeControls,
          baseMessageRef: sendOptions?.editMessageRef,
          queuePolicy: sendOptions?.queuePolicy ?? "auto",
          goalAction: sendOptions?.goalAction,
          goalText: sendOptions?.goalText,
          promptCommand: sendOptions?.promptCommand,
          planCommand: sendOptions?.planCommand,
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
    // 大段粘贴导入期间的"上传中"状态归属会话:多 Pane 下只禁用目标 Pane。
    targetConversationId?: string,
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
      setUploadingFiles(true, targetConversationId);
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
    return {
      text,
      uploadedFiles,
      referencedConversations: normalizeConversationMentionReferences(draft.conversationMentions),
    };
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

    // A first submit from the home draft may still be waiting for the gateway
    // to bind its run to a canonical conversation. Route the follow-up through
    // that canonical id before clearing the composer; otherwise the request
    // can be sent as a second draft and the original input is lost on remap.
    let targetConversationId = chatCommandPipeline.resolveConversationId(conversationId).trim();
    if (
      targetConversationId === conversationId &&
      isLocalDraftConversationId(conversationId) &&
      chatCommandPipeline.hasPending(conversationId)
    ) {
      targetConversationId =
        (await chatCommandPipeline.waitForConversationBinding(conversationId))?.trim() ?? "";
    }
    if (!targetConversationId || !isDisplayedConversation(targetConversationId)) return false;

    const workdir = (
      conversationWorkdirsRef.current.get(targetConversationId) ??
      displayedConversationWorkdirRef.current ??
      activeWorkspaceProjectPath ??
      settings.system.workdir
    ).trim();
    try {
      const materialized = await materializeComposerDraftForSend(
        draft,
        uploadedFiles,
        workdir,
        targetConversationId,
      );
      if (!materialized.text && materialized.uploadedFiles.length === 0) return false;
      clearCurrentComposerDraftForQueuedTurn(targetConversationId);
      clearedComposer = true;
      if (chatCommandPipeline.hasPending(targetConversationId)) {
        await prepareChatRuntime("send", api, CHAT_RUNTIME_PREPARE_TIMEOUT_MS);
        await api.chatCommand({
          type: "chat.submit",
          message: materialized.text,
          conversationId: targetConversationId,
          selectedModel: buildGatewaySelectedModel(
            selectionForConversation(targetConversationId),
            activeProviders,
          ),
          systemSettings: buildGatewaySystemSettings(settings, workdir),
          uploadedFiles: materialized.uploadedFiles,
          referencedConversations: materialized.referencedConversations,
          clientRequestId: createUuid(),
          runtimeControls: chatRuntimeControlsForCurrentProvider,
          queuePolicy,
        });
        refreshChatQueueSnapshot(targetConversationId);
        return true;
      }
      const outcome = await sendChat(materialized.text, {
        conversationId: targetConversationId,
        uploadedFiles: materialized.uploadedFiles,
        referencedConversations: materialized.referencedConversations,
        runtimeControls: chatRuntimeControlsForCurrentProvider,
        workdir,
        queuePolicy,
        optimisticEcho: false,
      });
      if (!outcome) {
        if (getDisplayedConversationId() === targetConversationId) {
          if (!composerRef.current?.hasContent()) composerRef.current?.setDraft(draft);
          if (getPendingUploadsForConversation(targetConversationId).length === 0) {
            setPendingUploadsForConversation(targetConversationId, uploadedFiles);
          }
        }
        return false;
      }
      if (outcome.kind === "failed") throw new Error(outcome.message);
      return true;
    } catch (error) {
      if (clearedComposer && getDisplayedConversationId() === targetConversationId) {
        if (!composerRef.current?.hasContent()) composerRef.current?.setDraft(draft);
        if (getPendingUploadsForConversation(targetConversationId).length === 0) {
          setPendingUploadsForConversation(targetConversationId, uploadedFiles);
        }
      }
      reportChatQueueActionError(targetConversationId, error, "queued chat request failed");
      return false;
    }
  };

  const finishQueuedChatEdit = (session: QueuedEditSession) => {
    if (queuedChatEditSessionRef.current !== session) return;
    queuedChatEditSessionRef.current = null;
    if (session.composerRevision === null) return;
    if (
      getDisplayedConversationId() === session.conversationId &&
      visibleConversationRevisionRef.current !== session.composerRevision
    )
      return;
    clearCurrentComposerDraftForQueuedTurn(session.conversationId);
    setPendingUploadsForConversation(session.conversationId, []);
    clearCachedComposerDraft(session.conversationId);
  };

  const cancelQueuedChatEdit = async () => {
    const session = queuedChatEditSessionRef.current;
    if (!session || !api || session.operation) return false;
    session.operation = "cancel";
    try {
      const response = await api.chatQueueEditCancel(session.conversationId, session.itemId);
      if (!response.accepted) {
        reportChatQueueActionError(
          session.conversationId,
          response.message,
          "queued edit cancel failed",
        );
        return false;
      }
      finishQueuedChatEdit(session);
      applyChatQueueSnapshot(response.snapshot);
      return true;
    } catch (error) {
      reportChatQueueActionError(session.conversationId, error, "queued edit cancel failed");
      return false;
    } finally {
      session.operation = undefined;
    }
  };

  const commitQueuedChatEdit = async () => {
    const session = queuedChatEditSessionRef.current;
    if (!session || !api || session.operation) return false;
    const conversationId = session.conversationId;
    if (getDisplayedConversationId() !== conversationId) return false;
    const draft = composerRef.current?.getDraft() ?? null;
    const uploadedFiles = getPendingUploadsForConversation(conversationId).slice();
    if (!queuedChatTurnHasContent(draft, uploadedFiles)) return false;
    session.operation = "commit";
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
      finishQueuedChatEdit(session);
      applyChatQueueSnapshot(response.snapshot);
      return true;
    } catch (error) {
      reportChatQueueActionError(conversationId, error, "queued edit failed");
      return false;
    } finally {
      session.operation = undefined;
      if (
        queuedChatEditSessionRef.current === session &&
        getDisplayedConversationId() !== conversationId
      ) {
        await cancelQueuedChatEdit();
      }
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
  const editQueuedTurn = async (id: string) => {
    const conversationId = getDisplayedConversationId();
    if (!api || !conversationId || queuedChatEditPendingRef.current) return;
    const revision = visibleConversationRevisionRef.current;
    const isCurrent = () =>
      getDisplayedConversationId() === conversationId &&
      visibleConversationRevisionRef.current === revision &&
      apiRef.current === api;
    queuedChatEditPendingRef.current = true;
    try {
      const previousSession = queuedChatEditSessionRef.current;
      if (previousSession) {
        const finished =
          previousSession.conversationId === conversationId
            ? await commitQueuedChatEdit()
            : await cancelQueuedChatEdit();
        if (!finished) return;
      } else {
        const currentDraft = composerRef.current?.getDraft() ?? null;
        const currentUploads = getPendingUploadsForConversation(conversationId).slice();
        if (
          queuedChatTurnHasContent(currentDraft, currentUploads) &&
          !(await submitCurrentComposerToGuiQueue("append"))
        )
          return;
      }
      if (!isCurrent()) return;
      const response = await api.chatQueueEditBegin(conversationId, id);
      if (!response.accepted || !response.item) {
        if (!response.accepted) {
          reportChatQueueActionError(conversationId, response.message, "queued edit failed");
        }
        return;
      }
      const session: QueuedEditSession = {
        conversationId,
        itemId: response.item.id,
        revision: response.snapshot?.revision ?? chatQueueRevisionRef.current,
        composerRevision: null,
      };
      // edit_begin removes the item; stale or invalid responses must restore its slot.
      queuedChatEditSessionRef.current = session;
      if (!isCurrent()) {
        await cancelQueuedChatEdit();
        return;
      }
      try {
        const draft = JSON.parse(response.item.draftJson) as MentionComposerDraft;
        const uploadedFiles = JSON.parse(response.item.uploadedFilesJson) as PendingUploadedFile[];
        session.composerRevision = revision;
        composerRef.current?.setDraft(draft);
        setPendingUploadsForConversation(
          conversationId,
          Array.isArray(uploadedFiles) ? uploadedFiles : [],
        );
        clearCachedComposerDraft(conversationId);
        applyChatQueueSnapshot(response.snapshot);
        window.requestAnimationFrame(() => {
          if (isCurrent() && queuedChatEditSessionRef.current === session)
            composerRef.current?.focus();
        });
      } catch (error) {
        await cancelQueuedChatEdit();
        throw new Error(asErrorMessage(error, "invalid queued edit payload"));
      }
    } catch (error) {
      reportChatQueueActionError(conversationId, error, "queued chat edit failed");
    } finally {
      queuedChatEditPendingRef.current = false;
    }
  };

  return {
    cancelChat,
    cancelQueuedChatEdit,
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
