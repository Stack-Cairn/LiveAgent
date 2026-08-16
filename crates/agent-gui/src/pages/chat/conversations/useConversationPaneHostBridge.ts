import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";
import type { ScrollFollowHandle } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import { type MutableRefObject, useMemo, useRef } from "react";

export type ConversationPaneHostHandle = {
  getComposer(): MentionComposerHandle | null;
  getScrollFollow(): ScrollFollowHandle | null;
};

export function useConversationPaneHostBridge() {
  const hostRef = useRef<ConversationPaneHostHandle | null>(null);
  const composerRef = useMemo<MutableRefObject<MentionComposerHandle | null>>(
    () => ({
      get current() {
        return hostRef.current?.getComposer() ?? null;
      },
      set current(_value: MentionComposerHandle | null) {},
    }),
    [],
  );
  const scrollFollowRef = useMemo<MutableRefObject<ScrollFollowHandle | null>>(
    () => ({
      get current() {
        return hostRef.current?.getScrollFollow() ?? null;
      },
      set current(_value: ScrollFollowHandle | null) {},
    }),
    [],
  );

  return { hostRef, composerRef, scrollFollowRef };
}
