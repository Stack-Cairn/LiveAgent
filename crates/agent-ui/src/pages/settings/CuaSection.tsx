import { Eye, EyeOff, MonitorSmartphone, Trash2 } from "@liveagent/ui/components/IconSet";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import { type CuaErrorPayload, formatCuaError } from "@liveagent/ui/lib/cua/formatCuaError";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { errorMessageWithFallback } from "@liveagent/ui/lib/shared/value";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CuaInstallerService } from "./CuaInstaller";
import { CuaInstallerPanel } from "./CuaInstallerPanel";
import { AgentActivationSwitch, SettingsGroup, SettingsRow } from "./shared";

export type CuaSettings = {
  enabled: boolean;
  allowedOwners: string[];
  auditLogLimit: number;
  /** 「信任模式」开关：开启后 `group:cua` 工具在前端不再弹审批
   * （CUA-reviewer 要求：默认逐次审批）。 */
  trustMode: boolean;
};

export type CuaAuditEntry = {
  timestamp: string;
  operation: string;
  ok: boolean;
  /** 失败原因——结构化 payload（kind + params + 英文 message），由 UI
   * 按当前 locale 翻译（CUA-006）。 */
  error?: CuaErrorPayload;
  detail?: unknown;
};

export type CuaStatus = {
  config: CuaSettings;
  platform: string;
  /** cua-driver 是否可用（installed + daemon running）。与 config.enabled
   * 独立——开关在前端 UI / backend CuaStore，driver 在 installer 路径。 */
  available: boolean;
  /** 后端 CuaRuntimeConfig.sandboxOffline 镜像。当前命令安全模式是
   * sandboxOffline 时为 true；UI 据此展示离线指示器与禁用状态。 */
  sandboxOffline?: boolean;
  recent: CuaAuditEntry[];
};

export type CuaService = {
  fetchStatus: () => Promise<CuaStatus | null>;
  setConfig: (config: CuaSettings) => Promise<CuaStatus | null>;
  clearAudit: () => Promise<CuaStatus | null>;
  /** 来自后端的平台标签（"macos" / "windows" / "linux"）。 */
  platformLabel: string;
} & Partial<CuaInstallerService>;

export type CuaSectionProps = {
  settings: CuaSettings;
  setSettings: (updater: (prev: CuaSettings) => CuaSettings) => void;
  /** 与 Rust 后端 CuaStore 通信的薄包装。设置面板挂载时由 host 注入。 */
  cuaService: CuaService;
};

type PlatformNote = {
  label: string;
  permissionKeys: string[];
  tone: string;
  supported: boolean;
};

const PLATFORM_NOTES: Record<string, PlatformNote> = {
  macos: {
    label: "macOS",
    permissionKeys: [
      "settings.cua.platformNotes.macos.accessibility",
      "settings.cua.platformNotes.macos.screenRecording",
      "settings.cua.platformNotes.macos.dragAndDrop",
    ],
    tone: "text-emerald-600 dark:text-emerald-400",
    supported: true,
  },
  windows: {
    label: "Windows",
    permissionKeys: ["settings.cua.platformNotes.unsupported"],
    tone: "text-amber-600 dark:text-amber-400",
    supported: false,
  },
  linux: {
    label: "Linux",
    permissionKeys: ["settings.cua.platformNotes.unsupported"],
    tone: "text-amber-600 dark:text-amber-400",
    supported: false,
  },
};

function joinOwners(list: string[]): string {
  return list
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(", ");
}

