/**
 * run_ended 事件的会话级等待表。
 *
 * v2 里 `chat_send` 是 202 受理即返回，真正的终态从 WS 的 `run_ended` 事件来。
 * 发送方在提交前注册一个 waiter，事件订阅层收到 run_ended 时带着终态和
 * 结算前的正文快照来兑现——发送方由此知道「这轮跑完了、跑出了什么」。
 *
 * 一次 run_ended 兑现该会话的**全部** waiter：pi 的 followUp 排队语义下，
 * agent_settled（即 run_ended 的来源）只在排队消息全部排空后发一次。
 */

import type { LiveRoundSnapshot } from "../../../lib/chat/conversation/chatAbort";

export type RunEndedResult = {
  state: "completed" | "failed" | "cancelled";
  errorMessage: string | null;
  /** run_ended 时刻、settle 清空之前的累计正文。完成态用它落史。 */
  draftAssistantText: string;
  /** 同一时刻的 liveRounds 快照——思考/工具调用链靠它落史，空数组回退纯文本。 */
  liveRounds: LiveRoundSnapshot[];
};

const waiters = new Map<string, Set<(result: RunEndedResult) => void>>();

/**
 * 等待某会话的下一条 run_ended。`signal` 中止时以 cancelled 兑现——
 * WS 断线时终态可能永远不来，用户的停止操作必须能解开这个等待。
 */
export function waitForRunEnded(
  conversationId: string,
  signal?: AbortSignal,
): Promise<RunEndedResult> {
  const key = conversationId.trim();
  return new Promise((resolve) => {
    let handlers = waiters.get(key);
    if (!handlers) {
      handlers = new Set();
      waiters.set(key, handlers);
    }
    const settle = (result: RunEndedResult) => {
      const current = waiters.get(key);
      if (current) {
        current.delete(settle);
        if (current.size === 0) waiters.delete(key);
      }
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      settle({ state: "cancelled", errorMessage: null, draftAssistantText: "", liveRounds: [] });
    };
    handlers.add(settle);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** 兑现该会话的全部 waiter。没有 waiter 时是无害的空操作。 */
export function resolveRunEnded(conversationId: string, result: RunEndedResult): void {
  const handlers = waiters.get(conversationId.trim());
  if (!handlers) return;
  waiters.delete(conversationId.trim());
  for (const handler of handlers) {
    handler(result);
  }
}
