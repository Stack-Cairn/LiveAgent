import { type ToolPolicy, updateMcp, updateSystem } from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { invoke } from "@liveagent/app/shims/tauriCore";
import { listen } from "@liveagent/app/shims/tauriEvent";
import { ToolPolicyToggle } from "@liveagent/ui/components/hub/ToolPolicyToggle";
import {
  Accessibility,
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  type IconComponent,
  Loader2,
  RefreshCw,
  Replace,
  Shield,
  ShieldOff,
  Sparkles,
  SquareMousePointer,
  Terminal,
  Video,
} from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import {
  applyCuaPolicy,
  buildCuaServerConfig,
  CUA_DEFAULT_TIMEOUT_MS,
  CUA_INSTALL_PROGRESS_EVENT,
  CUA_MAX_LOG_LINES,
  CUA_UPSTREAM_REPO_URL,
  type CuaInstallPreview,
  type CuaInstallProgress,
  type CuaPermissions,
  type CuaProbe,
  cuaCommandDrift,
  cuaDisplayCommand,
  findCuaDriverServer,
  findCuaDriverServerIndex,
  patchCuaProbeCachePermissions,
  readCuaPolicy,
  readCuaProbeCache,
  realignCuaServerConfig,
  writeCuaProbeCache,
} from "./cuaDriverForm";

/** 引导步骤单步状态：完成 / 待办 / 未就绪 / 进行中 */
type StepState = "done" | "current" | "todo" | "busy";

/** 时间轴节点的视觉档位 */
type NodeTone = "done" | "active" | "warn" | "neutral";

const NODE_TONE_CLASS: Record<NodeTone, string> = {
  done: "border-transparent bg-emerald-500 text-white shadow-sm shadow-emerald-500/30",
  active: "border-transparent bg-sky-500 text-white shadow-sm shadow-sky-500/30",
  warn: "border-transparent bg-amber-500 text-white shadow-sm shadow-amber-500/30",
  neutral: "border-border/75 bg-card text-muted-foreground",
};

/**
 * 竖向时间轴条目：左侧状态节点 + 连接线，右侧标题行与整宽卡片。
 * 每个配置独占一行，安装 → 授权 → 配置的推进顺序由节点颜色直接表达。
 */
