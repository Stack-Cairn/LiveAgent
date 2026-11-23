import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";

/**
 * A send clears the composer before the Gateway acknowledges it. When the
 * command is not accepted (connection dropped, rejected, already pending) the
 * draft goes back, unless the user already started typing something new.
 */
export function restoreUnsentComposerDraft(
  composer: MentionComposerHandle | null,
  draft: ReturnType<MentionComposerHandle["getDraft"]> | null,
): void {
  if (draft && composer && !composer.hasContent()) composer.setDraft(draft);
}
