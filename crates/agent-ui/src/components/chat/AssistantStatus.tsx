import type { ReactNode } from "react";
import { useLocale } from "../../i18n/index";
import {
  compactionProgressDetail,
  normalizeLiveToolStatus,
  VIBING_STATUS,
} from "../../lib/chat/assistantStatus";
import { cn } from "../../lib/shared/utils";
import { CompactionBand } from "./CompactionBand";
import { LiveSparkle } from "./LiveSparkle";

export { VIBING_STATUS } from "../../lib/chat/assistantStatus";

export function VibingText({ className }: { className?: string }) {
  return <AssistantStatus className={className}>{VIBING_STATUS}</AssistantStatus>;
}

/**
 * The live "compressing context" status. Wears the same violet band as the
 * settled compaction seam so the two moments of one event look alike, and
 * so the fold stands out from ordinary grey tool/reasoning rows while
 * scanning history. `progress` is the raw compaction tool status; its
 * locale-neutral progress (output tokens, retries, stage, elapsed) shows as a
 * muted suffix, hidden from the live region so the ticking clock is not
 * re-announced.
 */
export function CompactingText({
  className,
  progress,
}: {
  className?: string;
  progress?: string | null;
}) {
  const { t } = useLocale();
  const detail = compactionProgressDetail(progress);
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn("flex min-w-0 max-w-full items-center", className)}
      data-compacting-status=""
    >
      <CompactionBand
        active
        label={t("chat.compactingContext")}
        meta={
          detail ? (
            <span
              aria-hidden="true"
              className="truncate text-tiny tabular-nums text-violet-700/60 dark:text-violet-300/60"
            >
              {detail}
            </span>
          ) : undefined
        }
      />
    </span>
  );
}

export function LiveAssistantStatus(props: {
  status: string | null;
  isCompaction?: boolean;
  className?: string;
}) {
  const { status, isCompaction = false, className } = props;
  const normalizedStatus = normalizeLiveToolStatus(status);
  if (isCompaction) return <CompactingText className={className} progress={status} />;
  if (!normalizedStatus || normalizedStatus === VIBING_STATUS) {
    // No concrete activity to report — show the liveness sparkle instead of a
    // filler phrase, matching the turn-level indicator under live replies.
    return <LiveSparkle className={className} />;
  }
  return <AssistantStatus className={className}>{normalizedStatus}</AssistantStatus>;
}

export function AssistantStatus({
  children,
  className,
  textClassName,
}: {
  children: ReactNode;
  className?: string;
  /** Kept for caller compatibility; text-only statuses intentionally render no loader icon. */
  iconClassName?: string;
  textClassName?: string;
}) {
  return (
    <span
      role="status"
      className={cn(
        "inline-flex min-h-5 min-w-0 max-w-full items-center text-sm font-normal text-muted-foreground",
        className,
      )}
    >
      <span className={cn("shimmer min-w-0 truncate whitespace-nowrap", textClassName)}>
        {children}
      </span>
    </span>
  );
}
