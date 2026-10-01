import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { RenderTimelineItem } from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";

const subscribeToNothing = () => () => {};

/** The page needs view availability, not a second projection of streaming messages. */
export function useHasConversationReply(
  items: readonly RenderTimelineItem[],
  liveStore: LiveTranscriptStore,
  isDraft: boolean,
) {
  const hasPersistedReply = useMemo(() => items.some((item) => item.kind === "assistant"), [items]);
  const getSnapshot = useCallback(
    () => !isDraft && (hasPersistedReply || liveStore.getSnapshot().liveRounds.length > 0),
    [hasPersistedReply, isDraft, liveStore],
  );
  // Once history contains a reply, streaming cannot change this answer.
  return useSyncExternalStore(
    isDraft || hasPersistedReply ? subscribeToNothing : liveStore.subscribe,
    getSnapshot,
    getSnapshot,
  );
}
