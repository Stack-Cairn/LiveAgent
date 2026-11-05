import { useState } from "react";
import { useLocale } from "../../i18n/index";
import { cn } from "../../lib/shared/utils";
import { Activity, ChevronRight, Goal } from "../IconSet";

const REMINDER_WRAPPER = /^<system-reminder>\n?([\s\S]*?)\n?<\/system-reminder>$/;
const GOAL_ROUND_HEADER = /^\[goal ([1-9]\d*)\/([1-9]\d*)\] /;

/** Splits a backend notice into its headline (first line) and the rest. */
export function splitBackgroundNotice(text: string): { headline: string; detail: string } {
  let normalized = text.replace(/\r\n/g, "\n").trim();
  // A runtime reminder (such as the output-limit continuation) is one wrapped block;
  // its first line is the tag, so show the text inside instead.
  normalized = REMINDER_WRAPPER.exec(normalized)?.[1]?.trim() ?? normalized;
  const newline = normalized.indexOf("\n");
  if (newline < 0) return { headline: normalized, detail: "" };
  return {
    headline: normalized.slice(0, newline).trim(),
    detail: normalized.slice(newline + 1).replace(/^\n+/, ""),
  };
}

/**
 * The round and goal of a goal continuation round, whose prompt the backend writes as
 * "[goal <round>/<max>] <goal>".
 */
export function parseGoalRoundNotice(
  text: string,
): { round: number; maxRounds: number; goal: string } | null {
  const match = GOAL_ROUND_HEADER.exec(text.trimStart());
  if (!match) return null;
  return {
    round: Number(match[1]),
    maxRounds: Number(match[2]),
    goal: text.trimStart().slice(match[0].length),
  };
}

/**
 * A notice the agent backend delivered on its own (a wait result, a background
 * process exit, a subagent report). It sits in the conversation where the agent
 * read it, but it is not something the user wrote, so it is shown as a muted
 * system line with its output folded, not as a user bubble with edit actions. It
 * spans the row and starts at the left edge, where agent output starts, even though
 * it travels in a user message. A goal continuation round is labelled with its round
 * and shows the goal text.
 */
export function BackgroundNoticeMessage(props: { text: string; className?: string }) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const goalRound = parseGoalRoundNotice(props.text);
  const { headline, detail } = splitBackgroundNotice(goalRound ? goalRound.goal : props.text);
  const label = goalRound
    ? t("chat.goal.continuing")
        .replace("{round}", String(goalRound.round))
        .replace("{max}", String(goalRound.maxRounds))
    : t("chat.backgroundNotice");
  const Icon = goalRound ? Goal : Activity;
  const summary = (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="shrink-0 font-medium">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-muted-foreground/75",
          goalRound ? "text-sm" : "font-mono text-xs",
        )}
      >
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
      {...(goalRound ? { "data-goal-round": "" } : {})}
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
