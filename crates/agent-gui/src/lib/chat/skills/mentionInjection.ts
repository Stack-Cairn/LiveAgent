// 会话级 skills 显式提及注入控制器:持有「哪条 user 消息该挂哪段显式提及块」。
//
// 为什么要有这层状态:显式提及块必须在后续轮次原样重放。若只在发生的那一轮挂、
// 下一轮撤掉,那条 user 消息的字节就变了,历史区间从它开始整段作废 —— 这正是把
// 内容留在 system prompt 里要躲的问题,换个位置再犯一遍没有意义。
//
// 与 memory 的 injectionController 是同一套形状(按会话 key 存取、按消息 id 绑定、
// 会话删除时清理、LRU 封顶),但刻意分开存:memory 的基线带 systemText 语义,
// 手动压缩会读它来复用冻结快照,把 skills 的块塞进那份状态会让基线凭空出现。
//
// 块只活在内存里,不落库也不进历史:它是发给模型的上下文,不是用户真的打了这些字。
// 进程重启/会话恢复后随之丢失,后续轮次不再重放 —— 那时前缀本来就要重建,不亏。

/** 缓存的会话数量上限,与 memory 注入控制器保持同量级。 */
const SKILL_MENTION_CONVERSATION_STATE_LIMIT = 32;

export type SkillMentionUpdateMap = ReadonlyMap<string, string>;

type ConversationSkillMentionState = {
  /** messageId → 显式提及块。一旦写入就不再改动,后续轮次原样重放。 */
  updates: Map<string, string>;
  lastTouchedAt: number;
};

const states = new Map<string, ConversationSkillMentionState>();

function pruneStates() {
  if (states.size <= SKILL_MENTION_CONVERSATION_STATE_LIMIT) return;
  const sorted = [...states.entries()].sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);
  for (const [key] of sorted.slice(0, states.size - SKILL_MENTION_CONVERSATION_STATE_LIMIT)) {
    states.delete(key);
  }
}

export const skillMentionInjection = {
  /**
   * 记录本轮的显式提及块。block 为空串表示这轮没有 `/skill-name` 提及 —— 此时
   * 什么都不做,连状态都不创建,保证「没有提及就不产生任何额外内容」。
   */
  record(params: { conversationId: string; messageId?: string; block: string }) {
    const block = params.block;
    if (!block) return;

    const key = params.conversationId.trim();
    const messageId = params.messageId?.trim() ?? "";
    // 没有会话 key 或没有可挂载的消息 id 就丢掉这次提及:宁可少挂一次,也不能
    // 挂到对不上的消息上。
    if (!key || !messageId) return;

    const existing = states.get(key);
    const state = existing ?? { updates: new Map<string, string>(), lastTouchedAt: 0 };
    state.updates.set(messageId, block);
    state.lastTouchedAt = Date.now();
    if (!existing) {
      states.set(key, state);
      pruneStates();
    }
  },

  /** 组装请求上下文时读取:messageId → 显式提及块。 */
  getMessageUpdates(conversationId: string): SkillMentionUpdateMap | undefined {
    return states.get(conversationId.trim())?.updates;
  },

  /** 会话删除/被裁掉:连同已记录的块一起丢弃。 */
  dispose(conversationId: string) {
    states.delete(conversationId.trim());
  },

  /** 应用退出。 */
  disposeAll() {
    states.clear();
  },
};
