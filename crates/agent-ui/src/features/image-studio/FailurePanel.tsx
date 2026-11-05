import { useState } from "react";
import { AlertTriangle, ImageOff } from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import type { ImageError, ImageJob } from "../../lib/imaging/types";
import type { ImageStudioController } from "./studioController";
import {
  errorActionMessage,
  type FailureKind,
  failureKind,
  isSlowDirectDownload,
} from "./studioModel";
import { formatMessage, imageErrorText } from "./studioText";

const titleKeys: Record<FailureKind, string> = {
  unknown: "imageStudio.failure.title.unknown",
  saveFailed: "imageStudio.failure.title.saveFailed",
  rejected: "imageStudio.failure.title.rejected",
  noOutput: "imageStudio.failure.title.noOutput",
  auth: "imageStudio.failure.title.auth",
  rateLimit: "imageStudio.failure.title.rateLimit",
  eventGap: "imageStudio.failure.title.eventGap",
  other: "imageStudio.noImage",
};

/**
 * The error that explains a failed job. An unknown outcome or a lost output anywhere wins,
 * since either may already be billed, and among lost outputs the one with a known remedy;
 * otherwise the job's own error, else the first item's.
 */
export function primaryJobError(job: ImageJob): ImageError | undefined {
  const errors = [job.error, ...job.items.map((item) => item.error)].filter(
    (error): error is ImageError => Boolean(error),
  );
  return (
    errors.find((error) => failureKind(error) === "unknown") ??
    errors.find(isSlowDirectDownload) ??
    errors.find((error) => failureKind(error) === "saveFailed") ??
    errors[0]
  );
}

/**
 * Explains why a job produced no image and offers the next step that fits the cause.
 * A result-unknown job may already be billed, so checking comes before regenerating.
 */
export function FailurePanel({
  job,
  controller,
  onOpenSettings,
}: {
  job: ImageJob;
  controller: ImageStudioController;
  onOpenSettings?: () => void;
}) {
  const { t } = useLocale();
  const [checking, setChecking] = useState(false);
  const [unchanged, setUnchanged] = useState(false);
  const error = primaryJobError(job);
  const kind = failureKind(error);
  const checkFirst = kind === "unknown" || job.status === "result_unknown";
  // The provider already answered with an image that was lost; rechecking cannot recover it.
  const lostOutput = !checkFirst && kind === "saveFailed";
  const mayBeBilled = checkFirst || lostOutput;
  // A recheck re-reads the backend's record; it cannot ask a provider about a sent request.
  // Say so when nothing changed, or the button looks dead. A changed job replaces this panel.
  const recheck = async () => {
    setChecking(true);
    setUnchanged(false);
    const read = await controller.refreshJob(job.id);
    setChecking(false);
    setUnchanged(read);
  };
  const regenerate = (
    <Button
      size="sm"
      variant={mayBeBilled ? "outline" : "default"}
      onClick={() => void controller.restoreJob(job.id)}
    >
      {t("imageStudio.restoreRetry")}
    </Button>
  );
  return (
    <div className="my-auto flex max-h-full w-full max-w-lg flex-col gap-4 overflow-y-auto px-6 py-5 lg:py-10">
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg ${mayBeBilled ? "bg-amber-500/15 text-amber-600 dark:text-amber-300" : "bg-muted text-muted-foreground"}`}
        >
          {mayBeBilled ? (
            <AlertTriangle className="size-5" strokeWidth={1.75} />
          ) : (
            <ImageOff className="size-5" strokeWidth={1.75} />
          )}
        </span>
        <div className="min-w-0 space-y-1">
          <h3 className="text-base font-semibold">{t(titleKeys[checkFirst ? "unknown" : kind])}</h3>
          {error && (
            <p className="break-words text-sm text-muted-foreground">{imageErrorText(error, t)}</p>
          )}
          {/* A cancelled job has no error, and nothing about it needs fixing. */}
          {error && (
            <p className="text-sm text-muted-foreground">
              {formatMessage(errorActionMessage(error), t)}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {checkFirst && (
          <Button size="sm" disabled={checking} onClick={() => void recheck()}>
            {t("imageStudio.failure.checkResult")}
          </Button>
        )}
        {(kind === "auth" || isSlowDirectDownload(error)) && onOpenSettings && (
          <Button size="sm" onClick={onOpenSettings}>
            {t("imageStudio.failure.openSettings")}
          </Button>
        )}
        {regenerate}
      </div>
      {unchanged && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("imageStudio.failure.recheckUnchanged")}
        </p>
      )}
      {mayBeBilled && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {t(
            lostOutput ? "imageStudio.failure.savedBilling" : "imageStudio.failure.billingWarning",
          )}
        </p>
      )}
      {error && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-xs">
          <dt className="text-muted-foreground">{t("imageStudio.failure.code")}</dt>
          <dd className="break-all font-mono">{error.code}</dd>
          {error.requestId && (
            <>
              <dt className="text-muted-foreground">{t("imageStudio.failure.requestId")}</dt>
              <dd className="break-all font-mono">{error.requestId}</dd>
            </>
          )}
          {error.reason && (
            <>
              <dt className="text-muted-foreground">{t("imageStudio.failure.reason")}</dt>
              <dd className="break-words">{error.reason}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}
