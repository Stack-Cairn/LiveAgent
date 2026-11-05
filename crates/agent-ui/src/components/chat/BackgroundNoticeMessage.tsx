import { useState } from "react";
import { useLocale } from "../../i18n/index";
import { cn } from "../../lib/shared/utils";
import { Activity, ChevronRight } from "../IconSet";

/** Splits a backend notice into its headline (first line) and the rest. */
export function splitBackgroundNotice(text: string): { headline: string; detail: string } {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const newline = normalized.indexOf("\n");
  if (newline < 0) return { headline: normalized, detail: "" };
  return {
    headline: normalized.slice(0, newline).trim(),
    detail: normalized.slice(newline + 1).replace(/^\n+/, ""),
  };
}

/**
 * A notice the agent backend delivered on its own (a wait result, a background
 * process exit, a subagent report). It sits in the conversation where the agent
 * read it, but it is not something the user wrote, so it is shown as a muted
 * system line with its output folded, not as a user bubble with edit actions. It
 * spans the row and starts at the left edge, where agent output starts, even though
 * it travels in a user message.
 */
export function BackgroundNoticeMessage(props: { text: string; className?: string }) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const { headline, detail } = splitBackgroundNotice(props.text);
  const label = t("chat.backgroundNotice");
  const summary = (
    <>
      <Activity aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="shrink-0 font-medium">{label}</span>
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground/75">
        {headline}
      </span>
    </>
  );
  return (
    <div
      className={cn(
        "flex w-full min-w-0 max-w-full flex-col items-start self-stretch text-sm text-muted-foreground",
        props.className,
      )}
      data-background-notice=""
    >
      {detail ? (
        <button
          type="button"
          className="inline-flex min-h-6 min-w-0 max-w-full items-center gap-1.5 self-start rounded-md text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          title={expanded ? t("chat.backgroundNoticeCollapse") : t("chat.backgroundNoticeExpand")}
          onClick={() => setExpanded((value) => !value)}
        >
          {summary}
          <ChevronRight
            aria-hidden="true"
            className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
          />
        </button>
      ) : (
        <div className="inline-flex min-h-6 min-w-0 max-w-full items-center gap-1.5">{summary}</div>
      )}
      {expanded && detail ? (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/50 px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
          {detail}
        </pre>
      ) : null}
    </div>
  );
}
