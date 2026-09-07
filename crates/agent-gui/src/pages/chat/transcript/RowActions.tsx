import {
  TranscriptAssistantMessageActions,
  TranscriptUserMessageActions,
} from "@liveagent/ui/components/chat/TranscriptMessageActions";
import type { UsageDetailEntry } from "@liveagent/ui/components/chat/UsagePanel";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import type {
  HistoryMessageRef,
  RenderUserMessage,
} from "../../../lib/chat/conversation/conversationState";
import { useRowInteraction } from "./rowInteraction";
import { useCopiedFlag } from "./useCopiedFlag";

export type AssistantRowFooterProps = {
  timestamp?: number;
  replyText: string;
  usageEntries?: readonly UsageDetailEntry[];
  usageContextWindow?: number;
  retryTarget: RenderUserMessage | null;
  onResendFromEdit: (
    messageRef: HistoryMessageRef,
    text: string,
    attachments: PendingUploadedFile[],
    referencedConversations: ConversationMentionReference[],
  ) => void;
  onBranchConversation?: (messageRef: HistoryMessageRef) => void;
};

export function AssistantRowFooter(props: AssistantRowFooterProps) {
  const {
    timestamp,
    replyText,
    usageEntries,
    usageContextWindow,
    retryTarget,
    onResendFromEdit,
    onBranchConversation,
  } = props;
  const { t } = useLocale();
  const { copied, markCopied } = useCopiedFlag();
  const { isSending, branchPendingMessageId } = useRowInteraction();
  const retryMessageRef = retryTarget?.messageRef;
  const branchPending = branchPendingMessageId != null;
  const isRowBranchPending =
    branchPending && !!retryMessageRef && branchPendingMessageId === retryMessageRef.messageId;

  return (
    <TranscriptAssistantMessageActions
      timestamp={timestamp}
      copied={copied}
      copyDisabled={!replyText}
      onCopy={() => {
        void navigator.clipboard.writeText(replyText);
        markCopied();
      }}
      usageEntries={usageEntries}
      usageContextWindow={usageContextWindow}
      retryDisabled={isSending || !retryMessageRef}
      retryTitle={retryMessageRef ? t("chat.retry") : "旧历史缺少稳定消息标识，无法重试"}
      onRetry={() => {
        if (!retryTarget || !retryMessageRef) return;
        onResendFromEdit(
          retryMessageRef,
          retryTarget.text,
          retryTarget.attachments,
          retryTarget.referencedConversations,
        );
      }}
      branchDisabled={isSending || !retryMessageRef || !onBranchConversation || branchPending}
      branchTitle={retryMessageRef ? t("chat.branch") : t("chat.branchUnavailable")}
      branchPending={isRowBranchPending}
      onBranch={() => {
        if (retryMessageRef) onBranchConversation?.(retryMessageRef);
      }}
    />
  );
}

export type UserRowFooterProps = {
  itemKey: string;
  text: string;
  timestamp: number;
  hasStableRef: boolean;
  messageId?: string;
  onStartEdit: (key: string) => void;
};

export function UserRowFooter(props: UserRowFooterProps) {
  const { itemKey, text, timestamp, hasStableRef, messageId, onStartEdit } = props;
  const { t } = useLocale();
  const { copied, markCopied } = useCopiedFlag();
  const { isSending } = useRowInteraction();

  return (
    <TranscriptUserMessageActions
      timestamp={timestamp}
      copied={copied}
      onCopy={() => {
        void navigator.clipboard.writeText(text);
        markCopied();
      }}
      editDisabled={isSending || !hasStableRef}
      editTitle={hasStableRef ? t("chat.edit") : "旧历史缺少稳定消息标识，无法编辑重发"}
      onEdit={() => {
        if (hasStableRef) onStartEdit(itemKey);
      }}
      rewindTurnId={messageId}
    />
  );
}
