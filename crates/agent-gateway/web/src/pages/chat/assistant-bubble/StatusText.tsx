import type { ReactNode } from "react";
import { Loader2 } from "../../../components/icons";
import { useLocale } from "../../../i18n";
import { VIBING_STATUS } from "../../../lib/chat/chatPageHelpers";
import { cn } from "../../../lib/shared/utils";

export function VibingText({ className }: { className?: string }) {
  return <AssistantStatus className={className}>{VIBING_STATUS}</AssistantStatus>;
}

export function CompactingText({ className }: { className?: string }) {
  const { t } = useLocale();
  return <AssistantStatus className={className}>{t("chat.compactingContext")}</AssistantStatus>;
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
        "inline-flex min-h-5 items-center gap-2 text-[calc(13px*var(--zone-font-scale,1))] font-normal text-muted-foreground",
        className,
      )}
    >
      <Loader2
        aria-hidden="true"
        className={cn("h-3.5 w-3.5 shrink-0 animate-spin", iconClassName)}
      />
      <span className={cn("shimmer", textClassName)}>{children}</span>
    </span>
  );
}
