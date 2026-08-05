import { useEffect } from "react";
import { backendFetchGet, subscribeEvents } from "../../../lib/backend/client";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";

type UseBackendEventSubscriptionParams = {
  currentConversationId: string;
  getConversationLiveTranscriptStore: (conversationId: string) => LiveTranscriptStore;
  updateToolStatus: (status: string | null, targetStore: LiveTranscriptStore) => void;
  appendDraftAssistantText: (delta: string, targetStore: LiveTranscriptStore) => void;
  settleLiveTranscript: (targetStore: LiveTranscriptStore) => void;
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
      // 处理运行终态
      else if (event === "run_ended") {
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
    currentConversationId,
    getConversationLiveTranscriptStore,
    updateToolStatus,
    appendDraftAssistantText,
    settleLiveTranscript,
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
