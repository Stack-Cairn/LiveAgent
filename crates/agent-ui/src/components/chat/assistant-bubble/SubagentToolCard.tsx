import { useSubagentCard } from "@liveagent/adapters/assistantBubble";
import { AssistantStatus } from "@liveagent/ui/components/chat/AssistantStatus";
import {
  formatSubagentDuration,
  formatSubagentTokens,
  type SubagentView,
  subagentElapsedMs,
} from "@liveagent/ui/contracts/subagentPane";
import { useLocale } from "@liveagent/ui/i18n/index";
import { summarizeToolCall } from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type ReactNode, useEffect, useState } from "react";
import { Bot, ChevronRight } from "../../IconSet";
import { compactInlineText, getToolDisplayName } from "./assistantBubbleUtils";

/** Re-renders every second while `active`, for durations that count up. */
export function useTickingNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function subagentStatusLabel(
  status: SubagentView["status"],
  t: (key: string) => string,
): string {
  switch (status) {
    case "running":
      return t("chat.tool.running");
    case "done":
      return t("chat.tool.success");
    case "cancelled":
      return t("chat.tool.stopped");
    default:
      return t("chat.tool.failed");
  }
}

/** Model, duration, tokens and tool count, as the card and the pane header show them. */
export function subagentMetaParts(
  view: SubagentView,
  now: number,
  t: (key: string) => string,
): string[] {
  const parts: string[] = [];
  if (view.model) parts.push(view.model);
  const duration = formatSubagentDuration(subagentElapsedMs(view, now));
  if (duration) parts.push(duration);
  const tokens = formatSubagentTokens(view.tokens);
  if (tokens) parts.push(t("chat.subagent.tokens").replace("{count}", tokens));
  if (view.toolCount === 1) parts.push(t("chat.subagent.toolCountOne"));
  else if (view.toolCount) {
    parts.push(t("chat.subagent.toolCount").replace("{count}", String(view.toolCount)));
  }
  return parts;
}

// The argument that says most about a child tool call, in the order tools name it.
// A search pattern says more than the directory it runs in.
const LATEST_TOOL_ARGUMENT_KEYS = [
  "command",
  "pattern",
  "query",
  "file_path",
  "path",
  "url",
  "description",
];

/** "Read · src/app.ts": the child tool a running subagent started last. */
export function subagentLatestToolText(view: SubagentView) {
  if (!view.latestTool) return "";
  const { name, arguments: args } = view.latestTool;
  const label = getToolDisplayName(name);
  const key = LATEST_TOOL_ARGUMENT_KEYS.find(
    (candidate) => typeof args[candidate] === "string" && args[candidate],
  );
  const summary = key
    ? compactInlineText(args[key], 160)
    : summarizeToolCall(
        { type: "toolCall", id: "", name, arguments: args },
        { includeName: false, includeManagerAction: false },
      );
  return summary ? `${label} · ${summary}` : label;
}

export function SubagentStatusText({
  view,
  className,
}: {
  view: SubagentView;
  className?: string;
}): ReactNode {
  const { t } = useLocale();
  const label = subagentStatusLabel(view.status, t);
  if (view.status === "running") {
    return (
      <AssistantStatus
        className={cn("min-h-0 gap-1.5 text-xs text-foreground/45", className)}
        iconClassName="size-3"
      >
        {label}
      </AssistantStatus>
    );
  }
  return (
    <span
      className={cn(
        "text-xs",
        view.status === "error" ? "text-[hsl(var(--chat-error))]" : "text-foreground/45",
        className,
      )}
    >
      {label}
    </span>
  );
}

/**
 * One subagent in the parent transcript: what it was asked, how it is doing, and
 * what it is doing now. Clicking it opens its own transcript in the side pane.
 */
export function SubagentCard({
  view,
  onOpen,
  label,
}: {
  view: SubagentView;
  onOpen: () => void;
  /** Replaces the "Subagent" prefix, e.g. "Follow-up" on a follow-up's card. */
  label?: string;
}) {
  const { t } = useLocale();
  const running = view.status === "running";
  const now = useTickingNow(running && view.startedAtMs !== undefined);
  const meta = subagentMetaParts(view, now, t);
  const latestTool = running ? subagentLatestToolText(view) : "";
  return (
    <button
      type="button"
      onClick={onOpen}
      data-subagent-card={view.id}
      aria-label={t("chat.subagent.open").replace("{name}", view.description)}
      title={view.error || undefined}
      className={cn(
        "group/subagent my-1 flex w-full min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-left",
        "border-foreground/[0.08] bg-foreground/[0.015] transition-colors duration-150",
        "hover:border-foreground/[0.14] hover:bg-foreground/[0.04]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] text-foreground/60">
        <Bot className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-xs text-foreground/45">
            {label ?? t("chat.subagent.label")}
          </span>
          <span className="min-w-0 truncate text-sm font-[450] text-foreground/80">
            {view.description}
          </span>
        </span>
        {meta.length > 0 || latestTool ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-foreground/45">
            {meta.length > 0 ? (
              <span className="shrink-0 tabular-nums">{meta.join(" · ")}</span>
            ) : null}
            {latestTool ? (
              <span className="min-w-0 truncate font-mono text-foreground/50" title={latestTool}>
                {meta.length > 0 ? "— " : ""}
                {latestTool}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <SubagentStatusText view={view} />
        <ChevronRight className="size-3 text-foreground/35 transition-colors group-hover/subagent:text-foreground/60" />
      </span>
    </button>
  );
}

/**
 * A `subagent` tool call: the subagent card once the host links the call to its
 * subagent, the plain tool row otherwise (older backends, hosts without subagents).
 *
 * A `subagent_followup` call shows the same subagent's card (its transcript carries
 * on in the same conversation). K-brain keeps the subagent's own status while the
 * follow-up runs, so the card takes its status from the follow-up call instead.
 */
export function SubagentToolCall({
  toolCallId,
  fallback,
  followup,
}: {
  toolCallId: string;
  fallback: ReactNode;
  followup?: { running: boolean; failed: boolean };
}) {
  const { t } = useLocale();
  const binding = useSubagentCard(toolCallId);
  if (!binding) return <>{fallback}</>;
  if (!followup) return <SubagentCard view={binding.view} onOpen={binding.open} />;
  const status: SubagentView["status"] = followup.running
    ? "running"
    : followup.failed
      ? "error"
      : binding.view.status === "running"
        ? "done"
        : binding.view.status;
  return (
    <SubagentCard
      view={status === binding.view.status ? binding.view : { ...binding.view, status }}
      onOpen={binding.open}
      label={t("chat.subagent.followupLabel")}
    />
  );
}

/**
 * `subagent_status` / `subagent_steer` / `subagent_cancel`: a concise tool row named
 * after the subagent's description when the host knows the subagent.
 */
export function SubagentControlToolCall({
  toolCallId,
  render,
}: {
  toolCallId: string;
  render: (subagentLabel: string | undefined) => ReactNode;
}) {
  const binding = useSubagentCard(toolCallId);
  return <>{render(binding?.view.description)}</>;
}
