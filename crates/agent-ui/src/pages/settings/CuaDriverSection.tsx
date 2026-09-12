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
  Download,
  ExternalLink,
  type IconComponent,
  Loader2,
  RefreshCw,
  Replace,
  ShieldOff,
  Video,
} from "@liveagent/ui/components/IconSet";
import { SettingsCopyButton } from "@liveagent/ui/components/settings/SettingsCopyButton";
import { SettingsRow, SettingsSection } from "@liveagent/ui/components/settings/SettingsLayout";
import { SettingsNotice } from "@liveagent/ui/components/settings/SettingsNotice";
import {
  SettingsToggleGroup,
  SettingsToggleGroupItem,
} from "@liveagent/ui/components/settings/SettingsToggleGroup";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { toast } from "@liveagent/ui/components/ui/toast-manager";
import type { UiSurface } from "@liveagent/ui/contracts/registry";
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

/** 卡片内部区块 */
function CardBlock(props: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "relative px-5",
        "after:pointer-events-none after:absolute after:inset-x-5 after:bottom-0 after:h-px after:bg-border/60 after:content-[''] last:after:hidden",
        props.className,
      )}
    >
      {props.children}
    </div>
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
        <Icon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{name}</span>
      </div>
      {status === "loading" ? (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("settings.cuaDriver.permissionsChecking")}
        </span>
      ) : (
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
            status === "granted" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
            status === "pending" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
            status === "unknown" && "bg-muted/60 text-muted-foreground",
          )}
        >
          {status === "granted" ? (
            <Check className="size-3" />
          ) : status === "pending" ? (
            <AlertTriangle className="size-3" />
          ) : status === "unknown" ? (
            <AlertCircle className="size-3" />
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

/**
 * `surface` 决定引导动作的可达性，而不是决定显示什么：探测与授权状态两端
 * 都经宿主真实读取（WebUI 走 gateway 中继），设置项两端同样可写；只有安装
 * 与授权这两个**必须在桌面主机那台机器上完成**的动作在 web 面收起——安装要
 * 用户先看清将要联网执行的命令全文，授权的系统对话框只弹在桌面机屏幕上。
 */
export function CuaDriverSection(props: SettingsSectionProps & { surface?: UiSurface }) {
  const { settings, setSettings, surface = "desktop" } = props;
  const { t } = useLocale();
  const canProvision = surface === "desktop";

  const [initialSnapshot] = useState(() => readCuaProbeCache());
  const [probe, setProbe] = useState<CuaProbe | null>(initialSnapshot?.probe ?? null);
  const [permissions, setPermissions] = useState<CuaPermissions | null>(
    initialSnapshot?.permissions ?? null,
  );
  const [preview, setPreview] = useState<CuaInstallPreview | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [installing, setInstalling] = useState(false);
  const [granting, setGranting] = useState(false);
  const [checking, setChecking] = useState(!initialSnapshot);
  const [permissionsLoading, setPermissionsLoading] = useState(!initialSnapshot);
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
      setPermissions(cached.permissions);
      setChecking(false);
      setPermissionsLoading(false);
      return;
    }

    setChecking(true);
    setError(null);
    setPermissionsLoading(true);
    const probeTask = invoke<CuaProbe>("cua_driver_probe");
    const permissionsTask = invoke<CuaPermissions>("cua_driver_permissions_status").catch(
      () => null,
    );

    try {
      const [probed, perms] = await Promise.all([probeTask, permissionsTask]);
      if (!mountedRef.current) return;
      writeCuaProbeCache(probed, perms);
      setProbe(probed);
      setPermissions(perms);
    } catch (err) {
      if (mountedRef.current) setError(String(err));
    } finally {
      if (mountedRef.current) {
        setChecking(false);
        setPermissionsLoading(false);
      }
    }
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

  const permissionRowStatus = (granted: boolean) =>
    permissionsKnown
      ? granted
        ? "granted"
        : "pending"
      : permissionsLoading
        ? "loading"
        : "unknown";

  useEffect(() => {
    if (!setupOpen || !installed || installing) return;
    const recheck = () => void refresh({ force: true });
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [setupOpen, installed, installing, refresh]);

  async function beginInstall() {
    setError(null);
    setSetupOpen(true);
    setPreview(null);
    try {
      setPreview(await invoke<CuaInstallPreview>("cua_driver_install_command"));
    } catch (err) {
      setError(String(err));
    }
  }

  async function confirmInstall() {
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

  useEffect(() => {
    if (error && !setupOpen) toast.error(error);
  }, [error, setupOpen]);

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

  const permissionsReady =
    installed &&
    (probe?.permissionsRequired === false || (permissionsKnown && !permissionsPending));
  const setupStep = !installed ? 0 : !permissionsReady ? 1 : 2;
  const steps = ["setupInstall", "setupPermissions", "setupEnable"] as const;
  const viewedStep = selectedStep ?? setupStep;

  return (
    <div className="space-y-6">
      <SettingsSection>
        <SettingsRow
          title="Computer Use"
          description={t("settings.cuaDriver.heroDesc")}
          control={
            <Switch
              checked={enabled}
              disabled={installing || checking || (!enabled && !permissionsReady)}
              aria-label={t("settings.cuaDriver.enable")}
              onCheckedChange={toggleEnabled}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t("settings.cuaDriver.setupTitle")}>
        {probe === null ? (
          <div
            className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl bg-settings-tile p-4"
            role="status"
            aria-busy={checking}
          >
            {checking ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : (
              <AlertCircle className="size-4 text-destructive" />
            )}
            <p className="text-sm text-muted-foreground">
              {checking ? t("settings.cuaDriver.heroChecking") : error}
            </p>
            {!checking ? (
              <Button size="sm" variant="outline" onClick={() => void refresh({ force: true })}>
                {t("settings.cuaDriver.recheck")}
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            <ol
              className="flex max-w-2xl items-center gap-3 px-1 py-2"
              aria-label={t("settings.cuaDriver.setupTitle")}
            >
              {steps.map((step, index) => {
                const done = index < setupStep || (index === 2 && enabled);
                const selected = index === viewedStep;
                return (
                  <li key={step} className="flex min-w-0 flex-1 items-center gap-3 last:flex-none">
                    <button
                      type="button"
                      aria-pressed={selected}
                      aria-current={index === setupStep ? "step" : undefined}
                      aria-label={`${t(`settings.cuaDriver.${step}`)}，${t(done ? "settings.cuaDriver.stepDone" : index === setupStep ? "settings.cuaDriver.stepNext" : "settings.cuaDriver.stepPending")}`}
                      aria-controls="cua-step-content"
                      onClick={() => setSelectedStep(index)}
                      className={cn(
                        "group flex shrink-0 cursor-pointer items-center gap-2.5 rounded-lg p-1",
                        "text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected
                          ? "text-foreground"
                          : "text-muted-foreground hover:bg-settings-tile-hover hover:text-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                          selected
                            ? "bg-foreground text-background"
                            : done
                              ? "bg-settings-active text-foreground"
                              : "bg-settings-tile text-muted-foreground ring-1 ring-inset ring-border",
                        )}
                      >
                        {done ? <Check className="size-3.5" /> : index + 1}
                      </span>
                      <span className="flex flex-col gap-0.5">
                        <span className="font-medium">{t(`settings.cuaDriver.${step}`)}</span>
                        <span className="text-tiny text-muted-foreground">
                          {t(
                            done
                              ? "settings.cuaDriver.stepDone"
                              : index === setupStep
                                ? "settings.cuaDriver.stepNext"
                                : "settings.cuaDriver.stepPending",
                          )}
                        </span>
                      </span>
                    </button>
                    {index < steps.length - 1 ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "h-px min-w-3 flex-1",
                          done ? "bg-foreground/25" : "bg-border",
                        )}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>
            <div id="cua-step-content" className="space-y-4 rounded-xl bg-settings-tile p-4">
              <div>
                <h3 className="text-sm font-medium">
                  {t(
                    probingInitial
                      ? "settings.cuaDriver.heroChecking"
                      : viewedStep === 0 && installed
                        ? "settings.cuaDriver.detected"
                        : viewedStep === 2 && enabled
                          ? "settings.cuaDriver.statusActive"
                          : `settings.cuaDriver.${steps[viewedStep]}`,
                  )}
                </h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t(
                    viewedStep === 0
                      ? "settings.cuaDriver.setupInstallDesc"
                      : viewedStep === 1
                        ? "settings.cuaDriver.permissionsGuide"
                        : "settings.cuaDriver.enablePreview",
                  )}
                </p>
                {viewedStep > setupStep ? (
                  <p className="mt-2 text-xs font-medium text-foreground">
                    {t(
                      setupStep === 0
                        ? "settings.cuaDriver.installFirst"
                        : "settings.cuaDriver.permissionsFirst",
                    )}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {viewedStep === 0 && !installed && canProvision ? (
                  <Button
                    size="sm"
                    disabled={checking || installing}
                    onClick={() => void beginInstall()}
                  >
                    <Download className="size-4" />
                    {t("settings.cuaDriver.install")}
                  </Button>
                ) : viewedStep === 1 ? (
                  <Button
                    size="sm"
                    disabled={!installed || checking}
                    onClick={() => setSetupOpen(true)}
                  >
                    {t("settings.cuaDriver.setupContinue")}
                  </Button>
                ) : viewedStep === 2 && !enabled ? (
                  <Button
                    size="sm"
                    disabled={!permissionsReady || checking || installing}
                    onClick={() => toggleEnabled(true)}
                  >
                    {t("settings.cuaDriver.enable")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={checking || installing}
                  onClick={() => void refresh({ force: true })}
                >
                  <RefreshCw className={checking ? "size-4 animate-spin" : "size-4"} />
                  {t("settings.cuaDriver.recheck")}
                </Button>
              </div>
              {!installed && !canProvision ? (
                <p className="text-xs text-muted-foreground">
                  {t("settings.cuaDriver.desktopOnlyInstall")}
                </p>
              ) : null}
            </div>
          </>
        )}
      </SettingsSection>

      <SettingsSection>
        <SettingsRow
          title={t("settings.cuaDriver.manageTitle")}
          description={t(
            commandDrift ? "settings.cuaDriver.commandDriftTitle" : "settings.cuaDriver.manageDesc",
          )}
          control={
            <Button size="sm" variant="outline" onClick={() => setManageOpen(true)}>
              {t("settings.cuaDriver.manageAction")}
            </Button>
          }
        />
      </SettingsSection>

      <Dialog
        open={setupOpen}
        onOpenChange={(open) => {
          if (!installing) setSetupOpen(open);
        }}
      >
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] max-w-xl flex-col"
          showCloseButton
          closeDisabled={installing}
          closeLabel={t("settings.cuaDriver.close")}
        >
          <DialogHeader>
            <DialogTitle>
              {t(
                setupStep === 0
                  ? "settings.cuaDriver.setupInstall"
                  : setupStep === 1
                    ? "settings.cuaDriver.setupPermissions"
                    : "settings.cuaDriver.heroReady",
              )}
            </DialogTitle>
            <DialogDescription>{t("settings.cuaDriver.setupDialogDesc")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {!installed ? (
              <>
                <p className="text-xs leading-5 text-muted-foreground">
                  {preview
                    ? t("settings.cuaDriver.confirmDesc").replace("{url}", preview.sourceUrl)
                    : t("settings.cuaDriver.heroChecking")}
                </p>
                {preview ? (
                  <div className="relative">
                    <pre className="overflow-auto whitespace-pre-wrap break-all rounded-xl bg-settings-tile p-3 pr-10 text-xs">
                      {preview.display}
                    </pre>
                    <SettingsCopyButton
                      size="compact"
                      title={preview.display}
                      value={preview.display}
                      className="absolute right-1 top-1"
                    />
                  </div>
                ) : null}
              </>
            ) : showPermissions ? (
              <div>
                <CardBlock className="py-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("settings.cuaDriver.permissionsGuide")}
                  </p>
                  {canProvision ? null : (
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                      {t("settings.cuaDriver.desktopOnlyGrant")}
                    </p>
                  )}
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
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                      {t("settings.cuaDriver.permissionsGranted").replace(
                        "{bundleId}",
                        permissions?.attributedTo ?? "com.trycua.driver",
                      )}
                    </p>
                  </CardBlock>
                ) : null}
              </div>
            ) : (
              <p className="text-sm">
                {t(
                  permissionsReady
                    ? "settings.cuaDriver.setupReadyDesc"
                    : "settings.cuaDriver.permissionsUnknown",
                )}
              </p>
            )}
            {installing || log.length > 0 ? (
              <details open={installing}>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {t("settings.cuaDriver.installLog")}
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-settings-tile p-3 font-mono text-xs">
                  {log.join("\n") || t("settings.cuaDriver.installing")}
                </pre>
              </details>
            ) : null}
            {error ? (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            {!installed ? (
              <Button
                size="sm"
                disabled={!preview || installing || !canProvision}
                onClick={() => void confirmInstall()}
              >
                {installing ? <Loader2 className="size-4 animate-spin" /> : null}
                {t(installing ? "settings.cuaDriver.installing" : "settings.cuaDriver.confirmRun")}
              </Button>
            ) : !permissionsReady ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={checking || granting}
                  onClick={() => void refresh({ force: true })}
                >
                  {t("settings.cuaDriver.recheck")}
                </Button>
                {canProvision ? (
                  <Button
                    size="sm"
                    disabled={granting || installing}
                    onClick={() => void grantPermissions()}
                  >
                    {granting ? <Loader2 className="size-4 animate-spin" /> : null}
                    {t("settings.cuaDriver.grantPermissions")}
                  </Button>
                ) : null}
              </>
            ) : (
              <Button
                size="sm"
                onClick={() => {
                  toggleEnabled(true);
                  setSetupOpen(false);
                }}
              >
                {t(enabled ? "settings.cuaDriver.close" : "settings.cuaDriver.enable")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] max-w-xl flex-col"
          showCloseButton
          closeLabel={t("settings.cuaDriver.close")}
        >
          <DialogHeader>
            <DialogTitle>{t("settings.cuaDriver.manageTitle")}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-6">
            {displayCommand ? (
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all text-xs">{displayCommand}</code>
                <SettingsCopyButton size="compact" title={displayCommand} value={displayCommand} />
              </div>
            ) : null}
            {commandDrift ? (
              <SettingsNotice variant="installation-warning">
                <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="size-3.5" />
                  {t("settings.cuaDriver.commandDriftTitle")}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t("settings.cuaDriver.commandDriftDesc")}
                </p>
                <div className="mt-2.5 space-y-1 font-mono text-xs">
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
                  className="mt-3 gap-1.5 rounded-lg"
                  onClick={realignCommand}
                >
                  <Replace className="size-3" />
                  {t("settings.cuaDriver.commandDriftRealign")}
                </Button>
              </SettingsNotice>
            ) : null}

            {/* 安全与审批 */}
            <SettingsSection title={t("settings.cuaDriver.groupSecurity")}>
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
                    <ShieldOff className="size-3.5 shrink-0 text-muted-foreground" />
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
            </SettingsSection>

            {/* 运行时参数 */}
            <SettingsSection title={t("settings.cuaDriver.groupRuntime")}>
              <CardBlock className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground">
                    {t("settings.cuaDriver.timeoutLabel")}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t("settings.cuaDriver.timeoutHint")}
                  </p>
                </div>
                <SettingsToggleGroup
                  value={[String(currentTimeout)]}
                  aria-label={t("settings.cuaDriver.timeoutLabel")}
                  disabled={!serverEntry}
                  className="shrink-0"
                  onValueChange={(values) => {
                    const nextValue = values[0];
                    if (nextValue) applyTimeout(Number(nextValue));
                  }}
                >
                  {TIMEOUT_PRESETS.map((preset) => (
                    <SettingsToggleGroupItem key={preset.value} value={String(preset.value)}>
                      {preset.label}
                    </SettingsToggleGroupItem>
                  ))}
                </SettingsToggleGroup>
              </CardBlock>
            </SettingsSection>

            {/* 能力概览与参考 */}
            <SettingsSection title={t("settings.cuaDriver.groupCapabilities")}>
              <CardBlock className="py-4">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {capabilities.map((cap) => (
                    <div
                      key={cap.key}
                      className={cn(
                        "flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-2",
                        "text-xs text-foreground/80",
                      )}
                    >
                      <div className="size-1.5 shrink-0 rounded-full bg-sky-500/70" />
                      <span className="truncate">{cap.label}</span>
                    </div>
                  ))}
                </div>
              </CardBlock>
              <CardBlock className="py-3">
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="min-w-0 truncate">{t("settings.cuaDriver.policyNote")}</span>
                  <a
                    href={CUA_UPSTREAM_REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground/80 hover:text-foreground hover:underline"
                  >
                    trycua/cua
                    <ExternalLink className="size-3" />
                  </a>
                </div>
              </CardBlock>
            </SettingsSection>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
