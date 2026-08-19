import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import type { ChatQueueTurnPreview } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import {
  type AppSettings,
  type ChatRuntimeControls,
  type CommandSafetyMode,
  type ExecutionMode,
  isAgentExecutionMode,
  normalizeChatRuntimeControls,
} from "../../../lib/settings";
import { answerAskUserQuestion } from "../../../lib/tools/askUserQuestionTools";
import { answerToolApproval } from "../../../lib/tools/toolApproval";
import { createTextComposerDraft } from "../composer/composerDraftText";
import {
  type ConversationQueueStore,
  createConversationQueueStore,
} from "../conversations/conversationQueueStore";
import type { ActiveGatewayBridgeRequest, SendChatAction } from "../gateway/gatewayBridgeTypes";
import {
  type GatewayChatClaimedRequest,
  normalizeGatewayCommandSafetyMode,
  normalizeGatewayExecutionMode,
  normalizeGatewayWorkdir,
} from "../gateway/gatewayBridgeTypes";
import type { ConversationRuntimeEntry } from "../runtime/chatPageRuntime";
import type {
  ManualCompactionRequest,
  ManualCompactionResult,
} from "../runtime/useManualCompaction";
import {
  appendQueuedChatTurn,
  buildQueuedChatTurnPreview,
  type ChatQueueItemDetail,
  type ChatQueueSnapshot,
  createQueuedChatTurn,
  getQueuedConversationIds,
  insertQueuedChatTurnAtSlot,
  moveQueuedChatTurn,
  promoteQueuedChatTurn,
  type QueuedChatTurn,
  type QueuedChatTurnEditSlot,
  queuedChatTurnHasContent,
  removeQueuedChatTurn,
  resolveQueuedChatTurnSlotIndex,
  takeNextQueuedChatTurn,
} from "./chatTurnQueue";

type UseChatTurnQueueParams = {
  settings: AppSettings;
  currentConversationId: string;
  queueStore?: ConversationQueueStore;
  currentConversationIdRef: MutableRefObject<string>;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  buildRuntimeEntryFromVisibleState: () => ConversationRuntimeEntry;
  isConversationRunning: (conversationId: string) => boolean;
  runningConversationIds: ReadonlySet<string>;
  getConversationAbortController: (conversationId: string) => AbortController | null;
  setConversationAbortController: (
    conversationId: string,
    controller: AbortController | null,
  ) => void;
  setConversationSendingState: (conversationId: string, value: boolean) => void;
  requestConversationStop: (conversationId: string) => boolean;
  getConversationStopRequestVersion: (conversationId: string) => number;
  isConversationStopRequested: (conversationId: string) => boolean;
  consumeConversationStop: (conversationId: string, expectedVersion?: number) => boolean;
  requestActiveConversationStop: (conversationId: string, options: { force: boolean }) => boolean;
  getConversationLiveTranscriptStore: (conversationId: string) => LiveTranscriptStore;
  captureAbortSnapshot: (store: LiveTranscriptStore) => void;
  updateToolStatus: (status: string | null, store: LiveTranscriptStore) => void;
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  pendingUploadedFiles: PendingUploadedFile[];
  setPendingUploadsForConversation: (
    conversationId: string,
    uploads: PendingUploadedFile[],
  ) => void;
  clearCachedComposerDraft: (conversationId?: string) => void;
  displayedConversationWorkdir: string;
  sendActionRef: MutableRefObject<SendChatAction>;
  /** WebUI compact_now 中继：调 ChatPage 的手动压缩入口（与本地用量环同一代码）。 */
  manualCompactActionRef: MutableRefObject<
    (request?: ManualCompactionRequest) => Promise<ManualCompactionResult>
  >;
};

/**
 * The chat turn queue: local queued turns (enqueue while a run is active,
 * FIFO drain on run end, in-composer editing with slot restore), the WebUI
 * remote queue protocol (gateway:chat-queue-request actions incl. remote
 * edit sessions and AskUserQuestion answers), and queue snapshot publishing
 * back to the gateway.
 */
