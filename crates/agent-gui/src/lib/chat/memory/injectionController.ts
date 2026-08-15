// 会话级 memory 注入控制器:持有「首轮冻结进 system prompt 的快照」与「后续轮次
// 挂在 user 消息上的增量块」,是 memory 注入位置的唯一状态持有者。
//
// 判定逻辑全部在纯函数 turnInjection 里,这里只负责状态归属:按会话 key 存取、
// 按消息 id 绑定增量、会话删除时清理、LRU 封顶防止 map 无限增长。
//
// 增量只活在内存里,不落库也不进历史:进程重启/会话恢复后基线随之丢失,下一轮
// 会重新把完整快照放进 system prompt —— 那一轮前缀本来就要重建,不亏。

import {
  type MemoryInjectionBaseline,
  type MemoryTurnUpdateMap,
  planMemoryTurnInjection,
} from "../../memory/prompts/turnInjection";

/** 缓存的会话数量上限,与 runtime 缓存同量级即可。 */
const INJECTION_CONVERSATION_STATE_LIMIT = 32;

type ConversationInjectionState = {
  baseline: MemoryInjectionBaseline;
  /** messageId → 增量块。一旦写入就不再改动,后续轮次原样重放。 */
  updates: Map<string, string>;
  lastTouchedAt: number;
};

const states = new Map<string, ConversationInjectionState>();

function pruneStates() {
  if (states.size <= INJECTION_CONVERSATION_STATE_LIMIT) return;
  const sorted = [...states.entries()].sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);
  for (const [key] of sorted.slice(0, states.size - INJECTION_CONVERSATION_STATE_LIMIT)) {
    states.delete(key);
  }
}

export type MemoryTurnInjectionResult = {
  /** 本轮进 system prompt 的 memory 文本。 */
  systemText: string;
  /** 本轮新挂出的增量块,便于调用方观测;为空表示没有变化。 */
  turnUpdate: string;
};

export const memoryTurnInjection = {
  /**
   * 请求边界调用一次:决定这轮 memory 走 system 段还是走 user 消息增量。
   * overview 传 null 表示读取失败,此时保持基线不动。
   */
  planTurn(params: {
    conversationId: string;
    messageId?: string;
    overview: string | null;
  }): MemoryTurnInjectionResult {
    const key = params.conversationId.trim();
    if (!key) {
      // 没有会话 key 就没法维持基线,退回旧行为:整块进 system prompt。
      return { systemText: params.overview ?? "", turnUpdate: "" };
    }

    const existing = states.get(key);
    const plan = planMemoryTurnInjection({
      baseline: existing?.baseline ?? null,
      overview: params.overview,
    });
    if (!plan.baseline) {
      return { systemText: plan.systemText, turnUpdate: "" };
    }

    const messageId = params.messageId?.trim() ?? "";
    if (plan.turnUpdate && !messageId) {
      // 没有可挂载的消息 id:丢掉这次增量,同时不推进指纹,留给下一轮补上。
      return { systemText: plan.systemText, turnUpdate: "" };
    }

    const state = existing ?? {
      baseline: plan.baseline,
      updates: new Map<string, string>(),
      lastTouchedAt: 0,
    };
    state.baseline = plan.baseline;
    state.lastTouchedAt = Date.now();
    if (plan.turnUpdate) {
      state.updates.set(messageId, plan.turnUpdate);
    }
    if (!existing) {
      states.set(key, state);
      pruneStates();
    }

    return { systemText: plan.systemText, turnUpdate: plan.turnUpdate };
  },

  /** 组装请求上下文时读取:messageId → 增量块。 */
  getMessageUpdates(conversationId: string): MemoryTurnUpdateMap | undefined {
    return states.get(conversationId.trim())?.updates;
  },

  /**
   * 读取已冻结的 system 段快照。手动压缩这类旁路会自己重新读一份 overview,直接
   * 用那份新读的会让 system 段在「压缩轮 → 下一轮发送」之间来回翻,凭空多废一次
   * 前缀。返回 undefined 表示这个会话还没有基线,调用方自行兜底。
   */
  getSystemText(conversationId: string): string | undefined {
    return states.get(conversationId.trim())?.baseline.systemText;
  },

  /** 会话删除/被裁掉:连基线一起丢弃。 */
  dispose(conversationId: string) {
    states.delete(conversationId.trim());
  },

  /** 应用退出。 */
  disposeAll() {
    states.clear();
  },
};