function parseOwners(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusLabel(
  ok: boolean,
  op: string,
  error: CuaErrorPayload | undefined,
  t: (key: string, locale: import("@liveagent/ui/i18n/index").Locale) => string,
  locale: import("@liveagent/ui/i18n/index").Locale,
): string {
  if (ok) return `${op} ✓`;
  // CUA-006：失败原因从 Rust 拿到的是结构化 payload，按当前 locale 翻。
  // 后端 message 是英文兜底，正常都能查到 key；万一 fallback 到 message。
  const detail = error ? formatCuaError(error, t, locale) : "";
  return detail ? `${op} ✗ · ${detail}` : `${op} ✗`;
}

export function CuaSection(props: CuaSectionProps) {
  const { settings, setSettings, cuaService } = props;
  const { t, locale } = useLocale();
  const [status, setStatus] = useState<CuaStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ownersDraft, setOwnersDraft] = useState<string>(joinOwners(settings.allowedOwners));
  const [persisting, setPersisting] = useState(false);
  const lastSyncedSettingsRef = useRef<CuaSettings>(settings);

  const platform = status?.platform ?? cuaService.platformLabel ?? "macos";
  const platformNote = PLATFORM_NOTES[platform] ?? PLATFORM_NOTES.macos;

  // 初次挂载：拉一次后端状态。
  useEffect(() => {
    let cancelled = false;
    cuaService
      .fetchStatus()
      .then((s) => {
        if (cancelled) return;
        if (s) setStatus(s);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessageWithFallback(err, t("settings.cua.errors.fetch")));
      });
    return () => {
      cancelled = true;
    };
  }, [cuaService, t]);

  // 当 settings 来自 props（被外部 reset 之类）时，把 owners draft 同步过去。
  useEffect(() => {
    if (settings !== lastSyncedSettingsRef.current) {
      setOwnersDraft(joinOwners(settings.allowedOwners));
      lastSyncedSettingsRef.current = settings;
    }
  }, [settings]);

  const persist = useCallback(
    async (next: CuaSettings) => {
      setPersisting(true);
      try {
        const updated = await cuaService.setConfig(next);
        if (updated) {
          setStatus(updated);
        }
        lastSyncedSettingsRef.current = next;
      } catch (err) {
        setLoadError(errorMessageWithFallback(err, t("settings.cua.errors.save")));
      } finally {
        setPersisting(false);
      }
    },
    [cuaService, t],
  );

  const handleEnabledToggle = useCallback(
    (value: boolean) => {
      const next: CuaSettings = { ...settings, enabled: value };
      setSettings(() => next);
      void persist(next);
    },
    [settings, persist, setSettings],
  );

  const handleAuditLimitChange = useCallback(
    (value: number) => {
      const next: CuaSettings = { ...settings, auditLogLimit: value };
      setSettings(() => next);
      void persist(next);
    },
    [settings, persist, setSettings],
  );

  const handleTrustModeToggle = useCallback(
    (value: boolean) => {
      const next: CuaSettings = { ...settings, trustMode: value };
      setSettings(() => next);
      void persist(next);
    },
    [settings, persist, setSettings],
  );

  const handleOwnersCommit = useCallback(() => {
    const next: CuaSettings = {
      ...settings,
      allowedOwners: parseOwners(ownersDraft),
    };
    setSettings(() => next);
    setOwnersDraft(joinOwners(next.allowedOwners));
    void persist(next);
  }, [ownersDraft, settings, persist, setSettings]);

  const handleClearAudit = useCallback(async () => {
    const updated = await cuaService.clearAudit();
    if (updated) setStatus(updated);
  }, [cuaService]);

  const auditCount = status?.recent.length ?? 0;
  const previewEntries = useMemo(() => (status?.recent ?? []).slice(-10).reverse(), [status]);
  const sandboxOffline = status?.sandboxOffline === true;

  return (
    <div className="space-y-6" data-testid="cua-section">
      {sandboxOffline ? (
        <div
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200"
          data-testid="cua-sandbox-offline-banner"
          role="status"
        >
          {t("settings.cua.sandboxOfflineBanner")}
        </div>
      ) : null}
      <SettingsGroup title={t("settings.cua.title")}>
        <SettingsRow
          title={t("settings.cua.enable")}
          description={
            sandboxOffline
              ? t("settings.cua.enableDescSandboxOffline")
              : platformNote.supported
                ? t("settings.cua.enableDesc")
                : t("settings.cua.enableDescUnsupported")
          }
          control={
            <AgentActivationSwitch
              checked={settings.enabled && !sandboxOffline}
              onToggle={() => handleEnabledToggle(!settings.enabled)}
              title={t("settings.cua.enable")}
              data-testid="cua-enable-switch"
              data-cua-enabled={settings.enabled ? "true" : "false"}
              disabled={sandboxOffline}
            />
          }
        />
        <SettingsRow
          title={t("settings.cua.platform")}
          description={t("settings.cua.platformDesc")}
          control={
            <div
              className={cn("flex items-center gap-2 text-xs", platformNote.tone)}
              data-testid="cua-platform"
            >
              <MonitorSmartphone className="h-3.5 w-3.5" />
              <span className="font-medium">{platformNote.label}</span>
            </div>
          }
        />
        <div className="px-5 pb-4">
          <ul className="ml-1 space-y-1 text-xs leading-relaxed text-muted-foreground">
            {platformNote.permissionKeys.map((key) => (
              <li key={key} className="flex items-start gap-1.5">
                <span className="mt-1 inline-block h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.cua.trustModeGroup")}>
        <SettingsRow
          title={t("settings.cua.trustMode")}
          description={t("settings.cua.trustModeDesc")}
          control={
            <AgentActivationSwitch
              checked={settings.trustMode}
              onToggle={() => handleTrustModeToggle(!settings.trustMode)}
              title={t("settings.cua.trustMode")}
              data-testid="cua-trust-mode-switch"
              data-cua-trust-mode={settings.trustMode ? "true" : "false"}
            />
          }
        />
        <div className="px-5 pb-4">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("settings.cua.trustModeHint")}
          </p>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.cua.allowedOwners")}>
        <div className="px-5 pt-4 pb-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("settings.cua.allowedOwnersDesc")}
          </p>
        </div>
        <div className="px-5 pb-4">
          <Input
            value={ownersDraft}
            onChange={(event) => setOwnersDraft(event.target.value)}
            onBlur={handleOwnersCommit}
            placeholder="Finder, Safari, Terminal"
            className="font-mono text-xs"
            data-testid="cua-allowed-owners-input"
          />
          <div className="mt-1.5 text-[11px] text-muted-foreground">
            {t("settings.cua.allowedOwnersHint")}
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.cua.audit")}>
        <SettingsRow
          title={t("settings.cua.auditLimit")}
          description={t("settings.cua.auditLimitDesc")}
          control={
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                max={1000}
                step={10}
                value={String(settings.auditLogLimit)}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) {
                    handleAuditLimitChange(value);
                  }
                }}
                className="w-24 text-xs"
                data-testid="cua-audit-limit-input"
              />
              <span
                className="text-xs text-muted-foreground"
                data-testid="cua-audit-count"
                data-cua-audit-count={String(auditCount)}
              >
                {t("settings.cua.auditCurrent").replace("{count}", String(auditCount))}
              </span>
            </div>
          }
        />
        <div className="px-5 pb-4">
          {previewEntries.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("settings.cua.auditEmpty")}</p>
          ) : (
            <ul className="divide-y divide-border/40 text-xs">
              {previewEntries.map((entry, idx) => (
                <li key={`${entry.timestamp}-${idx}`} className="flex items-center gap-3 py-1.5">
                  <span
                    className={cn(
                      "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                      entry.ok
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "bg-rose-500/10 text-rose-600 dark:text-rose-400",
                    )}
                    title={entry.ok ? "ok" : "error"}
                  >
                    {entry.ok ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {formatTimestamp(entry.timestamp)}
                  </span>
                  <span className="flex-1 truncate">
                    {statusLabel(entry.ok, entry.operation, entry.error, t, locale)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => void handleClearAudit()}
              disabled={auditCount === 0}
              aria-label={t("settings.cua.auditClear")}
              aria-disabled={auditCount === 0}
              data-testid="cua-clear-audit-button"
              data-cua-audit-clear-disabled={auditCount === 0 ? "true" : "false"}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <Trash2 className="h-3 w-3" />
              {t("settings.cua.auditClear")}
            </button>
          </div>
        </div>
      </SettingsGroup>

      {loadError ? (
        <div className="rounded-lg border border-rose-300 bg-rose-50 px-4 py-2 text-xs text-rose-700 dark:border-rose-800/60 dark:bg-rose-950/40 dark:text-rose-300">
          {loadError}
        </div>
      ) : null}
      {persisting ? (
        <div className="text-xs text-muted-foreground">{t("settings.cua.saving")}</div>
      ) : null}

      {cuaService.detectDriver &&
      cuaService.installDriver &&
      cuaService.updateDriver &&
      cuaService.startDriverDaemon &&
      cuaService.getInstallPreview ? (
        <CuaInstallerPanel
          service={{
            detectDriver: cuaService.detectDriver.bind(cuaService),
            installDriver: cuaService.installDriver.bind(cuaService),
            updateDriver: cuaService.updateDriver.bind(cuaService),
            startDriverDaemon: cuaService.startDriverDaemon.bind(cuaService),
            getInstallPreview: cuaService.getInstallPreview.bind(cuaService),
          }}
          platform={platform}
        />
      ) : null}
    </div>
  );
}
