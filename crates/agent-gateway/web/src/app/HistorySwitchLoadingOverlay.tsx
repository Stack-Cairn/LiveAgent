import { Loader2 } from "@liveagent/ui/components/IconSet";
import type { AppSettings } from "@/lib/settings";

export function HistorySwitchLoadingOverlay(props: { locale: AppSettings["locale"] }) {
  const label = props.locale === "en-US" ? "Loading conversation..." : "正在加载对话...";

  return (
    <div
      className="gateway-history-switch-overlay"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div className="gateway-history-switch-overlay-card">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span>{label}</span>
      </div>
    </div>
  );
}
