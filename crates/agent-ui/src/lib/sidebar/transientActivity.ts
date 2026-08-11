import { workspaceProjectPathKey } from "@liveagent/app/lib/settings";

export type TransientSidebarRunningConversation = {
  conversationId: string;
  workdir?: string | null;
};

export function mergeTransientSidebarRunningActivity(
  runningConversationIds: ReadonlySet<string>,
  runningProjectPathKeys: ReadonlySet<string>,
  transient: TransientSidebarRunningConversation | null | undefined,
): {
  runningConversationIds: ReadonlySet<string>;
  runningProjectPathKeys: ReadonlySet<string>;
} {
  const conversationId = transient?.conversationId.trim() ?? "";
  const projectPathKey = workspaceProjectPathKey(transient?.workdir ?? "");
  let nextConversationIds = runningConversationIds;
  let nextProjectPathKeys = runningProjectPathKeys;
  if (conversationId && !runningConversationIds.has(conversationId)) {
    nextConversationIds = new Set(runningConversationIds).add(conversationId);
  }
  if (projectPathKey && !runningProjectPathKeys.has(projectPathKey)) {
    nextProjectPathKeys = new Set(runningProjectPathKeys).add(projectPathKey);
  }
  return {
    runningConversationIds: nextConversationIds,
    runningProjectPathKeys: nextProjectPathKeys,
  };
}
