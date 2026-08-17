import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo, useState } from "react";
import { useLocale } from "../../i18n/index";
import type { RetryAttemptRecord } from "../../lib/chat/retryAttempts";
import { ChevronRight, RefreshCw } from "../IconSet";
import { LazyCollapse } from "./LazyCollapse";

// Expandable per-attempt stream-retry history for the live run.
export const RetryDetailsBlock = memo(function RetryDetailsBlock({
  attempts,
}: {
  attempts: readonly RetryAttemptRecord[];
}) {
  const { t } = useLocale();
  const [isOpen, setIsOpen] = useState(false);

  if (attempts.length === 0) return null;

  return (
    <div className="group/retry w-full">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
        className="retry-details-toggle flex w-full cursor-pointer select-none items-center gap-2 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] font-normal text-muted-foreground/80 hover:text-foreground"
      >
        <RefreshCw className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <span>{t("chat.retryDetailsToggle").replace("{count}", String(attempts.length))}</span>
        <ChevronRight
          className={cn(
            "ml-auto h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-200 ease-out",
            isOpen ? "rotate-90" : "",
          )}
        />
      </button>
      <LazyCollapse open={isOpen}>
        {() => (
          <div className="space-y-1 pb-1 pt-1.5">
            {/* Index-keyed: attempt ordinals can repeat within one list (text
                mode's tool-recovery loop restarts each wrapper's counter at 1)
                and the list is append-only, so the index is the stable key. */}
            {attempts.map((entry, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: retry attempts are append-only and their reported ordinals can repeat.
                key={`${index}-${entry.attempt}-${entry.maxAttempts}`}
                className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] text-muted-foreground"
              >
                <div className="font-medium text-foreground/80">
                  {t("chat.retryAttemptLabel")
                    .replace("{attempt}", String(entry.attempt))
                    .replace("{maxAttempts}", String(entry.maxAttempts))}
                </div>
                <div className="whitespace-pre-wrap break-words">{entry.errorMessage}</div>
              </div>
            ))}
          </div>
        )}
      </LazyCollapse>
    </div>
  );
});
