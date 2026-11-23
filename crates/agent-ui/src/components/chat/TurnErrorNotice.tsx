import "@liveagent/ui/i18n/namespaces/turnErrors";
import { Button } from "@liveagent/ui/components/ui/button";
import { createContext, memo, useContext, useMemo } from "react";
import { useLocale } from "../../i18n/index";
import {
  classifyTurnError,
  type TurnErrorDetail,
  type TurnErrorKind,
} from "../../lib/chat/turnError";
import { cn } from "../../lib/shared/utils";
import { AlertCircle, ChevronRight, RotateCcw, Settings } from "../IconSet";

const COPY_KEYS: Record<TurnErrorKind, string> = {
  auth: "auth",
  rate_limit: "rateLimit",
  server: "server",
  connection: "connection",
  timeout: "timeout",
  context_limit: "contextLimit",
  bad_request: "badRequest",
  unknown: "unknown",
};

/**
 * Opens provider settings from an "invalid API key" error. The transcript that
 * owns the settings navigation provides it; without it the button is hidden.
 */
const TurnErrorSettingsContext = createContext<(() => void) | null>(null);
export const TurnErrorSettingsProvider = TurnErrorSettingsContext.Provider;

/**
 * The typed error row of a failed turn, shared by the desktop transcript and
 * the WebUI: a translated explanation of the failure, a Retry action that
 * resends the turn's prompt, provider settings for a rejected key, and the raw
 * error collapsed underneath.
 */
export const TurnErrorNotice = memo(function TurnErrorNotice({
  error,
  errorDetail,
  onRetry,
  retryDisabled = false,
  className,
}: {
  /** The failure exactly as the backend reported it. */
  error: string;
  /** The backend's structured classification; preferred over reading the text. */
  errorDetail?: TurnErrorDetail | null;
  /** Resend the failed turn's prompt; the Retry button is hidden without it. */
  onRetry?: () => void;
  retryDisabled?: boolean;
  className?: string;
}) {
  const { t } = useLocale();
  const openProviderSettings = useContext(TurnErrorSettingsContext);
  const info = useMemo(() => classifyTurnError(error, errorDetail), [error, errorDetail]);
  const copy = COPY_KEYS[info.kind];
  const showDetail = info.detail && info.detail !== info.raw;

  return (
    <div
      role="alert"
      className={cn(
        "flex w-full min-w-0 max-w-full flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm",
        className,
      )}
      data-turn-error={info.kind}
    >
      <div className="flex min-w-0 items-start gap-2">
        <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-destructive">
              {t(`chat.turnError.${copy}.title`)}
            </span>
            {info.status ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {t("chat.turnError.status").replace("{status}", String(info.status))}
              </span>
            ) : null}
          </div>
          <p className="break-words text-muted-foreground">{t(`chat.turnError.${copy}.body`)}</p>
          {showDetail ? <p className="break-words text-foreground/80">{info.detail}</p> : null}
        </div>
      </div>
      {onRetry || (info.kind === "auth" && openProviderSettings) ? (
        <div className="flex flex-wrap items-center gap-2 pl-6">
          {onRetry ? (
            <Button
              size="sm"
              variant="outline"
              disabled={retryDisabled}
              onClick={onRetry}
              data-turn-error-retry=""
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
              {t("chat.turnError.retry")}
            </Button>
          ) : null}
          {info.kind === "auth" && openProviderSettings ? (
            <Button size="sm" variant="ghost" onClick={openProviderSettings}>
              <Settings aria-hidden="true" className="size-3.5" />
              {t("chat.turnError.openProviderSettings")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <details className="group/turn-error pl-6">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden="true"
            className="size-3 transition-transform group-open/turn-error:rotate-90"
          />
          {t("chat.turnError.details")}
        </summary>
        <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-muted/50 px-2 py-1.5 font-mono text-xs text-muted-foreground">
          {info.raw}
        </pre>
      </details>
    </div>
  );
});
