import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";
import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import type { ConversationDraftStore } from "../conversations/conversationDraftStore";

type UseComposerDraftCacheParams = {
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  currentConversationIdRef: MutableRefObject<string>;
  activeView: "chat" | "skills-hub" | "mcp-hub";
  currentConversationId: string;
  draftStore: ConversationDraftStore;
};

/**
 * Per-conversation composer draft cache: snapshots the live draft when the
 * user leaves a conversation and restores it (post-paint) when they return.
 * The owner ref tracks which conversation the composer's current content
 * belongs to, so restores never clobber freshly-typed input.
 */
export function useComposerDraftCache(params: UseComposerDraftCacheParams) {
  const { composerRef, currentConversationIdRef, activeView, currentConversationId, draftStore } =
    params;
  const composerDraftCacheRef = useRef<ConversationDraftStore>(draftStore);
  const composerDraftOwnerRef = useRef(currentConversationId);

  function cacheActiveComposerDraft(conversationId = composerDraftOwnerRef.current) {
    const targetConversationId = conversationId.trim();
    const composer = composerRef.current;
    if (
      !targetConversationId ||
      composerDraftOwnerRef.current !== targetConversationId ||
      !composer
    ) {
      return;
    }

    const draft = composer.getDraft();
    if (draft.isEmpty || !draft.text.trim()) {
      composerDraftCacheRef.current.delete(targetConversationId);
      return;
    }

    composerDraftCacheRef.current.set(targetConversationId, draft);
  }

  function prepareComposerForConversationChange() {
    cacheActiveComposerDraft();
    composerDraftOwnerRef.current = "";
  }

  const restoreCachedComposerDraft = useCallback(
    (conversationId: string) => {
      const targetConversationId = conversationId.trim();
      const composer = composerRef.current;
      if (!targetConversationId || !composer) {
        return;
      }

      const cachedDraft = composerDraftCacheRef.current.get(targetConversationId);
      if (cachedDraft) {
        composer.setDraft(cachedDraft);
      } else {
        composer.clear();
      }
      composerDraftOwnerRef.current = targetConversationId;
    },
    [composerRef],
  );

  function clearCachedComposerDraft(conversationId = currentConversationIdRef.current) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) {
      return;
    }
    composerDraftCacheRef.current.delete(targetConversationId);
  }

  /** Cache-eviction for deleted conversations (owner reset included). */
  function deleteCachedComposerDraftState(conversationId: string) {
    composerDraftCacheRef.current.delete(conversationId);
    if (composerDraftOwnerRef.current === conversationId) {
      composerDraftOwnerRef.current = "";
    }
  }

  useEffect(() => {
    if (activeView !== "chat") {
      return;
    }

    const targetConversationId = currentConversationId.trim();
    if (!targetConversationId) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const composer = composerRef.current;
      if (
        !composer ||
        (composerDraftOwnerRef.current === targetConversationId && composer.hasContent())
      ) {
        return;
      }
      restoreCachedComposerDraft(targetConversationId);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeView, currentConversationId, composerRef, restoreCachedComposerDraft]);

  return {
    composerDraftCacheRef,
    cacheActiveComposerDraft,
    prepareComposerForConversationChange,
    restoreCachedComposerDraft,
    clearCachedComposerDraft,
    deleteCachedComposerDraftState,
  };
}
