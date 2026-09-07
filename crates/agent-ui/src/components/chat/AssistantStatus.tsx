import type { ReactNode } from "react";
import { useLocale } from "../../i18n/index";
import { normalizeLiveToolStatus, VIBING_STATUS } from "../../lib/chat/assistantStatus";
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

export function LiveAssistantStatus(props: {
  status: string | null;
  isCompaction?: boolean;
  className?: string;
}) {
  const { status, isCompaction = false, className } = props;
  const normalizedStatus = normalizeLiveToolStatus(status);
  if (isCompaction) return <CompactingText className={className} />;
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
        "inline-flex min-h-5 min-w-0 max-w-full items-center text-[calc(13px*var(--zone-font-scale,1))] font-normal text-muted-foreground",
        className,
      )}
    >
      <span className={cn("shimmer min-w-0 truncate whitespace-nowrap", textClassName)}>
        {children}
      </span>
    </span>
  );
}
