import {
  collectHostDiagnostics,
  DIAGNOSTICS_SAVE_LABEL_KEY,
  saveDiagnosticsBundle,
} from "@liveagent/adapters/diagnostics";
import type { AppSettings } from "@liveagent/app/lib/settings";
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Copy,
  FileText,
  Loader2,
  ShieldCheck,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  buildDiagnosticsBundle,
  type ClipboardWriter,
  copyDiagnosticsSummary,
  type DiagnosticsBundle,
} from "@liveagent/ui/lib/diagnostics/bundle";
import { getDiagnosticsCapture } from "@liveagent/ui/lib/diagnostics/recentErrors";
import { REDACTION_CATEGORIES, totalRedactions } from "@liveagent/ui/lib/diagnostics/redact";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useEffect, useRef, useState } from "react";

function formatDiagnosticsSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

type Phase =
  | { kind: "collecting" }
  | { kind: "failed"; error: string }
  | { kind: "ready"; bundle: DiagnosticsBundle };

type Notice = { tone: "ok" | "error"; text: string } | null;

export type DiagnosticsExportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: AppSettings;
  /** Injected in tests; defaults to the browser clipboard. */
  clipboard?: ClipboardWriter;
  now?: () => Date;
};

/**
 * Collects a redacted diagnostics bundle, previews every file and the redaction
 * tally, and only then saves (desktop: native dialog, browser: download).
 */
export function DiagnosticsExportDialog(props: DiagnosticsExportDialogProps) {
  const { t } = useLocale();
  const { open, onOpenChange, clipboard, now } = props;
  const [phase, setPhase] = useState<Phase>({ kind: "collecting" });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const settingsRef = useRef(props.settings);
  settingsRef.current = props.settings;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase({ kind: "collecting" });
    setNotice(null);
    void (async () => {
      try {
        const facts = await collectHostDiagnostics();
        const capture = getDiagnosticsCapture();
        const bundle = buildDiagnosticsBundle({
          ...facts,
          generatedAt: now?.() ?? new Date(),
          settings: settingsRef.current,
          recentErrors: capture?.errors() ?? [],
          appLog: capture?.log() ?? [],
        });
        if (!cancelled) setPhase({ kind: "ready", bundle });
      } catch (error) {
        if (!cancelled)
          setPhase({
            kind: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, now]);

  const bundle = phase.kind === "ready" ? phase.bundle : null;
  const totalBytes = bundle?.files.reduce((sum, file) => sum + file.bytes, 0) ?? 0;
  const redactionRows = bundle
    ? REDACTION_CATEGORIES.filter((category) => bundle.redactions[category] > 0)
    : [];

  const save = async () => {
    if (!bundle) return;
    setSaving(true);
    setNotice(null);
    try {
      const result = await saveDiagnosticsBundle(bundle);
      if (result.status === "saved") {
        setNotice({
          tone: "ok",
          text: result.location
            ? `${t("diagnostics.saved")}: ${result.location}`
            : t("diagnostics.saved"),
        });
      }
    } catch (error) {
      setNotice({
        tone: "error",
        text: format(t("diagnostics.saveFailed"), {
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    if (!bundle) return;
    try {
      const copied = await copyDiagnosticsSummary(bundle, clipboard);
      setNotice(
        copied
          ? { tone: "ok", text: t("diagnostics.summaryCopied") }
          : { tone: "error", text: t("diagnostics.copyFailed") },
      );
    } catch {
      setNotice({ tone: "error", text: t("diagnostics.copyFailed") });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(720px,calc(100dvh-32px))] max-w-xl flex-col"
        layout="fullscreen-mobile"
        data-testid="diagnostics-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive className="size-4 text-muted-foreground" />
            {t("diagnostics.title")}
          </DialogTitle>
          <DialogDescription>{t("diagnostics.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4 px-5 pb-4">
          {phase.kind === "collecting" ? (
            <div
              className="flex items-center gap-2 py-6 text-xs text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-3.5 animate-spin" />
              {t("diagnostics.collecting")}
            </div>
          ) : null}
          {phase.kind === "failed" ? (
            <div
              className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              {format(t("diagnostics.collectFailed"), { error: phase.error })}
            </div>
          ) : null}
          {bundle ? (
            <>
              <section className="space-y-2" aria-labelledby="diagnostics-files-heading">
                <div className="flex items-baseline justify-between gap-2">
                  <h3
                    id="diagnostics-files-heading"
                    className="text-xs font-medium text-foreground"
                  >
                    {t("diagnostics.files")}
                  </h3>
                  <span className="text-tiny text-muted-foreground">
                    {format(t("diagnostics.fileCount"), {
                      count: bundle.files.length,
                      size: formatDiagnosticsSize(totalBytes),
                    })}
                  </span>
                </div>
                <ul
                  className="divide-y divide-border/50 rounded-lg bg-settings-tile"
                  data-testid="diagnostics-file-list"
                >
                  {bundle.files.map((file) => (
                    <li key={file.path} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono text-tiny">
                        {file.path}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {formatDiagnosticsSize(file.bytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="space-y-2" aria-labelledby="diagnostics-redactions-heading">
                <div className="flex items-baseline justify-between gap-2">
                  <h3
                    id="diagnostics-redactions-heading"
                    className="flex items-center gap-1.5 text-xs font-medium text-foreground"
                  >
                    <ShieldCheck className="size-3.5 text-success" />
                    {t("diagnostics.redactions")}
                  </h3>
                  {redactionRows.length > 0 ? (
                    <span className="text-tiny text-muted-foreground">
                      {format(t("diagnostics.redactionsTotal"), {
                        count: totalRedactions(bundle.redactions),
                      })}
                    </span>
                  ) : null}
                </div>
                {redactionRows.length > 0 ? (
                  <ul
                    className="grid gap-x-4 gap-y-1 rounded-lg bg-settings-tile px-3 py-2 text-xs sm:grid-cols-2"
                    data-testid="diagnostics-redactions"
                  >
                    {redactionRows.map((category) => (
                      <li key={category} className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">
                          {t(`diagnostics.redaction.${category}`)}
                        </span>
                        <span className="tabular-nums text-foreground">
                          {bundle.redactions[category]}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("diagnostics.redactionsNone")}</p>
                )}
                <p className="text-tiny leading-4 text-muted-foreground">
                  {t("diagnostics.excluded")}
                </p>
              </section>
            </>
          ) : null}
        </DialogBody>
        <DialogFooter className="items-center border-t border-border/60 max-[820px]:flex-row">
          <output
            aria-live="polite"
            className={cn(
              "mr-auto flex min-w-0 items-center gap-1.5 truncate text-xs",
              notice?.tone === "ok" && "text-success",
              notice?.tone === "error" && "text-destructive",
            )}
          >
            {notice?.tone === "ok" ? <CheckCircle2 className="size-3.5 shrink-0" /> : null}
            {notice ? <span className="truncate">{notice.text}</span> : null}
          </output>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!bundle}
            onClick={() => void copy()}
            data-testid="diagnostics-copy-summary"
          >
            <Copy className="size-3.5" />
            {t("diagnostics.copySummary")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!bundle || saving}
            onClick={() => void save()}
            data-testid="diagnostics-save"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {saving ? t("diagnostics.saving") : t(DIAGNOSTICS_SAVE_LABEL_KEY)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
