import { type ReactNode, useEffect, useState } from "react";
import { AppErrorBoundary } from "../../components/AppErrorBoundary";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  ImageIcon,
  ImageOff,
  Info,
  Loader2,
  RefreshCw,
  X,
} from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import type { ExportDestination, ImageStudioClient } from "../../lib/imaging/types";
import { AssetImage } from "./AssetImage";
import { AssetLightbox } from "./AssetLightbox";
import type { DraftStorage } from "./drafts";
import { splitFramedPrompt } from "./framing";
import { ImageComposer } from "./ImageComposer";
import { ResultGallery } from "./ResultGallery";
import {
  formatJobTime,
  jobErrorLines,
  type NoticeTone,
  noticeDuration,
  statusLabel,
  terminalJob,
} from "./studioModel";
import { formatMessage, message } from "./studioText";
import { useImageStudio } from "./useImageStudio";

export interface ImageStudioPageProps {
  client: ImageStudioClient;
  ownerId: string;
  backendId: string;
  exportDestinations?: readonly ExportDestination[];
  storage?: DraftStorage;
  onOpenSettings?: () => void;
  /** Host-level controls for the title bar, e.g. the app theme toggle. */
  headerActions?: ReactNode;
}
const noticeStyles: Record<NoticeTone, { className: string; Icon: typeof Info }> = {
  success: { className: "border-success/30 bg-success/10 text-success", Icon: CheckCircle2 },
  info: { className: "border-border bg-popover text-foreground", Icon: Info },
  warning: {
    className:
      "border-amber-500/30 bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
    Icon: AlertTriangle,
  },
  error: {
    className: "border-destructive/30 bg-destructive/10 text-destructive",
    Icon: AlertCircle,
  },
};