function TimelineItem(props: {
  node: ReactNode;
  tone: NodeTone;
  /** 连接线到下一个节点的颜色；最后一项传 "none" 不画线 */
  connector: "done" | "default" | "none";
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const { node, tone, connector, title, action, children } = props;
  return (
    <div className="relative flex gap-4 pb-7 last:pb-0">
      <div className="relative flex w-9 shrink-0 justify-center">
        {connector !== "none" ? (
          <span
            className={cn(
              "absolute top-11 bottom-0 w-px transition-colors duration-500",
              connector === "done" ? "bg-emerald-500/40" : "bg-border/70",
            )}
          />
        ) : null}
        <span
          className={cn(
            "z-10 mt-0.5 flex h-9 w-9 items-center justify-center rounded-full border transition-colors duration-300",
            NODE_TONE_CLASS[tone],
          )}
        >
          {node}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-9 items-center justify-between gap-3 pr-1">
          <h2 className="text-[14px] font-semibold tracking-tight text-foreground">{title}</h2>
          {action}
        </div>
        <div className="mt-2 overflow-hidden rounded-2xl border border-border/75 bg-card shadow-[0_1px_2px_hsl(var(--foreground)/0.02)]">
          {children}
        </div>
      </div>
    </div>
  );
}

/** 卡片内部区块 */
function CardBlock(props: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "relative px-5 after:pointer-events-none after:absolute after:right-5 after:bottom-0 after:left-5 after:h-px after:bg-border/60 after:content-[''] last:after:hidden",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (!value) return;
    navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={value}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

/** 顶栏 Hero 状态卡片：发光图标、状态 Badge 与主开关；推进进度由下方时间轴表达 */
function HeroCard(props: {
  probing: boolean;
  installed: boolean;
  installing: boolean;
  grant: StepState | "skip";
  enabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useLocale();
  const { probing, installed, installing, grant, enabled, onToggle } = props;
  const running = enabled;
  const checking = probing || grant === "busy";

  const statusTitle = !installed
    ? probing
      ? t("settings.cuaDriver.heroChecking")
      : t("settings.cuaDriver.statusNotInstalled")
    : grant === "busy"
      ? t("settings.cuaDriver.heroChecking")
      : grant === "current"
        ? t("settings.cuaDriver.heroNeedsGrant")
        : enabled
          ? t("settings.cuaDriver.statusActive")
          : t("settings.cuaDriver.heroReady");

  const dotClass = checking
    ? "bg-muted-foreground/40"
    : !installed || grant === "current"
      ? "bg-amber-500"
      : enabled
        ? "bg-emerald-500"
        : "bg-sky-500";

  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-2xl border bg-card transition-all duration-500",
        running ? "border-emerald-500/30" : "border-border/75",
      )}
    >
      {/* 动态光晕 */}
      <div
        className={cn(
          "pointer-events-none absolute -top-24 -right-16 h-64 w-64 rounded-full blur-3xl transition-colors duration-700",
          running ? "bg-emerald-500/15" : "bg-sky-500/10",
        )}
      />
      <div
        className={cn(
          "pointer-events-none absolute inset-0 bg-gradient-to-br via-transparent to-transparent transition-colors duration-700",
          running ? "from-emerald-500/[0.07]" : "from-sky-500/[0.08]",
        )}
      />

      <div className="relative flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="flex min-w-0 items-center gap-3.5">
          <div
            className={cn(
              "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white shadow-lg transition-all duration-500",
              running
                ? "bg-gradient-to-br from-emerald-500 to-teal-600 shadow-emerald-500/25"
                : "bg-gradient-to-br from-sky-500 to-blue-600 shadow-sky-500/25",
            )}
          >
            <SquareMousePointer className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="text-[16px] font-semibold text-foreground">Computer Use</h3>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                  running
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "bg-muted/70 text-muted-foreground",
                )}
              >
                <span className="relative flex h-1.5 w-1.5 shrink-0">
                  {running ? (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  ) : null}
                  <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", dotClass)} />
                </span>
                {statusTitle}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t("settings.cuaDriver.heroDesc")}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3 self-end sm:self-center">
          <Switch
            tone="success"
            checked={enabled}
            disabled={!installed || installing}
            title={enabled ? t("settings.cuaDriver.disable") : t("settings.cuaDriver.enable")}
            aria-label={enabled ? t("settings.cuaDriver.disable") : t("settings.cuaDriver.enable")}
            onCheckedChange={onToggle}
          />
        </div>
      </div>
    </section>
  );
}

/** 权限状态行 */
function PermissionRow(props: {
  icon: IconComponent;
  name: string;
  status: "loading" | "granted" | "pending" | "unknown";
}) {
  const { t } = useLocale();
  const { icon: Icon, name, status } = props;
  return (
    <CardBlock className="flex items-center justify-between gap-4 py-3.5">
      <div className="flex items-center gap-2.5">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{name}</span>
      </div>
      {status === "loading" ? (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("settings.cuaDriver.permissionsChecking")}
        </span>
      ) : (
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium",
            status === "granted" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
            status === "pending" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
            status === "unknown" && "bg-muted/60 text-muted-foreground",
          )}
        >
          {status === "granted" ? (
            <Check className="h-3 w-3" />
          ) : status === "pending" ? (
            <AlertTriangle className="h-3 w-3" />
          ) : status === "unknown" ? (
            <AlertCircle className="h-3 w-3" />
          ) : null}
          {status === "granted"
            ? t("settings.cuaDriver.statusGranted")
            : status === "pending"
              ? t("settings.cuaDriver.permNotGranted")
              : t("settings.cuaDriver.permissionsUnknown")}
        </span>
      )}
    </CardBlock>
  );
}

const TIMEOUT_PRESETS = [
  { label: "30s", value: 30_000 },
  { label: "60s", value: 60_000 },
  { label: "120s", value: 120_000 },
  { label: "300s", value: 300_000 },
];

