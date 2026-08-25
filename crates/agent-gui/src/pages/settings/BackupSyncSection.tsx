import {
  AlertTriangle,
  ArchiveRestore,
  Brain,
  CheckCircle2,
  CircleHelp,
  Cloud,
  CloudDownload,
  Download,
  FileText,
  HardDrive,
  Key,
  Loader2,
  Lock,
  McpLogo,
  MessageSquare,
  Plug,
  Save,
  Server,
  Settings2,
  Shield,
  SkillIcon,
  Upload,
  XCircle,
  Zap,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import { LabelTooltip } from "@liveagent/ui/components/ui/label-tooltip";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import { listen } from "@tauri-apps/api/event";
import { type ReactNode, useCallback, useEffect, useState } from "react";
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

/** 即时反馈条：成功绿 / 失败红，替代裸文本。 */
function FeedbackStrip({ status }: { status: Status }) {
  if (!status) return null;
  const ok = status.kind === "ok";
  return (
    <div
      className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs leading-relaxed ${
        ok
          ? "border-emerald-600/25 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/25 dark:text-emerald-300"
          : "border-destructive/30 bg-destructive/10 text-destructive"
      }`}
    >
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      ) : (
        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      )}
      <span className="min-w-0 break-all font-medium">{status.text}</span>
    </div>
  );
}

function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <Label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
      {children}
      {hint ? (
        <LabelTooltip label={<span className="max-w-64 text-xs leading-relaxed">{hint}</span>}>
          <CircleHelp className="h-3.5 w-3.5 cursor-help text-muted-foreground/60" />
        </LabelTooltip>
      ) : null}
    </Label>
  );
}

/** 顶部状态横幅：未配置 / 已就绪 / 自动同步失败，聚合上次同步时间与自动同步开关态。 */
function SyncStatusBanner({
  view,
  loading,
  t,
}: {
  view: BackupSyncConfigView | null;
  loading: boolean;
  t: (key: string) => string;
}) {
  if (loading && !view) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card px-5 py-4">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t("settings.backupSyncLoading")}</span>
      </div>
    );
  }

  // 加载失败时 view 为 null：按「未配置」展示，具体错误由表单区的反馈条给出。
  const configured = view ? canTestSyncConnection(view) : false;
  const failed = Boolean(view?.lastError);

  const iconWrap = failed
    ? "bg-destructive/10 text-destructive"
    : configured
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : "bg-muted text-muted-foreground";

  return (
    <div className="rounded-2xl border border-border/60 bg-card px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${iconWrap}`}
        >
          {failed ? <AlertTriangle className="h-5 w-5" /> : <Cloud className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">
            {failed
              ? t("settings.backupSyncAutoErrorTitle")
              : configured
                ? t("settings.backupSyncStatusReady")
                : t("settings.backupSyncStatusNotConfigured")}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {configured
              ? view?.lastSyncAt
                ? `${t("settings.backupSyncLastAt")}${formatTimestamp(view.lastSyncAt)}`
                : t("settings.backupSyncStatusNeverSynced")
              : t("settings.backupSyncStatusNotConfiguredHint")}
          </p>
        </div>
        {configured ? (
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium leading-none ${
              view?.autoSync
                ? "border-emerald-600/25 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/25 dark:text-emerald-300"
                : "border-border/70 bg-muted/45 text-muted-foreground"
            }`}
          >
            <Zap className="h-3 w-3" />
            {view?.autoSync ? t("settings.backupSyncAutoOn") : t("settings.backupSyncAutoOff")}
          </span>
        ) : null}
      </div>
      {failed && view?.lastError ? (
        <p className="mt-3 break-all rounded-xl bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive/90">
          {view.lastError}
        </p>
      ) : null}
    </div>
  );
}

/** 本地备份的大号操作磁贴。 */
function ActionTile({
  icon,
  busy,
  title,
  hint,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  busy: boolean;
  title: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-xl border border-border/60 bg-background/60 px-3.5 py-3 text-left transition-colors hover:border-border hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-55"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
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
    <div
      className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs ${
        excluded ? "bg-muted/30 text-muted-foreground/70" : "bg-muted/45 text-foreground/85"
      }`}
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center ${excluded ? "opacity-60" : ""}`}
      >
        {icon}
      </span>
      <span
        className={`truncate font-medium ${excluded ? "line-through decoration-muted-foreground/40" : ""}`}
      >
        {label}
      </span>
    </div>
  );
}

export function BackupSyncSection(props: SettingsSectionProps) {
  const { settings, setSettings, reloadSettings } = props;
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

  /**
   * 还原（导入 / 下载）落库后同步前端状态。
   *
   * 顺序不能反：`reloadSettings` 从 SQLite 重载 providers/mcp/system，
   * 但 skills 只存在于 localStorage，库里没有 —— 必须重载完再把快照里的
   * skills 盖上去，否则会被重载出来的旧值顶掉。
   *
   * 不重载的后果不是「显示旧值」这么轻：`persistSettings` 按域 diff，
   * 用户之后动任一域就会拿还原前的内存值写回库，把还原静默回滚掉。
   */
  const syncStateAfterRestore = useCallback(
    async (skillsPayload: unknown) => {
      await reloadSettings?.();
      if (skillsPayload) {
        const skills = normalizeSkillsSettings(skillsPayload);
        setSettings((prev) => ({ ...prev, skills }));
      }
    },
    [reloadSettings, setSettings],
  );

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
    (value: PresetId) => {
      setPreset(value);
      const matched = SYNC_PRESETS.find((item) => item.id === value);
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
      await syncStateAfterRestore(outcome.skills);
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
      await syncStateAfterRestore(outcome.skills);
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

  return (
    <div className="mx-auto w-full max-w-[980px] space-y-5">
      <SyncStatusBanner view={syncView} loading={syncBusy === "load"} t={t} />

      {/* 两栏等高拉伸（默认 stretch），保证左右卡片底边始终对齐。 */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* 左栏：WebDAV 同步配置。弹性布局把底部操作区钉在底边，撑高时中间留白。 */}
        <section className="flex flex-col rounded-2xl border border-border/60 bg-card">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-5 py-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Cloud className="h-4 w-4" />
              </span>
              <h3 className="text-sm font-semibold text-foreground">
                {t("settings.backupSyncTitle")}
              </h3>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/45 px-2.5 py-1 text-[11px] font-medium leading-none text-muted-foreground">
              <Lock className="h-3 w-3" />
              {t("settings.backupSyncCredentialNote")}
            </span>
          </header>

          <div className="flex-1 space-y-4 px-5 py-4">
            <div className="space-y-1.5">
              <FieldLabel>{t("settings.backupSyncPreset")}</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                {presetOptions.map((item) => {
                  const active = preset === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={syncLocked}
                      aria-pressed={active}
                      onClick={() => handlePresetChange(item.id)}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                        active
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border/70 bg-background/60 text-muted-foreground hover:border-border hover:text-foreground"
                      }`}
                    >
                      {t(`settings.backupSyncPreset_${item.id}`)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <FieldLabel>{t("settings.backupSyncUrl")}</FieldLabel>
              <div className="relative">
                <Server className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  value={form.url}
                  disabled={syncLocked}
                  placeholder="https://dav.example.com/dav/"
                  className="pl-9"
                  onChange={(event) => patchForm({ url: event.target.value })}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <FieldLabel>{t("settings.backupSyncUsername")}</FieldLabel>
                <Input
                  value={form.username}
                  disabled={syncLocked}
                  autoComplete="off"
                  onChange={(event) => patchForm({ username: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <FieldLabel>{t("settings.backupSyncPassword")}</FieldLabel>
                <div className="relative">
                  <Key className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
                  <Input
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
                      // 清空密码框视为「没动过」，而不是「把密码改成空」。
                      // 后端只在 passwordTouched 时采用新值，若这里对空串也置 true，
                      // 用户输入几个字符再全删掉就会静默抹掉已存的密码 —— 与本框
                      // 自己的「留空则不修改」占位提示直接矛盾，且此后自动同步因
                      // 凭据不全而永久静默跳过（auto_upload 的 credentials 分支）。
                      // 真要清空密码就关掉同步或改用户名，不该由删字符触发。
                      patchForm({ password, passwordTouched: password.length > 0 });
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <FieldLabel>{t("settings.backupSyncRemoteDir")}</FieldLabel>
                <Input
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
                  value={form.profile}
                  disabled={syncLocked}
                  placeholder="default"
                  onChange={(event) => patchForm({ profile: event.target.value })}
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3.5 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <Zap className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground">
                    {t("settings.backupSyncAuto")}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {t("settings.backupSyncAutoHint")}
                  </p>
                </div>
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

          <footer className="space-y-3 border-t border-border/60 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
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
              <div className="mx-1 h-4 w-px bg-border/70" />
              <Button
                variant="outline"
                size="sm"
                disabled={syncLocked || dirty}
                onClick={() => void handleUpload()}
              >
                {syncBusy === "upload" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
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
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {t("settings.backupSyncDirtyHint")}
              </div>
            ) : null}

            <FeedbackStrip status={syncStatus} />
          </footer>
        </section>

        {/* 右栏：本地备份 + 备份范围。范围卡弹性补足高度，与左栏底边对齐。 */}
        <aside className="flex flex-col gap-5">
          <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <HardDrive className="h-4 w-4" />
              </span>
              <h3 className="text-sm font-semibold text-foreground">
                {t("settings.backupLocalTitle")}
              </h3>
            </div>

            <div className="space-y-2">
              <ActionTile
                icon={<Download className="h-4 w-4" />}
                busy={busy === "export"}
                title={t("settings.backupExport")}
                hint={t("settings.backupExportHint")}
                disabled={busy !== null}
                onClick={() => void handleExport()}
              />
              <ActionTile
                icon={<Upload className="h-4 w-4" />}
                busy={busy === "import"}
                title={t("settings.backupImport")}
                hint={t("settings.backupImportHint")}
                disabled={busy !== null}
                onClick={() => void handleImport()}
              />
            </div>

            <div className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
              <ArchiveRestore className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("settings.backupAutoBackupHint")}</span>
            </div>

            <FeedbackStrip status={status} />
          </section>

          <section className="flex-1 space-y-3 rounded-2xl border border-border/60 bg-card p-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Shield className="h-4 w-4" />
              </span>
              <h3 className="text-sm font-semibold text-foreground">
                {t("settings.backupScopeTitle")}
              </h3>
            </div>

            <div className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {t("settings.backupScopeIncluded")}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <ScopeItem
                  icon={<Server className="h-3.5 w-3.5" />}
                  label={t("settings.backupDomainProviders")}
                />
                <ScopeItem
                  icon={<McpLogo className="h-3.5 w-3.5" />}
                  label={t("settings.backupDomainMcp")}
                />
                <ScopeItem
                  icon={<Settings2 className="h-3.5 w-3.5" />}
                  label={t("settings.backupDomainSystem")}
                />
                <ScopeItem
                  icon={<SkillIcon className="h-3.5 w-3.5" />}
                  label={t("settings.backupDomainSkills")}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {t("settings.backupScopeExcluded")}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <ScopeItem
                  excluded
                  icon={<MessageSquare className="h-3.5 w-3.5" />}
                  label={t("settings.backupScopeChat")}
                />
                <ScopeItem
                  excluded
                  icon={<Brain className="h-3.5 w-3.5" />}
                  label={t("settings.backupScopeMemory")}
                />
                <ScopeItem
                  excluded
                  icon={<FileText className="h-3.5 w-3.5" />}
                  label={t("settings.backupScopeUploads")}
                />
                <ScopeItem
                  excluded
                  icon={<Key className="h-3.5 w-3.5" />}
                  label={t("settings.backupScopeSshKeys")}
                />
              </div>
            </div>
          </section>
        </aside>
      </div>

      {dialog}
    </div>
  );
}
