import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { useEffect } from "react";
import { backendFetchGet, subscribeEvents } from "../../../lib/backend/client";
import type { LiveRoundSnapshot } from "../../../lib/chat/conversation/chatAbort";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import {
  appendTextDeltaToRound,
  appendThinkingDeltaToRound,
  attachToolResultToRound,
  type LiveRound,
  markToolCallRunningInRound,
  updateEnsuredLiveRound,
  upsertToolCallToRound,
} from "../../../lib/chat/messages/uiMessages";
import { type RunEndedResult, resolveRunEnded } from "../runtime/runEndedWaiters";

type UseBackendEventSubscriptionParams = {
  currentConversationId: string;
  getConversationLiveTranscriptStore: (conversationId: string) => LiveTranscriptStore;
  updateToolStatus: (status: string | null, targetStore: LiveTranscriptStore) => void;
  appendDraftAssistantText: (delta: string, targetStore: LiveTranscriptStore) => void;
  batchLiveRoundsUpdate: (
    updater: (prev: LiveRound[]) => LiveRound[],
    targetStore: LiveTranscriptStore,
  ) => void;
  settleLiveTranscript: (targetStore: LiveTranscriptStore) => void;
  /** 结算前取快照（会先冲掉 rAF 批处理里还没落库的增量）。 */
  getLiveSnapshot: (targetStore: LiveTranscriptStore) => {
    draftAssistantText: string;
    liveRounds: LiveRoundSnapshot[];
  };
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
    batchLiveRoundsUpdate,
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
      const round = typeof payloadObj.round === "number" ? payloadObj.round : null;

      // 处理 token 增量事件：草稿正文（落史回退源）与 liveRounds 双写；
      // 渲染只认 liveRounds（有轮次时草稿不上屏），不会重复显示。
      if (event === "token_delta") {
        const delta = payloadObj.delta as string | undefined;
        if (typeof delta === "string" && delta) {
          appendDraftAssistantText(delta, transcriptStore);
          if (round !== null) {
            batchLiveRoundsUpdate(
              (prev) =>
                updateEnsuredLiveRound(prev, round, (target) => ({
                  ...appendTextDeltaToRound(target, delta),
                  thinkingOpen: false,
                })),
              transcriptStore,
            );
          }
        }
      }
      // 思考增量：只进 liveRounds，不进草稿正文（契约 §2.1）。
      else if (event === "thinking_delta") {
        const delta = payloadObj.delta as string | undefined;
        if (typeof delta === "string" && delta && round !== null) {
          batchLiveRoundsUpdate(
            (prev) =>
              updateEnsuredLiveRound(prev, round, (target) => ({
                ...appendThinkingDeltaToRound(target, delta),
                thinkingOpen: true,
              })),
            transcriptStore,
          );
        }
      }
      // 工具调用开始：落卡片并标记运行中。
      else if (event === "tool_call") {
        const toolCall = payloadObj.toolCall as ToolCall | undefined;
        if (toolCall && typeof toolCall.id === "string" && round !== null) {
          batchLiveRoundsUpdate(
            (prev) =>
              updateEnsuredLiveRound(prev, round, (target) =>
                markToolCallRunningInRound(
                  { ...upsertToolCallToRound(target, toolCall), thinkingOpen: false },
                  toolCall,
                ),
              ),
            transcriptStore,
          );
        }
      }
      // 工具结果：贴回对应卡片（后端已按 id 定位到实际轮次）。
      else if (event === "tool_result") {
        const toolResult = payloadObj.toolResult as ToolResultMessage | undefined;
        if (toolResult && typeof toolResult.toolCallId === "string" && round !== null) {
          batchLiveRoundsUpdate(
            (prev) =>
              updateEnsuredLiveRound(prev, round, (target) => {
                const existing = target.blocks.find(
                  (block) =>
                    block.kind === "tool" && block.item.toolCall.id === toolResult.toolCallId,
                );
                const toolCall: ToolCall =
                  existing?.kind === "tool"
                    ? existing.item.toolCall
                    : ({
                        type: "toolCall",
                        id: toolResult.toolCallId,
                        name: toolResult.toolName,
                        arguments: {},
                      } as ToolCall);
                const next = attachToolResultToRound(target, toolCall, toolResult);
                return {
                  ...next,
                  runningToolCallIds: next.runningToolCallIds.filter(
                    (id) => id !== toolResult.toolCallId,
                  ),
                };
              }),
            transcriptStore,
          );
        }
      }
      // 处理工具状态变化
      else if (event === "tool_status_change") {
        const status = payloadObj.status as string | null | undefined;
        updateToolStatus(status ?? null, transcriptStore);
      }
      // 处理运行终态：先带着结算前的正文/轮次快照兑现发送方的 waiter，
      // 再 settle 清空 live 状态——顺序反了内容就丢了。
      else if (event === "run_ended") {
        const rawState = payloadObj.state;
        const state: RunEndedResult["state"] =
          rawState === "failed" || rawState === "cancelled" ? rawState : "completed";
        const errorMessage =
          typeof payloadObj.errorMessage === "string" && payloadObj.errorMessage
            ? payloadObj.errorMessage
            : null;
        const snapshot = getLiveSnapshot(transcriptStore);
        resolveRunEnded(conversationId, {
          state,
          errorMessage,
          draftAssistantText: snapshot.draftAssistantText,
          liveRounds: snapshot.liveRounds,
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
    batchLiveRoundsUpdate,
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
