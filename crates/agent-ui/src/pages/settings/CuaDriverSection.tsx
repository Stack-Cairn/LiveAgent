import {
  type McpServerConfig,
  type ToolPolicy,
  updateMcp,
  updateSystem,
} from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { invoke } from "@liveagent/app/shims/tauriCore";
import { listen } from "@liveagent/app/shims/tauriEvent";
import { ToolPolicyToggle } from "@liveagent/ui/components/hub/ToolPolicyToggle";
import {
  AlertTriangle,
  Check,
  Circle,
  Clock3,
  Download,
  ExternalLink,
  Hand,
  type IconComponent,
  Loader2,
  Package,
  Plug,
  RefreshCw,
  Settings2,
  Shield,
  ShieldOff,
} from "@liveagent/ui/components/IconSet";
import { Input } from "@liveagent/ui/components/ui/input";
import {
  CUA_DRIVER_SERVER_ID as CUA_SERVER_ID,
  effectiveServerPolicyDefault,
  isCuaDriverServerId,
} from "@liveagent/ui/contracts/mcpServerDefaults";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { AgentActivationSwitch } from "@liveagent/ui/pages/settings/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";

/** 与 RemoteSection 同款的卡片标题行，保持两节视觉一致。 */
function SectionCardHeader({ icon: Icon, title }: { icon: IconComponent; title: string }) {
  return (
    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
      <Icon className="h-4 w-4 text-muted-foreground" />
      {title}
    </div>
  );
}

/**
 * CUA（Computer Use Agent）的接入引导，驱动用 trycua/cua 的 cua-driver。
 *
 * 能力本身没有任何专属代码路径——`cua-driver mcp` 就是一个普通 stdio MCP
 * server，接进来之后约 60 个工具由 `tools/list` 自动发现，调用、审批、
 * 截图渲染全部复用既有 MCP 链路。
 *
 * 但它的 MCP 条目**不在 MCP Hub 里露面**（见
 * `contracts/mcpServerDefaults.ts` 的 `isHubHiddenServerId`）：那条目是
 * 这里总开关的实现细节，command 由 `cua-driver manifest` 决定、args 不该
 * 随意改。两个入口都能写同一份配置只会让人搞不清哪边说了算——所以启停、
 * 审批策略、超时、自指闸门全部收在这一节。
 *
 * 仅桌面端注册（见 agent-gui 的 `settingsExtension`）：探测 / 安装 /
 * 授权都依赖 Tauri 命令。
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const INSTALL_PROGRESS_EVENT = "cua_driver_install_progress";
const MAX_LOG_LINES = 200;
const UPSTREAM_REPO_URL = "https://github.com/trycua/cua";

type Probe = {
  installed: boolean;
  path?: string | null;
  version?: string | null;
  mcpCommand?: string | null;
  mcpArgs?: string[];
  /** 本平台是否有系统授权门槛。只有 macOS 为 true。 */
  permissionsRequired?: boolean;
  error?: string | null;
};

type Permissions = {
  supported: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  attributedTo?: string | null;
  daemonRunning: boolean;
  error?: string | null;
};

type InstallPreview = {
  program: string;
  args: string[];
  display: string;
  sourceUrl: string;
};

type InstallProgress = { stream: string; line: string };

/**
 * 探测结果的进程内缓存。
 *
 * 每次挂载都重新探测意味着每次切到 CUA 页都要 spawn 三个子进程
 * （`manifest` / `status` / `permissions status`）——在 Windows 上那是三次
 * 控制台闪窗，在 macOS 上则可能唤起 CuaDriver.app 的守护进程。这些事实在
 * 一分钟内不会变，来回切页时没有重查的理由。
 *
 * 「重新检测」按钮、安装完成、授权完成三处显式跳过缓存。
 */
const PROBE_CACHE_TTL_MS = 60_000;

let probeCache: { at: number; probe: Probe; permissions: Permissions | null } | null = null;

function readProbeCache() {
  if (!probeCache) return null;
  return Date.now() - probeCache.at <= PROBE_CACHE_TTL_MS ? probeCache : null;
}

