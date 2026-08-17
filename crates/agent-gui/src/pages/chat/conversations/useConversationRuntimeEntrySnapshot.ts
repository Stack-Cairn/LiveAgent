import { useCallback, useSyncExternalStore } from "react";
import type { ConversationRuntimeEntry } from "../runtime/chatPageRuntime";
import type { ConversationRuntimeRegistry } from "./createConversationRuntimeRegistry";

/**
 * Reactive read of one conversation's runtime entry. This is how page-level
 * "current conversation" metadata (sessionId / createdAt / selectedModel)
 * derives from the registry instead of living in mirrored React state — the
 * registry entry is the single writer target, so two panes can never fight
 * over a page-level slot.
 */
export function useConversationRuntimeEntrySnapshot(
  registry: ConversationRuntimeRegistry,
  conversationId: string,
): ConversationRuntimeEntry | null {
  const subscribe = useCallback(
    (listener: () => void) => registry.subscribe(conversationId, listener),
    [registry, conversationId],
  );
  const getSnapshot = useCallback(
    () => registry.getSnapshot(conversationId),
    [registry, conversationId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
