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
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import {
  applyBackupImport,
  BACKUP_SYNC_STATUS_EVENT,
  type BackupDomainCounts,
  type BackupManifest,
  type BackupSyncConfigView,
  type BackupSyncStatusEvent,
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
import {
  applySyncStatusEvent,
  canTestSyncConnection,
  detectPreset,
  emptyForm,
  formFromView,
  isAutoSyncSuccess,
  isDirty,
  type PresetId,
  SYNC_PRESETS,
  type SyncForm,
} from "./backupSyncForm";
import type { SettingsSectionProps } from "./types";

type Status = { kind: "ok" | "error"; text: string } | null;

type SyncBusy = "load" | "test" | "save" | "upload" | "download" | null;

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

  // 后台自动同步的结果。手动同步的成败由命令返回值就地反馈，不经过这个事件，
  // 所以这里收到的一定是「用户没主动点按钮时发生的同步」。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<BackupSyncStatusEvent>(BACKUP_SYNC_STATUS_EVENT, (event) => {
      setSyncView((prev) => applySyncStatusEvent(prev, event.payload));
      if (isAutoSyncSuccess(event.payload)) {
        setSyncStatus({ kind: "ok", text: t("settings.backupSyncAutoDone") });
      }
    }).then((fn) => {
      // 组件在 listen resolve 前就卸载时，拿到句柄立刻注销，避免泄漏。
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [t]);

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

  /**
   * 开启自动同步前先确认一次。
   *
   * 开关一旦打开，此后每次改配置都会把含明文 API Key 的快照推到远端，
   * 而且不再有任何逐次提示。这个后果值得一次显式点头；关闭方向无害，直接生效。
   */
  const handleAutoSyncChange = useCallback(
    async (checked: boolean) => {
      if (!checked) {
        patchForm({ autoSync: false });
        return;
      }
      const confirmed = await confirm({
        title: t("settings.backupSyncAutoConfirmTitle"),
        subtitle: t("settings.backupSyncAutoConfirmSubtitle"),
        description: t("settings.backupSyncAutoConfirmDesc"),
        confirmLabel: t("settings.backupSyncAutoConfirmAction"),
        cancelLabel: t("settings.backupCancel"),
        tone: "warning",
      });
      if (confirmed) patchForm({ autoSync: true });
    },
    [confirm, patchForm, t],
  );

  /** 保存后立即测一次连接：配置填错的话，此刻纠正的成本最低。 */
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

      // 凭据不全时没什么可测的，直接报保存成功即可。
      if (!canTestSyncConnection(view)) {
        setSyncStatus({ kind: "ok", text: t("settings.backupSyncSaveDone") });
        return;
      }
      try {
        await testSyncConnection();
        setSyncStatus({ kind: "ok", text: t("settings.backupSyncSaveAndTestDone") });
      } catch (error) {
        // 保存本身是成功的，连接失败只是提醒 —— 不能让用户以为配置没存上。
        setSyncStatus({
          kind: "error",
          text: `${t("settings.backupSyncSaveAndTestFailed")}${errorText(error)}`,
        });
      }
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
      // 后端在成功时清了 last_error，视图同步跟上，横幅立即消失。
      setSyncView((prev) => (prev ? { ...prev, lastSyncAt: syncedAt, lastError: null } : prev));
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
      // 下载成功证明这条链路是通的，后端已清 last_error，视图同步跟上。
      setSyncView((prev) => (prev ? { ...prev, lastError: null } : prev));
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
              onCheckedChange={(checked) => void handleAutoSyncChange(checked)}
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

        {/*
          自动同步失败的常驻横幅。区别于下面那条 syncStatus —— 后者是本次交互的
          即时反馈，切走页面就没了；这条来自库里的 last_error，只要故障没修好，
          每次进设置页都还在。用户不会在后台同步失败时正好盯着这个页面。
        */}
        {syncView?.lastError ? (
          <div className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-1">
              <div className="text-xs font-medium text-destructive">
                {t("settings.backupSyncAutoErrorTitle")}
              </div>
              <p className="break-all text-xs leading-relaxed text-destructive/90">
                {syncView.lastError}
              </p>
            </div>
          </div>
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