export function CuaDriverSection(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();

  const [probe, setProbe] = useState<CuaProbe | null>(null);
  const [permissions, setPermissions] = useState<CuaPermissions | null>(null);
  const [preview, setPreview] = useState<CuaInstallPreview | null>(null);
  const [confirmingInstall, setConfirmingInstall] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [granting, setGranting] = useState(false);
  const [checking, setChecking] = useState(true);
  const [permissionsLoading, setPermissionsLoading] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // 总开关的真实状态就是这个 MCP server 的启用状态
  const serverEntry = findCuaDriverServer(settings.mcp.servers);
  const enabled = serverEntry?.enabled === true;

  const policy: ToolPolicy = readCuaPolicy(settings.system.toolPolicies, serverEntry);
  const allowSelfTargeting = settings.system.cuaAllowSelfTargeting === true;
  const displayCommand = cuaDisplayCommand(serverEntry, probe);
  const commandDrift = cuaCommandDrift(serverEntry, probe);

  const refresh = useCallback(async (options?: { force?: boolean }) => {
    const cached = options?.force ? null : readCuaProbeCache();
    if (cached) {
      setProbe(cached.probe);
      if (cached.permissions) setPermissions(cached.permissions);
      setChecking(false);
      setPermissionsLoading(false);
      return;
    }

    setChecking(true);
    setPermissionsLoading(true);
    const probeTask = invoke<CuaProbe>("cua_driver_probe");
    const permissionsTask = invoke<CuaPermissions>("cua_driver_permissions_status").catch(
      () => null,
    );

    let probed: CuaProbe | null = null;
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
    if (probed) writeCuaProbeCache(probed, perms);
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

  const installUnlistenRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      installUnlistenRef.current?.();
      installUnlistenRef.current = null;
    },
    [],
  );

  const installed = probe?.installed === true;
  const showPermissions = installed && probe?.permissionsRequired === true;
  const permissionsKnown = permissions?.supported === true;
  const permissionsPending =
    permissionsKnown && (!permissions.accessibility || !permissions.screenRecording);

  const grantState: StepState | "skip" =
    probe?.permissionsRequired !== true
      ? "skip"
      : !installed
        ? "todo"
        : !permissionsKnown
          ? permissionsLoading
            ? "busy"
            : "todo"
          : permissionsPending
            ? "current"
            : "done";

  const permissionRowStatus = (granted: boolean) =>
    permissionsKnown
      ? granted
        ? "granted"
        : "pending"
      : permissionsLoading
        ? "loading"
        : "unknown";

  async function beginInstall() {
    setError(null);
    try {
      setPreview(await invoke<CuaInstallPreview>("cua_driver_install_command"));
      setConfirmingInstall(true);
    } catch (err) {
      setError(String(err));
    }
  }

  async function confirmInstall() {
    setConfirmingInstall(false);
    setInstalling(true);
    setLog([]);
    setError(null);

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<CuaInstallProgress>(CUA_INSTALL_PROGRESS_EVENT, (event) => {
        setLog((prev) => [...prev, event.payload.line].slice(-CUA_MAX_LOG_LINES));
      });
      if (!mountedRef.current) {
        unlisten();
        unlisten = null;
        return;
      }
      installUnlistenRef.current = unlisten;

      await invoke<CuaProbe>("cua_driver_install");
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
      const next = await invoke<CuaPermissions>("cua_driver_permissions_grant");
      patchCuaProbeCachePermissions(next);
      if (mountedRef.current) setPermissions(next);
    } catch (err) {
      if (mountedRef.current) setError(String(err));
    } finally {
      if (mountedRef.current) setGranting(false);
    }
  }

  function toggleEnabled(next: boolean) {
    if (next && !probe?.installed) return;
    setSettings((prev) => {
      const index = findCuaDriverServerIndex(prev.mcp.servers);
      if (index < 0) {
        if (!next || !probe) return prev;
        return updateMcp(prev, { servers: [...prev.mcp.servers, buildCuaServerConfig(probe)] });
      }
      return updateMcp(prev, {
        servers: prev.mcp.servers.map((server, idx) =>
          idx === index ? { ...server, enabled: next } : server,
        ),
      });
    });
  }

  function setPolicy(next: ToolPolicy) {
    setSettings((prev) =>
      updateSystem(prev, {
        toolPolicies: applyCuaPolicy(
          prev.system.toolPolicies,
          findCuaDriverServer(prev.mcp.servers),
          next,
        ),
      }),
    );
  }

  function setAllowSelfTargeting(next: boolean) {
    setSettings((prev) => updateSystem(prev, { cuaAllowSelfTargeting: next }));
  }

  function applyTimeout(timeoutMs: number) {
    if (!serverEntry || timeoutMs === serverEntry.timeoutMs) return;
    setSettings((prev) => {
      const index = findCuaDriverServerIndex(prev.mcp.servers);
      if (index < 0) return prev;
      return updateMcp(prev, {
        servers: prev.mcp.servers.map((server, idx) =>
          idx === index ? { ...server, timeoutMs } : server,
        ),
      });
    });
  }

  function realignCommand() {
    if (!probe) return;
    setSettings((prev) => {
      const index = findCuaDriverServerIndex(prev.mcp.servers);
      if (index < 0) return prev;
      return updateMcp(prev, {
        servers: prev.mcp.servers.map((server, idx) =>
          idx === index ? realignCuaServerConfig(server, probe) : server,
        ),
      });
    });
  }

  const currentTimeout = serverEntry?.timeoutMs ?? CUA_DEFAULT_TIMEOUT_MS;

  const capabilities = [
    { key: "capWindows", label: t("settings.cuaDriver.capWindows") },
    { key: "capScreenshot", label: t("settings.cuaDriver.capScreenshot") },
    { key: "capMouse", label: t("settings.cuaDriver.capMouse") },
    { key: "capKeyboard", label: t("settings.cuaDriver.capKeyboard") },
    { key: "capMenu", label: t("settings.cuaDriver.capMenu") },
    { key: "capBrowser", label: t("settings.cuaDriver.capBrowser") },
  ];

  const probingInitial = checking && probe === null;

  // 驱动节点：已装 → 完成；安装/首查中 → 进行中；未装 → 当前待办
  const driverTone: NodeTone = installed
    ? "done"
    : probingInitial || installing
      ? "neutral"
      : "active";
  const driverNode =
    probingInitial || installing ? (
      <Loader2 className="h-4 w-4 animate-spin" />
    ) : installed ? (
      <Check className="h-4 w-4" />
    ) : (
      <Download className="h-4 w-4" />
    );

  // 授权节点：已授权 → 完成；查询中 → 进行中；缺权限 → 警示；其余 → 中性
  const grantTone: NodeTone =
    grantState === "done" ? "done" : grantState === "current" ? "warn" : "neutral";
  const grantNode =
    grantState === "busy" ? (
      <Loader2 className="h-4 w-4 animate-spin" />
    ) : grantState === "done" ? (
      <Check className="h-4 w-4" />
    ) : (
      <Shield className="h-4 w-4" />
    );

  return (
    <div className="w-full space-y-6">
      {/* 顶部全宽 Hero 仪表卡片 */}
      <HeroCard
        probing={probingInitial}
        installed={installed}
        installing={installing}
        grant={grantState}
        enabled={enabled}
        onToggle={() => toggleEnabled(!enabled)}
      />

      {/* 竖向时间轴：每个配置独占一行，节点颜色即推进状态 */}
      <div>
        <TimelineItem
          tone={driverTone}
          node={driverNode}
          connector={installed ? "done" : "default"}
          title={t("settings.cuaDriver.groupDriver")}
          action={
            <button
              type="button"
              disabled={checking || installing}
              onClick={() => void refresh({ force: true })}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={checking ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              {t("settings.cuaDriver.recheck")}
            </button>
          }
        >
          <CardBlock className="flex items-center justify-between gap-4 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                  installed
                    ? "bg-emerald-500/10 text-emerald-500"
                    : "bg-muted/60 text-muted-foreground",
                )}
              >
                {checking && !probe ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : installed ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {installed
                    ? probe?.version
                      ? t("settings.cuaDriver.detectedWithVersion").replace(
                          "{version}",
                          probe.version,
                        )
                      : t("settings.cuaDriver.detected")
                    : t("settings.cuaDriver.notInstalledTitle")}
                </div>
                {displayCommand ? (
                  <p
                    className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
                    title={displayCommand}
                  >
                    {displayCommand}
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t("settings.cuaDriver.notInstalledDesc")}
                  </p>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {displayCommand ? <CopyButton value={displayCommand} /> : null}
              {installed ? null : (
                <Button
                  size="sm"
                  className="h-8 gap-1.5 rounded-lg text-xs"
                  disabled={installing || confirmingInstall || checking}
                  onClick={() => void beginInstall()}
                >
                  {installing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {installing
                    ? t("settings.cuaDriver.installing")
                    : t("settings.cuaDriver.install")}
                </Button>
              )}
            </div>
          </CardBlock>

          {/* 配置漂移 / 安装确认 / 日志 / 错误 */}
          {commandDrift || (confirmingInstall && preview) || log.length > 0 || error ? (
            <div className="space-y-3 border-t border-border/60 px-5 py-4">
              {commandDrift ? (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.05] p-3.5">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {t("settings.cuaDriver.commandDriftTitle")}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {t("settings.cuaDriver.commandDriftDesc")}
                  </p>
                  <div className="mt-2.5 space-y-1 font-mono text-[11px]">
                    <div className="flex items-center gap-2 rounded bg-background/80 px-2.5 py-1.5">
                      <span className="shrink-0 text-muted-foreground">
                        {t("settings.cuaDriver.commandDriftConfigured")}
                      </span>
                      <span className="min-w-0 truncate">{commandDrift.configured}</span>
                    </div>
                    <div className="flex items-center gap-2 rounded bg-background/80 px-2.5 py-1.5">
                      <span className="shrink-0 text-muted-foreground">
                        {t("settings.cuaDriver.commandDriftProbed")}
                      </span>
                      <span className="min-w-0 truncate">{commandDrift.probed}</span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3 h-7 gap-1.5 rounded-lg text-xs"
                    onClick={realignCommand}
                  >
                    <Replace className="h-3 w-3" />
                    {t("settings.cuaDriver.commandDriftRealign")}
                  </Button>
                </div>
              ) : null}

              {confirmingInstall && preview ? (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.05] p-3.5">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {t("settings.cuaDriver.confirmTitle")}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t("settings.cuaDriver.confirmDesc").replace("{url}", preview.sourceUrl)}
                  </p>
                  <div className="relative mt-2.5">
                    <pre className="overflow-x-auto rounded-lg bg-foreground/[0.05] px-3 py-2 pr-9 font-mono text-[11px] leading-relaxed text-foreground">
                      {preview.display}
                    </pre>
                    <CopyButton
                      value={preview.display}
                      className="absolute top-1 right-1 bg-background/60"
                    />
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      className="h-7.5 rounded-lg text-xs"
                      onClick={() => void confirmInstall()}
                    >
                      {t("settings.cuaDriver.confirmRun")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7.5 rounded-lg text-xs"
                      onClick={() => setConfirmingInstall(false)}
                    >
                      {t("settings.cuaDriver.confirmCancel")}
                    </Button>
                  </div>
                </div>
              ) : null}

              {log.length > 0 ? (
                <div className="overflow-hidden rounded-xl bg-zinc-950">
                  <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
                    <Terminal className="h-3 w-3 text-zinc-400" />
                    <span className="text-[10px] text-zinc-400">
                      {t("settings.cuaDriver.installLog")}
                    </span>
                    {installing ? (
                      <Loader2 className="ml-auto h-3 w-3 animate-spin text-zinc-400" />
                    ) : null}
                  </div>
                  <pre className="max-h-48 overflow-auto px-3 py-2 font-mono text-[10.5px] leading-relaxed text-zinc-300">
                    {log.join("\n")}
                  </pre>
                </div>
              ) : null}

              {error ? (
                <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.05] px-3.5 py-2.5">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                  <p className="min-w-0 break-words text-xs text-destructive">{error}</p>
                </div>
              ) : null}
            </div>
          ) : null}
        </TimelineItem>

        {/* macOS 权限授权：仅 macOS 平台展示 */}
        {showPermissions ? (
          <TimelineItem
            tone={grantTone}
            node={grantNode}
            connector={grantState === "done" ? "done" : "default"}
            title={t("settings.cuaDriver.permissionsTitle")}
            action={
              permissionsKnown && !permissionsPending ? undefined : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 rounded-lg text-xs"
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
              )
            }
          >
            <CardBlock className="py-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("settings.cuaDriver.permissionsDesc")}
              </p>
            </CardBlock>
            <PermissionRow
              icon={Accessibility}
              name={t("settings.cuaDriver.permAccessibility")}
              status={permissionRowStatus(permissions?.accessibility === true)}
            />
            <PermissionRow
              icon={Video}
              name={t("settings.cuaDriver.permScreenRecording")}
              status={permissionRowStatus(permissions?.screenRecording === true)}
            />
            {permissionsKnown && !permissionsPending ? (
              <CardBlock className="py-2.5">
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  {t("settings.cuaDriver.permissionsGranted").replace(
                    "{bundleId}",
                    permissions?.attributedTo ?? "com.trycua.driver",
                  )}
                </p>
              </CardBlock>
            ) : null}
          </TimelineItem>
        ) : null}

        {/* 安全与审批 */}
        <TimelineItem
          tone="neutral"
          node={<Shield className="h-4 w-4" />}
          connector="default"
          title={t("settings.cuaDriver.groupSecurity")}
        >
          <CardBlock className="flex items-center justify-between gap-3 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">
                {t("settings.cuaDriver.policyTitle")}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("settings.cuaDriver.policyDesc")}
              </p>
            </div>
            <ToolPolicyToggle
              value={policy}
              ariaLabel={t("settings.cuaDriver.policyTitle")}
              size="sm"
              onChange={setPolicy}
            />
          </CardBlock>

          <CardBlock className="flex items-center justify-between gap-3 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <ShieldOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {t("settings.cuaDriver.allowSelfTitle")}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("settings.cuaDriver.allowSelfDesc")}
              </p>
            </div>
            <Switch
              checked={allowSelfTargeting}
              title={t("settings.cuaDriver.allowSelfTitle")}
              aria-label={t("settings.cuaDriver.allowSelfTitle")}
              onCheckedChange={() => setAllowSelfTargeting(!allowSelfTargeting)}
            />
          </CardBlock>
        </TimelineItem>

        {/* 运行时参数 */}
        <TimelineItem
          tone="neutral"
          node={<Clock3 className="h-4 w-4" />}
          connector="default"
          title={t("settings.cuaDriver.groupRuntime")}
        >
          <CardBlock className="flex flex-wrap items-center justify-between gap-3 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">
                {t("settings.cuaDriver.timeoutLabel")}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("settings.cuaDriver.timeoutHint")}
              </p>
            </div>
            <fieldset
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: 同 ToolPolicyToggle——互斥单选语义需要向读屏表达。
              role="radiogroup"
              aria-label={t("settings.cuaDriver.timeoutLabel")}
              className="inline-flex shrink-0 items-center rounded-lg border border-border/60 bg-muted/40 p-0.5"
            >
              {TIMEOUT_PRESETS.map((preset) => {
                const active = currentTimeout === preset.value;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: 同 ToolPolicyToggle——分段控件保留 button 样式。
                  <button
                    key={preset.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={!serverEntry}
                    onClick={() => applyTimeout(preset.value)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-[11px] font-medium leading-none transition-colors disabled:opacity-50",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </fieldset>
          </CardBlock>
        </TimelineItem>

        {/* 能力概览与参考 */}
        <TimelineItem
          tone="neutral"
          node={<Sparkles className="h-4 w-4" />}
          connector="none"
          title={t("settings.cuaDriver.groupCapabilities")}
        >
          <CardBlock className="py-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
              {capabilities.map((cap) => (
                <div
                  key={cap.key}
                  className="flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-2 text-xs text-foreground/80"
                >
                  <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500/70" />
                  <span className="truncate">{cap.label}</span>
                </div>
              ))}
            </div>
          </CardBlock>
          <CardBlock className="py-3">
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
              <span className="min-w-0 truncate">{t("settings.cuaDriver.policyNote")}</span>
              <a
                href={CUA_UPSTREAM_REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground/80 hover:text-foreground hover:underline"
              >
                trycua/cua
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </CardBlock>
        </TimelineItem>
      </div>
    </div>
  );
}
