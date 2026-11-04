import {
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Link2,
  Loader2,
  Share2,
} from "@liveagent/ui/components/IconSet";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@liveagent/ui/components/ui/radio-group";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import { buildShareUrl, resolveShareOrigin } from "@liveagent/ui/lib/chat/historyShareOrigin";
import { copyTextToClipboard } from "@liveagent/ui/lib/shared/clipboard";
import { COPY_FEEDBACK_DURATION, useCopyFeedback } from "@liveagent/ui/lib/shared/useCopyFeedback";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useEffect, useId, useMemo, useState } from "react";

type ShareConversation = {
  title: string;
};

type HistoryShareStatus = {
  enabled: boolean;
  token?: string;
  conversationId?: string;
  conversation_id?: string;
  redactToolContent?: boolean;
  redact_tool_content?: boolean;
};

type HistoryShareModalProps = {
  conversation: ShareConversation;
  share: HistoryShareStatus | null;
  isLoading: boolean;
  isUpdating: boolean;
  errorMessage: string | null;
  shareOrigin?: string;
  shareBackendUrl?: string;
  shareOriginPort?: number;
  shareOriginLoading?: boolean;
  onToggle: (enabled: boolean, options?: { redactToolContent?: boolean }) => void;
  onRedactToolContentChange: (redactToolContent: boolean) => void;
  onClose: () => void;
};

