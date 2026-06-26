import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import type { AgentStatus, ChatEvent, ChatRuntimeSnapshotEvent, GatewaySelectedModel } from "@/lib/gatewayTypes";
import type { LiveConversationStreamStore } from "@/lib/liveConversationStreamStore";
import type { ConversationRuntimeEntry, RunningConversationRuntime, SendChatOptions } from "@/app/types";
import type { GatewayChatCommandInput } from "@/lib/gatewaySocket";

import { ChatRunTracker, type ChatRunTrackerSnapshot } from "@/lib/chatRunTracker";
import { ChatEventStreamManager, type StreamManagerCallbacks } from "@/lib/chatEventStreamManager";
import { executeSendChat, refreshChatQueueSnapshotDebounced } from "@/lib/chatSendOrchestrator";
import { isLocalDraftConversationId } from "@/lib/localDraftConversation";

export type ChatOrchestrationApi = {
  commandChat(input: GatewayChatCommandInput): AsyncIterable<ChatEvent>;
  streamChatEvents(
    conversationId: string,
    options?: { runId?: string; afterSeq?: number; signal?: AbortSignal },
  ): AsyncIterable<ChatEvent>;
  cancelChat(conversationId: string, runId: string): Promise<void>;
  chatQueueGet(conversationId: string): Promise<{ snapshot: unknown }>;
};

export type ChatOrchestrationDeps = {
  api: ChatOrchestrationApi | null;
  getStatus(): AgentStatus | null;
  isAgentMode: boolean;
  buildGatewaySelectedModel(): GatewaySelectedModel | undefined;
  buildGatewaySystemSettings(workdir: string): {
    executionMode?: string;
    workdir?: string;
    selectedSystemTools?: string[];
  } | undefined;
  buildRuntimeControls(controls: unknown): unknown;
  prepareChatRuntime(reason: string, timeout: number): Promise<AgentStatus>;
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
  ensureHistorySummary(id: string, title: string, startedAt: number, workdir: string): void;
  applyLiveConversationTitle(id: string, title: string, options: { isFinal: boolean }): void;
  markLiveConversationStreamActive(id: string): void;
  setLiveConversationStreamStatus(id: string, status: string | null, isCompaction?: boolean): void;
  handleTunnelManagerChatEvent(event: ChatEvent): void;
  isChatStreamNotAvailableEvent(event: ChatEvent): boolean;
  stickTranscriptToBottom(): void;
  isVisibleConversation(id: string): boolean;
  isTranscriptAtBottom(): boolean;
  preserveTranscriptScrollPosition(fn: () => void, opts: { stickToBottom: boolean }): void;
  refreshTranscriptScrollState(): void;
  applyChatQueueSnapshot(snapshot: unknown): void;
  commitConversationLiveStreamToRuntime(id: string, options: { clearLiveStream: boolean }): void;
  clearConversationLiveStream(id: string): void;
  reloadHistory(options: {
    preferredConversationId: string;
    skipSelectionSync?: boolean;
    silent?: boolean;
  }): Promise<void>;
  refreshVisibleConversationHistorySnapshot(
    id: string,
    options?: { allowIdle?: boolean; serverIdle?: boolean },
  ): Promise<void>;
  buildOptimisticConversationTitle(message: string): string;
  createLocalDraftConversationId(): string;
  readGatewayChatEventRunId(event: ChatEvent): string;
  recordProjectActivity(workdir: string, updatedAt: number): void;
  hasRetainedConversationLiveStream(id: string): boolean;
};

