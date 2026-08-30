import { buildHistoryMessageRefPayload } from "@liveagent/ui/lib/chat/historyMessageRef";
import {
  type ConversationMentionReference,
  normalizeConversationMentionReferences,
} from "@liveagent/ui/lib/chat/mentionReferences";
import type { ConversationViewState, HistoryMessageRef } from "../conversationState";
import type { RetryAttemptRecord } from "../liveTranscriptStore";

type QueueEventOptions = {
  allowAfterClose?: boolean;
};

type QueueUserMessageOptions = {
  // Stable id of the newly-created user message. It is persisted in the
  // normal history JSON and lets remote viewers join the live run without
  // guessing its history twin from prompt/reply text.
  messageId?: string;
  // Edit-resend: the edited (truncation-base) user message. The gateway
  // broadcasts a `rebased` event from it so every other connected client
  // truncates its transcript at the same point.
  baseMessageRef?: HistoryMessageRef;
  // The new user message's own stable identity (minted at persist time).
  // Carried on every user_message so remote transcripts can bind the turn's
  // messageRef immediately — a later edit-resend of THIS message anchors its
  // rebase without waiting for a history refresh.
  messageRef?: HistoryMessageRef;
  // Structured references authorized by this user turn. Remote WebUI viewers
  // need the same metadata immediately instead of waiting for history enrich.
  referencedConversations?: readonly ConversationMentionReference[];
};

type GatewayBridgeSendResult = Promise<void> | void;

export type ManualCompactionTerminalStatus = "compacted" | "failed" | "busy" | "skipped";

type GatewayBridgeEventControllerParams = {
  conversationId: string;
  requestId: string;
  workerId?: string;
  enabled: boolean;
  sendEvent: (
    requestId: string,
    event: Record<string, unknown>,
    options?: { workerId?: string },
  ) => GatewayBridgeSendResult;
  flushEvents?: (requestId: string) => Promise<void>;
  resolveErrorConversationId?: () => string;
};

export type GatewayBridgeEventController = {
  queueEvent: (
    event: Record<string, unknown>,
    options?: QueueEventOptions,
  ) => GatewayBridgeSendResult;
  queueUserMessage: (
    message: string,
    uploadedFiles?: readonly unknown[],
    options?: QueueUserMessageOptions,
  ) => GatewayBridgeSendResult;
  queueToken: (delta: string, extra?: Record<string, unknown>) => void;
  queueTitle: (nextTitle: string, allowAfterClose?: boolean) => void;
  queueToolStatus: (status: string | null, isCompaction?: boolean) => void;
  queueRetryAttempts: (attempts: readonly RetryAttemptRecord[]) => void;
  queueCheckpoint: (state: ConversationViewState, contextUsageTokens?: number) => void;
  queueManualCompactionResult: (
    operationId: string,
    status: ManualCompactionTerminalStatus,
    message?: string,
  ) => void;
  emitError: (message: string, conversationIdOverride?: string) => void;
  close: () => Promise<void>;
  hasForwardedText: () => boolean;
  isClosed: () => boolean;
};