export function useChatTurnQueue(params: UseChatTurnQueueParams) {
  const {
    settings,
    currentConversationId,
    queueStore: providedQueueStore,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    buildRuntimeEntryFromVisibleState,
    isConversationRunning,
    runningConversationIds,
    getConversationAbortController,
    setConversationAbortController,
    setConversationSendingState,
    requestConversationStop,
    getConversationStopRequestVersion,
    isConversationStopRequested,
    consumeConversationStop,
    requestActiveConversationStop,
    getConversationLiveTranscriptStore,
    captureAbortSnapshot,
    updateToolStatus,
    composerRef,
    pendingUploadedFiles,
    setPendingUploadsForConversation,
    clearCachedComposerDraft,
    displayedConversationWorkdir,
    sendActionRef,
    manualCompactActionRef,
  } = params;
  const fallbackQueueStoreRef = useRef<ConversationQueueStore | null>(null);
  if (!fallbackQueueStoreRef.current) {
    fallbackQueueStoreRef.current = createConversationQueueStore();
  }
  const queueStore = providedQueueStore ?? fallbackQueueStoreRef.current;

  const queuedChatTurnsRef = useRef<QueuedChatTurn[]>(queueStore.getAllSnapshot());
  const subscribeQueuedChatTurns = useCallback(
    (listener: () => void) =>
      queueStore.subscribeAll(() => {
        queuedChatTurnsRef.current = queueStore.getAllSnapshot();
        listener();
      }),
    [queueStore],
  );
  const getQueuedChatTurnsSnapshot = useCallback(() => queueStore.getAllSnapshot(), [queueStore]);
  const queuedChatTurns = useSyncExternalStore(
    subscribeQueuedChatTurns,
    getQueuedChatTurnsSnapshot,
    getQueuedChatTurnsSnapshot,
  );
  const queuedChatProcessingConversationIdsRef = useRef(new Set<string>());
  const queuedChatStopVersionsRef = useRef(new Map<string, number>());
  // 打断并执行的恢复意图：conversationId → 触发打断那一刻的 stop-request 版本号。
  // stopConversation 会打上 stop-requested 标记，而 drain effect 对该标记一律
  // "消费后跳过"（普通停止不允许自动放行队列）。登记版本号让 drain effect 能
  // 识别出"这次停止是打断并执行"，消费标记后继续自动发送；若用户随后又按了
  // 普通停止，版本号被 bump，登记的意图自动失效，队列保持挂起。
  const queuedChatInterruptResumeVersionsRef = useRef(new Map<string, number>());
  const queuedChatProcessingStatesRef = useRef(
    new Map<
      string,
      {
        stopVersion: number;
        stopRequestVersion: number | null;
        inFlightTurn: QueuedChatTurn | null;
      }
    >(),
  );
  const chatQueuePublishChainsRef = useRef(new Map<string, Promise<void>>());
  const queuedChatTurnEditSlotRef = useRef<
    | (QueuedChatTurnEditSlot & {
        originalId: string;
        createdAt: number;
        executionMode: ExecutionMode;
        workdir: string;
        commandSafetyMode: CommandSafetyMode;
        runtimeControls: ChatRuntimeControls;
        gatewayRequest?: QueuedChatTurn["gatewayRequest"];
      })
    | null
  >(null);
  const chatQueueRevisionRef = useRef(0);
  const chatQueueKnownConversationIdsRef = useRef(new Set<string>());
  const remoteQueuedChatTurnEditSlotsRef = useRef<
    Map<
      string,
      {
        item: QueuedChatTurn;
        slot: QueuedChatTurnEditSlot;
        revision: number;
      }
    >
  >(new Map());
  const previousRunningConversationIdsRef = useRef<ReadonlySet<string>>(new Set());

  function buildChatQueueSnapshot(
    conversationId: string,
    queue: readonly QueuedChatTurn[] = queuedChatTurnsRef.current,
  ): ChatQueueSnapshot {
    const key = conversationId.trim();
    return {
      conversationId: key,
      revision: chatQueueRevisionRef.current,
      items: queue
        .filter((item) => item.conversationId === key)
        .map((item) => ({
          id: item.id,
          previewText: buildQueuedChatTurnPreview(item.draft),
          fileCount: item.uploadedFiles.length,
          createdAt: item.createdAt,
          source: item.gatewayRequest ? "webui" : "gui",
          editable: true,
        })),
    };
  }

  function buildChatQueueItemDetail(item: QueuedChatTurn): ChatQueueItemDetail {
    const summary = {
      id: item.id,
      previewText: buildQueuedChatTurnPreview(item.draft),
      fileCount: item.uploadedFiles.length,
      createdAt: item.createdAt,
      source: item.gatewayRequest ? ("webui" as const) : ("gui" as const),
      editable: true,
    };
    return {
      ...summary,
      draftJson: JSON.stringify(item.draft),
      uploadedFilesJson: JSON.stringify(item.uploadedFiles),
    };
  }

  function rememberChatQueueConversationId(conversationId: string) {
    const key = conversationId.trim();
    if (key) {
      chatQueueKnownConversationIdsRef.current.add(key);
    }
    return key;
  }

  function collectChatQueueSnapshotConversationIds(
    queue: readonly QueuedChatTurn[] = queuedChatTurnsRef.current,
    extraConversationIds: readonly string[] = [],
  ) {
    const conversationIds = new Set(chatQueueKnownConversationIdsRef.current);
    for (const item of queue) {
      const key = rememberChatQueueConversationId(item.conversationId);
      if (key) conversationIds.add(key);
    }
    for (const conversationId of extraConversationIds) {
      const key = rememberChatQueueConversationId(conversationId);
      if (key) conversationIds.add(key);
    }
    return conversationIds;
  }

  function cancelGatewayQueuedTurnRequest(item: QueuedChatTurn | null | undefined) {
    const gatewayRequest = item?.gatewayRequest;
    if (!item || !gatewayRequest) return;
    void invoke("gateway_chat_cancel_request", {
      request_id: gatewayRequest.requestId,
      conversation_id: item.conversationId,
      worker_id: gatewayRequest.workerId ?? "gui-queue",
    } as any).catch((error) => {
      console.warn("gateway_chat_cancel_request failed", error);
    });
  }

  function publishChatQueueSnapshot(
    conversationId: string,
    queue: readonly QueuedChatTurn[] = queuedChatTurnsRef.current,
  ) {
    const targetConversationId = rememberChatQueueConversationId(conversationId);
    if (!targetConversationId) {
      return;
    }
    const snapshot = buildChatQueueSnapshot(targetConversationId, queue);
    const previous =
      chatQueuePublishChainsRef.current.get(targetConversationId) ?? Promise.resolve();
    const publication = previous
      .catch(() => undefined)
      .then(() =>
        invoke("gateway_publish_chat_queue_event", {
          input: {
            conversationId: snapshot.conversationId,
            snapshotJson: JSON.stringify(snapshot),
            revision: snapshot.revision,
          },
        } as any),
      )
      .then(() => undefined)
      .catch((error) => {
        console.warn("gateway_publish_chat_queue_event failed", error);
      });
    chatQueuePublishChainsRef.current.set(targetConversationId, publication);
    void publication.finally(() => {
      if (chatQueuePublishChainsRef.current.get(targetConversationId) === publication) {
        chatQueuePublishChainsRef.current.delete(targetConversationId);
      }
    });
  }

  function publishChatQueueSnapshots(
    conversationIds: Iterable<string>,
    queue: readonly QueuedChatTurn[] = queuedChatTurnsRef.current,
  ) {
    for (const conversationId of conversationIds) {
      publishChatQueueSnapshot(conversationId, queue);
    }
  }

  const setQueuedChatTurnsState = useCallback(
    (updater: (current: QueuedChatTurn[]) => QueuedChatTurn[]) => {
      const previous = queuedChatTurnsRef.current;
      const next = queueStore.update(updater);
      queuedChatTurnsRef.current = next;
      chatQueueRevisionRef.current += 1;
      const conversationIds = new Set<string>();
      for (const item of previous) conversationIds.add(item.conversationId);
      for (const item of next) conversationIds.add(item.conversationId);
      const currentId = currentConversationIdRef.current.trim();
      if (currentId) conversationIds.add(currentId);
      publishChatQueueSnapshots(conversationIds, next);
      return next;
    },
    [queueStore],
  );

  const queuedChatTurnsForCurrentConversation = useMemo<ChatQueueTurnPreview[]>(
    () =>
      queuedChatTurns
        .filter((item) => item.conversationId === currentConversationId)
        .map((item) => ({
          id: item.id,
          previewText: buildQueuedChatTurnPreview(item.draft),
          fileCount: item.uploadedFiles.length,
        })),
    [currentConversationId, queuedChatTurns],
  );

  function resolveStopConversationId() {
    // Stop only ever targets the conversation the user is looking at (or the
    // one the composer references). Never fall back to "any running
    // conversation" — that silently kills an unrelated background run when
    // the visible sending state and the running set are briefly out of sync.
    const visibleConversationId = currentConversationId.trim();
    if (visibleConversationId && runningConversationIds.has(visibleConversationId)) {
      return visibleConversationId;
    }
    const referencedConversationId = currentConversationIdRef.current.trim();
    if (referencedConversationId && runningConversationIds.has(referencedConversationId)) {
      return referencedConversationId;
    }
    return visibleConversationId || referencedConversationId;
  }

  function stopConversation(conversationId: string) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) return false;
    const force = requestConversationStop(targetConversationId);
    const stopRequestVersion = getConversationStopRequestVersion(targetConversationId);
    const nextStopVersion = (queuedChatStopVersionsRef.current.get(targetConversationId) ?? 0) + 1;
    queuedChatStopVersionsRef.current.set(targetConversationId, nextStopVersion);
    const processingState = queuedChatProcessingStatesRef.current.get(targetConversationId);
    if (processingState) {
      processingState.stopRequestVersion = stopRequestVersion;
      cancelGatewayQueuedTurnRequest(processingState.inFlightTurn);
    }
    const controller = getConversationAbortController(targetConversationId);
    const transcriptStore = getConversationLiveTranscriptStore(targetConversationId);
    if (controller) {
      captureAbortSnapshot(transcriptStore);
      updateToolStatus("正在停止当前任务...", transcriptStore);
      controller.abort();
    }
    const handled = requestActiveConversationStop(targetConversationId, { force });
    if (force) {
      queuedChatProcessingConversationIdsRef.current.delete(targetConversationId);
      setConversationAbortController(targetConversationId, null);
      setConversationSendingState(targetConversationId, false);
      updateToolStatus(null, transcriptStore);
    }
    return handled || Boolean(controller);
  }

  function stopSending() {
    const conversationId = resolveStopConversationId();
    if (!conversationId) return;
    const nextQueuedTurn = queuedChatTurnsRef.current.find(
      (item) => item.conversationId === conversationId,
    );
    if (nextQueuedTurn) {
      // Composer Stop is stop-and-continue when this conversation already
      // has queued work; runQueuedTurnNow records the resume intent before
      // aborting the current run.
      runQueuedTurnNow(nextQueuedTurn.id);
      return;
    }
    stopConversation(conversationId);
  }

  function clearCurrentComposerDraftForQueuedTurn(conversationId: string) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId || currentConversationIdRef.current !== targetConversationId) {
      return;
    }
    composerRef.current?.clear();
    setPendingUploadsForConversation(targetConversationId, []);
    clearCachedComposerDraft(targetConversationId);
  }

  function enqueueCurrentComposerTurn(position: "end" | "edit") {
    const conversationId = currentConversationIdRef.current.trim();
    const draft = composerRef.current?.getDraft() ?? null;
    const uploadedFiles = pendingUploadedFiles.slice();
    if (!conversationId || !queuedChatTurnHasContent(draft, uploadedFiles)) {
      return false;
    }

    const runtimeEntry =
      conversationRuntimeCacheRef.current.get(conversationId) ??
      buildRuntimeEntryFromVisibleState();
    const editSlot =
      position === "edit" && queuedChatTurnEditSlotRef.current?.conversationId === conversationId
        ? queuedChatTurnEditSlotRef.current
        : null;
    const executionMode = editSlot?.executionMode ?? settings.system.executionMode;
    const commandSafetyMode = editSlot?.commandSafetyMode ?? settings.system.commandSafetyMode;
    const workdirForTurn = isAgentExecutionMode(executionMode)
      ? (
          editSlot?.workdir ??
          runtimeEntry.workdir ??
          displayedConversationWorkdir ??
          settings.system.workdir
        ).trim()
      : "";
    const queuedTurn = createQueuedChatTurn({
      id: editSlot?.originalId,
      conversationId,
      draft,
      uploadedFiles,
      executionMode,
      workdir: workdirForTurn,
      commandSafetyMode,
      runtimeControls: editSlot?.runtimeControls ?? settings.chatRuntimeControls,
      createdAt: editSlot?.createdAt,
      gatewayRequest: editSlot?.gatewayRequest,
    });

    setQueuedChatTurnsState((current) => {
      if (editSlot) {
        return insertQueuedChatTurnAtSlot(current, queuedTurn, editSlot);
      }
      return appendQueuedChatTurn(current, queuedTurn);
    });
    if (editSlot) {
      queuedChatTurnEditSlotRef.current = null;
    }
    clearCurrentComposerDraftForQueuedTurn(conversationId);
    return true;
  }

  /**
   * Enqueue a composer turn for an explicit conversation (workbench panes
   * sending into a busy background conversation). Unlike the current-composer
   * path it never touches the page composer or edit slots; the caller owns
   * clearing its own composer. The turn's workdir comes from the target
   * conversation's runtime entry, never from the visible conversation.
   */
  function enqueueComposerTurnForConversation(input: {
    conversationId: string;
    draft: MentionComposerDraft | null;
    uploadedFiles: PendingUploadedFile[];
  }) {
    const conversationId = input.conversationId.trim();
    const uploadedFiles = input.uploadedFiles.slice();
    if (!conversationId || !queuedChatTurnHasContent(input.draft, uploadedFiles)) {
      return false;
    }
    const runtimeEntry =
      conversationRuntimeCacheRef.current.get(conversationId) ??
      (conversationId === currentConversationIdRef.current
        ? buildRuntimeEntryFromVisibleState()
        : null);
    const executionMode = settings.system.executionMode;
    const workdirForTurn = isAgentExecutionMode(executionMode)
      ? (
          runtimeEntry?.workdir ??
          (conversationId === currentConversationIdRef.current
            ? displayedConversationWorkdir
            : settings.system.workdir)
        ).trim()
      : "";
    const queuedTurn = createQueuedChatTurn({
      conversationId,
      draft: input.draft,
      uploadedFiles,
      executionMode,
      workdir: workdirForTurn,
      commandSafetyMode: settings.system.commandSafetyMode,
      runtimeControls: settings.chatRuntimeControls,
    });
    setQueuedChatTurnsState((current) => appendQueuedChatTurn(current, queuedTurn));
    setPendingUploadsForConversation(conversationId, []);
    clearCachedComposerDraft(conversationId);
    return true;
  }

  function isQueuedChatTurnEditBlockingProcessing(conversationId: string) {
    const slot = queuedChatTurnEditSlotRef.current;
    if (!slot || slot.conversationId !== conversationId.trim()) return false;
    const queue = queuedChatTurnsRef.current;
    const firstQueuedIndex = queue.findIndex((item) => item.conversationId === slot.conversationId);
    if (firstQueuedIndex < 0) return false;
    return resolveQueuedChatTurnSlotIndex(queue, slot) <= firstQueuedIndex;
  }

  function requestQueuedChatTurnProcessing(conversationId: string) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) return;
    if (isConversationStopRequested(targetConversationId)) {
      queuedChatProcessingConversationIdsRef.current.delete(targetConversationId);
      const stopRequestVersion = getConversationStopRequestVersion(targetConversationId);
      consumeConversationStop(targetConversationId, stopRequestVersion);
      return;
    }
    if (queuedChatProcessingConversationIdsRef.current.has(targetConversationId)) return;
    if (isConversationRunning(targetConversationId)) return;
    if (isQueuedChatTurnEditBlockingProcessing(targetConversationId)) return;
    if (!queuedChatTurnsRef.current.some((item) => item.conversationId === targetConversationId)) {
      return;
    }

    queuedChatProcessingConversationIdsRef.current.add(targetConversationId);
    const processingState = {
      stopVersion: queuedChatStopVersionsRef.current.get(targetConversationId) ?? 0,
      stopRequestVersion: null as number | null,
      inFlightTurn: null as QueuedChatTurn | null,
    };
    queuedChatProcessingStatesRef.current.set(targetConversationId, processingState);
    const wasStoppedDuringProcessing = () =>
      (queuedChatStopVersionsRef.current.get(targetConversationId) ?? 0) !==
      processingState.stopVersion;
    const releaseProcessingState = () => {
      if (queuedChatProcessingStatesRef.current.get(targetConversationId) !== processingState) {
        return;
      }
      queuedChatProcessingStatesRef.current.delete(targetConversationId);
      queuedChatProcessingConversationIdsRef.current.delete(targetConversationId);
    };
    let inFlightQueuedTurn: QueuedChatTurn | null = null;
    void Promise.resolve()
      .then(async () => {
        if (isConversationStopRequested(targetConversationId)) return false;
        if (isConversationRunning(targetConversationId)) return;
        const taken = takeNextQueuedChatTurn(queuedChatTurnsRef.current, targetConversationId);
        if (!taken.item) return false;
        const queuedTurn = taken.item;
        inFlightQueuedTurn = queuedTurn;
        processingState.inFlightTurn = queuedTurn;
        setQueuedChatTurnsState(() => taken.queue);
        const gatewayRequest = queuedTurn.gatewayRequest;
        const gatewayWorkerId = gatewayRequest?.workerId?.trim() || "gui-queue";
        const gatewayBridgeRequest: ActiveGatewayBridgeRequest | null = gatewayRequest
          ? {
              requestId: gatewayRequest.requestId,
              conversationId: targetConversationId,
              clientRequestId: gatewayRequest.clientRequestId,
              workerId: gatewayWorkerId,
              startedAt: Date.now(),
              selectedModelOverride: gatewayRequest.selectedModel,
              runtimeControlsOverride: gatewayRequest.runtimeControls
                ? normalizeChatRuntimeControls(gatewayRequest.runtimeControls)
                : queuedTurn.runtimeControls,
              executionModeOverride: queuedTurn.executionMode,
              workdirOverride: queuedTurn.workdir,
              commandSafetyModeOverride: queuedTurn.commandSafetyMode,
            }
          : null;
        const markGatewayStarted =
          gatewayRequest && gatewayBridgeRequest
            ? async () => {
                await invoke("gateway_chat_mark_started", {
                  request_id: gatewayRequest.requestId,
                  conversation_id: targetConversationId,
                  worker_id: gatewayWorkerId,
                } as any);
              }
            : undefined;
        const accepted = await sendActionRef.current({
          composerDraftOverride: queuedTurn.draft,
          uploadedFilesOverride: queuedTurn.uploadedFiles,
          conversationIdOverride: targetConversationId,
          executionModeOverride: queuedTurn.executionMode,
          workdirOverride: queuedTurn.workdir,
          commandSafetyModeOverride: queuedTurn.commandSafetyMode,
          runtimeControlsOverride: queuedTurn.runtimeControls,
          gatewayBridgeRequestOverride: gatewayBridgeRequest,
          preserveComposerOnStart: true,
          beforeRuntimeStart: markGatewayStarted,
          afterInitialHistoryPersist: markGatewayStarted,
        });
        const stopped = wasStoppedDuringProcessing();
        if (!accepted) {
          if (stopped && gatewayRequest) {
            cancelGatewayQueuedTurnRequest(queuedTurn);
          } else {
            setQueuedChatTurnsState((current) =>
              promoteQueuedChatTurn(appendQueuedChatTurn(current, queuedTurn), queuedTurn.id),
            );
          }
          inFlightQueuedTurn = null;
        } else if (gatewayRequest) {
          if (stopped) {
            cancelGatewayQueuedTurnRequest(queuedTurn);
          } else {
            void invoke("gateway_chat_complete", {
              request_id: gatewayRequest.requestId,
              conversation_id: targetConversationId,
              worker_id: gatewayWorkerId,
            } as any).catch((error) => {
              console.warn("gateway_chat_complete failed", error);
            });
          }
        }
        processingState.inFlightTurn = null;
        return accepted;
      })
      .then((accepted) => {
        releaseProcessingState();
        if (wasStoppedDuringProcessing() || isConversationStopRequested(targetConversationId)) {
          if (processingState.stopRequestVersion !== null) {
            consumeConversationStop(targetConversationId, processingState.stopRequestVersion);
          }
          return;
        }
        if (
          accepted &&
          !isConversationRunning(targetConversationId) &&
          queuedChatTurnsRef.current.some((item) => item.conversationId === targetConversationId)
        ) {
          requestQueuedChatTurnProcessing(targetConversationId);
        }
      })
      .catch(() => {
        const failedQueuedTurn = inFlightQueuedTurn;
        if (failedQueuedTurn) {
          if (wasStoppedDuringProcessing() && failedQueuedTurn.gatewayRequest) {
            cancelGatewayQueuedTurnRequest(failedQueuedTurn);
          } else {
            setQueuedChatTurnsState((current) =>
              promoteQueuedChatTurn(
                appendQueuedChatTurn(current, failedQueuedTurn),
                failedQueuedTurn.id,
              ),
            );
          }
          inFlightQueuedTurn = null;
        }
        processingState.inFlightTurn = null;
        releaseProcessingState();
        if (isConversationStopRequested(targetConversationId)) {
          if (processingState.stopRequestVersion !== null) {
            consumeConversationStop(targetConversationId, processingState.stopRequestVersion);
          }
        }
      });
  }

  useEffect(() => {
    const previousRunningConversationIds = previousRunningConversationIdsRef.current;
    previousRunningConversationIdsRef.current = runningConversationIds;
    for (const conversationId of getQueuedConversationIds(queuedChatTurnsRef.current)) {
      if (
        !previousRunningConversationIds.has(conversationId) ||
        runningConversationIds.has(conversationId)
      ) {
        continue;
      }
      const interruptResumeVersion =
        queuedChatInterruptResumeVersionsRef.current.get(conversationId);
      queuedChatInterruptResumeVersionsRef.current.delete(conversationId);
      if (isConversationStopRequested(conversationId)) {
        queuedChatProcessingConversationIdsRef.current.delete(conversationId);
        const stopRequestVersion = getConversationStopRequestVersion(conversationId);
        consumeConversationStop(conversationId, stopRequestVersion);
        // 打断并执行：这次停止就是为了立刻放行队首轮次，消费掉 stop 标记后
        // 继续向下触发处理；版本号不匹配说明打断之后用户又请求过停止，尊重
        // 最新意图，保持队列挂起。
        if (interruptResumeVersion !== stopRequestVersion) {
          continue;
        }
      }
      requestQueuedChatTurnProcessing(conversationId);
    }
  }, [runningConversationIds, queuedChatTurns]);

  function runQueuedTurnNow(id: string) {
    const queuedTurn = queuedChatTurnsRef.current.find((item) => item.id === id.trim());
    if (!queuedTurn) return;
    setQueuedChatTurnsState((current) => promoteQueuedChatTurn(current, queuedTurn.id));
    if (isConversationRunning(queuedTurn.conversationId)) {
      stopConversation(queuedTurn.conversationId);
      // 登记恢复意图（须在 stopConversation bump 版本号之后取值），运行结束后
      // drain effect 据此消费 stop 标记并自动发送刚置顶的轮次。
      queuedChatInterruptResumeVersionsRef.current.set(
        queuedTurn.conversationId,
        getConversationStopRequestVersion(queuedTurn.conversationId),
      );
      return;
    }
    requestQueuedChatTurnProcessing(queuedTurn.conversationId);
  }

  function moveQueuedTurnUp(id: string) {
    setQueuedChatTurnsState((current) => moveQueuedChatTurn(current, id, "up"));
  }

  function editQueuedTurn(id: string) {
    const key = id.trim();
    const queuedTurnIndex = queuedChatTurnsRef.current.findIndex((item) => item.id === key);
    const queuedTurn = queuedTurnIndex >= 0 ? queuedChatTurnsRef.current[queuedTurnIndex] : null;
    if (!queuedTurn) return;
    const targetConversationId = queuedTurn.conversationId.trim();
    if (!targetConversationId || currentConversationIdRef.current.trim() !== targetConversationId) {
      return;
    }

    const currentDraft = composerRef.current?.getDraft() ?? null;
    const currentUploads = pendingUploadedFiles.slice();
    if (queuedChatTurnHasContent(currentDraft, currentUploads)) {
      enqueueCurrentComposerTurn(queuedChatTurnEditSlotRef.current ? "edit" : "end");
    }

    const sameConversationQueue = queuedChatTurnsRef.current.filter(
      (item) => item.conversationId === targetConversationId,
    );
    const sameConversationIndex = sameConversationQueue.findIndex((item) => item.id === key);
    const previousId =
      sameConversationIndex > 0
        ? (sameConversationQueue[sameConversationIndex - 1]?.id ?? null)
        : null;
    const nextId =
      sameConversationIndex >= 0
        ? (sameConversationQueue[sameConversationIndex + 1]?.id ?? null)
        : null;
    queuedChatTurnEditSlotRef.current = {
      conversationId: targetConversationId,
      previousId,
      nextId,
      index: sameConversationIndex >= 0 ? sameConversationIndex : undefined,
      originalId: queuedTurn.id,
      createdAt: queuedTurn.createdAt,
      executionMode: queuedTurn.executionMode,
      workdir: queuedTurn.workdir,
      commandSafetyMode: queuedTurn.commandSafetyMode,
      runtimeControls: { ...queuedTurn.runtimeControls },
      gatewayRequest: queuedTurn.gatewayRequest ? { ...queuedTurn.gatewayRequest } : undefined,
    };
    setQueuedChatTurnsState((current) => removeQueuedChatTurn(current, key));
    composerRef.current?.setDraft(queuedTurn.draft);
    setPendingUploadsForConversation(targetConversationId, queuedTurn.uploadedFiles);
    clearCachedComposerDraft(targetConversationId);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function removeQueuedTurn(id: string) {
    const queuedTurn = queuedChatTurnsRef.current.find((item) => item.id === id.trim());
    setQueuedChatTurnsState((current) => removeQueuedChatTurn(current, id));
    cancelGatewayQueuedTurnRequest(queuedTurn);
  }

  function shouldQueueGatewayChatRequest(
    conversationId: string,
    queuePolicy: "auto" | "append" | "interrupt",
  ) {
    const key = conversationId.trim();
    if (!key) return false;
    return (
      queuePolicy === "append" ||
      queuePolicy === "interrupt" ||
      queuedChatTurnsRef.current.some((item) => item.conversationId === key) ||
      isQueuedChatTurnEditBlockingProcessing(key)
    );
  }

  async function enqueueGatewayChatRequest(
    claimed: GatewayChatClaimedRequest,
    conversationId: string,
  ) {
    const payload = claimed.request;
    const requestId = payload.requestId.trim();
    const targetConversationId = conversationId.trim();
    const message = payload.message ?? "";
    const uploadedFiles = Array.isArray(payload.uploadedFiles) ? payload.uploadedFiles : [];
    if (!requestId || !targetConversationId || (!message.trim() && uploadedFiles.length === 0)) {
      return false;
    }

    const executionMode =
      normalizeGatewayExecutionMode(payload.executionMode) ?? settings.system.executionMode;
    const commandSafetyMode =
      normalizeGatewayCommandSafetyMode(payload.commandSafetyMode) ??
      settings.system.commandSafetyMode;
    const workdir =
      normalizeGatewayWorkdir(payload.workdir) ??
      conversationRuntimeCacheRef.current.get(targetConversationId)?.workdir ??
      displayedConversationWorkdir ??
      settings.system.workdir;
    const runtimeControls = payload.runtimeControls
      ? normalizeChatRuntimeControls(payload.runtimeControls)
      : settings.chatRuntimeControls;
    const queuedTurn = createQueuedChatTurn({
      id: `gateway-${requestId}`,
      conversationId: targetConversationId,
      draft: createTextComposerDraft(message),
      uploadedFiles,
      executionMode,
      workdir: isAgentExecutionMode(executionMode) ? workdir : "",
      commandSafetyMode,
      runtimeControls,
      gatewayRequest: {
        requestId,
        clientRequestId:
          payload.clientRequestId?.trim() || claimed.clientRequestId?.trim() || undefined,
        workerId: "gui-queue",
        queuePolicy:
          payload.queuePolicy === "append" || payload.queuePolicy === "interrupt"
            ? payload.queuePolicy
            : "auto",
        selectedModel: payload.selectedModel,
        runtimeControls: payload.runtimeControls,
      },
    });

    setQueuedChatTurnsState((current) => appendQueuedChatTurn(current, queuedTurn));
    if (payload.queuePolicy === "interrupt") {
      // 与本地"打断并执行"共用同一路径：置顶 + 运行中则打断并登记恢复意图；
      // 空闲则直接触发队列处理（此前空闲时也会打 stop 标记且无人消费，
      // 导致该轮次永远挂起）。
      runQueuedTurnNow(queuedTurn.id);
    }
    return true;
  }

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    type GatewayChatQueueRequestEvent = {
      requestId: string;
      action: string;
      conversationId?: string;
      itemId?: string;
      direction?: "up" | "down" | string;
      revision?: number;
      draftJson?: string;
      uploadedFilesJson?: string;
      requestJson?: string;
    };

    const respond = (requestId: string, response: Record<string, unknown>) => {
      if (!requestId.trim()) return;
      void invoke("gateway_chat_queue_respond", {
        input: {
          requestId,
          accepted: response.accepted === true,
          message: typeof response.message === "string" ? response.message : "",
          snapshotJson: typeof response.snapshotJson === "string" ? response.snapshotJson : "",
          itemJson: typeof response.itemJson === "string" ? response.itemJson : "",
          errorCode: typeof response.errorCode === "string" ? response.errorCode : "",
          revision: chatQueueRevisionRef.current,
        },
      } as any).catch((error) => {
        console.warn("gateway_chat_queue_respond failed", error);
      });
    };

    const snapshotJson = (conversationId: string) =>
      JSON.stringify(buildChatQueueSnapshot(conversationId));

    void listen<GatewayChatQueueRequestEvent>("gateway:chat-queue-request", (event) => {
      if (disposed) return;
      const request = event.payload;
      const requestId = request.requestId?.trim() ?? "";
      const action = request.action?.trim() ?? "";
      const conversationId =
        request.conversationId?.trim() || currentConversationIdRef.current.trim();
      const itemId = request.itemId?.trim() ?? "";

      const fail = (message: string, errorCode = "invalid_request") => {
        respond(requestId, {
          accepted: false,
          message,
          errorCode,
          snapshotJson: conversationId ? snapshotJson(conversationId) : "",
        });
      };

      if (!requestId) return;

      if (!conversationId && action !== "get") {
        fail("conversation_id is required");
        return;
      }

      if (action === "get") {
        respond(requestId, {
          accepted: true,
          snapshotJson: snapshotJson(conversationId),
        });
        return;
      }

      // WebUI 对 AskUserQuestion 卡片的应答：itemId 即 toolCallId，request_json
      // 携带 {questionId, selectedLabel}[]，直接落到工具挂起表。
      if (action === "tool_answer") {
        if (!itemId) {
          fail("tool_answer requires item_id", "invalid_request");
          return;
        }
        let rawAnswers: unknown;
        try {
          rawAnswers = JSON.parse(request.requestJson || "[]");
        } catch {
          fail("invalid tool answer payload", "invalid_payload");
          return;
        }
        const outcome = answerAskUserQuestion(itemId, rawAnswers, { conversationId });
        if (!outcome.ok) {
          fail(outcome.message || "question not pending", "not_found");
          return;
        }
        respond(requestId, { accepted: true });
        return;
      }

      // WebUI 对工具审批卡片的决定:itemId 即 toolCallId,request_json 携带
      // {"decision":"approve"|"deny"|"approve_session"},落到桌面审批挂起表。
      if (action === "tool_approval") {
        if (!itemId) {
          fail("tool_approval requires item_id", "invalid_request");
          return;
        }
        let decision: unknown;
        try {
          decision = JSON.parse(request.requestJson || "{}");
        } catch {
          fail("invalid tool approval payload", "invalid_payload");
          return;
        }
        const raw =
          decision && typeof decision === "object"
            ? (decision as { decision?: unknown }).decision
            : decision;
        if (raw !== "approve" && raw !== "deny" && raw !== "approve_session") {
          fail("invalid tool approval decision", "invalid_payload");
          return;
        }
        const outcome = answerToolApproval(itemId, raw, { conversationId });
        if (!outcome.ok) {
          fail(outcome.message || "approval not pending", "not_found");
          return;
        }
        respond(requestId, { accepted: true });
        return;
      }

      // WebUI 用量环触发的手动压缩：按目标 conversationId 装载独立 runtime，
      // 不要求桌面当前正显示该会话；运行中与单飞校验仍按目标会话隔离。
      // 回包时序：不再"受理即回包"。手动压缩探针（无副作用）通过、真正开始
      // 压缩时经 onAccepted 同步回 accepted:true；探针拒绝/前置抛错则据返回值
      // 同步回 accepted:false + message（WebUI 已在 !accepted 时展示 message）。
      // 只有真正开始压缩才会后续经 operationId 关联终态事件。Rust relay 30s
      // 超时 >> 探针耗时（纯 token 计数，无 LLM 调用），安全。本 effect 闭包是
      // []-dep，校验只读恒新的 ref；细校验由 manualCompactActionRef 指向的最新
      // 闭包自行复核。
      if (action === "compact_now") {
        if (isConversationRunning(conversationId)) {
          fail("conversation is running", "busy");
          return;
        }
        if (
          conversationRuntimeCacheRef.current.get(conversationId)?.compactionStatus.phase ===
          "running"
        ) {
          fail("compaction already in progress", "compacting");
          return;
        }
        // operationId 严格化：缺失或非空字符串解析失败直接拒绝。回退到 requestId
        // 会产生 WebUI 从未登记的 operationId，终态永不匹配、挂满 5 分钟超时。
        let operationId = "";
        if (request.requestJson?.trim()) {
          try {
            const payload = JSON.parse(request.requestJson) as { operationId?: unknown };
            if (typeof payload.operationId === "string" && payload.operationId.trim()) {
              operationId = payload.operationId.trim();
            }
          } catch {
            fail("invalid manual compaction payload", "invalid_payload");
            return;
          }
        }
        if (!operationId) {
          fail("manual compaction requires operationId", "invalid_payload");
          return;
        }
        const codeFor = (status: ManualCompactionResult["status"]) =>
          status === "busy" ? "busy" : status === "skipped" ? "skipped" : "failed";
        let responded = false;
        const respondAccepted = () => {
          if (responded) return;
          responded = true;
          respond(requestId, { accepted: true });
        };
        void manualCompactActionRef
          .current({
            conversationId,
            operationId,
            onAccepted: respondAccepted,
          })
          .then((result) => {
            // 已受理即真正开始压缩，终态改经 operationId 事件；未受理说明探针
            // 拒绝，此处据返回值同步回包。
            if (responded) return;
            responded = true;
            fail(result.message || "manual compaction declined", codeFor(result.status));
          })
          .catch((error) => {
            if (!responded) {
              responded = true;
              fail(String(error), "failed");
            }
            console.warn("manual compaction relayed from WebUI failed", error);
          });
        return;
      }

      const item = queuedChatTurnsRef.current.find(
        (candidate) => candidate.id === itemId && candidate.conversationId === conversationId,
      );

      if (action === "get_item") {
        if (!item) {
          fail("queued item not found", "not_found");
          return;
        }
        respond(requestId, {
          accepted: true,
          itemJson: JSON.stringify(buildChatQueueItemDetail(item)),
          snapshotJson: snapshotJson(conversationId),
        });
        return;
      }

      if (action === "run_now") {
        if (!item) {
          fail("queued item not found", "not_found");
          return;
        }
        runQueuedTurnNow(item.id);
        respond(requestId, { accepted: true, snapshotJson: snapshotJson(conversationId) });
        return;
      }

      if (action === "move") {
        if (!item) {
          fail("queued item not found", "not_found");
          return;
        }
        const direction = request.direction === "down" ? "down" : "up";
        setQueuedChatTurnsState((current) => moveQueuedChatTurn(current, item.id, direction));
        respond(requestId, { accepted: true, snapshotJson: snapshotJson(conversationId) });
        return;
      }

      if (action === "remove") {
        if (!item) {
          fail("queued item not found", "not_found");
          return;
        }
        removeQueuedTurn(item.id);
        respond(requestId, { accepted: true, snapshotJson: snapshotJson(conversationId) });
        return;
      }

      if (action === "edit_begin") {
        if (!item) {
          fail("queued item not found", "not_found");
          return;
        }
        const sameConversationQueue = queuedChatTurnsRef.current.filter(
          (candidate) => candidate.conversationId === conversationId,
        );
        const sameConversationIndex = sameConversationQueue.findIndex(
          (candidate) => candidate.id === item.id,
        );
        const slot: QueuedChatTurnEditSlot = {
          conversationId,
          previousId:
            sameConversationIndex > 0
              ? (sameConversationQueue[sameConversationIndex - 1]?.id ?? null)
              : null,
          nextId:
            sameConversationIndex >= 0
              ? (sameConversationQueue[sameConversationIndex + 1]?.id ?? null)
              : null,
          index: sameConversationIndex >= 0 ? sameConversationIndex : undefined,
        };
        remoteQueuedChatTurnEditSlotsRef.current.set(item.id, {
          item,
          slot,
          revision: chatQueueRevisionRef.current,
        });
        const detail = buildChatQueueItemDetail(item);
        setQueuedChatTurnsState((current) => removeQueuedChatTurn(current, item.id));
        respond(requestId, {
          accepted: true,
          itemJson: JSON.stringify(detail),
          snapshotJson: snapshotJson(conversationId),
        });
        return;
      }

      if (action === "edit_cancel") {
        const session = remoteQueuedChatTurnEditSlotsRef.current.get(itemId);
        if (!session) {
          fail("queued edit session not found", "not_found");
          return;
        }
        if (session.slot.conversationId !== conversationId) {
          fail("queued edit session conversation mismatch", "not_found");
          return;
        }
        remoteQueuedChatTurnEditSlotsRef.current.delete(itemId);
        setQueuedChatTurnsState((current) =>
          insertQueuedChatTurnAtSlot(current, session.item, session.slot),
        );
        respond(requestId, { accepted: true, snapshotJson: snapshotJson(conversationId) });
        return;
      }

      if (action === "edit_commit") {
        const session = remoteQueuedChatTurnEditSlotsRef.current.get(itemId);
        if (!session) {
          fail("queued edit session not found", "not_found");
          return;
        }
        if (session.slot.conversationId !== conversationId) {
          fail("queued edit session conversation mismatch", "not_found");
          return;
        }
        if (
          typeof request.revision === "number" &&
          request.revision > 0 &&
          request.revision < chatQueueRevisionRef.current
        ) {
          fail("queued edit revision conflict", "conflict");
          return;
        }
        let draft: MentionComposerDraft;
        let uploadedFiles: PendingUploadedFile[];
        try {
          draft = JSON.parse(request.draftJson || "") as MentionComposerDraft;
          uploadedFiles = JSON.parse(request.uploadedFilesJson || "[]") as PendingUploadedFile[];
        } catch {
          fail("invalid queued edit payload", "invalid_payload");
          return;
        }
        const nextItem = createQueuedChatTurn({
          ...session.item,
          draft,
          uploadedFiles: Array.isArray(uploadedFiles) ? uploadedFiles : [],
          id: session.item.id,
          createdAt: session.item.createdAt,
        });
        remoteQueuedChatTurnEditSlotsRef.current.delete(itemId);
        setQueuedChatTurnsState((current) =>
          insertQueuedChatTurnAtSlot(current, nextItem, session.slot),
        );
        respond(requestId, { accepted: true, snapshotJson: snapshotJson(conversationId) });
        return;
      }

      fail(`unsupported chat queue action: ${action}`, "unsupported_action");
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return {
    queuedChatTurnsRef,
    queuedChatTurnEditSlotRef,
    setQueuedChatTurnsState,
    queuedChatTurnsForCurrentConversation,
    publishChatQueueSnapshots,
    collectChatQueueSnapshotConversationIds,
    stopConversation,
    stopSending,
    enqueueCurrentComposerTurn,
    enqueueComposerTurnForConversation,
    requestQueuedChatTurnProcessing,
    runQueuedTurnNow,
    moveQueuedTurnUp,
    editQueuedTurn,
    removeQueuedTurn,
    shouldQueueGatewayChatRequest,
    enqueueGatewayChatRequest,
  };
}
