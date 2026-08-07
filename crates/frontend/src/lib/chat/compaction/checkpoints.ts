/**
 * compaction_checkpoint 事件的会话级过期标记。
 *
 * core 在 run 中途提交压缩 checkpoint 时会先落库再发事件（crates/core/src/
 * chat/compaction/controller.ts 的 persist → queueCheckpoint 顺序），事件到达
 * 时前端缓存的 ConversationViewState 与持久化游标还停在压缩前的旧窗口。放任
 * 前端按旧窗口落库（initial / terminal persist 都按游标整段覆盖 active
 * segment）会把 core 已折叠的历史复活——与 edit-resend 的
 * suppressFrontendHistoryPersist 防的是同一类事故，只是触发源不同。
 *
 * 语义：标志置位 = 「该会话的前端历史窗口已过期，禁写历史」。清除只发生在
 * 从历史重拉权威窗口并重设持久化游标之后。对齐失败则标志保留、继续禁写——
 * core 每轮终态都自己落库，前端写入本就是冗余副本，跳过没有数据损失。
 */

const staleConversations = new Set<string>();

/** 收到 compaction_checkpoint：该会话的前端历史窗口从此过期。 */
export function markCompactionCheckpoint(conversationId: string): void {
  const key = conversationId.trim();
  if (key) staleConversations.add(key);
}

/** 前端历史落库前的守卫：过期窗口禁写。 */
export function hasPendingCompactionCheckpoint(conversationId: string): boolean {
  return staleConversations.has(conversationId.trim());
}

/** 仅在权威窗口重拉成功（游标已重设）后调用。 */
export function clearCompactionCheckpoint(conversationId: string): void {
  staleConversations.delete(conversationId.trim());
}
