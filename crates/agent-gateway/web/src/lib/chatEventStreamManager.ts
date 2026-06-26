import type { ChatEvent, ChatRuntimeSnapshotEvent } from "@/lib/gatewayTypes";
import type { LiveConversationStreamStore } from "@/lib/liveConversationStreamStore";
import type { RunningConversationRuntime } from "@/app/types";

import { ChatRunTracker, resolveRunKey } from "@/lib/chatRunTracker";
import { resolveRunningConversationStreamAfterSeq } from "@/lib/historySync";
import {
  isChatStreamNotAvailableMessage,
  isRecoverableChatStreamTransportMessage,
} from "@/lib/chatStreamRecovery";
import {
  isTerminalChatEvent,
  isAbortError,
  asErrorMessage,
  normalizeOptionalStatus,
  readChatEventTitle,
  isChatEventTitleFinal,
} from "@/app/chatEventUtils";

export type StreamManagerApi = {
  streamChatEvents(
    conversationId: string,
    options?: {
      runId?: string;
      afterSeq?: number;
      signal?: AbortSignal;
    },
  ): AsyncIterable<ChatEvent>;
};

export type StreamManagerCallbacks = {
  getConversationLiveStreamStore(id: string): LiveConversationStreamStore | null;
  refreshVisibleConversationHistorySnapshot(
    id: string,
    options?: { allowIdle?: boolean; serverIdle?: boolean },
  ): void;
  applyLiveConversationTitle(
    id: string,
    title: string,
    options: { isFinal: boolean },
  ): void;
  setLiveConversationStreamStatus(
    id: string,
    status: string | null,
    isCompaction?: boolean,
  ): void;
  markLiveConversationStreamActive(id: string): void;
  commitTerminalLiveStream(id: string): void;
  clearConversationLiveStream(id: string): void;
  handleTunnelManagerChatEvent(event: ChatEvent): void;
  applyChatRuntimeSnapshotEvent(
    event: ChatRuntimeSnapshotEvent,
    fallbackConversationId: string,
  ): boolean;
  isChatStreamNotAvailableEvent(event: ChatEvent): boolean;
  isVisibleConversation(id: string): boolean;
};

export class ChatEventStreamManager {
  private api: StreamManagerApi | null = null;
  private unsubscribeReconcile: (() => void) | null = null;

  constructor(
    private tracker: ChatRunTracker,
    private callbacks: StreamManagerCallbacks,
  ) {
    this.unsubscribeReconcile = this.tracker.onReconcile(
      (conversationId) => this.reconcile(conversationId),
    );
  }

  updateCallbacks(next: StreamManagerCallbacks) {
    this.callbacks = next;
  }

  setApi(api: StreamManagerApi | null) {
    this.api = api;
  }

  private reconcile(conversationId: string) {
    if (!this.api) return;
    const entry = this.tracker.getFullEntry(conversationId);

    const needsStream =
      (entry.state === "remote_starting" || entry.state === "remote_running") &&
      !entry.eventStreamController &&
      entry.runId &&
      this.callbacks.isVisibleConversation(conversationId);

    if (needsStream) {
      this.startEventStream(
        conversationId,
        this.api,
        this.tracker.getRuntime(conversationId),
      );
      return;
    }

    if (
      (entry.state === "idle" || entry.state === "completing") &&
      entry.eventStreamController
    ) {
      this.tracker.stopEventStream(conversationId);
      return;
    }

    if (
      entry.eventStreamController &&
      entry.eventStreamRunKey &&
      entry.runId &&
      entry.eventStreamRunKey !== entry.runId
    ) {
      this.tracker.stopEventStream(conversationId);
      this.startEventStream(
        conversationId,
        this.api!,
        this.tracker.getRuntime(conversationId),
      );
    }
  }

  subscribeIfNeeded(conversationId: string, api: StreamManagerApi) {
    const id = conversationId.trim();
    if (!id) return;
    this.api = api;
    if (!this.tracker.canSubscribeEventStream(id)) return;
    if (this.tracker.isLocalRunning(id)) return;
    if (this.tracker.getAbortController(id) !== null) return;
    if (!this.callbacks.isVisibleConversation(id)) return;

    const runtime = this.tracker.getRuntime(id);
    const nextRunKey = resolveRunKey(runtime);
    if (!nextRunKey && !this.tracker.isAwaitingRemote(id)) return;

    const existingRunKey = this.tracker.getEventStreamRunKey(id);
    if (this.tracker.hasActiveStream(id) && existingRunKey === nextRunKey) return;

    if (this.tracker.hasActiveStream(id)) {
      this.tracker.stopEventStream(id);
    }

    this.startEventStream(id, api, runtime);
  }

  stopSubscription(conversationId: string) {
    this.tracker.stopEventStream(conversationId.trim());
  }

  stopAllSubscriptions() {
    this.tracker.stopAllEventStreams();
  }

  clearStreamingState(
    conversationId: string,
    options?: {
      remoteRunId?: string;
      preserveRemoteRun?: boolean;
      preserveRemoteRunOnMismatch?: boolean;
    },
  ) {
    const id = conversationId.trim();
    if (!id) return;

    const store = this.callbacks.getConversationLiveStreamStore(id);
    store?.setToolStatus(null, false, { flush: true });
    this.callbacks.setLiveConversationStreamStatus(id, null);
    this.tracker.clearStreamingState(id, options);
  }

