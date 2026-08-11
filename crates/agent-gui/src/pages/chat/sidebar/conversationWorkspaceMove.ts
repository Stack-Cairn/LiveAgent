import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";

type WorkspaceMoveStore = Pick<SidebarStore, "clearMutationError" | "setCwd">;
type ConversationCwdChanged = (conversationId: string, cwd: string) => void;

export async function moveConversationToWorkspace(
  store: WorkspaceMoveStore,
  conversationId: string,
  cwd: string,
  onConversationCwdChanged: ConversationCwdChanged,
) {
  store.clearMutationError(conversationId);
  const moved = await store.setCwd(conversationId, cwd);
  if (moved) {
    onConversationCwdChanged(conversationId, cwd);
  }
  return moved;
}

export async function moveConversationsToWorkspace(
  store: WorkspaceMoveStore,
  conversationIds: readonly string[],
  cwd: string,
  onConversationCwdChanged: ConversationCwdChanged,
) {
  const results = await Promise.all(
    conversationIds.map(async (conversationId) => ({
      conversationId,
      moved: await moveConversationToWorkspace(
        store,
        conversationId,
        cwd,
        onConversationCwdChanged,
      ),
    })),
  );
  return results.filter((result) => !result.moved).map((result) => result.conversationId);
}
