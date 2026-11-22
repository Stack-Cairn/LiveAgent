import type { ReactNode } from "react";
import { useLocale } from "../../i18n/index";
import { VIBING_STATUS } from "../../lib/chat/assistantStatus";
import { cn } from "../../lib/shared/utils";
import { Loader2, Square } from "../IconSet";
import { CompactionBand } from "./CompactionBand";
import { LiveTurnStatus } from "./LiveTurnStatus";

export { isStoppedReply, VIBING_STATUS } from "../../lib/chat/assistantStatus";

/** Settled marker for a reply the user stopped, in place of any transport abort text. */
export function GenerationStoppedNotice({ className }: { className?: string }) {
  const { t } = useLocale();
  return (
    <span
      className={cn(
        "inline-flex min-h-5 min-w-0 max-w-full items-center gap-1.5 text-sm font-normal text-muted-foreground",
        className,
      )}
      data-generation-stopped=""
    >
      <Square aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 truncate whitespace-nowrap">{t("chat.generationStopped")}</span>
    </span>
  );
}

export function VibingText({ className }: { className?: string }) {
  return <AssistantStatus className={className}>{VIBING_STATUS}</AssistantStatus>;
}

/**
 * The live "compressing context" status. Wears the same violet band as the
 * settled compaction seam so the two moments of one event look alike, and
 * so the fold stands out from ordinary grey tool/reasoning rows while
 * scanning history.
 */
export function CompactingText({ className }: { className?: string }) {
  const { t } = useLocale();
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn("flex min-w-0 max-w-full items-center", className)}
      data-compacting-status=""
    >
      <CompactionBand active label={t("chat.compactingContext")} />
    </span>
  );
}

/**
 * The single live status row of a running turn (see LiveTurnStatus). Every
 * surface that shows a reply in progress renders exactly one of these, below
 * the turn's content; nothing else in the turn carries a spinner.
 */
export function LiveAssistantStatus(props: {
  status: string | null;
  isCompaction?: boolean;
  awaitingDecision?: boolean;
  startedAtMs?: number;
  hasRunningTool?: boolean;
  toolActivity?: { label: string; title?: string } | null;
  className?: string;
}) {
  const { isCompaction = false, ...rest } = props;
  return <LiveTurnStatus {...rest} compacting={isCompaction} />;
}

export function AssistantStatus({
  children,
  className,
  iconClassName,
  textClassName,
}: {
  children: ReactNode;
  className?: string;
  iconClassName?: string;
  textClassName?: string;
}) {
  return (
    <span
      role="status"
      className={cn(
        "inline-flex min-h-5 min-w-0 max-w-full items-center gap-1.5 text-sm font-normal text-muted-foreground",
        className,
      )}
    >
      <Loader2
        aria-hidden="true"
        className={cn("size-3.5 shrink-0 animate-spin motion-reduce:animate-none", iconClassName)}
      />
      <span className={cn("shimmer min-w-0 truncate whitespace-nowrap", textClassName)}>
        {children}
      </span>
    </span>
  );
}
