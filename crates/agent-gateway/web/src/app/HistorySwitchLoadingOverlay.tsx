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
          "inline-flex items-center gap-0p5rem",
          "border border-solid border-border/60 rounded-full bg-background/95 text-muted-foreground shadow-gateway-history-switch-overlay-card",
          "px-0p875rem py-0p5rem text-xs font-medium leading-1rem",
        )}
      >
        <Loader2 className="size-4 animate-spin text-primary" />
        <span>{label}</span>
      </div>
    </div>
  );
}
