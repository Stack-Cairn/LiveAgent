// 编辑重发(edit-resend)的引擎侧截断:曾经跑在桌面前端的四步
// (截断历史 → 用截断后 state 算子代理保留集 → invalidate 内存花名册 →
// prune 持久层)整体迁到这里,由 engine 在受理 chat_send 时调用。
//
// 顺序铁律:
// - keep 集必须来自**截断后**的 state,否则被删消息里的子代理也会被保留;
// - invalidate 必须先于 prune,否则内存花名册残留已删 agent。

import type { Message } from "@earendil-works/pi-ai";
import {
  collectRetainedSubagentParentToolCallIds,
  pruneSubagentRunsForConversation,
} from "../../subagents";
import type { WireMessageRef } from "../../protocol/wireEvents";
import {
  buildConversationStateFromWindow,
  CHAT_HISTORY_WINDOW_MESSAGES,
  type ChatHistoryWindowRecord,
  type ConversationPersistenceCursor,
  getChatHistoryWindow,
  replaceChatHistoryFromMessage,
} from "../history/chatHistory";
import type { ConversationViewState, HistoryMessageRef } from "./conversationState";

export function historyMessageRefFromWire(ref: WireMessageRef): HistoryMessageRef {
  return {
    segmentIndex: ref.segment_index,
    messageIndex: ref.message_index,
    segmentId: ref.segment_id,
    messageId: ref.message_id,
    role: ref.role,
    contentHash: ref.content_hash,
  };
}

type EditResendDeps = {
  getWindow: typeof getChatHistoryWindow;
  replaceFromMessage: typeof replaceChatHistoryFromMessage;
  pruneRuns: (input: {
    parentConversationId: string;
    keepParentToolCallIds: string[];
  }) => Promise<unknown>;
};

const defaultDeps: EditResendDeps = {
  getWindow: getChatHistoryWindow,
  replaceFromMessage: replaceChatHistoryFromMessage,
  pruneRuns: (input) => pruneSubagentRunsForConversation(input),
};

export type EditResendResult = {
  state: ConversationViewState;
  cursor: ConversationPersistenceCursor;
  window: ChatHistoryWindowRecord;
};

/**
 * 在会话历史里把 baseMessageRef 指向的用户消息替换为 replacementMessage,
 * 截掉其后的全部内容,并同步清理被截断分支的子代理运行。
 * 抛错即整体失败,历史保持不变(替换在 backend 里是单事务)。
 */
export async function applyEditResendTruncation(params: {
  conversationId: string;
  baseMessageRef: HistoryMessageRef;
  replacementMessage: Message;
  /** 引擎进程级子代理花名册缓存;prune 前必须失效。 */
  invalidateSubagentStore: (conversationId: string) => void;
  deps?: Partial<EditResendDeps>;
}): Promise<EditResendResult> {
  const { conversationId, baseMessageRef, replacementMessage } = params;
  const deps = { ...defaultDeps, ...params.deps };

  // 修订号必须现取:引擎缓存的 session.state 落后于最近一次持久化。
  const window = await deps.getWindow({
    id: conversationId,
    maxMessages: CHAT_HISTORY_WINDOW_MESSAGES,
    includeActiveSegment: true,
  });
  const replaced = await deps.replaceFromMessage({
    id: conversationId,
    baseMessageRef,
    replacementMessage,
    maxMessages: CHAT_HISTORY_WINDOW_MESSAGES,
    expectedRevision: window.revision,
  });
  if (!replaced.activeSegment) throw new Error("历史替换结果缺少活跃分段");

  const state = buildConversationStateFromWindow(replaced);
  const keepParentToolCallIds = collectRetainedSubagentParentToolCallIds(state);
  params.invalidateSubagentStore(conversationId);
  await deps
    .pruneRuns({ parentConversationId: conversationId, keepParentToolCallIds })
    .catch((error) => {
      // 清理失败不中断重发:残留的子代理数据只是垃圾,不影响正确性。
      console.warn(`[engine] edit-resend subagent cleanup failed for ${conversationId}:`, error);
    });

  return {
    state,
    cursor: {
      activeSegmentIndex: replaced.activeSegment.segmentIndex,
      activeSegmentId: replaced.activeSegment.segmentId,
    },
    window: replaced,
  };
}
