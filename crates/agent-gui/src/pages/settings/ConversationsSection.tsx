import { useState } from "react";
import { History, Loader2, Upload } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import {
  type CodexImportPreview,
  type CodexImportResult,
  importCodexChatHistory,
  scanCodexChatHistory,
} from "../../lib/chat/history/chatHistory";
import { CodexImportDialog } from "./CodexImportDialog";

export function ConversationsSection() {
  const { t } = useLocale();
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dialog, setDialog] = useState<CodexImportPreview | null>(null);
  const [result, setResult] = useState<CodexImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleScan() {
    setScanning(true);
    setResult(null);
    setError(null);
    try {
      const preview = await scanCodexChatHistory();
      if (preview.sessions.length === 0) {
        setError(t("chat.history.codexImportDialogEmpty"));
        return;
      }
      setDialog(preview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setScanning(false);
    }
  }

  async function handleConfirm(ids: string[]) {
    setDialog(null);
    setImporting(true);
    setError(null);
    try {
      setResult(await importCodexChatHistory(ids));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <History className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h3 className="text-sm font-semibold">{t("settings.conversationsTitle")}</h3>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            {t("settings.conversationsDescription")}
          </p>
        </div>
      </div>

      <section className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">{t("settings.codexImportTitle")}</div>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              {t("settings.codexImportDescription")}
            </p>
          </div>
          <Button type="button" onClick={() => void handleScan()} disabled={scanning || importing}>
            {scanning || importing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {scanning || importing
              ? t("chat.history.codexImporting")
              : t("chat.history.codexImport")}
          </Button>
        </div>

        {result ? (
          <div className="mt-4 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {t("settings.codexImportResult")
              .replace("{imported}", String(result.importedCount))
              .replace("{scanned}", String(result.scannedCount))}
          </div>
        ) : null}
        {error ? (
          <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {t("chat.history.codexImportFailed")}：{error}
          </div>
        ) : null}
      </section>

      {dialog ? (
        <CodexImportDialog
          preview={dialog}
          onClose={() => setDialog(null)}
          onConfirm={(ids) => void handleConfirm(ids)}
        />
      ) : null}
    </div>
  );
}
