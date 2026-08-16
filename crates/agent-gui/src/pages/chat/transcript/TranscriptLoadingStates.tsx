import { LoaderCircle } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";

export function HistorySwitchLoadingOverlay() {
  const { t } = useLocale();
  const label = t("chat.loadingConversation");

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-background/95 backdrop-blur-[2px]"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background/95 px-3.5 py-2 text-xs font-medium text-muted-foreground shadow-sm">
        <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
        <span>{label}</span>
      </div>
    </div>
  );
}
