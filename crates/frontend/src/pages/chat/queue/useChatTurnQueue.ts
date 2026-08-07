import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MentionComposerHandle } from "../../../components/chat/MentionComposer";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import type { ToolStatus } from "../../../lib/protocol/wireEvents";
import type { AppSettings, ChatRuntimeControls } from "../../../lib/settings";
import type { SendChatAction } from "../bridge/bridgeTypes";
import type { ChatQueueTurnPreview } from "../components/ChatComposerBar";
import type { ConversationRuntimeEntry } from "../runtime/chatPageRuntime";
import {
  appendQueuedChatTurn,
  buildQueuedChatTurnPreview,
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
  updateToolStatus: (status: ToolStatus | null, store: LiveTranscriptStore) => void;
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  pendingUploadedFiles: PendingUploadedFile[];
  setPendingUploadsForConversation: (
    conversationId: string,
    uploads: PendingUploadedFile[],
  ) => void;
  clearCachedComposerDraft: (conversationId?: string) => void;
  displayedConversationWorkdir: string;
  sendActionRef: MutableRefObject<SendChatAction>;
};

/**
 * The chat turn queue: local queued turns (enqueue while a run is active,
 * FIFO drain on run end, in-composer editing with slot restore).
 */
export function useChatTurnQueue(params: UseChatTurnQueueParams) {
  const {
    settings,
    currentConversationId,
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
  } = params;

  const [queuedChatTurns, setQueuedChatTurns] = useState<QueuedChatTurn[]>([]);
  const queuedChatTurnsRef = useRef<QueuedChatTurn[]>([]);
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
      }
    >(),
  );
  const queuedChatTurnEditSlotRef = useRef<
    | (QueuedChatTurnEditSlot & {
        originalId: string;
        createdAt: number;
        workdir: string;
        runtimeControls: ChatRuntimeControls;
      })
    | null
  >(null);
  const previousRunningConversationIdsRef = useRef<ReadonlySet<string>>(new Set());

  const setQueuedChatTurnsState = useCallback(
    (updater: (current: QueuedChatTurn[]) => QueuedChatTurn[]) => {
      const previous = queuedChatTurnsRef.current;
      const next = updater(previous).slice();
      queuedChatTurnsRef.current = next;
      setQueuedChatTurns(next);
      return next;
    },
    [],
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
    }
    const controller = getConversationAbortController(targetConversationId);
    const transcriptStore = getConversationLiveTranscriptStore(targetConversationId);
    if (controller) {
      captureAbortSnapshot(transcriptStore);
      updateToolStatus({ kind: "ui_stopping" }, transcriptStore);
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
    const workdirForTurn = (
      editSlot?.workdir ??
      runtimeEntry.workdir ??
      displayedConversationWorkdir ??
      settings.system.workdir
    ).trim();
    const queuedTurn = createQueuedChatTurn({
      id: editSlot?.originalId,
      conversationId,
      draft,
      uploadedFiles,
      workdir: workdirForTurn,
      runtimeControls: editSlot?.runtimeControls ?? settings.chatRuntimeControls,
      createdAt: editSlot?.createdAt,
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
        setQueuedChatTurnsState(() => taken.queue);
        const accepted = await sendActionRef.current({
          composerDraftOverride: queuedTurn.draft,
          uploadedFilesOverride: queuedTurn.uploadedFiles,
          conversationIdOverride: targetConversationId,
          workdirOverride: queuedTurn.workdir,
          runtimeControlsOverride: queuedTurn.runtimeControls,
          preserveComposerOnStart: true,
        });
        if (!accepted) {
          setQueuedChatTurnsState((current) =>
            promoteQueuedChatTurn(appendQueuedChatTurn(current, queuedTurn), queuedTurn.id),
          );
          inFlightQueuedTurn = null;
        }
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
          setQueuedChatTurnsState((current) =>
            promoteQueuedChatTurn(
              appendQueuedChatTurn(current, failedQueuedTurn),
              failedQueuedTurn.id,
            ),
          );
          inFlightQueuedTurn = null;
        }
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
      workdir: queuedTurn.workdir,
      runtimeControls: { ...queuedTurn.runtimeControls },
    };
    setQueuedChatTurnsState((current) => removeQueuedChatTurn(current, key));
    composerRef.current?.setDraft(queuedTurn.draft);
    setPendingUploadsForConversation(targetConversationId, queuedTurn.uploadedFiles);
    clearCachedComposerDraft(targetConversationId);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function removeQueuedTurn(id: string) {
    setQueuedChatTurnsState((current) => removeQueuedChatTurn(current, id));
  }

  return {
    queuedChatTurnsRef,
    queuedChatTurnEditSlotRef,
    setQueuedChatTurnsState,
    queuedChatTurnsForCurrentConversation,
    stopConversation,
    stopSending,
    enqueueCurrentComposerTurn,
    requestQueuedChatTurnProcessing,
    runQueuedTurnNow,
    moveQueuedTurnUp,
    editQueuedTurn,
    removeQueuedTurn,
  };
}
