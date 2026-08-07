import type { ToolCall, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { useEffect } from "react";
import { backendFetchGet, subscribeEvents } from "../../../lib/backend/client";
import { markCompactionCheckpoint } from "../../../lib/chat/compaction/checkpoints";
import type { CompactionStatus } from "../../../lib/chat/compaction/types";
import type { LiveRoundSnapshot } from "../../../lib/chat/conversation/chatAbort";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { HostedSearchBlock } from "../../../lib/chat/messages/hostedSearch";
import {
  appendTextDeltaToRound,
  appendThinkingDeltaToRound,
  attachToolResultToRound,
  collapseThinking,
  type LiveRound,
  markToolCallRunningInRound,
  updateEnsuredLiveRound,
  upsertHostedSearchToRound,
  upsertToolCallToRound,
} from "../../../lib/chat/messages/uiMessages";
import { type RunEndedResult, resolveRunEnded } from "../runtime/runEndedWaiters";
import type { WireToolStatus } from "../runtime/toolStatusText";

/**
 * 这个订阅认领的会话事件。名字与 core 的 WireEvent["type"] 一一对应
 * （crates/core/src/protocol/wireEvents.ts）；新增会话事件要同时加到这里，
 * 否则会被当成别人的事件静默丢掉。
 */
const CHAT_EVENTS = new Set([
  "token_delta",
  "thinking_delta",
  "round_meta",
  "tool_call",
  "tool_result",
  "hosted_search",
  "tool_status_change",
  "compaction_status",
  "compaction_checkpoint",
  "hook_warning",
  "run_ended",
  "tool-approval:request",
]);

type UseBackendEventSubscriptionParams = {
  currentConversationId: string;
  getConversationLiveTranscriptStore: (conversationId: string) => LiveTranscriptStore;
  updateToolStatus: (status: WireToolStatus | null, targetStore: LiveTranscriptStore) => void;
  /** 压缩阶段状态机。引擎独占压缩，前端只据此渲染（占位文案、失败 toast）。 */
  updateCompactionStatus: (conversationId: string, status: CompactionStatus) => void;
  /** hook 告警。hook 编排在 core 引擎里跑，前端只把告警收进运行时条目做 toast。 */
  updateHookWarning: (
    conversationId: string,
    warning: { hookName: string; hookType: string; event: string; message: string },
  ) => void;
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
    updateCompactionStatus,
    updateHookWarning,
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    settleLiveTranscript,
    getLiveSnapshot,
    onBackendToolApprovalRequest,
  } = params;

  useEffect(() => {
    const unsubscribe = subscribeEvents((message) => {
      const { event, payload } = message;

      // 事件名与载荷结构由 core 的 WireEvent 契约给定
      // （crates/core/src/protocol/wireEvents.ts）：backend 只原样扇出，
      // 中间没有改名层，所以这里的分支名就是 core 发射时写的 type。
      if (!payload || typeof payload !== "object") {
        return;
      }

      const payloadObj = payload as Record<string, unknown>;

      // 后台任务事件（memory_organize_*、cron_prompt_*）不属于任何会话，
      // 由各自的订阅方处理。这里先按名字挑出会话事件，否则它们会掉进下面
      // 「缺 conversation_id」的告警里刷屏。
      if (!CHAT_EVENTS.has(event)) {
        return;
      }

      const conversationId = payloadObj.conversation_id as string | undefined;

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
      // 一轮助手消息落定时的 provider/model/usage，渲染轮次页脚。
      else if (event === "round_meta") {
        if (round !== null) {
          const usage = payloadObj.usage as Usage | undefined;
          batchLiveRoundsUpdate(
            (prev) =>
              updateEnsuredLiveRound(prev, round, (target) => ({
                ...collapseThinking(target),
                meta: {
                  provider: String(payloadObj.provider ?? ""),
                  model: String(payloadObj.model ?? ""),
                  api: String(payloadObj.api ?? ""),
                  stopReason: String(payloadObj.stop_reason ?? ""),
                  usage,
                  usageTotalTokens: usage?.totalTokens,
                },
              })),
            transcriptStore,
          );
        }
      }
      // 工具调用出现/更新：落卡片并标记运行中。流式增量、执行开始、审批标记
      // 补发共用这一个事件，upsert 幂等，重复到达不会叠加。
      else if (event === "tool_call") {
        const toolCall = payloadObj.tool_call as ToolCall | undefined;
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
      // 工具结果：贴回对应卡片。core 一并带上 tool_call，不必从轮次里反查。
      else if (event === "tool_result") {
        const toolResult = payloadObj.tool_result as ToolResultMessage | undefined;
        const toolCall = payloadObj.tool_call as ToolCall | undefined;
        if (toolResult && typeof toolResult.toolCallId === "string" && round !== null) {
          batchLiveRoundsUpdate(
            (prev) =>
              updateEnsuredLiveRound(prev, round, (target) => {
                const resolvedToolCall: ToolCall = toolCall ?? {
                  type: "toolCall",
                  id: toolResult.toolCallId,
                  name: toolResult.toolName,
                  arguments: {},
                };
                const next = attachToolResultToRound(target, resolvedToolCall, toolResult);
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
      // provider 原生托管搜索块的增量更新。
      else if (event === "hosted_search") {
        const hostedSearch = payloadObj.hosted_search as HostedSearchBlock | undefined;
        if (hostedSearch && typeof hostedSearch.id === "string" && round !== null) {
          batchLiveRoundsUpdate(
            (prev) =>
              updateEnsuredLiveRound(prev, round, (target) =>
                upsertHostedSearchToRound(collapseThinking(target), hostedSearch),
              ),
            transcriptStore,
          );
        }
      }
      // 工具状态：core 只发事实（tagged union），中文文案在渲染层生成。
      else if (event === "tool_status_change") {
        const status = payloadObj.status as WireToolStatus | null | undefined;
        updateToolStatus(status ?? null, transcriptStore);
      }
      // 压缩阶段状态：压缩本身跑在引擎里，前端只把状态收进会话运行时条目，
      // 由它驱动输入框占位文案与失败 toast。
      else if (event === "compaction_status") {
        const status = payloadObj.status as CompactionStatus | undefined;
        if (status && typeof status.phase === "string") {
          updateCompactionStatus(conversationId, status);
        }
      }
      // 压缩 checkpoint：core 已把折叠后的新 segment 落库，前端缓存的历史
      // 窗口从这一刻起过期——标记后本轮（含后续轮）禁写前端历史，直到
      // reloadConversationFromHistory 重拉权威窗口。摘要内容不在这里消费，
      // 下次加载历史时随窗口一起回来。
      else if (event === "compaction_checkpoint") {
        markCompactionCheckpoint(conversationId);
      }
      // hook 告警：不致命，仅收进运行时条目驱动 toast。
      else if (event === "hook_warning") {
        updateHookWarning(conversationId, {
          hookName: String(payloadObj.hook_name ?? ""),
          hookType: String(payloadObj.hook_type ?? ""),
          event: String(payloadObj.event ?? ""),
          message: String(payloadObj.message ?? ""),
        });
      }
      // 处理运行终态：先带着结算前的正文/轮次快照兑现发送方的 waiter，
      // 再 settle 清空 live 状态——顺序反了内容就丢了。
      else if (event === "run_ended") {
        const rawState = payloadObj.state;
        const state: RunEndedResult["state"] =
          rawState === "failed" || rawState === "cancelled" ? rawState : "completed";
        const errorMessage =
          typeof payloadObj.error_message === "string" && payloadObj.error_message
            ? payloadObj.error_message
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
      // 处理后端工具审批请求：将其转发给前端本地审批系统处理。
      // 唯一由 Rust backend（approval.rs）而非 core 发射的聊天事件。
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
    updateCompactionStatus,
    updateHookWarning,
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
