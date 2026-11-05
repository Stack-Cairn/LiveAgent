import { BackgroundNoticeMessage } from "@liveagent/ui/components/chat/BackgroundNoticeMessage";
import { EditableUserMessageBubble } from "@liveagent/ui/components/chat/EditableUserMessageBubble";
import { UserMessageBubbleBody } from "@liveagent/ui/components/chat/UserMessageBubbleBody";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import type { CommitDetailsLoader } from "@liveagent/ui/lib/chat/userMessageContent";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo } from "react";
import { loadComposerUploadedImagePreview } from "../../../agent-ui-adapters/composerImagePreview";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import { UserRowFooter } from "./RowActions";
import type { UserRow } from "./rowModel";

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

  if (item.backgroundNotice) {
    return <BackgroundNoticeMessage text={item.text} className={compactedClass} />;
  }

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
      <UserMessageBubbleBody
        messageKey={item.key}
        text={item.text}
        attachments={item.attachments}
        workspaceRoot={workspaceRoot}
        onLoadUploadedImagePreview={loadComposerUploadedImagePreview}
        loadCommitDetails={loadCommitDetails}
      />
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
