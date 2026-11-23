import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useEffect, useRef, useState } from "react";

// How long "Reconnected" stays visible after the connection comes back.
const GATEWAY_RECONNECTED_NOTICE_MS = 2_500;

type GatewayConnectionBannerProps = {
  // The Gateway connection is down (dropped after it was up, or the first
  // connect failed with a transport error).
  disconnected: boolean;
  onRetryNow?: () => void;
};

/**
 * Connection status for the chat surface: a polite live region that says the
 * connection dropped and is being re-established (with a manual retry), then
 * briefly confirms the recovery. Replaces the raw WebSocket close text.
 */
export function GatewayConnectionBanner({
  disconnected,
  onRetryNow,
}: GatewayConnectionBannerProps) {
  const { t } = useLocale();
  const [showReconnected, setShowReconnected] = useState(false);
  const wasDisconnectedRef = useRef(disconnected);

  useEffect(() => {
    const wasDisconnected = wasDisconnectedRef.current;
    wasDisconnectedRef.current = disconnected;
    if (disconnected) {
      setShowReconnected(false);
      return;
    }
    if (!wasDisconnected) return;
    setShowReconnected(true);
    const timer = window.setTimeout(() => setShowReconnected(false), GATEWAY_RECONNECTED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [disconnected]);

  return (
    <GatewayConnectionBannerView
      state={disconnected ? "disconnected" : showReconnected ? "reconnected" : "hidden"}
      label={
        disconnected
          ? t("gatewayWeb.connection.lost")
          : showReconnected
            ? t("gatewayWeb.connection.reconnected")
            : ""
      }
      retryLabel={t("gatewayWeb.connection.retryNow")}
      onRetryNow={onRetryNow}
    />
  );
}

type GatewayConnectionBannerViewProps = {
  state: "disconnected" | "reconnected" | "hidden";
  label: string;
  retryLabel: string;
  onRetryNow?: () => void;
};

export function GatewayConnectionBannerView({
  state,
  label,
  retryLabel,
  onRetryNow,
}: GatewayConnectionBannerViewProps) {
  // The live region stays mounted so screen readers announce each change.
  return (
    <div role="status" aria-live="polite" data-testid="gateway-connection-status">
      {state === "hidden" ? null : (
        <div
          className={cn(
            "mx-20px mt-12px mb-0 flex items-center gap-8px rounded-xl border px-12px py-8px text-sm",
            "max-640:mx-10px max-640:mt-8px max-640:mb-0",
            state === "disconnected"
              ? "border-warning/20 bg-warning/8 text-foreground"
              : "border-success/20 bg-success/8 text-foreground",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-8px shrink-0 rounded-full",
              state === "disconnected" ? "animate-pulse bg-muted-foreground/50" : "bg-success",
            )}
          />
          <span className="min-w-0 flex-1">{label}</span>
          {state === "disconnected" && onRetryNow ? (
            <Button type="button" variant="outline" size="sm" onClick={onRetryNow}>
              {retryLabel}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
