import { useCallback, useSyncExternalStore } from "react";
import type {
  ConversationHydrationPhase,
  ConversationHydrationStore,
} from "./conversationHydrationStore";

/** Reactive read of one conversation's hydration phase (null = idle). */
export function useConversationHydrationPhase(
  store: ConversationHydrationStore,
  conversationId: string,
): ConversationHydrationPhase | null {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(conversationId, listener),
    [store, conversationId],
  );
  const getSnapshot = useCallback(
    () => store.getSnapshot(conversationId),
    [store, conversationId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
