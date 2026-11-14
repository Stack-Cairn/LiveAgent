import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  ShieldCheck,
} from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useCallback, useEffect, useState } from "react";
import {
  type BrowserImportResultView,
  type BrowserImportSource,
  type BrowserImportSummary,
  browserImportSkipReasonKey,
  browserImportSourceKey,
  browserImportSourceLabel,
  describeBrowserImportResult,
  parseBrowserImportDomains,
} from "../../lib/browser/browserCookieImport";
import type { EmbeddedBrowserClient } from "../../lib/browser/embeddedBrowser";
import { cn } from "../../lib/shared/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

type ImportClient = Required<Pick<EmbeddedBrowserClient, "listImportSources" | "importCookies">>;

export type EmbeddedBrowserImportDialogProps = {
  client: ImportClient;
  onClose: () => void;
  /** Called after a run that imported at least one cookie. */
  onImported?: (summary: BrowserImportSummary) => void;
};

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}

/**
 * "Import sign-in state" dialog: pick a local browser profile, optionally
 * narrow to some sites, and copy its cookies into the built-in browser. The
 * host decrypts on this device and only reports counts back.
 */
export function EmbeddedBrowserImportDialog(props: EmbeddedBrowserImportDialogProps) {
  const { client, onClose, onImported } = props;
  const { t } = useLocale();
  const [sources, setSources] = useState<BrowserImportSource[] | null>(null);
  const [sourcesError, setSourcesError] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [domainsInput, setDomainsInput] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [result, setResult] = useState<BrowserImportResultView | null>(null);

  useEffect(() => {
    let disposed = false;
    client
      .listImportSources()
      .then((next) => {
        if (disposed) return;
        setSources(next);
        setSelectedKey((current) => current || (next[0] ? browserImportSourceKey(next[0]) : ""));
      })
      .catch((error) => {
        if (disposed) return;
        setSources([]);
        setSourcesError(errorMessage(error));
      });
    return () => {
      disposed = true;
    };
  }, [client]);

  const selected =
    sources?.find((source) => browserImportSourceKey(source) === selectedKey) ?? null;

  const runImport = useCallback(async () => {
    if (!selected || importing) return;
    setImporting(true);
    setImportError("");
    setResult(null);
    try {
      const summary = await client.importCookies({
        browser: selected.browser,
        profileDir: selected.profileDir,
        domains: parseBrowserImportDomains(domainsInput),
      });
      setResult(describeBrowserImportResult(summary));
      if (summary.imported > 0) onImported?.(summary);
    } catch (error) {
      setImportError(errorMessage(error));
    } finally {
      setImporting(false);
    }
  }, [client, domainsInput, importing, onImported, selected]);

  const loading = sources === null;
  const empty = !loading && sources.length === 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !importing) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-90dvh max-w-lg flex-col p-0"
        closeDisabled={importing}
        closeLabel={t("projectTools.browserImportClose")}
        showCloseButton
        data-embedded-browser-import=""
      >
        <DialogHeader>
          <DialogTitle>{t("projectTools.browserImportTitle")}</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {t("projectTools.browserImportDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("projectTools.browserImportLoadingSources")}
            </div>
          ) : empty ? (
            <div className="flex flex-col items-center gap-2 rounded-xl bg-muted/50 px-6 py-8 text-center">
              <Info className="size-5 text-muted-foreground" />
              <div className="text-sm font-medium text-foreground">
                {t("projectTools.browserImportNoSourcesTitle")}
              </div>
              <div className="max-w-80 text-xs leading-relaxed text-muted-foreground">
                {sourcesError || t("projectTools.browserImportNoSourcesHint")}
              </div>
            </div>
          ) : (
            <fieldset disabled={importing} className="min-w-0 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="embedded-browser-import-source">
                  {t("projectTools.browserImportSource")}
                </Label>
                <Select value={selectedKey || null} onValueChange={setSelectedKey}>
                  <SelectTrigger variant="plain" id="embedded-browser-import-source">
                    <SelectValue placeholder={t("projectTools.browserImportSourcePlaceholder")}>
                      {(value: unknown) => {
                        const source = sources.find(
                          (entry) => browserImportSourceKey(entry) === value,
                        );
                        return source ? browserImportSourceLabel(source) : null;
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent className="max-h-60 w-80 max-w-viewport-inset-2rem">
                    {sources.map((source) => {
                      const key = browserImportSourceKey(source);
                      return (
                        <SelectItem key={key} value={key}>
                          {browserImportSourceLabel(source)}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="embedded-browser-import-domains">
                  {t("projectTools.browserImportDomains")}
                </Label>
                <Input
                  variant="plain"
                  id="embedded-browser-import-domains"
                  value={domainsInput}
                  onChange={(event) => setDomainsInput(event.currentTarget.value)}
                  placeholder={t("projectTools.browserImportDomainsPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void runImport();
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t("projectTools.browserImportDomainsHint")}
                </p>
              </div>
              <div className="flex gap-2.5 rounded-lg bg-muted/50 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <div className="space-y-1">
                  <p>{t("projectTools.browserImportKeychainNote")}</p>
                  <p>{t("projectTools.browserImportPrivacyNote")}</p>
                </div>
              </div>
            </fieldset>
          )}

          {importError ? (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {importError}
            </p>
          ) : null}
          {result ? <ImportResult result={result} /> : null}
        </DialogBody>
        <DialogFooter>
          <DialogActions>
            <Button size="sm" variant="outline" onClick={onClose} disabled={importing}>
              {result ? t("projectTools.browserImportDone") : t("projectTools.browserImportCancel")}
            </Button>
            {empty || loading ? null : (
              <Button size="sm" onClick={() => void runImport()} disabled={!selected || importing}>
                {importing ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {importing
                  ? t("projectTools.browserImportRunning")
                  : result
                    ? t("projectTools.browserImportAgain")
                    : t("projectTools.browserImportSubmit")}
              </Button>
            )}
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportResult({ result }: { result: BrowserImportResultView }) {
  const { t } = useLocale();
  const good = result.outcome === "success" || result.outcome === "partial";
  const headline = t(`projectTools.browserImportOutcome.${result.outcome}`).replace(
    "{count}",
    String(result.imported),
  );
  return (
    <div
      role="status"
      className={cn(
        "mt-4 space-y-2 rounded-lg border px-3 py-2.5 text-xs",
        good ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5",
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        {good ? (
          <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <AlertTriangle className="size-4 text-amber-500" />
        )}
        {headline}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground">
        <dt>{t("projectTools.browserImportImported")}</dt>
        <dd className="text-right tabular-nums text-foreground">{result.imported}</dd>
        <dt>{t("projectTools.browserImportSkipped")}</dt>
        <dd className="text-right tabular-nums text-foreground">{result.skippedTotal}</dd>
        {result.skipped.map((entry) => (
          <div key={entry.reason} className="col-span-2 grid grid-cols-subgrid pl-3">
            <dt className="text-muted-foreground/90">
              {t(browserImportSkipReasonKey(entry.reason))}
            </dt>
            <dd className="text-right tabular-nums">{entry.count}</dd>
          </div>
        ))}
        <dt>{t("projectTools.browserImportFailed")}</dt>
        <dd className="text-right tabular-nums text-foreground">{result.failed}</dd>
      </dl>
      {result.keyError ? (
        <p className="flex gap-1.5 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {t("projectTools.browserImportKeyError")} {result.keyError}
          </span>
        </p>
      ) : null}
    </div>
  );
}