export function createGatewayBridgeEventController(
  params: GatewayBridgeEventControllerParams,
): GatewayBridgeEventController {
  let forwardedText = false;
  let streamClosed = false;
  let closePromise: Promise<void> | null = null;
  let lastToolStatusKey = "";
  let lastToolStatus: string | null = null;
  let lastToolStatusIsCompaction = false;
  let lastRetryAttemptsKey = "[]";

  const queueEvent = (event: Record<string, unknown>, options?: QueueEventOptions) => {
    if (!params.enabled) return;
    if (streamClosed && !options?.allowAfterClose) return;
    return params.sendEvent(params.requestId, event, { workerId: params.workerId });
  };

  const queueToolStatus = (status: string | null, isCompaction = false) => {
    const normalizedStatus = status?.trim() ?? "";
    const statusKey = `${normalizedStatus}::${isCompaction ? "1" : "0"}`;
    if (statusKey === lastToolStatusKey) return;
    lastToolStatusKey = statusKey;
    lastToolStatus = normalizedStatus || null;
    lastToolStatusIsCompaction = isCompaction;
    queueEvent({
      type: "tool_status",
      status: normalizedStatus || null,
      isCompaction,
      conversation_id: params.conversationId,
    });
  };

  // Rides on the tool_status wire event (re-sending the current status text)
  // so the WebUI can mirror the desktop's expandable retry-details block
  // without a new event type. Events without a retryAttempts array leave the
  // WebUI's list untouched; an explicit empty array clears it.
  const queueRetryAttempts = (attempts: readonly RetryAttemptRecord[]) => {
    const payload = attempts.map((entry) => ({
      attempt: entry.attempt,
      maxAttempts: entry.maxAttempts,
      errorMessage: entry.errorMessage,
    }));
    const attemptsKey = JSON.stringify(payload);
    if (attemptsKey === lastRetryAttemptsKey) return;
    lastRetryAttemptsKey = attemptsKey;
    queueEvent({
      type: "tool_status",
      status: lastToolStatus,
      isCompaction: lastToolStatusIsCompaction,
      retryAttempts: payload,
      conversation_id: params.conversationId,
    });
  };

  return {
    queueEvent,
    queueUserMessage(message: string, uploadedFiles = [], options?: QueueUserMessageOptions) {
      if (!message.trim() && uploadedFiles.length === 0) return;
      const referencedConversations = normalizeConversationMentionReferences(
        options?.referencedConversations,
        params.conversationId,
      );
      return queueEvent({
        type: "user_message",
        message,
        ...(options?.messageId?.trim() ? { message_id: options.messageId.trim() } : {}),
        uploaded_files: uploadedFiles.map((file) =>
          file && typeof file === "object" ? { ...(file as Record<string, unknown>) } : file,
        ),
        conversation_id: params.conversationId,
        ...(referencedConversations.length > 0
          ? {
              referenced_conversations: referencedConversations.map((reference) => ({
                id: reference.id,
                title: reference.title,
                ...(reference.cwd ? { cwd: reference.cwd } : {}),
                ...(reference.updatedAt === undefined ? {} : { updated_at: reference.updatedAt }),
              })),
            }
          : {}),
        ...(options?.messageRef
          ? { message_ref: buildHistoryMessageRefPayload(options.messageRef) }
          : {}),
        ...(options?.baseMessageRef
          ? {
              base_message_ref: buildHistoryMessageRefPayload(options.baseMessageRef),
              reason: "edit_resend",
            }
          : {}),
      });
    },
    queueToken(delta: string, extra?: Record<string, unknown>) {
      if (delta.length === 0 && !extra) return;
      if (delta.length > 0) {
        forwardedText = true;
      }
      queueEvent({
        type: "token",
        text: delta,
        conversation_id: params.conversationId,
        ...extra,
      });
    },
    queueTitle(nextTitle: string, allowAfterClose = false) {
      const title = nextTitle.trim();
      if (!title) return;
      queueEvent(
        {
          type: "token",
          text: "",
          title,
          titleFinal: allowAfterClose === true,
          conversation_id: params.conversationId,
        },
        { allowAfterClose },
      );
    },
    queueToolStatus,
    queueRetryAttempts,
    queueCheckpoint(state: ConversationViewState, contextUsageTokens?: number) {
      const activeSegment = state.segments[state.activeSegmentIndex];
      const summary = activeSegment?.summary;
      if (!summary?.content.trim()) return;

      queueEvent({
        type: "token",
        text: summary.content,
        provider: "liveagent",
        model: "summary",
        api: "liveagent-compaction",
        conversation_id: params.conversationId,
        checkpoint: {
          summaryId: summary.id,
          segmentIndex: activeSegment.segmentIndex,
          coveredMessageCount: summary.summaryMeta.coveredMessageCount,
          coversThroughMessageId: summary.summaryMeta.coversThroughMessageId,
          timestamp: summary.timestamp,
          generatedBy: {
            providerId: summary.summaryMeta.generatedBy.providerId,
            model: summary.summaryMeta.generatedBy.model,
            promptVersion: summary.summaryMeta.generatedBy.promptVersion,
          },
          ...(typeof contextUsageTokens === "number" && contextUsageTokens > 0
            ? { contextUsageTokens: Math.floor(contextUsageTokens) }
            : {}),
        },
      });
    },
    queueManualCompactionResult(operationId, status, message) {
      // 终态结果事件经可靠 ingress 送达；queueEvent 可能返回投递 Promise，
      // 丢弃它会让 ingress 失败无人捕获。对 Promise 显式 catch，同步返回值
      // （enabled=false 或同步 sink）自然跳过。
      const sendResult = queueEvent({
        type: "manual_compaction_result",
        operationId: operationId.trim(),
        status,
        ...(message?.trim() ? { message: message.trim() } : {}),
        conversation_id: params.conversationId,
      });
      if (sendResult && typeof (sendResult as Promise<void>).then === "function") {
        (sendResult as Promise<void>).catch((error) => {
          console.warn("manual compaction result event failed", error);
        });
      }
    },
    emitError(message: string, conversationIdOverride?: string) {
      queueEvent({
        type: "error",
        message,
        conversation_id:
          conversationIdOverride ?? params.resolveErrorConversationId?.() ?? params.conversationId,
      });
    },
    close() {
      streamClosed = true;
      closePromise ??= params.flushEvents?.(params.requestId) ?? Promise.resolve();
      return closePromise;
    },
    hasForwardedText() {
      return forwardedText;
    },
    isClosed() {
      return streamClosed;
    },
  };
}
