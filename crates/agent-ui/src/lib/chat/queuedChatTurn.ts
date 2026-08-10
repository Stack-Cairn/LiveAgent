import type { MentionComposerDraft } from "../../components/chat/MentionComposer";

export function queuedChatTurnHasContent(
  draft: MentionComposerDraft | null | undefined,
  uploadedFiles: readonly unknown[],
): draft is MentionComposerDraft {
  return Boolean(draft && (!draft.isEmpty || draft.text.trim() || uploadedFiles.length > 0));
}
