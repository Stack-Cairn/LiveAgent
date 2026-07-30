import { useState } from "react";
import { History, Loader2, Upload } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import {
  type ImportPreview,
  type ImportResult,
  importClaudeCodeChatHistory,
  importCodexChatHistory,
  scanClaudeCodeChatHistory,
  scanCodexChatHistory,
} from "../../lib/chat/history/chatHistory";
import { ImportDialog, type ImportSource } from "./ImportDialog";

type ImportDialogState = {
  source: ImportSource;
  preview: ImportPreview;
};

export function ConversationsSection() {
  const { t } = useLocale();
  const [scanning, setScanning] = useState<ImportSource | null>(null);
  const [importing, setImporting] = useState<ImportSource | null>(null);
  const [dialog, setDialog] = useState<ImportDialogState | null>(null);
  const [result, setResult] = useState<{ source: ImportSource; value: ImportResult } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleScan(source: ImportSource) {
    setScanning(source);
    setResult(null);
    setError(null);
    try {
      const preview =
        source === "codex" ? await scanCodexChatHistory() : await scanClaudeCodeChatHistory();
      if (preview.sessions.length === 0) {
        setError(
          t(
            source === "codex"
              ? "chat.history.codexImportDialogEmpty"
              : "chat.history.claudeCodeImportDialogEmpty",
          ),
        );
        return;
      }
      setDialog({ source, preview });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setScanning(null);
    }
  }

  async function handleConfirm(source: ImportSource, ids: string[]) {
    setDialog(null);
    setImporting(source);
    setError(null);
    try {
      const value =
        source === "codex"
          ? await importCodexChatHistory(ids)
          : await importClaudeCodeChatHistory(ids);
      setResult({ source, value });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(null);
    }
  }

  function claudeImportCard() {
    const busy = scanning !== null || importing !== null;
    const sourceResult = result?.source?.startsWith("claude-") ? result.value : null;
    return (
      <section className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">{t("settings.claudeImportTitle")}</div>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              {t("settings.claudeImportDescription")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleScan("claude-code")}
              disabled={busy}
            >
              {scanning === "claude-code" || importing === "claude-code" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {t("chat.history.claudeCodeImport")}
            </Button>
          </div>
        </div>
        {sourceResult ? (
          <div className="mt-4 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {t("settings.claudeImportResult")
              .replace("{imported}", String(sourceResult.importedCount))
              .replace("{scanned}", String(sourceResult.scannedCount))}
          </div>
        ) : null}
        {error ? (
          <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {t("chat.history.claudeImportFailed")}：{error}
          </div>
        ) : null}
      </section>
    );
  }

  function codexImportCard() {
    const busy = scanning !== null || importing !== null;
    const sourceResult = result?.source === "codex" ? result.value : null;

    return (
      <section className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">{t("settings.codexImportTitle")}</div>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              {t("settings.codexImportDescription")}
            </p>
          </div>
          <Button type="button" onClick={() => void handleScan("codex")} disabled={busy}>
            {scanning === "codex" || importing === "codex" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {scanning === "codex" || importing === "codex"
              ? t("chat.history.codexImporting")
              : t("chat.history.codexImport")}
          </Button>
        </div>
        {sourceResult ? (
          <div className="mt-4 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {t("settings.codexImportResult")
              .replace("{imported}", String(sourceResult.importedCount))
              .replace("{scanned}", String(sourceResult.scannedCount))}
          </div>
        ) : null}
        {error ? (
          <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {t("chat.history.codexImportFailed")}：{error}
          </div>
        ) : null}
      </section>
    );
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

      {claudeImportCard()}
      {codexImportCard()}

      {dialog ? (
        <ImportDialog
          source={dialog.source}
          preview={dialog.preview}
          onClose={() => setDialog(null)}
          onConfirm={(ids) => void handleConfirm(dialog.source, ids)}
        />
      ) : null}
    </div>
  );
}