function serverConfigFrom(probe: Probe): McpServerConfig {
  return {
    id: CUA_SERVER_ID,
    description: "trycua/cua — CUA 驱动（跨平台）",
    docsUrl: UPSTREAM_REPO_URL,
    enabled: true,
    transport: "stdio",
    // 绝对路径而非裸命令：MCP 子进程继承的是 GUI 进程那份窄 PATH，
    // 通常不含 ~/.local/bin —— 官方安装脚本的默认落点。
    command: probe.mcpCommand || probe.path || "cua-driver",
    // 刻意不带 `--direct`：那会让 MCP 进程沿用 LiveAgent 的 TCC 归属，
    // 等于要求 LiveAgent 自己去拿辅助功能与屏幕录制授权。默认模式经
    // CuaDriver.app 的守护进程代理，授权归它。
    args: probe.mcpArgs?.length ? probe.mcpArgs : ["mcp"],
    url: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

export function CuaDriverSection(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();

  const [probe, setProbe] = useState<Probe | null>(null);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [preview, setPreview] = useState<InstallPreview | null>(null);
  const [confirmingInstall, setConfirmingInstall] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [granting, setGranting] = useState(false);
  const [checking, setChecking] = useState(true);
  const [permissionsLoading, setPermissionsLoading] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // 总开关的真实状态就是这个 MCP server 的启用状态——没有第二份配置。
  const serverEntry = settings.mcp.servers.find((server) => isCuaDriverServerId(server.id));
  const enabled = serverEntry?.enabled === true;

  // 策略键跟随条目里那份 id 的原文，而不是常量：已有配置可能把 id 写成
  // `CUA-DRIVER`，此时运行时按原文查 `server:CUA-DRIVER`，这里若硬写
  // `server:cua-driver` 就会出现「页面显示的策略与实际执行的不是同一条」。
  const policyKey = `server:${serverEntry?.id.trim() || CUA_SERVER_ID}`;
  const policy: ToolPolicy =
    settings.system.toolPolicies?.[policyKey] ?? effectiveServerPolicyDefault(CUA_SERVER_ID);
  const allowSelfTargeting = settings.system.cuaAllowSelfTargeting === true;

  // 超时用受控草稿：边打字边写回会把 "6" 这种中间态存成 6ms。
  const [timeoutDraft, setTimeoutDraft] = useState(() => String(serverEntry?.timeoutMs ?? 60_000));
  useEffect(() => {
    setTimeoutDraft(String(serverEntry?.timeoutMs ?? 60_000));
  }, [serverEntry?.timeoutMs]);

  /**
   * 两个探测并行发。
   *
   * 权限查询要 spawn 子进程、还可能等 CuaDriver.app 的守护进程握手，比
   * probe 慢得多；串行的话用户会先看到驱动信息、隔一会儿授权那节才「长
   * 出来」，整页跳一下。并行之后授权节的骨架随第一帧就位，只有里面的
   * 状态文字在等。
   *
   * 授权查询失败不清空已有结果：`permissions grant` 之后重查若临时失败，
   * 直接归零会把刚拿到的授权显示成「未授权」。
   */
  const refresh = useCallback(async (options?: { force?: boolean }) => {
    const cached = options?.force ? null : readProbeCache();
    if (cached) {
      setProbe(cached.probe);
      if (cached.permissions) setPermissions(cached.permissions);
      setChecking(false);
      setPermissionsLoading(false);
      return;
    }

    setChecking(true);
    setPermissionsLoading(true);
    const probeTask = invoke<Probe>("cua_driver_probe");
    const permissionsTask = invoke<Permissions>("cua_driver_permissions_status").catch(() => null);

    let probed: Probe | null = null;
    try {
      probed = await probeTask;
      if (mountedRef.current) setProbe(probed);
    } catch (err) {
      if (mountedRef.current) {
        setProbe({ installed: false });
        setError(String(err));
      }
    } finally {
      if (mountedRef.current) setChecking(false);
    }

    const perms = await permissionsTask;
    // 缓存与组件是否还挂着无关：探测的是机器状态，下次挂载照样能用。
    if (probed) probeCache = { at: Date.now(), probe: probed, permissions: perms };
    if (!mountedRef.current) return;
    if (perms) setPermissions(perms);
    setPermissionsLoading(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  // 卸载时兜底摘掉安装进度监听：`confirmInstall` 正常路径自己会摘，但组件
  // 在安装途中被卸载时那段 finally 还没跑到。
  const installUnlistenRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      installUnlistenRef.current?.();
      installUnlistenRef.current = null;
    },
    [],
  );

  const installed = probe?.installed === true;
  // 是否渲染授权那一节只看平台与安装状态——两者都在 probe 里，不必等权限
  // 查询回来。Windows / Linux 没有 TCC 门槛，整节不存在。
  const showPermissions = installed && probe?.permissionsRequired === true;
  const permissionsKnown = permissions?.supported === true;
  const permissionsPending =
    permissionsKnown && (!permissions.accessibility || !permissions.screenRecording);

  async function beginInstall() {
    setError(null);
    try {
      setPreview(await invoke<InstallPreview>("cua_driver_install_command"));
      setConfirmingInstall(true);
    } catch (err) {
      setError(String(err));
    }
  }

  /**
   * 监听必须在 `cua_driver_install` 发出**之前**注册完成。
   *
   * 之前是靠 `installing` 触发的 effect 去注册，而 effect 要等下一轮渲染、
   * `listen()` 本身还是异步的——这两段时间里安装脚本已经在往外打日志了，
   * 开头那几行直接丢掉。这里改成 `await listen(...)` 之后再发调用，并在
   * finally 里摘掉；组件若在这中间被卸载，由上面的 ref 兜底。
   */
  async function confirmInstall() {
    setConfirmingInstall(false);
    setInstalling(true);
    setLog([]);
    setError(null);

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<InstallProgress>(INSTALL_PROGRESS_EVENT, (event) => {
        setLog((prev) => [...prev, event.payload.line].slice(-MAX_LOG_LINES));
      });
      // 注册与卸载可能已经交错：卸载先发生时立刻摘掉，别把监听器漏在外面。
      if (!mountedRef.current) {
        unlisten();
        unlisten = null;
        return;
      }
      installUnlistenRef.current = unlisten;

      await invoke<Probe>("cua_driver_install");
      await refresh({ force: true });
    } catch (err) {
      if (mountedRef.current) setError(String(err));
    } finally {
      unlisten?.();
      if (installUnlistenRef.current === unlisten) installUnlistenRef.current = null;
      if (mountedRef.current) setInstalling(false);
    }
  }

  async function grantPermissions() {
    setGranting(true);
    setError(null);
    try {
      const next = await invoke<Permissions>("cua_driver_permissions_grant");
      // 授权状态刚变过，缓存里那份已经过时。
      if (probeCache) probeCache = { ...probeCache, permissions: next };
      if (mountedRef.current) setPermissions(next);
    } catch (err) {
      if (mountedRef.current) setError(String(err));
    } finally {
      if (mountedRef.current) setGranting(false);
    }
  }

  /**
   * 总开关 = 「cua-driver 这个 MCP server 是否启用」。
   *
   * 关闭时只把 `enabled` 置 false 而不删除条目：用户可能在 MCP Hub 里
   * 改过 args、超时或权限策略，删掉再加回来会静默丢掉这些自定义。
   * 打开时若条目还不存在才新建。
   */
  function toggleEnabled(next: boolean) {
    if (next && !probe?.installed) return;
    setSettings((prev) => {
      const index = prev.mcp.servers.findIndex((server) => isCuaDriverServerId(server.id));
      if (index < 0) {
        if (!next || !probe) return prev;
        return updateMcp(prev, { servers: [...prev.mcp.servers, serverConfigFrom(probe)] });
      }
      return updateMcp(prev, {
        servers: prev.mcp.servers.map((server, idx) =>
          idx === index ? { ...server, enabled: next } : server,
        ),
      });
    });
  }

  function setPolicy(next: ToolPolicy) {
    setSettings((prev) => {
      const current = { ...(prev.system.toolPolicies ?? {}) };
      // 规范化键一并清掉：id 写成 `CUA-DRIVER` 时两个键会同时存在，留着那条
      // 会让 resolveToolPolicy 的回落读到上一次的值。
      delete current[`server:${CUA_SERVER_ID}`];
      // 与 McpServersForm 同一条规则：等于该 server 的缺省值才删 key。
      // cua-driver 的缺省是 ask，所以「始终允许」必须显式落库。
      if (next === effectiveServerPolicyDefault(CUA_SERVER_ID)) delete current[policyKey];
      else current[policyKey] = next;
      return updateSystem(prev, {
        toolPolicies: Object.keys(current).length > 0 ? current : undefined,
      });
    });
  }

  function setAllowSelfTargeting(next: boolean) {
    setSettings((prev) => updateSystem(prev, { cuaAllowSelfTargeting: next }));
  }

  function commitTimeout() {
    const parsed = Number.parseInt(timeoutDraft.trim(), 10);
    const next =
      Number.isFinite(parsed) && parsed > 0
        ? Math.min(parsed, 600_000)
        : (serverEntry?.timeoutMs ?? 60_000);
    setTimeoutDraft(String(next));
    if (!serverEntry || next === serverEntry.timeoutMs) return;
    setSettings((prev) =>
      updateMcp(prev, {
        servers: prev.mcp.servers.map((server) =>
          isCuaDriverServerId(server.id) ? { ...server, timeoutMs: next } : server,
        ),
      }),
    );
  }

  const statusText = !installed
    ? t("settings.cuaDriver.statusNotInstalled")
    : enabled
      ? t("settings.cuaDriver.statusActive")
      : t("settings.cuaDriver.statusIdle");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-500/10">
            <Hand className="h-[18px] w-[18px] text-sky-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t("settings.cuaDriver.title")}</h3>
            <p className="text-xs text-muted-foreground">{t("settings.cuaDriver.subtitle")}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex max-w-[260px] items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium",
              enabled
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-muted/50 text-muted-foreground",
            )}
            title={probe?.path ?? undefined}
          >
            {enabled ? (
              <Hand className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <Circle className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">{statusText}</span>
          </div>

          <AgentActivationSwitch
            checked={enabled}
            disabled={!installed || installing}
            title={enabled ? t("settings.cuaDriver.disable") : t("settings.cuaDriver.enable")}
            onToggle={() => toggleEnabled(!enabled)}
          />
        </div>
      </div>

      <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <SectionCardHeader icon={Package} title={t("settings.cuaDriver.groupDriver")} />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1.5 text-xs"
            disabled={checking || installing}
            onClick={() => void refresh({ force: true })}
          >
            <RefreshCw className={checking ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            {t("settings.cuaDriver.recheck")}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/30 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              {installed ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
              ) : (
                <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              {installed
                ? probe?.version
                  ? t("settings.cuaDriver.detectedWithVersion").replace("{version}", probe.version)
                  : t("settings.cuaDriver.detected")
                : t("settings.cuaDriver.notInstalledTitle")}
            </div>
            <p className="mt-0.5 break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
              {probe?.path ?? t("settings.cuaDriver.notInstalledDesc")}
            </p>
          </div>
          {installed ? null : (
            <Button
              size="sm"
              className="h-8 shrink-0 gap-1.5"
              disabled={installing || confirmingInstall || checking}
              onClick={() => void beginInstall()}
            >
              {installing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {installing ? t("settings.cuaDriver.installing") : t("settings.cuaDriver.install")}
            </Button>
          )}
        </div>

        {/* 安装确认：把即将执行的命令原文摆出来。这条命令会从网络下载一段
            shell 脚本并直接执行，用户有权先看清楚再决定，也可以复制到自己
            的终端里跑。绝不自动安装。 */}
        {confirmingInstall && preview ? (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/[0.07] px-4 py-3">
            <p className="flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              {t("settings.cuaDriver.confirmTitle")}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {t("settings.cuaDriver.confirmDesc").replace("{url}", preview.sourceUrl)}
            </p>
            <pre className="mt-2.5 overflow-x-auto rounded-lg bg-foreground/[0.06] px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
              {preview.display}
            </pre>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" className="h-8" onClick={() => void confirmInstall()}>
                {t("settings.cuaDriver.confirmRun")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={() => setConfirmingInstall(false)}
              >
                {t("settings.cuaDriver.confirmCancel")}
              </Button>
            </div>
          </div>
        ) : null}

        {log.length > 0 ? (
          <pre className="max-h-56 overflow-auto rounded-lg bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {log.join("\n")}
          </pre>
        ) : null}

        {error ? (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        ) : null}
      </div>

      {/* macOS TCC。授权归 CuaDriver.app 而非 LiveAgent —— 这是刻意选择的
          代理模式，宿主不需要任何辅助功能 / 屏幕录制权限。

          渲染条件只看 probe 里的平台位：Windows / Linux 没有这道门槛，整
          节不存在；macOS 上则整节随第一帧就位，只有里面的状态在等查询，
          不会出现「卡片过一会儿才长出来」的跳动。 */}
      {showPermissions ? (
        <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
          <SectionCardHeader icon={Shield} title={t("settings.cuaDriver.permissionsTitle")} />
          <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/30 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                {!permissionsKnown ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : permissionsPending ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                ) : (
                  <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                )}
                {!permissionsKnown
                  ? permissionsLoading
                    ? t("settings.cuaDriver.permissionsChecking")
                    : t("settings.cuaDriver.permissionsUnknown")
                  : permissionsPending
                    ? t("settings.cuaDriver.permissionsPending")
                    : t("settings.cuaDriver.statusGranted")}
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {!permissionsKnown || permissionsPending
                  ? t("settings.cuaDriver.permissionsDesc")
                  : t("settings.cuaDriver.permissionsGranted").replace(
                      "{bundleId}",
                      permissions?.attributedTo ?? "com.trycua.driver",
                    )}
              </p>
            </div>
            {permissionsKnown && !permissionsPending ? null : (
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1.5"
                // 读不到状态时也要能点：授权引导本身是修复手段，把它锁住
                // 只会让用户卡在「无法读取」这一步。
                disabled={granting}
                onClick={() => void grantPermissions()}
              >
                {granting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Shield className="h-3.5 w-3.5" />
                )}
                {t("settings.cuaDriver.grantPermissions")}
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {/* 参数全在这里改，MCP Hub 不再列出 cua-driver 这一条——两个入口都能
          写同一份配置只会让人搞不清哪边说了算。 */}
      <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
        <SectionCardHeader icon={Settings2} title={t("settings.cuaDriver.groupBehavior")} />

        <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/30 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t("settings.cuaDriver.policyTitle")}</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {t("settings.cuaDriver.policyDesc")}
            </p>
          </div>
          <ToolPolicyToggle
            value={policy}
            ariaLabel={t("settings.cuaDriver.policyTitle")}
            size="sm"
            onChange={setPolicy}
          />
        </div>

        {/* 自指闸门。默认关闭：模型操作宿主界面能点掉自己的审批弹窗、改写
            这份设置、甚至关掉应用。 */}
        <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/30 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <ShieldOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {t("settings.cuaDriver.allowSelfTitle")}
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {t("settings.cuaDriver.allowSelfDesc")}
            </p>
          </div>
          <AgentActivationSwitch
            checked={allowSelfTargeting}
            title={t("settings.cuaDriver.allowSelfTitle")}
            onToggle={() => setAllowSelfTargeting(!allowSelfTargeting)}
          />
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="cua-driver-timeout"
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
          >
            <Clock3 className="h-3 w-3" />
            {t("settings.cuaDriver.timeoutLabel")}
          </label>
          <Input
            id="cua-driver-timeout"
            type="text"
            inputMode="numeric"
            value={timeoutDraft}
            disabled={!serverEntry}
            onChange={(event) => setTimeoutDraft(event.target.value)}
            onBlur={commitTimeout}
            placeholder="60000"
            className="w-40 font-mono text-[13px]"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            {t("settings.cuaDriver.timeoutHint")}
          </p>
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-border/60 bg-card p-5">
        <SectionCardHeader icon={Plug} title={t("settings.cuaDriver.groupAbout")} />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.cuaDriver.description")}{" "}
          <a
            href={UPSTREAM_REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-foreground underline underline-offset-2"
          >
            trycua/cua
            <ExternalLink className="h-3 w-3" />
          </a>
        </p>
        <p className="rounded-lg bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          {t("settings.cuaDriver.policyNote")}
        </p>
      </div>
    </div>
  );
}
