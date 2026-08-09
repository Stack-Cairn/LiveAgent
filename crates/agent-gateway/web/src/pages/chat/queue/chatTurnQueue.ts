import type { MentionComposerDraft } from "@liveagent/ui/components/chat/MentionComposer";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";

export function queuedChatTurnHasContent(
  draft: MentionComposerDraft | null | undefined,
  uploadedFiles: readonly PendingUploadedFile[],
): draft is MentionComposerDraft {
  return Boolean(draft && (!draft.isEmpty || draft.text.trim() || uploadedFiles.length > 0));
}
