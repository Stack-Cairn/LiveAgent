import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Cloud,
  CloudDownload,
  Download,
  Loader2,
  Plug,
  Save,
  Shield,
  Upload,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useCallback, useEffect, useState } from "react";
import {
  applyBackupImport,
  type BackupDomainCounts,
  type BackupManifest,
  type BackupSyncConfigView,
  downloadBackup,
  exportBackup,
  fetchRemoteInfo,
  loadSyncConfig,
  peekBackupImport,
  saveSyncConfig,
  testSyncConnection,
  uploadBackup,
} from "../../lib/backup";
import { normalizeSkillsSettings } from "../../lib/settings";
import type { SettingsSectionProps } from "./types";

type Status = { kind: "ok" | "error"; text: string } | null;

type SyncBusy = "load" | "test" | "save" | "upload" | "download" | null;

/** 表单态。密码单独用 `passwordTouched` 标记，避免把占位符当真密码提交。 */
type SyncForm = {
  url: string;
  username: string;
  password: string;
  passwordTouched: boolean;
  remoteDir: string;
  profile: string;
  autoSync: boolean;
};

type PresetId = "jianguoyun" | "nextcloud" | "synology" | "custom";

/** 预设仅填充 URL 模板，其余字段仍需用户自填。 */
const SYNC_PRESETS: { id: Exclude<PresetId, "custom">; url: string }[] = [
  { id: "jianguoyun", url: "https://dav.jianguoyun.com/dav/" },
  { id: "nextcloud", url: "https://server/remote.php/dav/files/USER/" },
  { id: "synology", url: "http://nas-ip:5005/" },
];

/**
 * 由已保存的 URL 反推预设，让重新进入设置页时下拉框不会永远停在「自定义」。
 *
 * 坚果云按 host 判断（而非 `includes`），否则 `dav.jianguoyun.com.evil.test`
 * 也会被认成坚果云。
 */
