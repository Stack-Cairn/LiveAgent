import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Download,
  Loader2,
  Shield,
  Upload,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useCallback, useState } from "react";
import {
  applyBackupImport,
  type BackupDomainCounts,
  type BackupManifest,
  exportBackup,
  peekBackupImport,
} from "../../lib/backup";
import { normalizeSkillsSettings } from "../../lib/settings";
import type { SettingsSectionProps } from "./types";

type Status = { kind: "ok" | "error"; text: string } | null;

/** 后端返回的错误已是可直接展示的中文文案。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  return String(error ?? "").trim();
}

/** manifest.createdAt 是 RFC3339 UTC，按本地时区展示。 */
function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function summarizeDomains(counts: BackupDomainCounts, t: (key: string) => string): string {
  return [
    `${t("settings.backupDomainProviders")} ${counts.providers}`,
    `${t("settings.backupDomainMcp")} ${counts.mcp}`,
    `${t("settings.backupDomainSystem")} ${counts.system}`,
    `${t("settings.backupDomainSkills")} ${counts.skills}`,
  ].join(" · ");
}

function describeSource(manifest: BackupManifest, t: (key: string) => string) {
  const rows: [string, string][] = [
    [t("settings.backupSourceDevice"), manifest.deviceName],
    [t("settings.backupSourceTime"), formatCreatedAt(manifest.createdAt)],
    [t("settings.backupSourceVersion"), manifest.appVersion],
  ];
  return (
    <div className="space-y-1">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <span className="shrink-0 opacity-70">{label}</span>
          <span className="break-all font-medium">{value}</span>
        </div>
      ))}
      <div className="pt-1">{summarizeDomains(manifest.domains, t)}</div>
    </div>
  );
}

export function BackupSyncSection(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const { confirm, dialog } = useConfirmDialog();
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [status, setStatus] = useState<Status>(null);

  const handleExport = useCallback(async () => {
    setBusy("export");
    setStatus(null);
    try {
      // skills 启用态只存在于前端，必须由这里拼进 payload。
      const path = await exportBackup(settings.skills);
      // 用户在系统对话框里取消时返回 null，不算失败。
      if (path) {
        setStatus({ kind: "ok", text: `${t("settings.backupExportDone")}${path}` });
      }
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) || t("settings.backupExportFailed") });
    } finally {
      setBusy(null);
    }
  }, [settings.skills, t]);

  const handleImport = useCallback(async () => {
    setBusy("import");
    setStatus(null);
    try {
      // 先只解析校验、不写库，让用户看到来源摘要再决定是否覆盖。
      const preview = await peekBackupImport();
      if (!preview) return;

      const confirmed = await confirm({
        title: t("settings.backupImportConfirmTitle"),
        subtitle: t("settings.backupImportConfirmSubtitle"),
        description: describeSource(preview.manifest, t),
        detail: preview.path,
        confirmLabel: t("settings.backupImportConfirmAction"),
        cancelLabel: t("settings.backupCancel"),
        tone: "warning",
      });
      if (!confirmed) return;

      const outcome = await applyBackupImport(preview.path);
      // skills 后端写不了 webview 存储，必须在这里回写。
      if (outcome.skills) {
        const skills = normalizeSkillsSettings(outcome.skills);
        setSettings((prev) => ({ ...prev, skills }));
      }
      setStatus({
        kind: "ok",
        text: `${t("settings.backupImportDone")}${summarizeDomains(outcome.applied, t)}`,
      });
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) || t("settings.backupImportFailed") });
    } finally {
      setBusy(null);
    }
  }, [confirm, setSettings, t]);

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Archive className="h-4 w-4 text-muted-foreground" />
          {t("settings.backupLocalTitle")}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.backupLocalDesc")}
        </p>

        <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
          <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-200">
            {t("settings.backupPlaintextWarning")}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void handleExport()}
          >
            {busy === "export" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {t("settings.backupExport")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void handleImport()}
          >
            {busy === "import" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {t("settings.backupImport")}
          </Button>
        </div>

        <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <ArchiveRestore className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("settings.backupAutoBackupHint")}</span>
        </div>

        {status ? (
          <div
            className={`break-all text-xs font-medium ${
              status.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
            }`}
          >
            {status.text}
          </div>
        ) : null}
      </section>

      <section className="space-y-2 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Shield className="h-4 w-4 text-muted-foreground" />
          {t("settings.backupScopeTitle")}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.backupScopeDesc")}
        </p>
      </section>

      {dialog}
    </div>
  );
}
