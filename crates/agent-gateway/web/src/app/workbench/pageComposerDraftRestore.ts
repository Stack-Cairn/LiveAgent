export type PageComposerDraftRestoreState = {
  workbenchEnabled: boolean;
  targetConversationId: string;
  ownerConversationId: string;
  composerHasContent: boolean;
};

/**
 * The Workbench pane host owns draft restore whenever the feature is enabled,
 * including after a multi-pane layout converges back to one pane. The legacy
 * page composer only restores drafts when the Workbench is disabled.
 */
export function shouldRestorePageComposerDraft(state: PageComposerDraftRestoreState): boolean {
  if (state.workbenchEnabled) return false;
  return (
    state.ownerConversationId.trim() !== state.targetConversationId.trim() ||
    !state.composerHasContent
  );
}
