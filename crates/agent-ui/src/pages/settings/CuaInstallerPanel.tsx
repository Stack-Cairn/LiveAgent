/**
 * CUA Driver 安装器面板。
 *
 * 显示当前 cua-driver 状态（安装 / 版本 / daemon）；提供安装 / 重启
 * daemon / 更新三组操作；安装进度通过 `subscribeProgress` 回调实时反映。
 *
 * MVP 范围：检测 + 安装 + 启动 daemon + 简单更新检查；复杂的更新策略
 * / 多通道 / 高级诊断留给后续迭代。
 */
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CloudDownload,
  ExternalLink,
  Play,
  RefreshCw,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type {
  CuaDriverDetection,
  CuaInstallerService,
  CuaUpdateResult,
  InstallerProgressEvent,
  InstallPreview,
} from "./CuaInstaller";
import { SettingsGroup } from "./shared";

export type CuaInstallerPanelProps = {
  service: CuaInstallerService;
  /** 来自后端的当前 OS 标签（"macos" / "windows" / "linux"）。 */
  platform: string;
};

type InstallFlowState =
  | { kind: "idle" }
  | { kind: "running"; stage: string; message: string; percent: number | null; logTail: string }
  | { kind: "success"; message: string; log?: string }
  | { kind: "info"; message: string; log?: string }
  | { kind: "error"; errorText: string; log?: string };

function statusTone(detection: CuaDriverDetection | null): {
  badge: string;
  labelKey: string;
} {
  if (!detection) {
    return {
      badge: "bg-muted text-muted-foreground",
      labelKey: "settings.cua.installer.statusUnknown",
    };
  }
  if (!detection.installed) {
    return {
      badge: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
      labelKey: "settings.cua.installer.statusNotInstalled",
    };
  }
  if (!detection.daemonRunning) {
    return {
      badge: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
      labelKey: "settings.cua.installer.statusInstalledNotRunning",
    };
  }
  return {
    badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    labelKey: "settings.cua.installer.statusInstalledRunning",
  };
}

function formatPercent(value: number | null | undefined): number {
  if (value == null) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

function permissionDeepLink(platform: string): string | null {
  if (platform === "macos") {
    // x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility
    return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
  }
  return null;
}

/**
 * 通用占位符替换。`t(key)` 拿到模板，再把 `{name}` 替换为传入值。
 * 与现有 i18n 模式保持一致（见 formatCuaError.interpolate）。
 */
function fillTemplate(
  template: string,
  params: Record<string, string | number | undefined>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) return match;
    return String(value);
  });
}

