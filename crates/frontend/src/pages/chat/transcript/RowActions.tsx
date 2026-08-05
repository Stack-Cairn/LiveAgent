import { Check, Copy, GitBranch, Loader2, Pencil, RefreshCw } from "../../../components/icons";
import { ConfirmActionPopover } from "../../../components/ui/confirm-action-popover";
import { useLocale } from "../../../i18n";
import type {
  HistoryMessageRef,
  RenderUserMessage,
} from "../../../lib/chat/conversation/conversationState";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import { useRowInteraction } from "./rowInteraction";
import { formatMessageTimestamp } from "./transcriptUtils";
import { useCopiedFlag } from "./useCopiedFlag";

// Row action bars live outside the memoized row bodies and read run-scoped
// state (sending flag, in-flight branch anchor) from the row-interaction
// store, so a run starting or settling never re-renders settled rows — only
// these small footers.

export type AssistantRowFooterProps = {
  timestamp?: number;
  replyText: string;
  retryTarget: RenderUserMessage | null;
  onResendFromEdit: (
    messageRef: HistoryMessageRef,
    text: string,
    attachments: PendingUploadedFile[],
  ) => void;
  onBranchConversation?: (messageRef: HistoryMessageRef) => void;
};

export function AssistantRowFooter(props: AssistantRowFooterProps) {
  const { timestamp, replyText, retryTarget, onResendFromEdit, onBranchConversation } = props;
  const { t } = useLocale();
  const { copied, markCopied } = useCopiedFlag();
  const { isSending, branchPendingMessageId } = useRowInteraction();

  const retryMessageRef = retryTarget?.messageRef;
  const retryDisabled = isSending || !retryMessageRef;
  const retryTitle = retryMessageRef ? t("chat.retry") : "旧历史缺少稳定消息标识，无法重试";
  const branchPending = branchPendingMessageId != null;
  const isRowBranchPending =
    branchPending && !!retryMessageRef && branchPendingMessageId === retryMessageRef.messageId;

  return (
    <div className="mt-1 flex items-center justify-start gap-1.5 pl-10">
      <span className="select-none text-[calc(11px*var(--zone-font-scale,1))] tabular-nums text-muted-foreground/70">
        {formatMessageTimestamp(timestamp ?? 0)}
      </span>
      <div
        className={`flex gap-0.5 transition-opacity group-focus-within/assistant:opacity-100 group-hover/assistant:opacity-100 ${isRowBranchPending ? "opacity-100" : "opacity-0"}`}
      >
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          title={t("chat.copy")}
          disabled={!replyText}
          onClick={() => {
            navigator.clipboard.writeText(replyText);
            markCopied();
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <ConfirmActionPopover
          title={t("chat.retryConfirmTitle")}
          description={t("chat.retryConfirmDescription")}
          confirmLabel={t("chat.retry")}
          align="start"
          side="top"
          onConfirm={() => {
            if (!retryTarget || !retryMessageRef) return;
            onResendFromEdit(retryMessageRef, retryTarget.text, retryTarget.attachments);
          }}
        >
          {() => (
            <button
              type="button"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title={retryTitle}
              disabled={retryDisabled}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
        </ConfirmActionPopover>
        <ConfirmActionPopover
          title={t("chat.branchConfirmTitle")}
          description={t("chat.branchConfirmDescription")}
          confirmLabel={t("chat.branch")}
          tone="default"
          align="start"
          side="top"
          onConfirm={() => {
            if (!retryMessageRef) return;
            onBranchConversation?.(retryMessageRef);
          }}
        >
          {() => (
            <button
              type="button"
              className={`rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed ${isRowBranchPending ? "" : "disabled:opacity-40"}`}
              title={retryMessageRef ? t("chat.branch") : t("chat.branchUnavailable")}
              disabled={isSending || !retryMessageRef || !onBranchConversation || branchPending}
            >
              {isRowBranchPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitBranch className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </ConfirmActionPopover>
      </div>
    </div>
  );
}

export type UserRowFooterProps = {
  itemKey: string;
  text: string;
  timestamp: number;
  hasStableRef: boolean;
  onStartEdit: (key: string) => void;
};

export function UserRowFooter(props: UserRowFooterProps) {
  const { itemKey, text, timestamp, hasStableRef, onStartEdit } = props;
  const { t } = useLocale();
  const { copied, markCopied } = useCopiedFlag();
  const { isSending } = useRowInteraction();

  const editDisabled = isSending || !hasStableRef;
  const editTitle = hasStableRef ? t("chat.edit") : "旧历史缺少稳定消息标识，无法编辑重发";

  return (
    <div className="mt-1 flex items-center justify-end gap-1.5">
      <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          title={t("chat.copy")}
          onClick={() => {
            navigator.clipboard.writeText(text);
            markCopied();
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          title={editTitle}
          disabled={editDisabled}
          onClick={() => {
            if (!hasStableRef) return;
            onStartEdit(itemKey);
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </div>
      <span className="select-none text-[calc(11px*var(--zone-font-scale,1))] tabular-nums text-muted-foreground/70">
        {formatMessageTimestamp(timestamp)}
      </span>
    </div>
  );
}
