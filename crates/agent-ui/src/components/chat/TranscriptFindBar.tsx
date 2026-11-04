import { ChevronDown, ChevronUp, Search, X } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { TranscriptFindState } from "@liveagent/ui/lib/transcript-find/useTranscriptFind";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export type TranscriptFindBarProps = {
  find: TranscriptFindState;
  className?: string;
};

/** Floating find bar pinned to the top-right corner of a transcript. */
export function TranscriptFindBar(props: TranscriptFindBarProps) {
  const { find, className } = props;
  const { t } = useLocale();
  if (!find.open) return null;

  const hasQuery = find.query.trim().length > 0;
  const status =
    find.total > 0
      ? t("chat.find.count")
          .replace("{current}", String(Math.max(find.activeIndex, 0) + 1))
          .replace("{total}", String(find.total))
      : hasQuery
        ? t("chat.find.noResults")
        : "";

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) find.previous();
      else find.next();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // Esc belongs to the bar: it must not also stop a run or close a pane.
      event.stopPropagation();
      find.close();
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: <search> is unknown to older WebKit/WebKitGTK webviews the desktop app still runs on.
    <div
      role="search"
      data-transcript-find=""
      aria-label={t("chat.find.label")}
      className={cn(
        "absolute top-2 right-5 z-20 flex items-center gap-0.5 rounded-lg border border-border/70 bg-popover/95 py-1 pr-1 pl-2.5 text-popover-foreground shadow-lg backdrop-blur",
        className,
      )}
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        ref={find.inputRef}
        type="text"
        value={find.query}
        onChange={(event) => find.setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("chat.find.placeholder")}
        aria-label={t("chat.find.label")}
        spellCheck={false}
        autoComplete="off"
        className="h-7 w-48 min-w-0 bg-transparent px-1.5 text-sm outline-none placeholder:text-muted-foreground/70"
      />
      <span
        aria-live="polite"
        data-transcript-find-status=""
        className={cn(
          "min-w-12 shrink-0 px-1 text-right text-xs tabular-nums text-muted-foreground",
          hasQuery && find.total === 0 && "text-destructive",
        )}
      >
        {status}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-6"
        aria-label={t("chat.find.previous")}
        title={t("chat.find.previous")}
        disabled={find.total === 0}
        onClick={find.previous}
      >
        <ChevronUp className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-6"
        aria-label={t("chat.find.next")}
        title={t("chat.find.next")}
        disabled={find.total === 0}
        onClick={find.next}
      >
        <ChevronDown className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-6"
        aria-label={t("chat.find.close")}
        title={t("chat.find.close")}
        onClick={find.close}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
