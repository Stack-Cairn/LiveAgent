import { EditableUserMessageBubble } from "@liveagent/ui/components/chat/EditableUserMessageBubble";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
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
  workspaceRoot?: string;
  loadCommitDetails: CommitDetailsLoader;
  onStartEdit: (key: string) => void;
  onCancelEdit: () => void;
  onResendFromEdit: (
    messageRef: HistoryMessageRef,
    text: string,
    attachments: PendingUploadedFile[],
    referencedConversations: ConversationMentionReference[],
  ) => void;
};

export const UserMessageRow = memo(function UserMessageRow(props: UserMessageRowProps) {
  const {
    row,
    isEditing,
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
          onResendFromEdit(
            effectiveMessageRef,
            newText,
            nextAttachments,
            item.referencedConversations,
          );
        }}
      />
    );
  }

  return (
    <div
      className={cn(
        "chat-user-bubble-wrap group relative ml-auto max-w-user-bubble-web",
        compactedClass,
      )}
      data-user-bubble-wrap
    >
      <div
        className={cn(
          "ml-auto w-fit max-w-full",
          "whitespace-pre-wrap rounded-2xl rounded-br-md bg-[hsl(var(--chat-user-bg))] px-4 py-2.5",
          "font-chat text-sm leading-relaxed break-words text-[hsl(var(--chat-user-fg))] [overflow-wrap:anywhere]",
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
        messageId={effectiveMessageRef?.messageId}
        onStartEdit={onStartEdit}
      />
    </div>
  );
});
