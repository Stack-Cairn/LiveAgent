import { EditableUserMessageBubble } from "@liveagent/ui/components/chat/EditableUserMessageBubble";
import {
  type PendingUploadedFile,
  splitUserAttachmentsForDisplay,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import {
  type CommitDetailsLoader,
  UserMessageContent,
} from "@liveagent/ui/lib/chat/userMessageContent";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo } from "react";
import { loadComposerUploadedImagePreview } from "../../../agent-ui-adapters/composerImagePreview";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import { UserRowFooter } from "./RowActions";
import type { UserRow } from "./rowModel";
import { UserAttachmentCards } from "./UserAttachmentCards";

export type UserMessageRowProps = {
  row: UserRow;
  isEditing: boolean;
  // True only in the row's birth window — never on virtualizer re-entry.
  animateEntrance: boolean;
  workspaceRoot?: string;
  loadCommitDetails: CommitDetailsLoader;
  onStartEdit: (key: string) => void;
  onCancelEdit: () => void;
  onResendFromEdit: (
    messageRef: HistoryMessageRef,
    text: string,
    attachments: PendingUploadedFile[],
  ) => void;
};

export const UserMessageRow = memo(function UserMessageRow(props: UserMessageRowProps) {
  const {
    row,
    isEditing,
    animateEntrance,
    workspaceRoot,
    loadCommitDetails,
    onStartEdit,
    onCancelEdit,
    onResendFromEdit,
  } = props;
  const item = row.item;

  const effectiveMessageRef = item.messageRef;
  const compactedClass = item.isFromCompactedSegment ? "opacity-70" : "";
  const { visibleFiles, pastedTextFiles } = splitUserAttachmentsForDisplay(
    item.attachments,
    item.text,
  );

  if (isEditing && effectiveMessageRef) {
    return (
      <EditableUserMessageBubble
        initialText={item.text}
        attachments={item.attachments}
        workspaceRoot={workspaceRoot}
        className={compactedClass}
        preserveViewportScrollOnFocus
        onLoadUploadedImagePreview={loadComposerUploadedImagePreview}
        onCancel={onCancelEdit}
        onSubmit={(newText, nextAttachments) => {
          onCancelEdit();
          onResendFromEdit(effectiveMessageRef, newText, nextAttachments);
        }}
      />
    );
  }

  return (
    <div
      className={cn(
        "chat-user-bubble-wrap group relative ml-auto max-w-[min(85%,calc(50em+2rem))]",
        compactedClass,
      )}
    >
      <div
        className={cn(
          animateEntrance && "chat-bubble-enter",
          "chat-user-bubble ml-auto w-fit max-w-full rounded-2xl rounded-br-md bg-[hsl(var(--chat-user-bg))] px-4 py-2.5 font-chat text-[calc(14.5px*var(--zone-font-scale,1))] leading-relaxed text-[hsl(var(--chat-user-fg))]",
        )}
      >
        <UserAttachmentCards files={visibleFiles} workspaceRoot={workspaceRoot} />
        {item.text ? (
          <UserMessageContent
            text={item.text}
            pastedTextFiles={pastedTextFiles}
            loadCommitDetails={loadCommitDetails}
          />
        ) : null}
      </div>
      <UserRowFooter
        itemKey={item.key}
        text={item.text}
        timestamp={item.timestamp}
        hasStableRef={!!effectiveMessageRef}
        onStartEdit={onStartEdit}
      />
    </div>
  );
});
