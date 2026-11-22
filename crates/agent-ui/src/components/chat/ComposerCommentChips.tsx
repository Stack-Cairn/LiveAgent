import { ComposerCommentEditor } from "@liveagent/ui/components/chat/ComposerCommentEditor";
import { ImageIcon, MessageSquareText, X } from "@liveagent/ui/components/IconSet";
import { Popover, PopoverContent, PopoverTrigger } from "@liveagent/ui/components/ui/popover";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type ComposerComment,
  type ComposerCommentSource,
  composerCommentLocation,
  composerCommentPreview,
} from "@liveagent/ui/lib/chat/composerComments";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState } from "react";

/** Localized short label for where a comment points. */
export function formatComposerCommentSourceLabel(
  t: (key: string) => string,
  source: ComposerCommentSource,
  /** The snippet came from a code block inside a message. */
  code = false,
) {
  if (code && (source.kind === "assistant" || source.kind === "user")) {
    return t("chat.comment.source.codeBlock");
  }
  switch (source.kind) {
    case "assistant":
      return t("chat.comment.source.assistant");
    case "user":
      return t("chat.comment.source.user");
    case "image":
      return t("chat.comment.source.image").replace("{name}", source.path ?? "");
    case "diff": {
      const location = composerCommentLocation(source);
      return source.side === "old"
        ? t("chat.comment.source.diffRemoved").replace("{location}", location)
        : location;
    }
    default:
      return composerCommentLocation(source);
  }
}

type ComposerCommentChipsProps = {
  comments: readonly ComposerComment[];
  disabled?: boolean;
  onUpdate: (comment: ComposerComment) => void;
  onRemove: (id: string) => void;
};

/**
 * Pending comments above the composer field, in send order. Each chip opens
 * an edit popover; the X removes it. Keyboard: Tab reaches each chip and its
 * remove button, Enter/Space opens the editor, Escape closes it.
 */
export function ComposerCommentChips(props: ComposerCommentChipsProps) {
  const { comments, disabled, onUpdate, onRemove } = props;
  const { t } = useLocale();
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <ul
      data-composer-comment-list=""
      aria-label={t("chat.comment.listLabel").replace("{count}", String(comments.length))}
      className="mb-1.5 flex max-h-28 min-w-0 flex-wrap gap-1.5 overflow-y-auto"
    >
      {comments.map((comment, index) => {
        const sourceLabel = formatComposerCommentSourceLabel(t, comment.source, comment.code);
        const Icon = comment.source.kind === "image" ? ImageIcon : MessageSquareText;
        const preview = comment.quote ? composerCommentPreview(comment.quote, 48) : "";
        return (
          <li
            key={comment.id}
            data-composer-comment-chip={comment.id}
            className={cn(
              "group flex h-7 min-w-0 max-w-full items-center rounded-md border border-border/70",
              "bg-muted/50 text-xs text-foreground sm:max-w-80",
            )}
          >
            <Popover
              open={editingId === comment.id}
              onOpenChange={(open) => setEditingId(open ? comment.id : null)}
            >
              <PopoverTrigger
                disabled={disabled}
                data-composer-comment-edit=""
                aria-label={`${t("chat.comment.edit")}: ${sourceLabel}`}
                title={comment.comment}
                className={cn(
                  "flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-md pl-2 pr-1 text-left",
                  "outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <span className="shrink-0 font-medium tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <Icon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                <span className="max-w-32 shrink-0 truncate text-muted-foreground">
                  {sourceLabel}
                </span>
                {preview ? (
                  <span className="hidden min-w-0 truncate italic text-muted-foreground sm:inline">
                    “{preview}”
                  </span>
                ) : null}
                <span className="min-w-0 truncate">{comment.comment}</span>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                className="w-80 max-w-[calc(100vw-2rem)] p-3"
              >
                {editingId === comment.id ? (
                  <ComposerCommentEditor
                    quote={comment.quote}
                    code={comment.code}
                    sourceLabel={sourceLabel}
                    initialValue={comment.comment}
                    submitLabel={t("chat.comment.update")}
                    onSubmit={(text) => {
                      onUpdate({ ...comment, comment: text });
                      setEditingId(null);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : null}
              </PopoverContent>
            </Popover>
            <button
              type="button"
              disabled={disabled}
              data-composer-comment-remove=""
              aria-label={`${t("chat.comment.remove")}: ${sourceLabel}`}
              title={t("chat.comment.remove")}
              className={cn(
                "flex h-full shrink-0 items-center rounded-r-md px-1.5 text-muted-foreground",
                "outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              )}
              onClick={() => onRemove(comment.id)}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
