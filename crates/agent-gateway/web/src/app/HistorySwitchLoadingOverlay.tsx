import { Loader2 } from "@liveagent/ui/components/IconSet";
import { t as translate } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { AppSettings } from "@/lib/settings";

export function HistorySwitchLoadingOverlay(props: { locale: AppSettings["locale"] }) {
  const label = translate("chat.loadingConversation", props.locale);

  return (
    <div
      className="absolute inset-0 z-(--layer-panel) flex items-center justify-center bg-background/95 backdrop-blur-2px"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div
        className={cn(
          "inline-flex items-center gap-2",
          "border border-solid border-border/60 rounded-full bg-background/95 text-muted-foreground shadow-gateway-history-switch-overlay-card",
          "px-3.5 py-2 text-xs font-medium leading-1rem",
        )}
      >
        <Loader2 className="size-4 animate-spin text-primary" />
        <span>{label}</span>
      </div>
    </div>
  );
}