function detectPreset(url: string): PresetId {
  const trimmed = url.trim();
  if (!trimmed) return "custom";
  let host = "";
  let port = "";
  try {
    const parsed = new URL(trimmed);
    host = parsed.hostname.toLowerCase();
    port = parsed.port;
  } catch {
    return "custom";
  }
  if (host === "dav.jianguoyun.com") return "jianguoyun";
  if (/\/remote\.php\/dav\//i.test(trimmed)) return "nextcloud";
  if (port === "5005" || port === "5006") return "synology";
  return "custom";
}

function emptyForm(): SyncForm {
  return {
    url: "",
    username: "",
    password: "",
    passwordTouched: false,
    remoteDir: "",
    profile: "",
    autoSync: false,
  };
}

function formFromView(view: BackupSyncConfigView): SyncForm {
  return {
    url: view.url,
    username: view.username,
    // 后端从不回传密码，表单里始终以空串起步，靠 placeholder 告知「已保存」。
    password: "",
    passwordTouched: false,
    remoteDir: view.remoteDir,
    profile: view.profile,
    autoSync: view.autoSync,
  };
}

/** 表单是否有未保存改动。上传/下载走的是库里的配置，脏表单必须先保存。 */
function isDirty(form: SyncForm, view: BackupSyncConfigView | null): boolean {
  if (!view) return true;
  return (
    form.passwordTouched ||
    form.url !== view.url ||
    form.username !== view.username ||
    form.remoteDir !== view.remoteDir ||
    form.profile !== view.profile ||
    form.autoSync !== view.autoSync
  );
}

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

/** lastSyncAt 是毫秒时间戳。 */
function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
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

  const [syncView, setSyncView] = useState<BackupSyncConfigView | null>(null);
  const [form, setForm] = useState<SyncForm>(emptyForm);
  const [preset, setPreset] = useState<PresetId>("custom");
  const [syncBusy, setSyncBusy] = useState<SyncBusy>("load");
  const [syncStatus, setSyncStatus] = useState<Status>(null);

  const dirty = isDirty(form, syncView);
  const syncLocked = syncBusy !== null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const view = await loadSyncConfig();
        if (cancelled) return;
        setSyncView(view);
        setForm(formFromView(view));
        setPreset(detectPreset(view.url));
      } catch (error) {
        if (!cancelled) setSyncStatus({ kind: "error", text: errorText(error) });
      } finally {
        if (!cancelled) setSyncBusy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patchForm = useCallback((patch: Partial<SyncForm>) => {
    setSyncStatus(null);
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const handlePresetChange = useCallback(
    (value: string) => {
      const next = value as PresetId;
      setPreset(next);
      const matched = SYNC_PRESETS.find((item) => item.id === next);
      // 选「自定义」时保留当前 URL，只有选到具体预设才覆写。
      if (matched) patchForm({ url: matched.url });
    },
    [patchForm],
  );

  /** 保存后刷新视图，dirty 归零，上传/下载随即解锁。 */
  const handleSaveSync = useCallback(async () => {
    setSyncBusy("save");
    setSyncStatus(null);
    try {
      const view = await saveSyncConfig({
        url: form.url,
        username: form.username,
        password: form.password,
        passwordTouched: form.passwordTouched,
        remoteDir: form.remoteDir,
        profile: form.profile,
        autoSync: form.autoSync,
      });
      setSyncView(view);
      setForm(formFromView(view));
      setPreset(detectPreset(view.url));
      setSyncStatus({ kind: "ok", text: t("settings.backupSyncSaveDone") });
    } catch (error) {
      setSyncStatus({
        kind: "error",
        text: errorText(error) || t("settings.backupSyncSaveFailed"),
      });
    } finally {
      setSyncBusy(null);
    }
  }, [form, t]);

  /** 测试连接读的是库里的配置，故未保存时不可用。 */
  const handleTestSync = useCallback(async () => {
    setSyncBusy("test");
    setSyncStatus(null);
    try {
      await testSyncConnection();
      setSyncStatus({ kind: "ok", text: t("settings.backupSyncTestDone") });
    } catch (error) {
      setSyncStatus({
        kind: "error",
        text: errorText(error) || t("settings.backupSyncTestFailed"),
      });
    } finally {
      setSyncBusy(null);
    }
  }, [t]);

  const handleUpload = useCallback(async () => {
    setSyncBusy("upload");
    setSyncStatus(null);
    try {
      // 远端已有备份时先让用户看清会覆盖谁 —— 可能是另一台机器刚传的。
      const remote = await fetchRemoteInfo();
      if (remote) {
        const confirmed = await confirm({
          title: t("settings.backupSyncUploadConfirmTitle"),
          subtitle: t("settings.backupSyncUploadConfirmSubtitle"),
          description: describeSource(remote.manifest, t),
          confirmLabel: t("settings.backupSyncUpload"),
          cancelLabel: t("settings.backupCancel"),
          tone: "warning",
        });
        if (!confirmed) return;
      }
      const syncedAt = await uploadBackup(settings.skills);
      setSyncView((prev) => (prev ? { ...prev, lastSyncAt: syncedAt } : prev));
      setSyncStatus({ kind: "ok", text: t("settings.backupSyncUploadDone") });
    } catch (error) {
      setSyncStatus({
        kind: "error",
        text: errorText(error) || t("settings.backupSyncUploadFailed"),
      });
    } finally {
      setSyncBusy(null);
    }
  }, [confirm, settings.skills, t]);

  const handleDownload = useCallback(async () => {
    setSyncBusy("download");
    setSyncStatus(null);
    try {
      const remote = await fetchRemoteInfo();
      if (!remote) {
        setSyncStatus({ kind: "error", text: t("settings.backupSyncRemoteEmpty") });
        return;
      }
      const confirmed = await confirm({
        title: t("settings.backupSyncDownloadConfirmTitle"),
        subtitle: t("settings.backupSyncDownloadConfirmSubtitle"),
        description: describeSource(remote.manifest, t),
        confirmLabel: t("settings.backupSyncDownload"),
        cancelLabel: t("settings.backupCancel"),
        tone: "warning",
      });
      if (!confirmed) return;

      const outcome = await downloadBackup();
      if (outcome.skills) {
        const skills = normalizeSkillsSettings(outcome.skills);
        setSettings((prev) => ({ ...prev, skills }));
      }
      setSyncStatus({
        kind: "ok",
        text: `${t("settings.backupSyncDownloadDone")}${summarizeDomains(outcome.applied, t)}`,
      });
    } catch (error) {
      setSyncStatus({
        kind: "error",
        text: errorText(error) || t("settings.backupSyncDownloadFailed"),
      });
    } finally {
      setSyncBusy(null);
    }
  }, [confirm, setSettings, t]);

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

      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Cloud className="h-4 w-4 text-muted-foreground" />
          {t("settings.backupSyncTitle")}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.backupSyncDesc")}
        </p>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("settings.backupSyncPreset")}</Label>
            <Select value={preset} onValueChange={handlePresetChange} disabled={syncLocked}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SYNC_PRESETS.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {t(`settings.backupSyncPreset_${item.id}`)}
                  </SelectItem>
                ))}
                <SelectItem value="custom">{t("settings.backupSyncPreset_custom")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("settings.backupSyncUrl")}</Label>
            <Input
              value={form.url}
              disabled={syncLocked}
              placeholder="https://dav.example.com/dav/"
              onChange={(event) => patchForm({ url: event.target.value })}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("settings.backupSyncUsername")}</Label>
              <Input
                value={form.username}
                disabled={syncLocked}
                autoComplete="off"
                onChange={(event) => patchForm({ username: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("settings.backupSyncPassword")}</Label>
              <Input
                type="password"
                value={form.password}
                disabled={syncLocked}
                autoComplete="new-password"
                placeholder={
                  syncView?.hasPassword && !form.passwordTouched
                    ? t("settings.backupSyncPasswordSaved")
                    : ""
                }
                onChange={(event) =>
                  patchForm({ password: event.target.value, passwordTouched: true })
                }
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("settings.backupSyncRemoteDir")}</Label>
              <Input
                value={form.remoteDir}
                disabled={syncLocked}
                placeholder="liveagent"
                onChange={(event) => patchForm({ remoteDir: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("settings.backupSyncProfile")}</Label>
              <Input
                value={form.profile}
                disabled={syncLocked}
                placeholder="default"
                onChange={(event) => patchForm({ profile: event.target.value })}
              />
            </div>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("settings.backupSyncProfileHint")}
          </p>

          <div className="flex items-start justify-between gap-3 rounded-xl border border-border/60 px-3.5 py-3">
            <div className="min-w-0 space-y-1">
              <div className="text-xs font-medium text-foreground">
                {t("settings.backupSyncAuto")}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("settings.backupSyncAutoHint")}
              </p>
            </div>
            <Switch
              checked={form.autoSync}
              disabled={syncLocked}
              title={t("settings.backupSyncAuto")}
              aria-label={t("settings.backupSyncAuto")}
              onCheckedChange={(checked) => patchForm({ autoSync: checked })}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={syncLocked} onClick={() => void handleSaveSync()}>
            {syncBusy === "save" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {t("settings.backupSyncSave")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={syncLocked || dirty}
            onClick={() => void handleTestSync()}
          >
            {syncBusy === "test" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plug className="h-3.5 w-3.5" />
            )}
            {t("settings.backupSyncTest")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={syncLocked || dirty}
            onClick={() => void handleUpload()}
          >
            {syncBusy === "upload" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Cloud className="h-3.5 w-3.5" />
            )}
            {t("settings.backupSyncUpload")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={syncLocked || dirty}
            onClick={() => void handleDownload()}
          >
            {syncBusy === "download" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CloudDownload className="h-3.5 w-3.5" />
            )}
            {t("settings.backupSyncDownload")}
          </Button>
        </div>

        {dirty && !syncLocked ? (
          <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
            {t("settings.backupSyncDirtyHint")}
          </p>
        ) : null}

        {syncView?.lastSyncAt ? (
          <p className="text-xs text-muted-foreground">
            {t("settings.backupSyncLastAt")}
            {formatTimestamp(syncView.lastSyncAt)}
          </p>
        ) : null}

        {syncStatus ? (
          <div
            className={`break-all text-xs font-medium ${
              syncStatus.kind === "ok"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-destructive"
            }`}
          >
            {syncStatus.text}
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
