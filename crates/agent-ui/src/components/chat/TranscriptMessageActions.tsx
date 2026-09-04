import {
  Check,
  Copy,
  GitBranch,
  Loader2,
  Pencil,
  RefreshCw,
  Undo2,
} from "@liveagent/ui/components/IconSet";
import { useLocale } from "../../i18n/index";
import { useCheckpointRewindAction } from "../../lib/chat/checkpointRewind";
import { cn } from "../../lib/shared/utils";
import { ConfirmActionPopover } from "../ui/confirm-action-popover";
import { type UsageDetailEntry, UsageInfoPopover } from "./UsagePanel";

export function formatTranscriptMessageTimestamp(timestamp: number | undefined) {
  if (!timestamp || !Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Keep the clock inside the action-button chrome so hover show/hide cannot
// desync. Use a color token (not `text-muted-foreground/70`) so a /opacity
// modifier cannot override the parent chrome's `opacity: 0`.
function TranscriptTimestampLabel(props: { timestamp?: number; className?: string }) {
  const label = formatTranscriptMessageTimestamp(props.timestamp);
  if (!label) return null;
  return (
    <span
      className={cn(
        "select-none text-[calc(11px*var(--zone-font-scale,1))] tabular-nums text-[hsl(var(--muted-foreground)/0.7)]",
        props.className,
      )}
    >
      {label}
    </span>
  );
}

type SharedActionProps = {
  copied: boolean;
  copyDisabled?: boolean;
  onCopy: () => void;
  alwaysShowActions?: boolean;
};

export function TranscriptUserMessageActions(
  props: SharedActionProps & {
    timestamp?: number;
    editDisabled: boolean;
    editTitle: string;
    onEdit: () => void;
    readOnly?: boolean;
    /** 本行用户消息的稳定 ID:检查点回退按 turnId=消息 ID 命中该轮。 */
    rewindTurnId?: string;
  },
) {
  const {
    copied,
    copyDisabled = false,
    onCopy,
    alwaysShowActions = false,
    timestamp,
    editDisabled,
    editTitle,
    onEdit,
    readOnly = false,
    rewindTurnId,
  } = props;
  const { t } = useLocale();
  // Provider 外(只读分享页等)返回 null:整颗按钮不渲染。
  const rewind = useCheckpointRewindAction(rewindTurnId);
  const rewindTitle = rewind?.available ? t("chat.rewindCode") : t("chat.rewindUnavailable");

  return (
    <div className="chat-user-bubble-actions mt-1 flex items-center justify-end gap-1.5">
      <div
        className={cn(
          "chat-row-hover-chrome chat-row-hover-chrome--actions flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
          alwaysShowActions && "[@media(any-hover:none)]:opacity-100",
        )}
      >
        {!readOnly ? (
          <div className="flex gap-0.5">
            <button
              type="button"
              className="chat-user-bubble-action rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title={t("chat.copy")}
              aria-label={t("chat.copy")}
              disabled={copyDisabled}
              onClick={onCopy}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              className="chat-user-bubble-action rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title={editTitle}
              aria-label={editTitle}
              disabled={editDisabled}
              onClick={onEdit}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            {rewind ? (
              <button
                type="button"
                className="chat-user-bubble-action rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                title={rewindTitle}
                aria-label={rewindTitle}
                disabled={rewind.disabled}
                onClick={rewind.onRewind}
              >
                {rewind.pending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Undo2 className="h-3.5 w-3.5" />
                )}
              </button>
            ) : null}
          </div>
        ) : null}
        <TranscriptTimestampLabel timestamp={timestamp} />
      </div>
    </div>
  );
}

export function TranscriptAssistantMessageActions(
  props: SharedActionProps & {
    timestamp?: number;
    usageEntries?: readonly UsageDetailEntry[];
    usageContextWindow?: number;
    retryDisabled: boolean;
    retryTitle: string;
    onRetry: () => void;
    branchDisabled: boolean;
    branchTitle: string;
    branchPending: boolean;
    onBranch: () => void;
    withAvatarSpacer?: boolean;
  },
) {
  const {
    copied,
    copyDisabled = false,
    onCopy,
    alwaysShowActions = false,
    timestamp,
    usageEntries,
    usageContextWindow,
    retryDisabled,
    retryTitle,
    onRetry,
    branchDisabled,
    branchTitle,
    branchPending,
    onBranch,
    withAvatarSpacer = false,
  } = props;
  const { t } = useLocale();
  const actions = (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center justify-start gap-0.5",
        !withAvatarSpacer && "pl-10",
      )}
    >
      <div
        className={cn(
          "chat-row-hover-chrome chat-row-hover-chrome--actions pointer-events-none flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-data-[actions-visible=true]/assistant:pointer-events-auto group-data-[actions-visible=true]/assistant:opacity-100 group-focus-within/assistant:pointer-events-auto group-focus-within/assistant:opacity-100 group-hover/assistant:pointer-events-auto group-hover/assistant:opacity-100 motion-reduce:transition-none",
          alwaysShowActions &&
            "[@media(any-hover:none)]:pointer-events-auto [@media(any-hover:none)]:opacity-100",
          branchPending && "pointer-events-auto opacity-100",
        )}
        data-force-visible={branchPending ? "true" : undefined}
      >
        <button
          type="button"
          className="chat-assistant-action inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          title={t("chat.copy")}
          aria-label={t("chat.copy")}
          disabled={copyDisabled}
          onClick={onCopy}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <ConfirmActionPopover
          title={t("chat.retryConfirmTitle")}
          description={t("chat.retryConfirmDescription")}
          confirmLabel={t("chat.retry")}
          align="start"
          side="top"
          onConfirm={onRetry}
        >
          {(open) => (
            <button
              type="button"
              className="chat-assistant-action inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title={retryTitle}
              aria-label={retryTitle}
              disabled={retryDisabled}
              onClick={open}
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
          onConfirm={onBranch}
        >
          {(open) => (
            <button
              type="button"
              className="chat-assistant-action inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title={branchTitle}
              aria-label={branchTitle}
              disabled={branchDisabled}
              onClick={open}
            >
              {branchPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitBranch className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </ConfirmActionPopover>
        <UsageInfoPopover entries={usageEntries} contextWindow={usageContextWindow} />
        <TranscriptTimestampLabel timestamp={timestamp} className="ml-1" />
      </div>
    </div>
  );

  if (!withAvatarSpacer) {
    return (
      <div className="chat-assistant-actions mt-1 flex items-center justify-start gap-1.5">
        {actions}
      </div>
    );
  }
  return (
    <div className="chat-assistant-actions assistant-bubble-shell flex w-full max-w-full items-start gap-3">
      <div className="assistant-bubble-avatar w-7 shrink-0" aria-hidden="true" />
      {actions}
    </div>
  );
}
