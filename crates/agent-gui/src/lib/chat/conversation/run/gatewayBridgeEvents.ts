import type { ConversationViewState } from "../conversationState";

type QueueEventOptions = {
  allowAfterClose?: boolean;
};

type GatewayBridgeEventControllerParams = {
  conversationId: string;
  requestId: string;
  workerId?: string;
  enabled: boolean;
  sendEvent: (
    requestId: string,
    event: Record<string, unknown>,
    options?: { workerId?: string },
  ) => void;
  resolveErrorConversationId?: () => string;
};

export type GatewayBridgeEventController = {
  queueEvent: (event: Record<string, unknown>, options?: QueueEventOptions) => void;
  queueToken: (delta: string, extra?: Record<string, unknown>) => void;
  queueTitle: (nextTitle: string, allowAfterClose?: boolean) => void;
  queueToolStatus: (status: string | null, isCompaction?: boolean) => void;
  queueCheckpoint: (state: ConversationViewState) => void;
  emitError: (message: string, conversationIdOverride?: string) => void;
  close: () => void;
  hasForwardedText: () => boolean;
  isClosed: () => boolean;
};

export function createGatewayBridgeEventController(
  params: GatewayBridgeEventControllerParams,
): GatewayBridgeEventController {
  let forwardedText = false;
  let streamClosed = false;
  let lastToolStatusKey = "";

  const queueEvent = (event: Record<string, unknown>, options?: QueueEventOptions) => {
    if (!params.enabled) return;
    if (streamClosed && !options?.allowAfterClose) return;
    params.sendEvent(params.requestId, event, { workerId: params.workerId });
  };

  const queueToolStatus = (status: string | null, isCompaction = false) => {
    const normalizedStatus = status?.trim() ?? "";
    const statusKey = `${normalizedStatus}::${isCompaction ? "1" : "0"}`;
    if (statusKey === lastToolStatusKey) return;
    lastToolStatusKey = statusKey;
    queueEvent({
      type: "tool_status",
      status: normalizedStatus || null,
      isCompaction,
      conversation_id: params.conversationId,
    });
  };

  return {
    queueEvent,
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
    queueCheckpoint(state: ConversationViewState) {
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
          segmentIndex: state.activeSegmentIndex,
          coveredMessageCount: summary.summaryMeta.coveredMessageCount,
          coversThroughMessageId: summary.summaryMeta.coversThroughMessageId,
          timestamp: summary.timestamp,
          generatedBy: {
            providerId: summary.summaryMeta.generatedBy.providerId,
            model: summary.summaryMeta.generatedBy.model,
            promptVersion: summary.summaryMeta.generatedBy.promptVersion,
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
    },
    hasForwardedText() {
      return forwardedText;
    },
    isClosed() {
      return streamClosed;
    },
  };
}
