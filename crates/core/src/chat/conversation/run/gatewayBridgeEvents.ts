import type {
  ToolStatus,
  WireEvent,
  WireMessageRef,
  WireRetryAttempt,
} from "../../../protocol/wireEvents";
import { toolStatusKey } from "../../../protocol/wireEvents";
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
};

/** 一轮助手消息落定时的元信息,与 wire 的 round_meta 同构。 */
export type RoundMeta = {
  provider?: string;
  model?: string;
  api?: string;
  stopReason?: string;
  usage?: unknown;
};

function buildWireMessageRef(ref: HistoryMessageRef): WireMessageRef {
  return {
    segment_index: ref.segmentIndex,
    message_index: ref.messageIndex,
    segment_id: ref.segmentId,
    message_id: ref.messageId,
    role: ref.role,
    content_hash: ref.contentHash,
  };
}

type GatewayBridgeSendResult = Promise<void> | void;

type GatewayBridgeEventControllerParams = {
  conversationId: string;
  requestId: string;
  workerId?: string;
  enabled: boolean;
  sendEvent: (
    requestId: string,
    event: WireEvent,
    options?: { workerId?: string },
  ) => GatewayBridgeSendResult;
  flushEvents?: (requestId: string) => Promise<void>;
  resolveErrorConversationId?: () => string;
};

export type GatewayBridgeEventController = {
  queueEvent: (event: WireEvent, options?: QueueEventOptions) => GatewayBridgeSendResult;
  queueUserMessage: (
    message: string,
    uploadedFiles?: readonly unknown[],
    options?: QueueUserMessageOptions,
  ) => GatewayBridgeSendResult;
  queueToken: (delta: string, round: number) => void;
  queueRoundMeta: (round: number, meta: RoundMeta) => void;
  queueTitle: (nextTitle: string, allowAfterClose?: boolean) => void;
  queueToolStatus: (status: ToolStatus | null, isCompaction?: boolean) => void;
  queueRetryAttempts: (attempts: readonly RetryAttemptRecord[]) => void;
  queueCheckpoint: (state: ConversationViewState) => void;
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
  let lastToolStatus: ToolStatus | null = null;
  let lastToolStatusIsCompaction = false;
  let lastRetryAttemptsKey = "[]";

  const queueEvent = (event: WireEvent, options?: QueueEventOptions) => {
    if (!params.enabled) return;
    if (streamClosed && !options?.allowAfterClose) return;
    return params.sendEvent(params.requestId, event, { workerId: params.workerId });
  };

  const queueToolStatus = (status: ToolStatus | null, isCompaction = false) => {
    const statusKey = `${toolStatusKey(status)}::${isCompaction ? "1" : "0"}`;
    if (statusKey === lastToolStatusKey) return;
    lastToolStatusKey = statusKey;
    lastToolStatus = status;
    lastToolStatusIsCompaction = isCompaction;
    queueEvent({
      type: "tool_status_change",
      status,
      is_compaction: isCompaction,
      conversation_id: params.conversationId,
    });
  };

  // Rides on the tool_status_change wire event (re-sending the current status)
  // so remote viewers can mirror the desktop's expandable retry-details block
  // without a new event type. Events without a retry_attempts array leave the
  // consumer's list untouched; an explicit empty array clears it.
  const queueRetryAttempts = (attempts: readonly RetryAttemptRecord[]) => {
    const payload: WireRetryAttempt[] = attempts.map((entry) => ({
      attempt: entry.attempt,
      max_attempts: entry.maxAttempts,
      error_message: entry.errorMessage,
    }));
    const attemptsKey = JSON.stringify(payload);
    if (attemptsKey === lastRetryAttemptsKey) return;
    lastRetryAttemptsKey = attemptsKey;
    queueEvent({
      type: "tool_status_change",
      status: lastToolStatus,
      is_compaction: lastToolStatusIsCompaction,
      retry_attempts: payload,
      conversation_id: params.conversationId,
    });
  };

  return {
    queueEvent,
    queueUserMessage(message: string, uploadedFiles = [], options?: QueueUserMessageOptions) {
      if (!message.trim() && uploadedFiles.length === 0) return;
      return queueEvent({
        type: "user_message",
        message,
        ...(options?.messageId?.trim() ? { message_id: options.messageId.trim() } : {}),
        uploaded_files: uploadedFiles.map((file) =>
          file && typeof file === "object" ? { ...(file as Record<string, unknown>) } : file,
        ),
        conversation_id: params.conversationId,
        ...(options?.messageRef ? { message_ref: buildWireMessageRef(options.messageRef) } : {}),
        ...(options?.baseMessageRef
          ? {
              base_message_ref: buildWireMessageRef(options.baseMessageRef),
              reason: "edit_resend" as const,
            }
          : {}),
      });
    },
    queueToken(delta: string, round: number) {
      if (delta.length === 0) return;
      forwardedText = true;
      queueEvent({
        type: "token_delta",
        round,
        delta,
        conversation_id: params.conversationId,
      });
    },
    queueRoundMeta(round: number, meta: RoundMeta) {
      queueEvent({
        type: "round_meta",
        round,
        provider: meta.provider,
        model: meta.model,
        api: meta.api,
        stop_reason: meta.stopReason,
        usage: meta.usage,
        conversation_id: params.conversationId,
      });
    },
    queueTitle(nextTitle: string, allowAfterClose = false) {
      const title = nextTitle.trim();
      if (!title) return;
      queueEvent(
        {
          type: "conversation_title",
          title,
          final: allowAfterClose === true,
          conversation_id: params.conversationId,
        },
        { allowAfterClose },
      );
    },
    queueToolStatus,
    queueRetryAttempts,
    queueCheckpoint(state: ConversationViewState) {
      const activeSegment = state.segments[state.activeSegmentIndex];
      const summary = activeSegment?.summary;
      if (!summary?.content.trim()) return;

      queueEvent({
        type: "compaction_checkpoint",
        summary_text: summary.content,
        conversation_id: params.conversationId,
        checkpoint: {
          summary_id: summary.id,
          segment_index: activeSegment.segmentIndex,
          covered_message_count: summary.summaryMeta.coveredMessageCount,
          covers_through_message_id: summary.summaryMeta.coversThroughMessageId,
          timestamp: summary.timestamp,
          generated_by: {
            provider_id: summary.summaryMeta.generatedBy.providerId,
            model: summary.summaryMeta.generatedBy.model,
            prompt_version: summary.summaryMeta.generatedBy.promptVersion,
          },
        },
      });
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
