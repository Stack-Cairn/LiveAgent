import { UserAttachmentCards as SharedUserAttachmentCards } from "@liveagent/ui/components/chat/UserAttachmentCards";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { loadComposerUploadedImagePreview } from "../../../agent-ui-adapters/composerImagePreview";

export function UserAttachmentCards(props: {
  files: PendingUploadedFile[];
  workspaceRoot?: string;
  onRemove?: (relativePath: string) => void;
}) {
  return (
    <SharedUserAttachmentCards
      {...props}
      onLoadUploadedImagePreview={loadComposerUploadedImagePreview}
    />
  );
}
