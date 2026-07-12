import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatHistorySummary } from "../../lib/chat/chatHistory";
import type { HistoryShareStatus } from "../../lib/gatewayTypes";
import { buildHistoryShareUrl } from "../../lib/historyShare";
import { useModalMotion } from "../../lib/shared/modalMotion";
import { cn } from "../../lib/shared/utils";
import { Check, Copy, Eye, EyeOff, Link2, Loader2, Share2, X } from "../icons";
import { Button } from "../ui/button";

type HistoryShareModalProps = {
  conversation: ChatHistorySummary;
  share: HistoryShareStatus | null;
  isLoading: boolean;
  isUpdating: boolean;
  errorMessage: string | null;
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
  return (
    <div
      role="radiogroup"
      aria-label="工具调用脱敏"
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border border-border/60 bg-muted/40 p-0.5",
        disabled && "pointer-events-none opacity-60",
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={value}
        disabled={disabled}
        onClick={() => onChange(true)}
        className={cn(
          "relative rounded-full px-3 py-1 text-[calc(11px*var(--zone-font-scale,1))] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/35 disabled:cursor-not-allowed",
          value
            ? "bg-emerald-500 text-white shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        开启
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={!value}
        disabled={disabled}
        onClick={() => onChange(false)}
        className={cn(
          "relative rounded-full px-3 py-1 text-[calc(11px*var(--zone-font-scale,1))] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/35 disabled:cursor-not-allowed",
          !value
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        关闭
      </button>
    </div>
  );
}

function ShareSwitch(props: { checked: boolean; disabled: boolean; onToggle: () => void }) {
  const { checked, disabled, onToggle } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={checked ? "关闭分享" : "开启分享"}
      title={checked ? "关闭分享" : "开启分享"}
      disabled={disabled}
      onClick={onToggle}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/35 disabled:cursor-not-allowed disabled:opacity-60 ${
        checked ? "bg-sky-500" : "bg-muted-foreground/20 hover:bg-muted-foreground/30"
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

export function HistoryShareModal({
  conversation,
  share,
  isLoading,
  isUpdating,
  errorMessage,
  onToggle,
  onRedactToolContentChange,
  onClose,
}: HistoryShareModalProps) {
  const { isClosing, modalState, requestClose } = useModalMotion(onClose);
  const [copied, setCopied] = useState(false);
  const [redactToolContent, setRedactToolContent] = useState(false);
  const shareUrl = useMemo(
    () => (share?.enabled && share.token ? buildHistoryShareUrl(share.token) : ""),
    [share?.enabled, share?.token],
  );
  const isEnabled = share?.enabled === true && Boolean(share.token?.trim());
  const isBusy = isLoading || isUpdating || isClosing;

  useEffect(() => {
    setRedactToolContent(share?.redact_tool_content === true);
  }, [share?.conversation_id, share?.redact_tool_content]);

  function handleRedactToggle() {
    const next = !redactToolContent;
    setRedactToolContent(next);
    if (isEnabled) {
      onRedactToolContentChange(next);
    }
  }

  function handleCopy() {
    if (!shareUrl) {
      return;
    }
    if (!navigator.clipboard?.writeText) {
      setCopied(false);
      return;
    }
    void navigator.clipboard
      .writeText(shareUrl)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        setCopied(false);
      });
  }

  return createPortal(
    <div
      className="history-share-modal-overlay fixed inset-0 z-[70] flex items-center justify-center p-4"
      data-state={modalState}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={requestClose} />

      <div className="history-share-modal-panel relative z-10 w-full max-w-lg overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-sky-500/20 bg-sky-500/10 text-sky-500">
              <Share2 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">分享会话</div>
              <div
                className="mt-1 truncate text-xs text-muted-foreground"
                title={conversation.title}
              >
                {conversation.title}
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={requestClose}
            className="h-8 w-8 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
            title="关闭"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div className="rounded-2xl border border-border/60 bg-muted/25 px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">公开只读链接</div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">
                  开启后，拥有链接的用户只能查看该会话内容，无法发送消息或执行任何操作。
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
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-colors",
                    redactToolContent
                      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "border-border/60 bg-background text-muted-foreground",
                  )}
                >
                  {redactToolContent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-foreground">工具调用脱敏</span>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                    仅展示工具卡片，隐藏参数、命令、返回内容与图片，且分享页中不可展开。
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
            <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在读取分享状态...
            </div>
          ) : null}

          {errorMessage ? (
            <div className="rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </div>
          ) : null}

          {isEnabled && shareUrl ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">分享链接</div>
              <div className="flex items-center gap-2 rounded-2xl border border-border/70 bg-background px-3 py-2 shadow-sm">
                <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <a
                  href={shareUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate font-mono text-xs text-sky-600 underline-offset-4 hover:underline dark:text-sky-400"
                  title={shareUrl}
                >
                  {shareUrl}
                </a>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                  title="复制链接"
                  aria-label="复制链接"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/70 px-3 py-3 text-sm text-muted-foreground">
              开启分享后会在这里生成公开链接。
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