function StudioNotice({
  text,
  tone,
  persistent,
  onDismiss,
  onReconnect,
}: {
  text: string;
  tone: NoticeTone;
  persistent: boolean;
  onDismiss: () => void;
  onReconnect: () => void;
}) {
  const { t } = useLocale();
  const duration = persistent ? null : noticeDuration[tone];
  // biome-ignore lint/correctness/useExhaustiveDependencies: the countdown restarts only when the message changes
  useEffect(() => {
    if (duration === null) return;
    const timer = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timer);
  }, [text, duration]);
  const { className, Icon } = noticeStyles[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      // Centered over the title row: the right edge holds header actions (theme
      // toggle, mobile history) that a persistent error must not cover.
      className={`absolute left-1/2 top-3 z-30 flex w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm shadow-lg backdrop-blur-sm ${className}`}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="max-h-24 min-w-0 flex-1 overflow-y-auto break-words leading-snug">
        {text}
      </span>
      {persistent ? (
        <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={onReconnect}>
          {t("imageStudio.reconnect")}
        </Button>
      ) : (
        <button
          type="button"
          aria-label={t("imageStudio.dismissNotice")}
          onClick={onDismiss}
          className="-mr-1 shrink-0 rounded-md p-0.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

export function ImageStudioPage(props: ImageStudioPageProps) {
  return (
    <AppErrorBoundary key={`${props.ownerId}:${props.backendId}`}>
      <ImageStudioWorkbench {...props} />
    </AppErrorBoundary>
  );
}
function ImageStudioWorkbench({
  client,
  ownerId,
  backendId,
  exportDestinations = [],
  storage,
  onOpenSettings,
  headerActions,
}: ImageStudioPageProps) {
  const { controller, view } = useImageStudio(client, ownerId, backendId, storage);
  const { locale, t } = useLocale();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  useEffect(
    () =>
      client.subscribeSettingsSaved?.(() => {
        void controller.refreshTargets();
      }),
    [client, controller],
  );
  useEffect(() => {
    const refresh = () => {
      void controller.refreshTargets();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [controller]);
  const jobs = Object.values(view.state.jobs).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const { selectedJobId, selectedAssetId } = view.state;
  // An explicit history pick wins; otherwise follow the selected image, else the newest result.
  const selectedJob =
    (selectedJobId ? view.state.jobs[selectedJobId] : undefined) ??
    (selectedAssetId
      ? jobs.find((job) => job.assetIds.includes(selectedAssetId))
      : jobs.find((job) => job.assetIds.length > 0));
  const jobAssets = selectedJob ? [...new Set(selectedJob.assetIds)] : [];
  const selected =
    selectedAssetId && (!selectedJob || jobAssets.includes(selectedAssetId))
      ? selectedAssetId
      : jobAssets[0];
  const selectedIndex = selected ? jobAssets.indexOf(selected) : -1;
  const selectedPrompt = selectedJob ? splitFramedPrompt(selectedJob.request.prompt) : undefined;
  if (view.supported === false)
    return (
      <section className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-lg font-semibold">{t("imageStudio.unavailableTitle")}</h1>
        <p className="max-w-lg text-sm text-muted-foreground">{t("imageStudio.unavailableBody")}</p>
        <Button variant="outline" onClick={() => void controller.start()}>
          {t("imageStudio.recheck")}
        </Button>
      </section>
    );
  if (view.supported === null)
    return (
      <section
        className="flex h-full flex-col items-center justify-center gap-3 p-6"
        aria-busy={view.loading}
      >
        <p role="status">
          {view.loading
            ? t("imageStudio.connecting")
            : view.notice || t("imageStudio.connectFailed")}
        </p>
        {!view.loading && (
          <Button variant="outline" onClick={() => void controller.start()}>
            {t("imageStudio.retryConnect")}
          </Button>
        )}
      </section>
    );
  return (
    <section
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
      aria-label={t("imageStudio.name")}
    >
      <header className="shrink-0 px-4 pt-4 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold tracking-tight">{t("imageStudio.title")}</h1>
          <div className="flex items-center gap-1">
            <Button
              className="lg:hidden"
              variant="ghost"
              size="sm"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen(!historyOpen)}
            >
              {t("imageStudio.history")}
            </Button>
            {headerActions}
          </div>
        </div>
        <div className="mt-3 border-b border-border">
          <span className="inline-flex border-b-2 border-primary px-4 pb-3 text-sm font-medium text-primary">
            {t("imageStudio.imagesTab")}
          </span>
        </div>
      </header>
      {view.pendingSubmissions.length > 0 && (
        <section
          aria-label={t("imageStudio.pending.label")}
          className="mx-4 mt-3 max-h-32 shrink-0 overflow-y-auto rounded-lg border border-border px-3 py-2 text-sm sm:mx-6"
        >
          <p>{t("imageStudio.pending.body")}</p>
          {view.pendingSubmissions.map(({ projectId, submission }) => (
            <Button
              key={projectId}
              type="button"
              variant="link"
              size="sm"
              className="max-w-full"
              disabled={view.loading}
              onClick={() => void controller.selectPendingSubmission(projectId)}
            >
              <span className="truncate">
                {formatMessage(
                  message("imageStudio.pending.view", {
                    prompt: splitFramedPrompt(submission.request.prompt).prompt,
                  }),
                  t,
                )}
              </span>
            </Button>
          ))}
        </section>
      )}
      {view.notice && (
        <StudioNotice
          key={view.noticeSeq}
          text={view.notice}
          tone={view.noticeTone}
          persistent={!view.loading && !view.draftReady}
          onDismiss={() => controller.dismissNotice(view.notice)}
          onReconnect={() => void controller.start()}
        />
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_19rem] lg:overflow-hidden xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-h-0 min-w-0 flex-col gap-4 lg:overflow-y-auto">
          <section
            aria-label={t("imageStudio.preview")}
            className="flex min-h-64 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card lg:min-h-0"
          >
            <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-4 py-2">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold" title={selectedPrompt?.prompt}>
                  {selectedPrompt ? selectedPrompt.prompt : t("imageStudio.preview")}
                </h2>
                {selectedJob && (
                  <p className="truncate text-xs text-muted-foreground">
                    {[
                      selectedJob.targetSnapshot.name,
                      statusLabel(selectedJob.status, t),
                      formatJobTime(selectedJob.createdAt, locale),
                      [selectedPrompt?.framing?.ratio, selectedPrompt?.framing?.tier]
                        .filter(Boolean)
                        .join(" "),
                      jobAssets.length > 1 && selectedIndex >= 0
                        ? formatMessage(
                            message("imageStudio.imageIndex", {
                              index: selectedIndex + 1,
                              total: jobAssets.length,
                            }),
                            t,
                          )
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </div>
              {selected && exportDestinations.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void controller.exportAsset(
                      selected,
                      exportDestinations.includes("download") ? "download" : exportDestinations[0],
                    )
                  }
                >
                  <Download className="mr-1.5 size-4" />
                  {t("imageStudio.download")}
                </Button>
              )}
            </div>
            <div className="relative flex min-h-48 flex-1 items-center justify-center overflow-hidden bg-muted/20">
              {selected ? (
                <button
                  type="button"
                  aria-label={t("imageStudio.viewLarge")}
                  title={t("imageStudio.viewLargeHint")}
                  className="absolute inset-0 flex cursor-zoom-in items-center justify-center focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => setLightboxOpen(true)}
                >
                  <AssetImage
                    client={client}
                    assetId={selected}
                    original
                    alt={selectedPrompt?.prompt || t("imageStudio.previewAlt")}
                    className="h-full w-full object-contain p-3"
                  />
                </button>
              ) : selectedJob && !terminalJob(selectedJob) ? (
                <div className="flex flex-col items-center gap-3 px-6 py-12 text-center text-muted-foreground">
                  <Loader2 className="size-8 animate-spin opacity-60 motion-reduce:animate-none" />
                  <p className="text-sm">{t("imageStudio.generating")}</p>
                </div>
              ) : selectedJob ? (
                <div className="flex max-w-md flex-col items-center gap-3 px-6 py-12 text-center">
                  <ImageOff className="size-8 text-muted-foreground opacity-60" strokeWidth={1.5} />
                  <p className="text-sm font-medium">{t("imageStudio.noImage")}</p>
                  {jobErrorLines(selectedJob, t).map((line) => (
                    <p key={line} className="break-words text-xs text-destructive">
                      {line}
                    </p>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void controller.restoreJob(selectedJob.id)}
                  >
                    {t("imageStudio.restoreRetry")}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 px-6 py-12 text-center text-muted-foreground">
                  <ImageIcon className="size-8 opacity-60" strokeWidth={1.5} />
                  <p className="text-sm">{t("imageStudio.emptyPreview")}</p>
                </div>
              )}
            </div>
            {jobAssets.length > 1 && selectedJob && (
              <div className="flex shrink-0 gap-2 overflow-x-auto border-t border-border px-4 py-2">
                {jobAssets.map((id, index) => (
                  <button
                    type="button"
                    key={id}
                    aria-label={formatMessage(
                      message("imageStudio.selectResult", {
                        index: index + 1,
                        model: selectedJob.targetSnapshot.name,
                      }),
                      t,
                    )}
                    aria-pressed={selected === id}
                    className={`size-14 shrink-0 overflow-hidden rounded-md border focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ${selected === id ? "border-primary ring-1 ring-primary" : "border-border opacity-70 hover:opacity-100"}`}
                    onClick={() => controller.selectAsset(id)}
                  >
                    <AssetImage
                      client={client}
                      assetId={id}
                      alt={formatMessage(message("imageStudio.result", { index: index + 1 }), t)}
                      className="size-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
          </section>
          <ImageComposer controller={controller} view={view} onOpenSettings={onOpenSettings} />
          {selected && (
            <AssetLightbox
              client={client}
              assetIds={jobAssets.length ? jobAssets : [selected]}
              index={Math.max(0, selectedIndex)}
              title={selectedPrompt?.prompt ?? t("imageStudio.preview")}
              assets={view.state.assets}
              open={lightboxOpen}
              onClose={() => setLightboxOpen(false)}
              onFailed={() =>
                controller.showNotice(message("imageStudio.notice.error.originalLoadFailed"))
              }
            />
          )}
        </div>
        <aside
          aria-label={t("imageStudio.history")}
          className={`${historyOpen ? "flex" : "hidden"} min-h-64 min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card lg:flex lg:min-h-0`}
        >
          <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4">
            <h2 className="font-semibold">{t("imageStudio.history")}</h2>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("imageStudio.refreshHistory")}
              disabled={view.loading}
              onClick={() => void controller.refreshHistory()}
            >
              <RefreshCw
                className={`size-4 ${view.loading ? "animate-spin motion-reduce:animate-none" : ""}`}
              />
            </Button>
          </div>
          <ResultGallery
            controller={controller}
            view={view}
            activeJobId={selectedJob?.id}
            onSelectJob={(id) => {
              controller.selectJob(id);
              setHistoryOpen(false);
            }}
          />
        </aside>
      </div>
    </section>
  );
}
