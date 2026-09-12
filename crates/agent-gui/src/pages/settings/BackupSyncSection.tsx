import {
  AlertTriangle,
  ArrowLeft,
  Brain,
  ChevronRight,
  CircleHelp,
  CloudDownload,
  Download,
  FileText,
  HardDrive,
  Key,
  Layers,
  Loader2,
  McpLogo,
  MessageSquare,
  Mic,
  ScrollText,
  Server,
  Settings2,
  SkillIcon,
  Upload,
} from "@liveagent/ui/components/IconSet";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@liveagent/ui/components/settings/SettingsLayout";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import { LabelTooltip } from "@liveagent/ui/components/ui/label-tooltip";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { toast } from "@liveagent/ui/components/ui/toast-manager";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { listen } from "@tauri-apps/api/event";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
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

type SyncBusy = "load" | "save" | "upload" | "download" | null;

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
    `${t("settings.backupDomainAgents")} ${counts.agents}`,
    `${t("settings.backupDomainModelFailover")} ${counts.modelFailover}`,
    `${t("settings.backupDomainStt")} ${counts.stt}`,
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

function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <Label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
      {children}
      {hint ? (
        <LabelTooltip label={<span className="max-w-64 text-xs leading-relaxed">{hint}</span>}>
          <CircleHelp className="size-3.5 cursor-help text-muted-foreground/60" />
        </LabelTooltip>
      ) : null}
    </Label>
  );
}

/** 备份范围条目：包含项常色，排除项弱化。 */
function ScopeItem({
  icon,
  label,
  excluded = false,
}: {
  icon: ReactNode;
  label: string;
  excluded?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1",
        "text-xs font-medium leading-none",
        excluded ? "bg-muted/30 text-muted-foreground/70" : "bg-muted/45 text-foreground/85",
      )}
    >
      <span
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center",
          excluded && "opacity-60",
        )}
      >
        {icon}
      </span>
      <span className={excluded ? "line-through decoration-muted-foreground/40" : ""}>{label}</span>
    </span>
  );
}

function BackupScopeDetails({ t }: { t: (key: string) => string }) {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">
          {t("settings.backupScopeIncluded")}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <ScopeItem
            icon={<Server className="size-3.5" />}
            label={t("settings.backupDomainProviders")}
          />
          <ScopeItem
            icon={<McpLogo className="size-3.5" />}
            label={t("settings.backupDomainMcp")}
          />
          <ScopeItem
            icon={<Settings2 className="size-3.5" />}
            label={t("settings.backupDomainSystem")}
          />
          <ScopeItem
            icon={<ScrollText className="size-3.5" />}
            label={t("settings.backupDomainAgents")}
          />
          <ScopeItem
            icon={<Layers className="size-3.5" />}
            label={t("settings.backupDomainModelFailover")}
          />
          <ScopeItem icon={<Mic className="size-3.5" />} label={t("settings.backupDomainStt")} />
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">
          {t("settings.backupScopeExcluded")}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <ScopeItem
            excluded
            icon={<MessageSquare className="size-3.5" />}
            label={t("settings.backupScopeChat")}
          />
          <ScopeItem
            excluded
            icon={<Brain className="size-3.5" />}
            label={t("settings.backupScopeMemory")}
          />
          <ScopeItem
            excluded
            icon={<FileText className="size-3.5" />}
            label={t("settings.backupScopeUploads")}
          />
          <ScopeItem
            excluded
            icon={<Key className="size-3.5" />}
            label={t("settings.backupScopeSshKeys")}
          />
          <ScopeItem
            excluded
            icon={<SkillIcon className="size-3.5" />}
            label={t("settings.backupScopeSkills")}
          />
          <ScopeItem
            excluded
            icon={<HardDrive className="size-3.5" />}
            label={t("settings.backupScopeDeviceLocal")}
          />
        </div>
      </div>
    </div>
  );
}

