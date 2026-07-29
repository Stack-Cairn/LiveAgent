import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { History, Loader2, Upload } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import {
  type ClaudeCodeImportPreview,
  type ClaudeCodeImportResult,
  type ClaudeOfficialImportPreview,
  type ClaudeOfficialImportResult,
  type CodexImportPreview,
  type CodexImportResult,
  importClaudeCodeChatHistory,
  importClaudeOfficialChatHistory,
  importCodexChatHistory,
  scanClaudeCodeChatHistory,
  scanClaudeOfficialChatHistory,
  scanCodexChatHistory,
} from "../../lib/chat/history/chatHistory";
import { ClaudeCodeImportDialog } from "./ClaudeCodeImportDialog";
import { CodexImportDialog } from "./CodexImportDialog";

type ImportSource = "codex" | "claude-code" | "claude-official";
type ImportPreview = CodexImportPreview | ClaudeCodeImportPreview | ClaudeOfficialImportPreview;
type ImportResult = CodexImportResult | ClaudeCodeImportResult | ClaudeOfficialImportResult;
type ImportDialog = {
  source: ImportSource;
  preview: ImportPreview;
  zipPath?: string;
};

export function ConversationsSection() {
  const { t } = useLocale();
  const [scanning, setScanning] = useState<ImportSource | null>(null);
  const [importing, setImporting] = useState<ImportSource | null>(null);
  const [dialog, setDialog] = useState<ImportDialog | null>(null);
  const [result, setResult] = useState<{ source: ImportSource; value: ImportResult } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleScan(source: ImportSource) {
    setScanning(source);
    setResult(null);
    setError(null);
    try {
      const zipPath =
        source === "claude-official"
          ? await invoke<string | null>("system_pick_file", {
              initialWorkdir: undefined,
              filterName: "Claude data export",
              extensions: ["zip"],
            })
          : undefined;
      if (source === "claude-official" && !zipPath) return;
      const officialZipPath = zipPath ?? "";
      const preview =
        source === "codex"
          ? await scanCodexChatHistory()
          : source === "claude-code"
            ? await scanClaudeCodeChatHistory()
            : await scanClaudeOfficialChatHistory(officialZipPath);
      if (preview.sessions.length === 0) {
        setError(
          t(
            source === "codex"
              ? "chat.history.codexImportDialogEmpty"
              : source === "claude-code"
                ? "chat.history.claudeCodeImportDialogEmpty"
                : "chat.history.claudeOfficialImportDialogEmpty",
          ),
        );
        return;
      }
      setDialog({ source, preview, zipPath: zipPath ?? undefined });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setScanning(null);
    }
  }

  async function handleConfirm(source: ImportSource, ids: string[], zipPath?: string) {
    setDialog(null);
    setImporting(source);
    setError(null);
    try {
      const value =
        source === "codex"
          ? await importCodexChatHistory(ids)
          : source === "claude-code"
            ? await importClaudeCodeChatHistory(ids)
            : await importClaudeOfficialChatHistory(zipPath ?? "", ids);
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
            <Button
              type="button"
              onClick={() => void handleScan("claude-official")}
              disabled={busy}
            >
              {scanning === "claude-official" || importing === "claude-official" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {t("chat.history.claudeOfficialImport")}
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

      {dialog?.source === "codex" ? (
        <CodexImportDialog
          preview={dialog.preview as CodexImportPreview}
          onClose={() => setDialog(null)}
          onConfirm={(ids) => void handleConfirm("codex", ids)}
        />
      ) : null}
      {dialog?.source === "claude-official" ? (
        <ClaudeCodeImportDialog
          preview={dialog.preview as ClaudeOfficialImportPreview}
          onClose={() => setDialog(null)}
          onConfirm={(ids) => void handleConfirm("claude-official", ids, dialog.zipPath)}
        />
      ) : null}
      {dialog?.source === "claude-code" ? (
        <ClaudeCodeImportDialog
          preview={dialog.preview as ClaudeCodeImportPreview}
          onClose={() => setDialog(null)}
          onConfirm={(ids) => void handleConfirm("claude-code", ids)}
        />
      ) : null}
    </div>
  );
}
