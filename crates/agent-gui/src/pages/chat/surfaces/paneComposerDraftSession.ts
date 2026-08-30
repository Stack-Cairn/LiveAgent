import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";

export type PaneComposerDraftController = {
  getDraft(): MentionComposerDraft | null;
  setDraft(draft: MentionComposerDraft): void;
};

/**
 * Restore one pane composer's draft and return a cleanup permanently bound to
 * the same conversation controller. React runs the old cleanup after rendering
 * the next conversation identity, so reading a mutable "latest controller"
 * ref here would save conversation A's text into conversation B.
 */
export function beginPaneComposerDraftSession(
  composer: MentionComposerHandle | null,
  controller: PaneComposerDraftController,
): () => void {
  const draft = controller.getDraft();
  if (draft) {
    composer?.setDraft(draft);
  } else {
    composer?.clear();
  }

  return () => {
    // Save only non-empty drafts. The page pipeline may already have cleared
    // this composer mid-switch, so an empty composer must not delete the draft
    // cached in the registry.
    const nextDraft = composer?.getDraft();
    if (!nextDraft || nextDraft.isEmpty || !nextDraft.text.trim()) {
      return;
    }
    controller.setDraft(nextDraft);
  };
}
