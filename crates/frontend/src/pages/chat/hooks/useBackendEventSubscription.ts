import { useEffect } from "react";
import { backendFetchGet, subscribeEvents } from "../../../lib/backend/client";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import { type RunEndedResult, resolveRunEnded } from "../runtime/runEndedWaiters";

type UseBackendEventSubscriptionParams = {
  currentConversationId: string;
  getConversationLiveTranscriptStore: (conversationId: string) => LiveTranscriptStore;
  updateToolStatus: (status: string | null, targetStore: LiveTranscriptStore) => void;
  appendDraftAssistantText: (delta: string, targetStore: LiveTranscriptStore) => void;
  settleLiveTranscript: (targetStore: LiveTranscriptStore) => void;
  /** 结算前取快照（会先冲掉 rAF 批处理里还没落库的增量）。 */
  getLiveSnapshot: (targetStore: LiveTranscriptStore) => { draftAssistantText: string };
  onBackendToolApprovalRequest?: (payload: {
    approval_id: string;
    conversation_id: string;
    tool_name: string;
    summary: string;
    recommended?: string;
  }) => void;
};

export function useBackendEventSubscription(params: UseBackendEventSubscriptionParams) {
  const {
    currentConversationId,
    getConversationLiveTranscriptStore,
    updateToolStatus,
    appendDraftAssistantText,
    settleLiveTranscript,
    getLiveSnapshot,
    onBackendToolApprovalRequest,
  } = params;

  useEffect(() => {
    const unsubscribe = subscribeEvents((message) => {
      const { event, payload } = message;

      // 所有事件都应该包含 conversation_id 用于路由（后端使用下划线命名）
      if (!payload || typeof payload !== "object") {
        return;
      }

      const payloadObj = payload as Record<string, unknown>;
      // 后端广播的是 conversation_id，但也支持 conversationId 以兼容两种命名
      const conversationId = (payloadObj.conversation_id ?? payloadObj.conversationId) as
        | string
        | undefined;

      if (!conversationId) {
        console.warn(`Event ${event} missing conversation_id in payload`, payload);
        return;
      }

      const transcriptStore = getConversationLiveTranscriptStore(conversationId);

      // 处理 token 增量事件
      if (event === "token_delta") {
        const delta = payloadObj.delta as string | undefined;
        if (typeof delta === "string") {
          appendDraftAssistantText(delta, transcriptStore);
        }
      }
      // 处理工具状态变化
      else if (event === "tool_status_change") {
        const status = payloadObj.status as string | null | undefined;
        updateToolStatus(status ?? null, transcriptStore);
      }
      // 处理运行终态：先带着结算前的正文快照兑现发送方的 waiter，
      // 再 settle 清空 live 状态——顺序反了正文就丢了。
      else if (event === "run_ended") {
        const rawState = payloadObj.state;
        const state: RunEndedResult["state"] =
          rawState === "failed" || rawState === "cancelled" ? rawState : "completed";
        const errorMessage =
          typeof payloadObj.errorMessage === "string" && payloadObj.errorMessage
            ? payloadObj.errorMessage
            : null;
        resolveRunEnded(conversationId, {
          state,
          errorMessage,
          draftAssistantText: getLiveSnapshot(transcriptStore).draftAssistantText,
        });
        settleLiveTranscript(transcriptStore);
      }
      // 处理后端工具审批请求：将其转发给前端本地审批系统处理
      else if (event === "tool-approval:request") {
        if (onBackendToolApprovalRequest) {
          onBackendToolApprovalRequest({
            approval_id: payloadObj.approval_id as string,
            conversation_id: conversationId,
            tool_name: payloadObj.tool_name as string,
            summary: payloadObj.summary as string,
            recommended: payloadObj.recommended as string | undefined,
          });
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [
    getConversationLiveTranscriptStore,
    updateToolStatus,
    appendDraftAssistantText,
    settleLiveTranscript,
    getLiveSnapshot,
    onBackendToolApprovalRequest,
  ]);

  // 页面加载/WS 重连时拉快照恢复
  useEffect(() => {
    if (!currentConversationId) return;

    (async () => {
      try {
        const snapshot = await backendFetchGet<unknown>("conversation_live", {
          conversationId: currentConversationId,
        });
        // 快照已在 backendFetchGet 调用点记录，这里仅作为恢复点
        console.debug("Conversation live snapshot fetched", snapshot);
      } catch (error) {
        console.warn("Failed to fetch conversation live snapshot", error);
      }
    })();
  }, [currentConversationId]);
}
