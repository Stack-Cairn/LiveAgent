import { assistantStatusSpinnerClassName } from "@liveagent/adapters/assistantStatus";
import { Loader2 } from "@liveagent/app/components/icons";
import type { ReactNode } from "react";
import { useLocale } from "../../i18n/index";
import { normalizeLiveToolStatus, VIBING_STATUS } from "../../lib/chat/assistantStatus";
import { cn } from "../../lib/shared/utils";

export { VIBING_STATUS } from "../../lib/chat/assistantStatus";

export function VibingText({ className }: { className?: string }) {
  return <AssistantStatus className={className}>{VIBING_STATUS}</AssistantStatus>;
}

export function CompactingText({ className }: { className?: string }) {
  const { t } = useLocale();
  return <AssistantStatus className={className}>{t("chat.compactingContext")}</AssistantStatus>;
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
    return <VibingText className={className} />;
  }
  return <AssistantStatus className={className}>{normalizedStatus}</AssistantStatus>;
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
        "inline-flex min-h-5 min-w-0 max-w-full items-center gap-2 text-[calc(13px*var(--zone-font-scale,1))] font-normal text-muted-foreground",
        className,
      )}
    >
      <Loader2
        aria-hidden="true"
        className={cn(
          "h-3.5 w-3.5 shrink-0 animate-spin",
          assistantStatusSpinnerClassName,
          iconClassName,
        )}
      />
      <span className={cn("shimmer min-w-0 truncate whitespace-nowrap", textClassName)}>
        {children}
      </span>
    </span>
  );
}
