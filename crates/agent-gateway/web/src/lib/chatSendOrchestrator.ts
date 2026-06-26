import type {
  AgentStatus,
  ChatControlEvent,
  ChatEvent,
  ChatRuntimeSnapshotEvent,
  GatewayChatRuntimeControls,
  GatewaySelectedModel,
} from "@/lib/gatewayTypes";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";
import type { LiveConversationStreamStore } from "@/lib/liveConversationStreamStore";
import type { ConversationRuntimeEntry, RunningConversationRuntime, SendChatOptions } from "@/app/types";

import { ChatRunTracker } from "@/lib/chatRunTracker";
import { ChatEventStreamManager } from "@/lib/chatEventStreamManager";
import {
  isChatStreamNotAvailableMessage,
  isRecoverableChatStreamTransportMessage,
} from "@/lib/chatStreamRecovery";
import { isLocalDraftConversationId } from "@/lib/localDraftConversation";
import {
  asErrorMessage,
  isAbortError,
  isChatControlEvent,
  isChatEventTitleFinal,
  isPreparingChatControlEvent,
  isRuntimeStartedChatControlEvent,
  isTerminalChatControlEvent,
  isTerminalChatEvent,
  normalizeOptionalStatus,
  readChatEventTitle,
} from "@/app/chatEventUtils";
import {
  getInitialChatRuntimeToolStatus,
  getPreparingChatRuntimeToolStatus,
  shouldApplyPreparingChatRuntimeStatus,
} from "@/app/chatRuntimeStatus";

export type SendChatApi = {
  commandChat(input: {
    type: "chat.submit" | "chat.edit_resend";
    message: string;
    conversationId?: string;
    selectedModel?: GatewaySelectedModel;
    systemSettings?: {
      executionMode?: string;
      workdir?: string;
      selectedSystemTools?: string[];
    };
    signal?: AbortSignal;
    uploadedFiles?: PendingUploadedFile[];
    clientRequestId?: string;
    runtimeControls?: GatewayChatRuntimeControls;
    baseMessageRef?: unknown;
    queuePolicy?: "auto" | "append" | "interrupt";
  }): AsyncIterable<ChatEvent>;
  streamChatEvents(
    conversationId: string,
    options?: { runId?: string; afterSeq?: number; signal?: AbortSignal },
  ): AsyncIterable<ChatEvent>;
};

export type SendChatContext = {
  tracker: ChatRunTracker;
  streamManager: ChatEventStreamManager;
  getStatus(): AgentStatus | null;
  isAgentMode: boolean;
  buildGatewaySelectedModel(): GatewaySelectedModel | undefined;
  buildGatewaySystemSettings(workdir: string): {
    executionMode?: string;
    workdir?: string;
    selectedSystemTools?: string[];
  } | undefined;
  buildRuntimeControls(
    controls: GatewayChatRuntimeControls | undefined,
  ): GatewayChatRuntimeControls;
  prepareChatRuntime(
    reason: string,
    timeout: number,
  ): Promise<AgentStatus>;
  isChatRuntimeReady(): boolean;
  getActiveWorkspaceProjectPath(): string;
  getDefaultWorkdir(): string;
  getConversationLiveStreamStore(id: string): LiveConversationStreamStore | null;
  updateConversationRuntimeEntry(
    id: string,
    updater: (entry: ConversationRuntimeEntry) => ConversationRuntimeEntry,
  ): void;
  pickConversationWorkdir(id: string): string;
  migrateConversationRuntime(from: string, to: string): void;
  migrateConversationSummary(from: string, to: string): void;
  setConversationRunningInHistory(id: string, running: boolean): void;
  ensureHistorySummary(
    id: string,
    title: string,
    startedAt: number,
    workdir: string,
  ): void;
  applyLiveConversationTitle(
    id: string,
    title: string,
    options: { isFinal: boolean },
  ): void;
  markLiveConversationStreamActive(id: string): void;
  setLiveConversationStreamStatus(
    id: string,
    status: string | null,
    isCompaction?: boolean,
  ): void;
  handleTunnelManagerChatEvent(event: ChatEvent): void;
  isChatStreamNotAvailableEvent(event: ChatEvent): boolean;
  stickTranscriptToBottom(): void;
  isVisibleConversation(id: string): boolean;
  refreshChatQueueSnapshot(conversationId: string): void;
  reloadHistory(options: {
    preferredConversationId: string;
    skipSelectionSync?: boolean;
    silent?: boolean;
  }): Promise<void>;
  refreshVisibleConversationHistorySnapshot(
    id: string,
    options?: { allowIdle?: boolean; serverIdle?: boolean },
  ): Promise<void>;
  commitConversationLiveStreamToRuntime(
    id: string,
    options: { clearLiveStream: boolean },
  ): void;
  buildOptimisticConversationTitle(message: string): string;
  createLocalDraftConversationId(): string;
  readGatewayChatEventRunId(event: ChatEvent): string;
  chatStartInFlightRef: { current: boolean };
  pendingDraftConversationMigrationRef: { current: { draftConversationId: string; startedAt: number } | null };
  optimisticTitleConversationIdsRef: { current: Set<string> };
  draftConversationPinnedRef: { current: boolean };
  protectedConversationRef: { current: string };
};

