import { Loader2 } from "@liveagent/ui/components/IconSet";
import { t as translate } from "@liveagent/ui/i18n/index";
import type { AppSettings } from "@/lib/settings";

export function HistorySwitchLoadingOverlay(props: { locale: AppSettings["locale"] }) {
  const label = translate("chat.loadingConversation", props.locale);

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