export function useChatOrchestration(deps: ChatOrchestrationDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const tracker = useMemo(() => new ChatRunTracker(), []);

  const chatStartInFlightRef = useRef(false);
  const pendingDraftConversationMigrationRef = useRef<{
    draftConversationId: string;
    startedAt: number;
  } | null>(null);
  const optimisticTitleConversationIdsRef = useRef<Set<string>>(new Set());
  const draftConversationPinnedRef = useRef(false);
  const protectedConversationRef = useRef("");

  const streamManagerCallbacks = useMemo((): StreamManagerCallbacks => ({
    getConversationLiveStreamStore: (id) => depsRef.current.getConversationLiveStreamStore(id),
    refreshVisibleConversationHistorySnapshot: (id, options) => {
      void depsRef.current.refreshVisibleConversationHistorySnapshot(id, options);
    },
    applyLiveConversationTitle: (id, title, opts) => depsRef.current.applyLiveConversationTitle(id, title, opts),
    setLiveConversationStreamStatus: (id, s, c) => depsRef.current.setLiveConversationStreamStatus(id, s, c),
    markLiveConversationStreamActive: (id) => depsRef.current.markLiveConversationStreamActive(id),
    commitTerminalLiveStream: (id) => {
      const d = depsRef.current;
      if (!d.isVisibleConversation(id)) {
        d.clearConversationLiveStream(id);
        return;
      }
      const shouldKeepBottom = d.isTranscriptAtBottom();
      d.preserveTranscriptScrollPosition(
        () => {
          d.commitConversationLiveStreamToRuntime(id, { clearLiveStream: false });
        },
        { stickToBottom: shouldKeepBottom },
      );
      if (shouldKeepBottom) {
        d.stickTranscriptToBottom();
      } else {
        d.refreshTranscriptScrollState();
      }
    },
    clearConversationLiveStream: (id) => depsRef.current.clearConversationLiveStream(id),
    handleTunnelManagerChatEvent: (e) => depsRef.current.handleTunnelManagerChatEvent(e),
    applyChatRuntimeSnapshotEvent: (event, fallback) => {
      const d = depsRef.current;
      const conversationId = event.conversation_id?.trim() || fallback.trim();
      if (!conversationId) return false;
      const liveStore = d.getConversationLiveStreamStore(conversationId);
      if (!liveStore) return false;

      liveStore.applySnapshot(event, { flush: true });
      const statusText = typeof event.tool_status === "string" ? event.tool_status.trim() : "";
      const normalizedStatus = statusText || null;
      const isCompaction = normalizedStatus !== null && event.tool_status_is_compaction === true;
      d.setLiveConversationStreamStatus(conversationId, normalizedStatus, isCompaction);
      d.markLiveConversationStreamActive(conversationId);

      const state = event.state ?? "running";
      const terminalState = state === "completed" || state === "failed" || state === "cancelled";
      if (terminalState) {
        tracker.markCompleted(conversationId);
      } else {
        tracker.markRemoteRunning(conversationId, {
          runId: event.run_id,
          workdir: event.workdir,
          updatedAt: event.updated_at ?? Date.now(),
        });
      }
      return terminalState;
    },
    isChatStreamNotAvailableEvent: (e) => depsRef.current.isChatStreamNotAvailableEvent(e),
    isVisibleConversation: (id) => depsRef.current.isVisibleConversation(id),
  }), [tracker]);

  const streamManager = useMemo(
    () => new ChatEventStreamManager(tracker, streamManagerCallbacks),
    [tracker, streamManagerCallbacks],
  );

  useEffect(() => {
    streamManager.updateCallbacks(streamManagerCallbacks);
  }, [streamManager, streamManagerCallbacks]);

  useEffect(() => {
    if (deps.api) {
      streamManager.setApi(deps.api);
    }
  }, [streamManager, deps.api]);

  const snapshot = useSyncExternalStore(
    tracker.subscribe,
    tracker.getSnapshot,
  );

  const sendChat = useCallback(
    async (message: string, options?: SendChatOptions) => {
      const d = depsRef.current;
      if (!d.api || chatStartInFlightRef.current) return;

      let activeConversationId = options?.conversationId?.trim() || "";
      if (!activeConversationId) {
        activeConversationId = d.createLocalDraftConversationId();
      }

      if (
        tracker.hasStartLock(activeConversationId) ||
        tracker.getAbortController(activeConversationId) !== null ||
        tracker.isLocalRunning(activeConversationId)
      ) {
        return;
      }

      const workdir = d.isAgentMode
        ? options?.workdir?.trim() ||
          d.pickConversationWorkdir(activeConversationId) ||
          d.getActiveWorkspaceProjectPath() ||
          d.getDefaultWorkdir()
        : "";

      await executeSendChat(d.api, {
        tracker,
        streamManager,
        getStatus: () => depsRef.current.getStatus(),
        isAgentMode: d.isAgentMode,
        buildGatewaySelectedModel: () => depsRef.current.buildGatewaySelectedModel(),
        buildGatewaySystemSettings: (w) => depsRef.current.buildGatewaySystemSettings(w),
        buildRuntimeControls: (c) => depsRef.current.buildRuntimeControls(c) as any,
        prepareChatRuntime: (r, t) => depsRef.current.prepareChatRuntime(r, t),
        isChatRuntimeReady: () => depsRef.current.isChatRuntimeReady(),
        getActiveWorkspaceProjectPath: () => depsRef.current.getActiveWorkspaceProjectPath(),
        getDefaultWorkdir: () => depsRef.current.getDefaultWorkdir(),
        getConversationLiveStreamStore: (id) => depsRef.current.getConversationLiveStreamStore(id),
        updateConversationRuntimeEntry: (id, u) => depsRef.current.updateConversationRuntimeEntry(id, u),
        pickConversationWorkdir: (id) => depsRef.current.pickConversationWorkdir(id),
        migrateConversationRuntime: (f, t) => depsRef.current.migrateConversationRuntime(f, t),
        migrateConversationSummary: (f, t) => depsRef.current.migrateConversationSummary(f, t),
        setConversationRunningInHistory: (id, running) => {
          const dd = depsRef.current;
          dd.recordProjectActivity(dd.pickConversationWorkdir(id), Date.now());
        },
        ensureHistorySummary: (id, title, at, w) => depsRef.current.ensureHistorySummary(id, title, at, w),
        applyLiveConversationTitle: (id, t, o) => depsRef.current.applyLiveConversationTitle(id, t, o),
        markLiveConversationStreamActive: (id) => depsRef.current.markLiveConversationStreamActive(id),
        setLiveConversationStreamStatus: (id, s, c) => depsRef.current.setLiveConversationStreamStatus(id, s, c),
        handleTunnelManagerChatEvent: (e) => depsRef.current.handleTunnelManagerChatEvent(e),
        isChatStreamNotAvailableEvent: (e) => depsRef.current.isChatStreamNotAvailableEvent(e),
        stickTranscriptToBottom: () => depsRef.current.stickTranscriptToBottom(),
        isVisibleConversation: (id) => depsRef.current.isVisibleConversation(id),
        refreshChatQueueSnapshot: (id) => {
          const dd = depsRef.current;
          if (dd.api) {
            refreshChatQueueSnapshotDebounced(dd.api, id, dd.applyChatQueueSnapshot);
          }
        },
        reloadHistory: (o) => depsRef.current.reloadHistory(o),
        refreshVisibleConversationHistorySnapshot: (id, o) =>
          depsRef.current.refreshVisibleConversationHistorySnapshot(id, o),
        commitConversationLiveStreamToRuntime: (id, o) =>
          depsRef.current.commitConversationLiveStreamToRuntime(id, o),
        buildOptimisticConversationTitle: (m) => depsRef.current.buildOptimisticConversationTitle(m),
        createLocalDraftConversationId: () => depsRef.current.createLocalDraftConversationId(),
        readGatewayChatEventRunId: (e) => depsRef.current.readGatewayChatEventRunId(e),
        chatStartInFlightRef,
        pendingDraftConversationMigrationRef,
        optimisticTitleConversationIdsRef,
        draftConversationPinnedRef,
        protectedConversationRef,
      }, message, options, activeConversationId, workdir);
    },
    [tracker, streamManager],
  );

  const cancelChat = useCallback(
    async (targetConversationId?: string) => {
      const d = depsRef.current;
      const id = targetConversationId?.trim() || "";
      if (!id) return;

      const controller = tracker.getAbortController(id);
      const cancelRunId =
        tracker.getEventStreamRunKey(id) ||
        tracker.getRuntime(id)?.runId ||
        "";

      const cancelRequest =
        !controller && d.api && id && !isLocalDraftConversationId(id)
          ? d.api.cancelChat(id, cancelRunId).catch(() => undefined)
          : null;

      controller?.abort();
      streamManager.stopSubscription(id);

      if (d.isVisibleConversation(id)) {
        const shouldKeepBottom = d.isTranscriptAtBottom();
        d.preserveTranscriptScrollPosition(
          () => {
            d.commitConversationLiveStreamToRuntime(id, { clearLiveStream: false });
          },
          { stickToBottom: shouldKeepBottom },
        );
        tracker.markCancelled(id);
        if (shouldKeepBottom) {
          d.stickTranscriptToBottom();
        } else {
          d.refreshTranscriptScrollState();
        }
      } else {
        tracker.markCancelled(id);
      }

      if (cancelRequest) {
        await cancelRequest;
      }
    },
    [tracker, streamManager],
  );

  const handleHistoryRunningEvent = useCallback(
    (conversationId: string, runtime: RunningConversationRuntime) => {
      const d = depsRef.current;
      if (!d.api) return;
      const id = conversationId.trim();
      if (!id) return;

      const runId = runtime.runId?.trim() ?? "";
      if (!runId) return;

      const previousRunKey = tracker.getEventStreamRunKey(id);
      const hasStaleStream =
        !previousRunKey &&
        d.hasRetainedConversationLiveStream(id) &&
        !tracker.isLocalRunning(id) &&
        tracker.getAbortController(id) === null;

      if (hasStaleStream) {
        d.clearConversationLiveStream(id);
      }

      d.recordProjectActivity(runtime.workdir ?? "", runtime.updatedAt ?? Date.now());
      tracker.markRemoteRunning(id, runtime);
    },
    [tracker],
  );

  const handleHistoryIdleEvent = useCallback(
    (conversationId: string, eventRunId?: string) => {
      const id = conversationId.trim();
      if (!id) return;

      if (tracker.shouldSuppressIdleEvent(id, eventRunId ?? "")) {
        return;
      }

      tracker.markIdle(id);
    },
    [tracker],
  );

  useEffect(() => {
    return () => {
      streamManager.dispose();
      tracker.resetAll();
    };
  }, [tracker, streamManager]);

  return {
    tracker,
    streamManager,
    snapshot,
    sendChat,
    cancelChat,
    handleHistoryRunningEvent,
    handleHistoryIdleEvent,
    chatStartInFlightRef,
    pendingDraftConversationMigrationRef,
    optimisticTitleConversationIdsRef,
    draftConversationPinnedRef,
    protectedConversationRef,
  };
}