export function BackupSyncSection(props: SettingsSectionProps) {
  const { reloadSettings } = props;
  const { t } = useLocale();
  const { confirm, dialog } = useConfirmDialog();
  const toastScope = useId();
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [status, setStatus] = useState<Status>(null);

  const [syncView, setSyncView] = useState<BackupSyncConfigView | null>(null);
  const [form, setForm] = useState<SyncForm>(emptyForm);
  const [preset, setPreset] = useState<PresetId>("custom");
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [syncFormOpen, setSyncFormOpen] = useState(false);
  const [syncBusy, setSyncBusy] = useState<SyncBusy>("load");
  const [syncStatus, setSyncStatus] = useState<Status>(null);

  const dirty = isDirty(form, syncView);
  const syncLocked = syncBusy !== null;
  const syncConfigured = syncView ? canTestSyncConnection(syncView) : false;

  useEffect(() => {
    if (!status) return;
    const options = { id: `${toastScope}-local`, appearance: "notice" as const };
    if (status.kind === "ok") toast.success(status.text, options);
    else toast.error(status.text, options);
  }, [status, toastScope]);

  useEffect(() => {
    if (!syncStatus) return;
    const options = { id: `${toastScope}-sync`, appearance: "notice" as const };
    if (syncStatus.kind === "ok") toast.success(syncStatus.text, options);
    else toast.error(syncStatus.text, options);
  }, [syncStatus, toastScope]);

  useEffect(
    () => () => {
      toast.dismiss(`${toastScope}-local`);
      toast.dismiss(`${toastScope}-sync`);
    },
    [toastScope],
  );

  /**
   * 还原（导入 / 下载）落库后从 SQLite 重载前端状态。
   *
   * 不重载的后果不是「显示旧值」这么轻：`persistSettings` 按域 diff，
   * 用户之后动任一域就会拿还原前的内存值写回库，把还原静默回滚掉。
   */
  const syncStateAfterRestore = useCallback(async () => {
    await reloadSettings?.();
  }, [reloadSettings]);

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

  const handleSyncDialogOpenChange = useCallback(
    (open: boolean) => {
      setSyncDialogOpen(open);
      if (open) setSyncFormOpen(false);
      if (!open && syncView) {
        setForm(formFromView(syncView));
        setPreset(detectPreset(syncView.url));
      }
    },
    [syncView],
  );

  const handlePresetChange = useCallback(
    (value: PresetId) => {
      setPreset(value);
      const matched = SYNC_PRESETS.find((item) => item.id === value);
      // 选「自定义」时保留当前 URL，只有选到具体预设才覆写。
      if (matched && value !== preset) patchForm({ url: matched.url });
      setSyncFormOpen(true);
    },
    [patchForm, preset],
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
        });
        if (!confirmed) return;
      }
      const syncedAt = await uploadBackup();
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
  }, [confirm, t]);

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
      });
      if (!confirmed) return;

      const outcome = await downloadBackup();
      await syncStateAfterRestore();
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
  }, [confirm, syncStateAfterRestore, t]);

  const handleExport = useCallback(async () => {
    setBusy("export");
    setStatus(null);
    try {
      const path = await exportBackup();
      // 用户在系统对话框里取消时返回 null，不算失败。
      if (path) {
        setStatus({ kind: "ok", text: `${t("settings.backupExportDone")}${path}` });
      }
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) || t("settings.backupExportFailed") });
    } finally {
      setBusy(null);
    }
  }, [t]);

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
      });
      if (!confirmed) return;

      const outcome = await applyBackupImport(preview.path);
      await syncStateAfterRestore();
      setStatus({
        kind: "ok",
        text: `${t("settings.backupImportDone")}${summarizeDomains(outcome.applied, t)}`,
      });
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) || t("settings.backupImportFailed") });
    } finally {
      setBusy(null);
    }
  }, [confirm, syncStateAfterRestore, t]);

  const presetOptions: { id: PresetId }[] = [...SYNC_PRESETS, { id: "custom" as const }];
  const syncSummary =
    syncBusy === "load" && !syncView
      ? t("settings.backupSyncLoading")
      : syncView?.lastError
        ? t("settings.backupSyncAutoErrorTitle")
        : syncConfigured
          ? [
              syncView?.autoSync ? t("settings.backupSyncAutoOn") : t("settings.backupSyncAutoOff"),
              syncView?.lastSyncAt
                ? `${t("settings.backupSyncLastAt")}${formatTimestamp(syncView.lastSyncAt)}`
                : t("settings.backupSyncStatusNeverSynced"),
            ].join(" · ")
          : t("settings.backupSyncStatusNotConfiguredHint");

  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings.backupLocalTitle")}>
        <SettingsCard>
          <SettingsRow
            title={t("settings.backupExport")}
            description={t("settings.backupExportHint")}
            control={
              <Button size="sm" disabled={busy !== null} onClick={() => void handleExport()}>
                {busy === "export" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {t("settings.backupExport")}
              </Button>
            }
          />
          <SettingsRow
            title={t("settings.backupImport")}
            description={
              <span>
                {t("settings.backupImportHint")}
                <span className="block">{t("settings.backupAutoBackupHint")}</span>
              </span>
            }
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void handleImport()}
              >
                {busy === "import" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Upload className="size-3.5" />
                )}
                {t("settings.backupImport")}
              </Button>
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("settings.backupSyncTitle")}>
        <SettingsCard>
          <SettingsRow
            title={
              syncView?.lastError
                ? t("settings.backupSyncAutoErrorTitle")
                : syncConfigured
                  ? t("settings.backupSyncStatusReady")
                  : t("settings.backupSyncStatusNotConfigured")
            }
            description={
              <span className={syncView?.lastError ? "text-destructive" : undefined}>
                {syncSummary}
              </span>
            }
            control={
              <Dialog open={syncDialogOpen} onOpenChange={handleSyncDialogOpenChange}>
                <DialogTrigger
                  render={
                    <Button
                      size="sm"
                      variant={syncConfigured ? "outline" : "default"}
                      disabled={syncBusy === "load"}
                    />
                  }
                >
                  {syncConfigured
                    ? t("settings.backupSyncManage")
                    : t("settings.backupSyncConfigure")}
                </DialogTrigger>
                <DialogContent
                  className="flex max-h-[calc(100dvh-2rem)] max-w-lg flex-col"
                  closeLabel={t("settings.backupCancel")}
                  showCloseButton
                >
                  <DialogHeader>
                    <div className="flex items-center gap-2">
                      {syncFormOpen ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={syncLocked}
                          aria-label={t("settings.backupSyncBackToProviders")}
                          onClick={() => setSyncFormOpen(false)}
                        >
                          <ArrowLeft className="size-4" />
                        </Button>
                      ) : null}
                      <DialogTitle>
                        {syncFormOpen
                          ? t(`settings.backupSyncPreset_${preset}`)
                          : t("settings.backupSyncChooseProvider")}
                      </DialogTitle>
                    </div>
                    <DialogDescription>{t("settings.backupSyncCredentialNote")}</DialogDescription>
                  </DialogHeader>

                  <DialogBody className="space-y-4">
                    {!syncFormOpen ? (
                      <div className="space-y-2">
                        {presetOptions.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            disabled={syncLocked}
                            className={cn(
                              "flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl px-4 py-3",
                              "bg-settings-tile text-left text-sm font-medium hover:bg-settings-tile-hover",
                              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                            )}
                            onClick={() => handlePresetChange(item.id)}
                          >
                            {t(`settings.backupSyncPreset_${item.id}`)}
                            <ChevronRight className="size-4 text-muted-foreground" />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <>
                        <div className="space-y-1.5">
                          <FieldLabel>{t("settings.backupSyncUrl")}</FieldLabel>
                          <div className="relative">
                            <Server className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
                            <Input
                              variant="plain"
                              value={form.url}
                              disabled={syncLocked}
                              placeholder="https://dav.example.com/dav/"
                              className="pl-9"
                              onChange={(event) => patchForm({ url: event.target.value })}
                            />
                          </div>
                        </div>

                        <div className="space-y-4">
                          <div className="space-y-1.5">
                            <FieldLabel>{t("settings.backupSyncUsername")}</FieldLabel>
                            <Input
                              variant="plain"
                              value={form.username}
                              disabled={syncLocked}
                              autoComplete="off"
                              onChange={(event) => patchForm({ username: event.target.value })}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <FieldLabel>{t("settings.backupSyncPassword")}</FieldLabel>
                            <div className="relative">
                              <Key className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
                              <Input
                                variant="plain"
                                type="password"
                                value={form.password}
                                disabled={syncLocked}
                                autoComplete="new-password"
                                className="pl-9"
                                placeholder={
                                  syncView?.hasPassword && !form.passwordTouched
                                    ? t("settings.backupSyncPasswordSaved")
                                    : ""
                                }
                                onChange={(event) => {
                                  const password = event.target.value;
                                  patchForm({ password, passwordTouched: password.length > 0 });
                                }}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="space-y-4">
                          <div className="space-y-1.5">
                            <FieldLabel>{t("settings.backupSyncRemoteDir")}</FieldLabel>
                            <Input
                              variant="plain"
                              value={form.remoteDir}
                              disabled={syncLocked}
                              placeholder="liveagent"
                              onChange={(event) => patchForm({ remoteDir: event.target.value })}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <FieldLabel hint={t("settings.backupSyncProfileHint")}>
                              {t("settings.backupSyncProfile")}
                            </FieldLabel>
                            <Input
                              variant="plain"
                              value={form.profile}
                              disabled={syncLocked}
                              placeholder="default"
                              onChange={(event) => patchForm({ profile: event.target.value })}
                            />
                          </div>
                        </div>

                        <div className="flex items-center justify-between gap-4 rounded-xl bg-settings-tile px-4 py-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-foreground">
                              {t("settings.backupSyncAuto")}
                            </div>
                            <p className="mt-0.5 text-xs text-muted-foreground">
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

                        {dirty && !syncLocked ? (
                          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                            <AlertTriangle className="size-3.5 shrink-0" />
                            {t("settings.backupSyncDirtyHint")}
                          </div>
                        ) : null}
                      </>
                    )}
                  </DialogBody>

                  {syncFormOpen ? (
                    <DialogFooter>
                      <Button
                        size="sm"
                        disabled={syncLocked || !dirty}
                        onClick={() => void handleSaveSync()}
                      >
                        {syncBusy === "save" ? <Loader2 className="size-3.5 animate-spin" /> : null}
                        {t("settings.backupSyncSave")}
                      </Button>
                    </DialogFooter>
                  ) : null}
                </DialogContent>
              </Dialog>
            }
          />

          {syncConfigured ? (
            <SettingsRow
              title={t("settings.backupSyncRemoteTitle")}
              description={
                syncView?.lastSyncAt
                  ? `${t("settings.backupSyncLastAt")}${formatTimestamp(syncView.lastSyncAt)}`
                  : t("settings.backupSyncStatusNeverSynced")
              }
              control={
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={syncLocked || dirty}
                    onClick={() => void handleUpload()}
                  >
                    {syncBusy === "upload" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Upload className="size-3.5" />
                    )}
                    {t("settings.backupSyncUpload")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={syncLocked || dirty}
                    onClick={() => void handleDownload()}
                  >
                    {syncBusy === "download" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <CloudDownload className="size-3.5" />
                    )}
                    {t("settings.backupSyncDownload")}
                  </Button>
                </div>
              }
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("settings.backupScopeTitle")}>
        <SettingsCard>
          <SettingsRow
            title={t("settings.backupScopeSummaryTitle")}
            description={t("settings.backupScopeSummary")}
            control={
              <Dialog>
                <DialogTrigger render={<Button size="sm" variant="outline" />}>
                  {t("settings.backupScopeView")}
                </DialogTrigger>
                <DialogContent
                  className="max-w-lg"
                  closeLabel={t("settings.backupCancel")}
                  showCloseButton
                >
                  <DialogHeader>
                    <DialogTitle>{t("settings.backupScopeTitle")}</DialogTitle>
                    <DialogDescription>{t("settings.backupScopeSummary")}</DialogDescription>
                  </DialogHeader>
                  <DialogBody>
                    <BackupScopeDetails t={t} />
                  </DialogBody>
                </DialogContent>
              </Dialog>
            }
          />
        </SettingsCard>
      </SettingsSection>

      {dialog}
    </div>
  );
}