export function CuaInstallerPanel(props: CuaInstallerPanelProps) {
  const { service, platform } = props;
  const { t } = useLocale();
  const [detection, setDetection] = useState<CuaDriverDetection | null>(null);
  const [preview, setPreview] = useState<InstallPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [flow, setFlow] = useState<InstallFlowState>({ kind: "idle" });
  const [logExpanded, setLogExpanded] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const chevronRef = useRef<HTMLSpanElement | null>(null);

  // CUA-044: WKWebView (Tauri WebView) 在 hidden / 隐藏式面板里会丢 className
  // 切换的 layout flush——Tailwind rotate-180 编译后的 transform: rotate(180deg)
  // 已经写入 stylesheet 但下一帧之前没有触发同步 layout，导致视觉不旋转。
  // useLayoutEffect 在 React commit 后、浏览器 paint 前同步运行；显式读
  // offsetWidth 强制一次同步 reflow，让 className 切换被立即提交。
  // （不再使用 inline style.transform——之前几轮的 inline style 路径在
  // WKWebView 中会被丢弃，className 走样式表 pipeline 更稳。）
  // biome-ignore lint/correctness/useExhaustiveDependencies: logExpanded is the trigger — re-run after every expand/collapse so the WebView reflows and the rotate-180 class actually paints.
  useLayoutEffect(() => {
    const el = chevronRef.current;
    if (!el) return;
    void el.offsetWidth;
  }, [logExpanded]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [next, pv] = await Promise.all([service.detectDriver(), service.getInstallPreview()]);
      setDetection(next);
      setPreview(pv);
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 监听 install 进度事件——通过 service.subscribeProgress 桥接，避免
  // agent-ui 直接依赖 @tauri-apps/api。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!service.subscribeProgress) return;
      try {
        const unlisten = await service.subscribeProgress((payload: InstallerProgressEvent) => {
          setFlow((current) => {
            if (current.kind !== "running") return current;
            return {
              kind: "running",
              stage: payload.stage,
              message: payload.message,
              percent: payload.percent ?? null,
              logTail: payload.logTail ?? current.logTail,
            };
          });
          if (payload.stage === "failed") {
            setFlow({
              kind: "error",
              errorText: payload.message,
              log: payload.logTail,
            });
          }
        });
        if (cancelled) {
          unlisten();
        } else {
          unlistenRef.current = unlisten;
        }
      } catch (err) {
        console.warn("[cua-installer] failed to subscribe progress event", err);
      }
    })();
    return () => {
      cancelled = true;
      if (unlistenRef.current) {
        try {
          unlistenRef.current();
        } catch {
          // ignore
        }
        unlistenRef.current = null;
      }
    };
  }, [service]);

  const startInstall = useCallback(async () => {
    setErrorBanner(null);
    setFlow({
      kind: "running",
      stage: "starting",
      message: t("settings.cua.installer.stage.starting"),
      percent: 0,
      logTail: "",
    });
    try {
      const result = await service.installDriver();
      if (!result) {
        setFlow({
          kind: "error",
          errorText: t("settings.cua.installer.errors.invoke"),
        });
        return;
      }
      if (result.success) {
        setFlow({
          kind: "success",
          message: fillTemplate(t("settings.cua.installer.installSuccess"), {
            version: result.installedVersion ?? "—",
            daemon: result.daemonStarted
              ? t("settings.cua.installer.daemonStarted")
              : t("settings.cua.installer.daemonNotStarted"),
          }),
          log: result.log,
        });
      } else {
        setFlow({
          kind: "error",
          errorText: result.error ?? t("settings.cua.installer.errors.unknown"),
          log: result.log,
        });
      }
      await refresh();
    } catch (err) {
      setFlow({
        kind: "error",
        errorText: errorTextFromUnknown(err, t),
      });
    }
  }, [service, refresh, t]);

  const restartDaemon = useCallback(async () => {
    setErrorBanner(null);
    setFlow({
      kind: "running",
      stage: "startingDaemon",
      message: t("settings.cua.installer.stage.startingDaemon"),
      percent: 90,
      logTail: "",
    });
    try {
      const ok = await service.startDriverDaemon();
      if (ok) {
        setFlow({ kind: "idle" });
      } else {
        setFlow({
          kind: "error",
          errorText: t("settings.cua.installer.errors.daemonStart"),
        });
      }
      await refresh();
    } catch (err) {
      setFlow({
        kind: "error",
        errorText: errorTextFromUnknown(err, t),
      });
    }
  }, [service, refresh, t]);

  const checkUpdate = useCallback(async () => {
    setErrorBanner(null);
    setFlow({
      kind: "running",
      stage: "starting",
      message: t("settings.cua.installer.stage.checkingUpdate"),
      percent: 0,
      logTail: "",
    });
    try {
      const result = await service.updateDriver(false);
      if (!result) {
        setFlow({
          kind: "error",
          errorText: t("settings.cua.installer.errors.invoke"),
        });
        return;
      }
      if (result.updateAvailable) {
        // 检测到新版本：语义上是 info（蓝），不是失败。
        setFlow({
          kind: "info",
          message: fillTemplate(t("settings.cua.installer.update.available"), {
            log: result.log.slice(0, 2000),
          }),
          log: result.log.slice(0, 2000),
        });
      } else {
        // 已是最新：语义上是 success（绿），不是失败。
        setFlow({
          kind: "success",
          message: fillTemplate(t("settings.cua.installer.update.upToDate"), {
            log: result.log.slice(0, 2000),
          }),
          log: result.log.slice(0, 2000),
        });
      }
    } catch (err) {
      setFlow({
        kind: "error",
        errorText: errorTextFromUnknown(err, t),
      });
    }
  }, [service, t]);

  const applyUpdate = useCallback(async () => {
    setErrorBanner(null);
    setFlow({
      kind: "running",
      stage: "installing",
      message: t("settings.cua.installer.stage.applyingUpdate"),
      percent: 50,
      logTail: "",
    });
    try {
      const result = (await service.updateDriver(true)) as CuaUpdateResult | null;
      if (!result) {
        setFlow({
          kind: "error",
          errorText: t("settings.cua.installer.errors.invoke"),
        });
        return;
      }
      // updateDriver(apply=true) 由后端走 spawn_blocking 跑 update --apply。
      // 必须按 result.error / result.updateAvailable / result.newVersion 三态区分：
      //   - error 非空            → error (红)
      //   - updateAvailable=true  → success (绿) 「更新成功」
      //   - updateAvailable=false → success (绿) 「已是最新版本」
      // 旧实现只看 newVersion，已是最新版本时也会被误标红「更新失败」(CUA-032)。
      const logSlice = result.log.slice(0, 2000);
      if (result.error) {
        setFlow({
          kind: "error",
          errorText: fillTemplate(t("settings.cua.installer.update.failed"), {
            log: logSlice,
          }),
          log: logSlice,
        });
      } else if (result.updateAvailable && result.newVersion) {
        setFlow({
          kind: "success",
          message: fillTemplate(t("settings.cua.installer.update.applied"), {
            version: result.newVersion,
            log: logSlice,
          }),
          log: logSlice,
        });
      } else {
        // 后端报告 updateAvailable=false、error=null：已是最新版本，按 success 渲染。
        setFlow({
          kind: "success",
          message: fillTemplate(t("settings.cua.installer.update.upToDate"), {
            log: logSlice,
          }),
          log: logSlice,
        });
      }
      await refresh();
    } catch (err) {
      setFlow({
        kind: "error",
        errorText: errorTextFromUnknown(err, t),
      });
    }
  }, [service, refresh, t]);

  const dismissFlow = useCallback(() => {
    setFlow({ kind: "idle" });
    setLogExpanded(false);
    setErrorBanner(null);
  }, []);

  const tone = useMemo(() => statusTone(detection), [detection]);
  const isRunning = flow.kind === "running";
  const macosPermissionsPath = permissionDeepLink(platform);

  return (
    <SettingsGroup title={t("settings.cua.installer.title")}>
      <div className="space-y-4 px-5 py-4" data-testid="cua-driver-status">
        <div
          className="flex flex-wrap items-center gap-3"
          data-cua-driver-state={
            detection
              ? detection.installed
                ? detection.daemonRunning
                  ? "running"
                  : "installed"
                : "missing"
              : "unknown"
          }
        >
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
              tone.badge,
            )}
            data-testid="cua-driver-status-badge"
          >
            {detection?.installed && detection.daemonRunning ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <AlertTriangle className="h-3 w-3" />
            )}
            {t(tone.labelKey)}
          </span>
          {detection?.installed ? (
            <span
              className="font-mono text-[11px] text-muted-foreground"
              data-testid="cua-driver-version"
              data-cua-driver-version={detection.version ?? ""}
            >
              {detection.version
                ? fillTemplate(t("settings.cua.installer.versionLabel"), {
                    version: detection.version,
                  })
                : t("settings.cua.installer.versionUnknown")}
            </span>
          ) : null}
          {detection?.path ? (
            <span
              className="truncate font-mono text-[11px] text-muted-foreground"
              title={detection.path}
            >
              {detection.path}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            data-testid="cua-driver-refresh"
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            {t("settings.cua.installer.refresh")}
          </button>
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.cua.installer.description")}
        </p>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2" data-testid="cua-driver-actions">
          {!detection?.installed ? (
            <Button
              variant="default"
              size="sm"
              onClick={() => void startInstall()}
              disabled={isRunning}
              data-testid="cua-driver-install-button"
            >
              <CloudDownload className="h-3.5 w-3.5" />
              {t("settings.cua.installer.install")}
            </Button>
          ) : null}
          {detection?.installed && !detection.daemonRunning ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void restartDaemon()}
              disabled={isRunning}
              data-testid="cua-driver-restart-daemon-button"
            >
              <Play className="h-3.5 w-3.5" />
              {t("settings.cua.installer.restartDaemon")}
            </Button>
          ) : null}
          {detection?.installed ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void checkUpdate()}
              disabled={isRunning}
              data-testid="cua-driver-check-update-button"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("settings.cua.installer.checkUpdate")}
            </Button>
          ) : null}
          {detection?.installed ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void applyUpdate()}
              disabled={isRunning}
              data-testid="cua-driver-update-button"
            >
              {t("settings.cua.installer.applyUpdate")}
            </Button>
          ) : null}
        </div>

        {/* Install preview info — Linux deps / command description */}
        {preview && !detection?.installed ? (
          <div
            className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground"
            data-testid="cua-driver-install-preview"
          >
            <p className="font-mono break-all text-foreground/80">
              {`${preview.command.program} ${preview.command.args
                .map((a) => (a.includes(" ") ? JSON.stringify(a) : a))
                .join(" ")}`}
            </p>
            {preview.linuxMissingPackages && preview.linuxMissingPackages.length > 0 ? (
              <p className="mt-1.5 text-amber-700 dark:text-amber-400">
                {fillTemplate(t("settings.cua.installer.linuxMissingDeps"), {
                  packages: preview.linuxMissingPackages.join(", "),
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* macOS permissions card */}
        {platform === "macos" && detection?.installed ? (
          <div
            className="rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2.5 text-[11px] leading-relaxed text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200"
            data-testid="cua-driver-permissions-card"
          >
            <p className="font-medium">{t("settings.cua.installer.macosPermissionsTitle")}</p>
            <p className="mt-1 whitespace-pre-line text-amber-900/90 dark:text-amber-200/90">
              {t("settings.cua.installer.macosPermissionsBody")}
            </p>
            {macosPermissionsPath ? (
              <a
                href={macosPermissionsPath}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-amber-900 underline hover:text-amber-700 dark:text-amber-200 dark:hover:text-amber-100"
                data-testid="cua-driver-permissions-link"
              >
                {t("settings.cua.installer.macosOpenSettings")}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </div>
        ) : null}

        {/* Running / progress */}
        {isRunning ? (
          <div className="space-y-1.5" data-testid="cua-driver-install-progress">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{
                  width: `${formatPercent(flow.kind === "running" ? flow.percent : null)}%`,
                }}
              />
            </div>
            <p
              className="font-mono text-[11px] text-muted-foreground"
              data-testid="cua-driver-install-progress-message"
            >
              {flow.kind === "running" ? flow.message : ""}
            </p>
          </div>
        ) : null}

        {/* Terminal-style log — error/info/success 都允许展开日志，便于看完整输出。 */}
        {(isRunning && flow.kind === "running" && flow.logTail) ||
        flow.kind === "error" ||
        flow.kind === "info" ||
        flow.kind === "success" ? (
          <div
            className="rounded-lg border border-border/60 bg-zinc-950/95 text-zinc-100"
            data-testid="cua-driver-install-log"
          >
            <button
              type="button"
              onClick={() => setLogExpanded((v) => !v)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[11px] text-zinc-300 hover:bg-zinc-900"
              data-testid="cua-driver-install-log-toggle"
              aria-expanded={logExpanded}
            >
              <span className="font-medium uppercase tracking-wide">
                {t("settings.cua.installer.logLabel")}
              </span>
              <span
                ref={chevronRef}
                className={cn(
                  "inline-flex transition-transform duration-150",
                  logExpanded ? "rotate-180" : "rotate-0",
                )}
                data-chevron-expanded={logExpanded ? "true" : "false"}
              >
                <ChevronDown className="h-3 w-3" />
              </span>
            </button>
            {logExpanded ? (
              <pre
                className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-zinc-800 px-3 py-2 font-mono text-[10.5px] leading-relaxed"
                data-testid="cua-driver-install-log-body"
              >
                {flow.kind === "running"
                  ? flow.logTail
                  : flow.kind === "error"
                    ? (flow.log ?? flow.errorText)
                    : flow.kind === "info" || flow.kind === "success"
                      ? (flow.log ?? flow.message)
                      : ""}
              </pre>
            ) : null}
          </div>
        ) : null}

        {/* Final state messages */}
        {flow.kind === "success" ? (
          <div
            className="rounded-lg border border-emerald-300/60 bg-emerald-50/60 px-3 py-2 text-[11px] text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-950/30 dark:text-emerald-200"
            data-testid="cua-driver-install-success"
          >
            <p className="font-medium">{flow.message}</p>
            <button
              type="button"
              onClick={dismissFlow}
              className="mt-1 text-emerald-900 underline hover:text-emerald-700 dark:text-emerald-200 dark:hover:text-emerald-100"
            >
              {t("settings.cua.installer.dismiss")}
            </button>
          </div>
        ) : null}

        {flow.kind === "info" ? (
          <div
            className="rounded-lg border border-blue-300/60 bg-blue-50/60 px-3 py-2 text-[11px] text-blue-900 dark:border-blue-700/40 dark:bg-blue-950/30 dark:text-blue-200"
            data-testid="cua-driver-install-info"
          >
            <p className="font-medium">{flow.message}</p>
            <button
              type="button"
              onClick={dismissFlow}
              className="mt-1 text-blue-900 underline hover:text-blue-700 dark:text-blue-200 dark:hover:text-blue-100"
            >
              {t("settings.cua.installer.dismiss")}
            </button>
          </div>
        ) : null}

        {flow.kind === "error" ? (
          <div
            className="rounded-lg border border-rose-300/60 bg-rose-50/60 px-3 py-2 text-[11px] text-rose-900 dark:border-rose-700/40 dark:bg-rose-950/30 dark:text-rose-200"
            data-testid="cua-driver-install-error"
          >
            <p className="font-medium">{flow.errorText}</p>
            <button
              type="button"
              onClick={dismissFlow}
              className="mt-1 text-rose-900 underline hover:text-rose-700 dark:text-rose-200 dark:hover:text-rose-100"
            >
              {t("settings.cua.installer.dismiss")}
            </button>
          </div>
        ) : null}

        {errorBanner ? (
          <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] text-rose-900 dark:border-rose-800/60 dark:bg-rose-950/40 dark:text-rose-300">
            {errorBanner}
          </div>
        ) : null}
      </div>
    </SettingsGroup>
  );
}

function errorTextFromUnknown(err: unknown, t: (key: string) => string): string {
  if (err instanceof Error) {
    return fillTemplate(t("settings.cua.installer.errors.exception"), { message: err.message });
  }
  if (typeof err === "string") return err;
  return t("settings.cua.installer.errors.unknown");
}
