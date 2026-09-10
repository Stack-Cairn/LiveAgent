import type { ArchivedSidebarConversation } from "./preferences";
import type { SidebarStore } from "./store";

export async function deleteSidebarConversation(
  id: string,
  context: {
    store: SidebarStore;
    archivedConversations?: readonly ArchivedSidebarConversation[];
    onSetConversationArchived?: (item: ArchivedSidebarConversation, archived: boolean) => void;
  },
): Promise<boolean> {
  const { store, archivedConversations, onSetConversationArchived } = context;
  if (store.getSnapshot().mutations.has(id)) return false;
  const archived = archivedConversations?.find((item) => item.id === id);
  // After a restart, an archived row may exist only in settings. Seed its
  // summary so the store can apply its normal running/error/rollback guards.
  if (archived && !store.peek(id)) {
    store.upsertLocal({ ...archived, providerId: "", model: "", createdAt: 0, updatedAt: 0 });
  }
  const removed = await store.remove(id);
  // An optimistic removal can roll back. Forget the fallback row only after
  // the backend has confirmed that the conversation was deleted.
  if (removed && archived) onSetConversationArchived?.(archived, false);
  return removed;
}

export type SidebarBatchDeleteResult = {
  deletedIds: readonly string[];
  failedIds: readonly string[];
  skippedIds: readonly string[];
};

export type SidebarBatchDeleteOptions = {
  /**
   * Polled before each delete. Once it returns true the batch stops issuing
   * further deletes: the one already in flight settles on its own, and every
   * unattempted id is reported in `skippedIds`.
   */
  shouldStop?: () => boolean;
};

export async function deleteSidebarConversations(
  ids: readonly string[],
  deleteOne: (id: string) => Promise<boolean>,
  options?: SidebarBatchDeleteOptions,
): Promise<SidebarBatchDeleteResult> {
  const deletedIds: string[] = [];
  const failedIds: string[] = [];
  const skippedIds: string[] = [];
  let stopped = false;
  for (const id of ids) {
    if (stopped || options?.shouldStop?.() === true) {
      stopped = true;
      skippedIds.push(id);
      continue;
    }
    try {
      if (await deleteOne(id)) {
        deletedIds.push(id);
      } else {
        failedIds.push(id);
      }
    } catch {
      failedIds.push(id);
    }
  }
  return { deletedIds, failedIds, skippedIds };
}
