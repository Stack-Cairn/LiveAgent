import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";
import type { MutableRefObject } from "react";

export type PaneComposerSendDeps = {
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  /** Persist/clear the conversation's cached draft alongside the live composer. */
  clearConversationDraft: () => void;
  restoreConversationDraft: (draft: MentionComposerDraft) => void;
  /**
   * Route the draft to its conversation (send now, or enqueue while that
   * conversation is running). Resolves true when the draft was accepted.
   */
  sendDraft: (draft: MentionComposerDraft) => Promise<boolean>;
};

/**
 * Send handler for a workbench pane's own composer. The page-level send path
 * reads the page composer + focused conversation, which a background pane must
 * not do; this handler captures the pane composer's draft and routes it by the
 * pane's conversationId. The composer clears in the same beat as the send
 * (matching the page pipeline's optimistic clear) and the draft is restored
 * when the send is rejected or throws, so no text is ever lost.
 */
export function createPaneComposerSendHandler(deps: PaneComposerSendDeps) {
  let sendInFlight = false;
  return () => {
    if (sendInFlight) return;
    const composer = deps.composerRef.current;
    const draft = composer?.getDraft() ?? null;
    if (!draft || (draft.isEmpty && !draft.text.trim())) return;
    sendInFlight = true;
    composer?.clear();
    deps.clearConversationDraft();
    const restore = () => {
      deps.restoreConversationDraft(draft);
      const liveComposer = deps.composerRef.current;
      if (liveComposer && !liveComposer.hasContent()) {
        liveComposer.setDraft(draft);
      }
    };
    void deps
      .sendDraft(draft)
      .then((accepted) => {
        if (!accepted) restore();
      })
      .catch(() => {
        restore();
      })
      .finally(() => {
        sendInFlight = false;
      });
  };
}
