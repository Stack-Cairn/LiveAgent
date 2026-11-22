import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import { composerCommentPreview } from "@liveagent/ui/lib/chat/composerComments";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

export type ComposerCommentEditorProps = {
  /** Snippet being commented on, shown above the field. */
  quote?: string;
  /** Short source label (e.g. "src/app.ts:12" or "Reply"). */
  sourceLabel?: string;
  code?: boolean;
  initialValue?: string;
  submitLabel: string;
  onSubmit: (comment: string) => void;
  onCancel: () => void;
  className?: string;
};

/**
 * Comment form shared by the transcript selection popover, the edit-diff
 * gutter and the pending comment chips. Enter (or Mod+Enter) submits,
 * Shift+Enter inserts a newline, Escape cancels without closing outer
 * dialogs.
 */
export function ComposerCommentEditor(props: ComposerCommentEditorProps) {
  const {
    quote,
    sourceLabel,
    code,
    initialValue = "",
    submitLabel,
    onSubmit,
    onCancel,
    className,
  } = props;
  const { t } = useLocale();
  const [value, setValue] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const quoteId = useId();
  const canSubmit = value.trim().length > 0;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  const submit = () => {
    if (value.trim()) onSubmit(value);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      submit();
    }
  };

  return (
    <div data-composer-comment-editor="" className={cn("flex min-w-0 flex-col gap-2", className)}>
      {quote || sourceLabel ? (
        <div id={quoteId} className="flex min-w-0 flex-col gap-1">
          {sourceLabel ? (
            <span className="truncate text-xs font-medium text-muted-foreground">
              {sourceLabel}
            </span>
          ) : null}
          {quote ? (
            <span
              className={cn(
                "line-clamp-3 border-l-2 border-primary/50 pl-2 text-xs text-muted-foreground",
                code ? "whitespace-pre-wrap font-mono" : "whitespace-pre-wrap break-words",
              )}
            >
              {code ? quote : composerCommentPreview(quote, 240)}
            </span>
          ) : null}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        value={value}
        rows={3}
        placeholder={t("chat.comment.placeholder")}
        aria-label={t("chat.comment.placeholder")}
        aria-describedby={quote || sourceLabel ? quoteId : undefined}
        className={cn(
          "min-h-16 w-full select-text resize-y rounded-md border border-border/70 bg-background px-2 py-1.5",
          "font-sans text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground",
          "focus-visible:border-primary/60 focus-visible:ring-1 focus-visible:ring-primary/30",
        )}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 text-xs leading-snug text-muted-foreground">
          {t("chat.comment.submitHint")}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={onCancel}>
            {t("chat.comment.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2"
            disabled={!canSubmit}
            data-composer-comment-submit=""
            onClick={submit}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
