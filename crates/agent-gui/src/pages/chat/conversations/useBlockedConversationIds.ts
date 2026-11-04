// Which listed conversations are blocked on the user (tool approval or an
// unanswered question). Shared by the sidebar and run-attention notifications.

import type { SidebarConversation } from "@liveagent/ui/lib/sidebar/types";
import { useCallback, useEffect, useMemo, useState } from "react";

/** Both the approval and the ask-question registries expose this shape, so one
 *  hook covers "which visible conversations are blocked on the user". */
export type PendingConversationStore = {
  getSnapshot: (conversationId: string) => readonly unknown[];
  subscribe: (conversationId: string, listener: () => void) => () => void;
};

export function useBlockedConversationIds(
  items: readonly SidebarConversation[],
  pendingStore: PendingConversationStore,
): ReadonlySet<string> {
  const conversationIds = useMemo(() => items.map((item) => item.id), [items]);
  const readSnapshot = useCallback(() => {
    const result = new Set<string>();
    for (const conversationId of conversationIds) {
      if (pendingStore.getSnapshot(conversationId).length > 0) result.add(conversationId);
    }
    return result;
  }, [pendingStore, conversationIds]);
  const [blockedConversationIds, setBlockedConversationIds] =
    useState<ReadonlySet<string>>(readSnapshot);

  useEffect(() => {
    const notify = () => setBlockedConversationIds(readSnapshot());
    const unsubscribers = conversationIds.map((conversationId) =>
      pendingStore.subscribe(conversationId, notify),
    );
    // Close the small render→subscribe race by re-reading once subscriptions exist.
    notify();
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [pendingStore, conversationIds, readSnapshot]);

  return blockedConversationIds;
}
