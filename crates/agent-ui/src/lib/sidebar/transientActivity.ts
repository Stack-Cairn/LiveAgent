import { workspaceProjectPathKey } from "@liveagent/app/lib/settings";

export type TransientSidebarRunningConversation = {
  conversationId: string;
  workdir?: string | null;
};

export function mergeTransientSidebarRunningActivity(
  runningConversationIds: ReadonlySet<string>,
  runningProjectPathKeys: ReadonlySet<string>,
  transients:
    | readonly (TransientSidebarRunningConversation | null | undefined)[]
    | TransientSidebarRunningConversation
    | null
    | undefined,
): {
  runningConversationIds: ReadonlySet<string>;
  runningProjectPathKeys: ReadonlySet<string>;
} {
  // 支持多个同时“转圈”的瞬态会话（issue #359 缺陷 #3）：手动压缩 pending 已按
  // 会话 id 键化，多个后台会话可同时压缩。既接受数组，也向后兼容单对象入参。
  const list = Array.isArray(transients)
    ? transients
    : transients
      ? [transients as TransientSidebarRunningConversation]
      : [];
  let nextConversationIds = runningConversationIds;
  let nextProjectPathKeys = runningProjectPathKeys;
  for (const transient of list) {
    const conversationId = transient?.conversationId.trim() ?? "";
    const projectPathKey = workspaceProjectPathKey(transient?.workdir ?? "");
    if (conversationId && !nextConversationIds.has(conversationId)) {
      nextConversationIds = new Set(nextConversationIds).add(conversationId);
    }
    if (projectPathKey && !nextProjectPathKeys.has(projectPathKey)) {
      nextProjectPathKeys = new Set(nextProjectPathKeys).add(projectPathKey);
    }
  }
  return {
    runningConversationIds: nextConversationIds,
    runningProjectPathKeys: nextProjectPathKeys,
  };
}