function RedactionPicker(props: {
  value: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  const { value, disabled, onChange } = props;
  const { t } = useLocale();
  const redactionGroupName = useId();
  return (
    <RadioGroup
      value={value}
      disabled={disabled}
      onValueChange={onChange}
      name={redactionGroupName}
      aria-label={t("sharedHistory.redactionTitle")}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border border-border/60 bg-muted/40 p-0.5",
        disabled && "pointer-events-none opacity-60",
      )}
    >
      {/* biome-ignore lint/a11y/noLabelWithoutControl: RadioGroupItem renders its associated native radio inside this label. */}
      <label
        className={cn(
          "cursor-pointer",
          disabled && "cursor-not-allowed",
          "relative rounded-full px-3 py-1 text-xs font-medium transition-colors",
          "has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-emerald-500/35 disabled:cursor-not-allowed",
          value
            ? "bg-emerald-500 text-white shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <RadioGroupItem className="sr-only" value={true} disabled={disabled} />
        {t("sharedHistory.shareDialog.on")}
      </label>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: RadioGroupItem renders its associated native radio inside this label. */}
      <label
        className={cn(
          "cursor-pointer",
          disabled && "cursor-not-allowed",
          "relative rounded-full px-3 py-1 text-xs font-medium transition-colors",
          "has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500/35 disabled:cursor-not-allowed",
          !value
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <RadioGroupItem className="sr-only" value={false} disabled={disabled} />
        {t("sharedHistory.shareDialog.off")}
      </label>
    </RadioGroup>
  );
}

function ShareSwitch(props: { checked: boolean; disabled: boolean; onToggle: () => void }) {
  const { checked, disabled, onToggle } = props;
  const { t } = useLocale();
  const label = checked
    ? t("sharedHistory.disableShare")
    : t("sharedHistory.shareDialog.enableShare");
  return (
    <Switch
      size="lg"
      nativeButton
      render={<button type="button" />}
      checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onCheckedChange={() => onToggle()}
    />
  );
}

export function HistoryShareModal({
  conversation,
  share,
  isLoading,
  isUpdating,
  errorMessage,
  shareOrigin,
  shareBackendUrl,
  shareOriginPort,
  shareOriginLoading = false,
  onToggle,
  onRedactToolContentChange,
  onClose,
}: HistoryShareModalProps) {
  const { t } = useLocale();
  const { copied, showCopied, resetCopied } = useCopyFeedback(
    false,
    COPY_FEEDBACK_DURATION.default,
  );
  const [redactToolContent, setRedactToolContent] = useState(false);
  const publicOrigin = resolveShareOrigin(shareOrigin, shareOriginPort, shareBackendUrl);
  const token = share?.enabled === true ? (share.token?.trim() ?? "") : "";
  const shareUrl = useMemo(() => buildShareUrl(token, publicOrigin), [publicOrigin, token]);
  const isEnabled = share?.enabled === true;
  const isBusy = isLoading || isUpdating;
  const canCopy = Boolean(shareUrl);

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversation ids reset local state when the share target changes
  useEffect(() => {
    setRedactToolContent(share?.redactToolContent === true || share?.redact_tool_content === true);
  }, [
    share?.conversationId,
    share?.conversation_id,
    share?.redactToolContent,
    share?.redact_tool_content,
  ]);

  function handleRedactToggle() {
    const next = !redactToolContent;
    setRedactToolContent(next);
    if (isEnabled) {
      onRedactToolContentChange(next);
    }
  }

  function handleCopy() {
    if (!shareUrl) return;
    void copyTextToClipboard(shareUrl).then((copied) => {
      if (copied) showCopied(true);
      else resetCopied();
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg p-0" closeLabel={t("sharedHistory.close")} showCloseButton>
        <DialogHeader className="flex-row items-start gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={cn(
                "flex size-10 shrink-0 items-center justify-center",
                "rounded-2xl border border-sky-500/20 bg-sky-500/10 text-sky-500",
              )}
            >
              <Share2 className="size-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-sm leading-normal">
                {t("sharedHistory.shareDialog.title")}
              </DialogTitle>
              <DialogDescription
                className="mt-1 truncate text-xs text-muted-foreground"
                title={conversation.title}
              >
                {conversation.title}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="rounded-2xl border border-border/60 bg-muted/25 px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {t("sharedHistory.shareDialog.publicLinkTitle")}
                </div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t("sharedHistory.shareDialog.publicLinkDescription")}
                </div>
              </div>
              <ShareSwitch
                checked={isEnabled}
                disabled={isBusy}
                onToggle={() => onToggle(!isEnabled, { redactToolContent })}
              />
            </div>
          </div>

          <div
            className={cn(
              "rounded-2xl border px-4 py-3 transition-colors",
              redactToolContent
                ? "border-emerald-500/30 bg-emerald-500/5"
                : "border-border/60 bg-muted/25",
            )}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <div
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-xl border transition-colors",
                    redactToolContent
                      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "border-border/60 bg-background text-muted-foreground",
                  )}
                >
                  {redactToolContent ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-foreground">
                    {t("sharedHistory.redactionTitle")}
                  </span>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                    {t("sharedHistory.shareDialog.redactionDescription")}
                  </p>
                </div>
              </div>
              <RedactionPicker
                value={redactToolContent}
                disabled={isBusy}
                onChange={(next) => {
                  if (next === redactToolContent) return;
                  handleRedactToggle();
                }}
              />
            </div>
          </div>

          {isLoading ? (
            <div
              className={cn(
                "flex items-center gap-2",
                "rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm text-muted-foreground",
              )}
            >
              <Loader2 className="size-4 animate-spin" />
              {t("sharedHistory.shareDialog.loadingStatus")}
            </div>
          ) : null}

          {errorMessage ? (
            <div className="rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </div>
          ) : null}

          {isEnabled && token ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                {t("sharedHistory.shareDialog.linkLabel")}
              </div>
              <div
                className={cn(
                  "flex items-center gap-2",
                  "rounded-2xl border border-border/70 bg-background px-3 py-2 shadow-sm",
                )}
              >
                <Link2 className="size-4 shrink-0 text-muted-foreground" />
                {shareUrl ? (
                  <a
                    href={shareUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={cn(
                      "min-w-0 flex-1 truncate font-mono text-xs text-sky-600 underline-offset-4",
                      "hover:underline dark:text-sky-400",
                    )}
                    title={shareUrl}
                  >
                    {shareUrl}
                  </a>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {shareOriginLoading
                      ? t("sharedHistory.loadingGateway")
                      : publicOrigin
                        ? token
                        : t("sharedHistory.shareDialog.gatewayUnavailable")}
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={!canCopy}
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-xl transition-colors",
                    canCopy
                      ? "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                      : "cursor-not-allowed text-muted-foreground/40",
                  )}
                  title={t("sharedHistory.copyLink")}
                  aria-label={t("sharedHistory.copyLink")}
                >
                  {copied ? (
                    <Check className="size-4 text-emerald-500" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                </button>
                <a
                  href={shareUrl || undefined}
                  target="_blank"
                  rel="noreferrer"
                  aria-disabled={!shareUrl}
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-xl transition-colors",
                    shareUrl
                      ? "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                      : "pointer-events-none text-muted-foreground/40",
                  )}
                  title={t("sharedHistory.openLink")}
                >
                  <ExternalLink className="size-4" />
                </a>
              </div>
              {!shareOriginLoading && !publicOrigin ? (
                <div
                  className={cn(
                    "rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2",
                    "text-xs leading-5 text-amber-700 dark:text-amber-300",
                  )}
                >
                  {t("sharedHistory.shareDialog.originWarning")}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/70 p-3 text-sm text-muted-foreground">
              {t("sharedHistory.shareDialog.emptyHint")}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