const CHAT_RUNTIME_STARTING_STATUS = "Starting desktop runtime...";
const CHAT_RUNTIME_STARTING_STATUS_DELAY_MS = 1_200;
const CHAT_RUNTIME_PREPARE_TIMEOUT_MS = 2_500;
const VIBING_STATUS = "Thinking...";

export async function executeSendChat(
  api: SendChatApi,
  ctx: SendChatContext,
  message: string,
  options: SendChatOptions | undefined,
  activeConversationId: string,
  effectiveWorkdir: string,
) {
  const isEditResend = Boolean(options?.editMessageRef);
  const startedAsDraft = isLocalDraftConversationId(activeConversationId);
  const controller = new AbortController();
  const startedAt = Date.now();
  const clientRequestId =
    options?.clientRequestId?.trim() ||
    `webui-chat-${activeConversationId}-${crypto.randomUUID()}`;
  const optimisticDraftTitle = ctx.buildOptimisticConversationTitle(message);
  const optimisticUserEntryId =
    options?.optimisticUserEntryId?.trim() || `user-${crypto.randomUUID()}`;
  const shouldAppendOptimistic = options?.skipOptimisticUserEntry !== true;

  ctx.draftConversationPinnedRef.current = false;
  ctx.pendingDraftConversationMigrationRef.current = startedAsDraft
    ? { draftConversationId: activeConversationId, startedAt }
    : null;
  ctx.protectedConversationRef.current = activeConversationId;
  ctx.tracker.blockHistoryHydration(activeConversationId);
  ctx.tracker.addStartLock(activeConversationId);
  ctx.tracker.markSending(activeConversationId, controller);

  if (ctx.isVisibleConversation(activeConversationId)) {
    ctx.stickTranscriptToBottom();
  }

  ctx.commitConversationLiveStreamToRuntime(activeConversationId, {
    clearLiveStream: true,
  });
  ctx.getConversationLiveStreamStore(activeConversationId);

  ctx.updateConversationRuntimeEntry(activeConversationId, (current) => ({
    ...current,
    error: null,
    toolStatus: getInitialChatRuntimeToolStatus(isEditResend),
    toolStatusIsCompaction: false,
    isSending: true,
    workdir: effectiveWorkdir || undefined,
    messages: shouldAppendOptimistic
      ? [
          ...current.messages,
          {
            id: optimisticUserEntryId,
            kind: "user" as const,
            text: message,
            attachments: options?.uploadedFiles ?? [],
          },
        ]
      : current.messages,
  }));

  if (startedAsDraft) {
    ctx.optimisticTitleConversationIdsRef.current.add(activeConversationId);
    ctx.ensureHistorySummary(activeConversationId, optimisticDraftTitle, startedAt, effectiveWorkdir);
  }

  let terminalEventSeen = false;
  let recoverableTransportError = false;
  let wasQueuedInGui = false;
  let runActive = false;
  let runtimeStarted = false;
  let activeGatewayRunId = "";
  const lockedConversationIds = new Set([activeConversationId]);

  const preserveRemoteRunCleanupOptions = () => ({
    remoteRunId: activeGatewayRunId,
    preserveRemoteRunOnMismatch: true,
  });

  let runtimeStartingStatusTimer: number | null = null;
  const clearRuntimeStartingStatusTimer = () => {
    if (runtimeStartingStatusTimer !== null) {
      window.clearTimeout(runtimeStartingStatusTimer);
      runtimeStartingStatusTimer = null;
    }
  };
  const clearRuntimeStartingStatus = () => {
    ctx.updateConversationRuntimeEntry(activeConversationId, (current) => {
      if (current.toolStatus !== CHAT_RUNTIME_STARTING_STATUS) return current;
      return { ...current, toolStatus: null, toolStatusIsCompaction: false };
    });
  };
  const scheduleRuntimeStartingStatusTimer = () => {
    clearRuntimeStartingStatusTimer();
    if (ctx.isChatRuntimeReady()) return;
    runtimeStartingStatusTimer = window.setTimeout(() => {
      runtimeStartingStatusTimer = null;
      if (runtimeStarted || terminalEventSeen || controller.signal.aborted || ctx.isChatRuntimeReady()) return;
      ctx.updateConversationRuntimeEntry(activeConversationId, (current) => {
        if (!current.isSending || current.toolStatus) return current;
        return { ...current, toolStatus: CHAT_RUNTIME_STARTING_STATUS, toolStatusIsCompaction: false };
      });
    }, CHAT_RUNTIME_STARTING_STATUS_DELAY_MS);
  };
  const markRunActive = () => {
    if (runActive) return;
    runActive = true;
    ctx.setConversationRunningInHistory(activeConversationId, true);
  };
  const markRuntimeStarted = () => {
    if (runtimeStarted) return;
    runtimeStarted = true;
    clearRuntimeStartingStatusTimer();
    markRunActive();
    clearRuntimeStartingStatus();
  };
  const markRunPreparing = () => {
    markRunActive();
    const nextToolStatus = getPreparingChatRuntimeToolStatus(isEditResend);
    ctx.updateConversationRuntimeEntry(activeConversationId, (current) => {
      if (
        !current.isSending ||
        !shouldApplyPreparingChatRuntimeStatus({
          currentStatus: current.toolStatus,
          isCompaction: current.toolStatusIsCompaction,
          isEditResend,
        })
      ) {
        return current;
      }
      return { ...current, toolStatus: nextToolStatus, toolStatusIsCompaction: false };
    });
  };

  const runtimeControls = ctx.buildRuntimeControls(options?.runtimeControls);
  const targetConversationId = isLocalDraftConversationId(activeConversationId)
    ? undefined
    : activeConversationId;

  try {
    ctx.chatStartInFlightRef.current = true;
    scheduleRuntimeStartingStatusTimer();

    void ctx.prepareChatRuntime("send", CHAT_RUNTIME_PREPARE_TIMEOUT_MS)
      .then(() => {
        if (ctx.isChatRuntimeReady()) {
          clearRuntimeStartingStatusTimer();
          clearRuntimeStartingStatus();
        }
      })
      .catch(() => undefined);

    const gatewaySelectedModel = ctx.buildGatewaySelectedModel();
    const gatewaySystemSettings = ctx.buildGatewaySystemSettings(effectiveWorkdir);

    const chatStream = api.commandChat({
      type: options?.editMessageRef ? "chat.edit_resend" : "chat.submit",
      message,
      conversationId: targetConversationId,
      selectedModel: gatewaySelectedModel,
      systemSettings: gatewaySystemSettings,
      signal: controller.signal,
      uploadedFiles: options?.uploadedFiles,
      clientRequestId,
      runtimeControls,
      baseMessageRef: options?.editMessageRef,
      queuePolicy: options?.queuePolicy ?? "auto",
    });

    for await (const event of chatStream) {
      const eventRunId = ctx.readGatewayChatEventRunId(event);
      if (eventRunId) {
        activeGatewayRunId = eventRunId;
      }

      if (event.conversation_id && event.conversation_id !== "") {
        const nextConversationId = event.conversation_id.trim();
        if (nextConversationId !== activeConversationId) {
          const previousConversationId = activeConversationId;
          if (
            ctx.pendingDraftConversationMigrationRef.current?.draftConversationId ===
            previousConversationId
          ) {
            ctx.pendingDraftConversationMigrationRef.current = null;
          }
          ctx.migrateConversationRuntime(previousConversationId, nextConversationId);
          ctx.migrateConversationSummary(previousConversationId, nextConversationId);
          activeConversationId = nextConversationId;
          lockedConversationIds.add(activeConversationId);
          if (runActive) {
            ctx.setConversationRunningInHistory(previousConversationId, false);
            ctx.setConversationRunningInHistory(activeConversationId, true);
          }
        }
        if (startedAsDraft) {
          ctx.optimisticTitleConversationIdsRef.current.add(activeConversationId);
          ctx.ensureHistorySummary(activeConversationId, optimisticDraftTitle, startedAt, effectiveWorkdir);
        }
      }

      if (event.type === "runtime_snapshot") {
        markRuntimeStarted();
        const liveStore = ctx.getConversationLiveStreamStore(activeConversationId);
        if (liveStore) {
          liveStore.applySnapshot(event as ChatRuntimeSnapshotEvent, { flush: true });
        }
        const state = (event as ChatRuntimeSnapshotEvent).state ?? "running";
        const terminalState = state === "completed" || state === "failed" || state === "cancelled";
        if (terminalState) {
          terminalEventSeen = true;
          clearRuntimeStartingStatusTimer();
          ctx.tracker.markCompleted(activeConversationId);
          ctx.streamManager.clearStreamingState(
            activeConversationId,
            preserveRemoteRunCleanupOptions(),
          );
          ctx.streamManager.commitTerminalLiveStream(activeConversationId);
        }
        continue;
      }

      if (isChatControlEvent(event)) {
        if (event.type === "queued_in_gui") {
          terminalEventSeen = true;
          wasQueuedInGui = true;
          clearRuntimeStartingStatusTimer();
          ctx.tracker.markQueuedInGui(activeConversationId);
          ctx.updateConversationRuntimeEntry(activeConversationId, (current) => ({
            ...current,
            messages: current.messages.filter((entry) => entry.id !== optimisticUserEntryId),
            error: null,
            toolStatus: null,
            toolStatusIsCompaction: false,
            isSending: false,
          }));
          const queueConversationId = event.conversation_id?.trim() || activeConversationId;
          ctx.refreshChatQueueSnapshot(queueConversationId);
          return;
        }

        if (event.type === "user_message") {
          markRunPreparing();
          ctx.getConversationLiveStreamStore(activeConversationId)?.appendEvent(event, {
            flush: true,
          });
          ctx.markLiveConversationStreamActive(activeConversationId);
          continue;
        }

        if (isTerminalChatControlEvent(event)) {
          terminalEventSeen = true;
          clearRuntimeStartingStatusTimer();
          ctx.streamManager.clearStreamingState(
            activeConversationId,
            preserveRemoteRunCleanupOptions(),
          );
          if (event.type === "failed") {
            ctx.getConversationLiveStreamStore(activeConversationId)?.appendEvent(event, {
              flush: true,
            });
          }
          ctx.tracker.markCompleted(activeConversationId);
          ctx.streamManager.commitTerminalLiveStream(activeConversationId);
          if (ctx.tracker.deletePendingHistoryRefresh(activeConversationId)) {
            void ctx.refreshVisibleConversationHistorySnapshot(activeConversationId, {
              allowIdle: true,
            });
          }
          continue;
        }

        if (isRuntimeStartedChatControlEvent(event)) {
          markRuntimeStarted();
          ctx.updateConversationRuntimeEntry(activeConversationId, (current) => ({
            ...current,
            toolStatus: VIBING_STATUS,
            toolStatusIsCompaction: false,
          }));
        } else if (isPreparingChatControlEvent(event)) {
          markRunPreparing();
        }
        continue;
      }

      markRuntimeStarted();

      if (ctx.isChatStreamNotAvailableEvent(event)) {
        terminalEventSeen = true;
        ctx.streamManager.recoverUnavailableStream(activeConversationId);
        return;
      }

      if (event.type === "tool_status") {
        const normalizedStatus = normalizeOptionalStatus(event.status);
        const isCompaction = normalizedStatus !== null && event.isCompaction === true;
        ctx.getConversationLiveStreamStore(activeConversationId)?.setToolStatus(
          normalizedStatus,
          isCompaction,
        );
        ctx.setLiveConversationStreamStatus(activeConversationId, normalizedStatus, isCompaction);
        ctx.updateConversationRuntimeEntry(activeConversationId, (current) => ({
          ...current,
          toolStatus: normalizedStatus,
          toolStatusIsCompaction: isCompaction,
        }));
      } else {
        const terminalEvent = isTerminalChatEvent(event);
        ctx.getConversationLiveStreamStore(activeConversationId)?.appendEvent(event, {
          flush: terminalEvent,
        });
        ctx.handleTunnelManagerChatEvent(event);
        if (terminalEvent) {
          terminalEventSeen = true;
          clearRuntimeStartingStatusTimer();
          ctx.streamManager.clearStreamingState(
            activeConversationId,
            preserveRemoteRunCleanupOptions(),
          );
          ctx.tracker.markCompleted(activeConversationId);
          ctx.streamManager.commitTerminalLiveStream(activeConversationId);
          if (ctx.tracker.deletePendingHistoryRefresh(activeConversationId)) {
            void ctx.refreshVisibleConversationHistorySnapshot(activeConversationId, {
              allowIdle: true,
            });
          }
        } else {
          ctx.markLiveConversationStreamActive(activeConversationId);
        }
      }

      const liveTitle = readChatEventTitle(event);
      if (liveTitle && isChatEventTitleFinal(event)) {
        ctx.applyLiveConversationTitle(
          event.conversation_id?.trim() || activeConversationId,
          liveTitle,
          { isFinal: true },
        );
      }
    }
  } catch (error) {
    if (!isAbortError(error)) {
      const errorMessage = asErrorMessage(error, "chat request failed");
      if (isChatStreamNotAvailableMessage(errorMessage)) {
        terminalEventSeen = true;
        ctx.streamManager.recoverUnavailableStream(activeConversationId);
      } else if (
        isRecoverableChatStreamTransportMessage(errorMessage) &&
        (runActive ||
          runtimeStarted ||
          activeGatewayRunId !== "" ||
          ctx.tracker.isRemoteRunning(activeConversationId))
      ) {
        recoverableTransportError = true;
        ctx.getConversationLiveStreamStore(activeConversationId)?.flush();
      } else {
        ctx.updateConversationRuntimeEntry(activeConversationId, (current) => ({
          ...current,
          error: errorMessage,
        }));
      }
    }
  } finally {
    clearRuntimeStartingStatusTimer();
    ctx.chatStartInFlightRef.current = false;

    if (wasQueuedInGui) {
      // queued_in_gui was handled by markQueuedInGui — do NOT clear streaming state again
    } else {
      ctx.streamManager.clearStreamingState(activeConversationId, {
        ...preserveRemoteRunCleanupOptions(),
        preserveRemoteRun: recoverableTransportError,
      });
    }

    if (ctx.tracker.canSubscribeEventStream(activeConversationId)) {
      ctx.streamManager.subscribeIfNeeded(activeConversationId, api);
    }

    const status = ctx.getStatus();
    if (status?.online && !terminalEventSeen) {
      await ctx.reloadHistory({
        preferredConversationId: activeConversationId,
        skipSelectionSync: true,
        silent: true,
      });
      if (
        recoverableTransportError &&
        !ctx.tracker.isRemoteRunning(activeConversationId) &&
        !ctx.tracker.isLocalRunning(activeConversationId) &&
        ctx.tracker.getAbortController(activeConversationId) === null
      ) {
        await ctx.refreshVisibleConversationHistorySnapshot(activeConversationId, {
          allowIdle: true,
          serverIdle: true,
        });
      }
    }

    if (!options?.editMessageRef) {
      ctx.tracker.unblockHistoryHydration(activeConversationId);
    }

    if (
      ctx.pendingDraftConversationMigrationRef.current?.draftConversationId ===
      activeConversationId
    ) {
      ctx.pendingDraftConversationMigrationRef.current = null;
    }

    for (const id of lockedConversationIds) {
      ctx.tracker.deleteStartLock(id);
    }
  }
}

const CHAT_QUEUE_REFRESH_DEBOUNCE_MS = 200;
let queueRefreshTimer: number | null = null;

export function refreshChatQueueSnapshotDebounced(
  api: { chatQueueGet(conversationId: string): Promise<{ snapshot: unknown }> },
  conversationId: string,
  applySnapshot: (snapshot: unknown) => void,
) {
  if (queueRefreshTimer !== null) {
    window.clearTimeout(queueRefreshTimer);
  }
  const load = () => {
    void api
      .chatQueueGet(conversationId)
      .then((response) => applySnapshot(response.snapshot))
      .catch(() => undefined);
  };
  load();
  queueRefreshTimer = window.setTimeout(() => {
    queueRefreshTimer = null;
    load();
  }, CHAT_QUEUE_REFRESH_DEBOUNCE_MS);
}