  commitTerminalLiveStream(conversationId: string) {
    this.callbacks.commitTerminalLiveStream(conversationId);
  }

  recoverUnavailableStream(conversationId: string) {
    const id = conversationId.trim();
    if (!id) return;
    this.callbacks.clearConversationLiveStream(id);
    this.clearStreamingState(id);
    this.callbacks.refreshVisibleConversationHistorySnapshot(id, {
      allowIdle: true,
    });
  }

  dispose() {
    this.unsubscribeReconcile?.();
    this.unsubscribeReconcile = null;
    this.stopAllSubscriptions();
  }

  private startEventStream(
    conversationId: string,
    api: StreamManagerApi,
    runtime: RunningConversationRuntime | null,
  ) {
    const controller = new AbortController();
    const runKey = resolveRunKey(runtime);
    this.tracker.setEventStreamController(conversationId, controller, runKey);
    const liveStore = this.callbacks.getConversationLiveStreamStore(conversationId);
    if (!liveStore) {
      this.tracker.clearEventStreamController(conversationId);
      return;
    }

    this.callbacks.refreshVisibleConversationHistorySnapshot(conversationId);
    const streamAfterSeq = resolveRunningConversationStreamAfterSeq(runtime?.firstSeq);

    void (async () => {
      let terminalEventSeen = false;
      let recoverableTransportError = false;
      try {
        for await (const event of api.streamChatEvents(conversationId, {
          runId: runtime?.runId,
          afterSeq: streamAfterSeq,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) return;

          const eventConversationId = event.conversation_id?.trim() || conversationId;
          const liveTitle = readChatEventTitle(event);
          if (liveTitle && isChatEventTitleFinal(event)) {
            this.callbacks.applyLiveConversationTitle(eventConversationId, liveTitle, {
              isFinal: true,
            });
          }

          if (event.type === "runtime_snapshot") {
            const terminalSnapshot = this.callbacks.applyChatRuntimeSnapshotEvent(
              event as ChatRuntimeSnapshotEvent,
              conversationId,
            );
            if (terminalSnapshot) {
              terminalEventSeen = true;
              this.callbacks.commitTerminalLiveStream(conversationId);
              this.handleRefreshHistoryAfterCompletion(conversationId);
              return;
            }
            continue;
          }

          if (event.type === "tool_status") {
            const normalizedStatus = normalizeOptionalStatus(event.status);
            const isCompaction = normalizedStatus !== null && event.isCompaction === true;
            liveStore.setToolStatus(normalizedStatus, isCompaction);
            this.callbacks.setLiveConversationStreamStatus(conversationId, normalizedStatus, isCompaction);
            continue;
          }

          if (this.callbacks.isChatStreamNotAvailableEvent(event)) {
            terminalEventSeen = true;
            this.recoverUnavailableStream(conversationId);
            return;
          }

          const terminalEvent = isTerminalChatEvent(event);
          liveStore.appendEvent(event, { flush: terminalEvent });
          this.callbacks.handleTunnelManagerChatEvent(event);

          if (terminalEvent) {
            terminalEventSeen = true;
            this.tracker.markCompleted(conversationId);
            this.callbacks.commitTerminalLiveStream(conversationId);
            this.handleRefreshHistoryAfterCompletion(conversationId);
            return;
          }

          this.callbacks.markLiveConversationStreamActive(conversationId);
        }
      } catch (error) {
        if (!isAbortError(error)) {
          const message = asErrorMessage(error, "chat event stream failed");
          if (isChatStreamNotAvailableMessage(message)) {
            terminalEventSeen = true;
            this.recoverUnavailableStream(conversationId);
            return;
          }
          if (isRecoverableChatStreamTransportMessage(message)) {
            recoverableTransportError = true;
            liveStore.flush();
            return;
          }
          liveStore.appendEvent(
            { type: "error", message, conversation_id: conversationId } as ChatEvent,
            { flush: true },
          );
          terminalEventSeen = true;
          this.tracker.markCompleted(conversationId);
          this.callbacks.commitTerminalLiveStream(conversationId);
          this.handleRefreshHistoryAfterCompletion(conversationId);
        }
      } finally {
        if (
          this.tracker.getEventStreamController(conversationId) === controller
        ) {
          this.tracker.clearEventStreamController(conversationId);
        }
        if (!terminalEventSeen && controller.signal.aborted) {
          liveStore.flush();
        }
        if (recoverableTransportError && !controller.signal.aborted) {
          liveStore.flush();
          this.clearStreamingState(conversationId, { preserveRemoteRun: true });
          window.setTimeout(() => {
            if (this.tracker.canSubscribeEventStream(conversationId) && !this.tracker.hasActiveStream(conversationId)) {
              this.subscribeIfNeeded(conversationId, api);
            }
          }, 500);
        } else if (!terminalEventSeen && !controller.signal.aborted) {
          liveStore.flush();
          this.clearStreamingState(conversationId);
          this.callbacks.setLiveConversationStreamStatus(conversationId, null);
        }
      }
    })();
  }

  private handleRefreshHistoryAfterCompletion(conversationId: string) {
    if (this.tracker.deletePendingHistoryRefresh(conversationId)) {
      this.callbacks.refreshVisibleConversationHistorySnapshot(conversationId, {
        allowIdle: true,
      });
    }
  }
}

