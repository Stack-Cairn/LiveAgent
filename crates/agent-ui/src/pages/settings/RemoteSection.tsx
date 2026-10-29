import type { AppSettings } from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { invoke } from "@liveagent/app/shims/tauriCore";
import { listen } from "@liveagent/app/shims/tauriEvent";
import {
  Eye,
  EyeOff,
  GitBranch,
  Globe,
  Key,
  Link2,
  MonitorSmartphone,
  Radio,
  RefreshCw,
  Server,
  Share2,
  Terminal,
  Wifi,
  WifiOff,
} from "@liveagent/ui/components/IconSet";
import { SettingsCopyButton } from "@liveagent/ui/components/settings/SettingsCopyButton";
import { SettingsRow, SettingsSection } from "@liveagent/ui/components/settings/SettingsLayout";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import { localizeLocalGatewayError } from "@liveagent/ui/lib/settings/localGatewayError";
import { buildGatewayPublicBaseUrl } from "@liveagent/ui/lib/shared/gatewayPublicUrl";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  normalizeIntegerDraftInput,
  parseIntegerDraftValue,
} from "@liveagent/ui/pages/settings/remoteInput";
import { AgentActivationSwitch } from "@liveagent/ui/pages/settings/shared";
import { useCallback, useEffect, useMemo, useState } from "react";

const REMOTE_GATEWAY_PORT_MAX = 65_535;

function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  readOnly,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const { t } = useLocale();

  return (
    <div className="relative flex-1">
      <Input
        variant="plain"
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-16 font-mono text-sm"
      />
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
        <button
          type="button"
          onClick={() => setVisible((prev) => !prev)}
          aria-label={t(visible ? "settings.remoteHideToken" : "settings.remoteShowToken")}
          className={cn(
            "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
            "hover:bg-muted/60 hover:text-foreground",
          )}
        >
          {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
        {value ? <SettingsCopyButton value={value} /> : null}
      </div>
    </div>
  );
}

function ToggleOptionCard({
  icon: Icon,
  title,
  hint,
  checked,
  onToggle,
}: {
  icon: typeof RefreshCw;
  title: string;
  hint: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-settings-tile px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          {title}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <AgentActivationSwitch checked={checked} title={title} onToggle={onToggle} />
    </div>
  );
}

type GatewayRuntimeStatus = {
  online: boolean;
  enabled: boolean;
  configured: boolean;
  gatewayUrl?: string;
  sessionId?: string | null;
  connectedSince?: number | null;
  lastHeartbeat?: number | null;
  lastError?: string | null;
  /** 当前链路协议："v2"（WebSocket+Protobuf）或 "v1"（弃用的 WebSocket 回退）。 */
  protocol?: string | null;
};

function updateRemoteSettings(
  setSettings: SettingsSectionProps["setSettings"],
  patch: Partial<AppSettings["remote"]>,
) {
  setSettings((prev) => ({
    ...prev,
    remote: {
      ...prev.remote,
      ...patch,
    },
  }));
}

function usePositiveIntegerDraft(
  value: number,
  options: { min?: number; max?: number },
  onCommit: (nextValue: number) => void,
) {
  const [draft, setDraft] = useState(() => String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const handleChange = useCallback(
    (rawValue: string) => {
      const nextDraft = normalizeIntegerDraftInput(rawValue);
      setDraft(nextDraft);

      const parsed = parseIntegerDraftValue(nextDraft, options);
      if (parsed !== null && parsed !== value) {
        onCommit(parsed);
      }
    },
    [onCommit, options, value],
  );

  const handleBlur = useCallback(() => {
    const parsed = parseIntegerDraftValue(draft, options);
    if (parsed === null) {
      setDraft(String(value));
      return;
    }

    setDraft(String(parsed));
    if (parsed !== value) {
      onCommit(parsed);
    }
  }, [draft, onCommit, options, value]);

  return {
    draft,
    handleBlur,
    handleChange,
  };
}

function buildGatewayEndpointPreview(settings: AppSettings["remote"], managedLocal: boolean) {
  return managedLocal
    ? buildGatewayPublicBaseUrl("http://127.0.0.1", settings.localGatewayPort)
    : buildGatewayPublicBaseUrl(settings.gatewayUrl, settings.gatewayPort);
}

function formatTimestamp(value?: number | null) {
  if (!value) return "N/A";
  const timestampMs = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(timestampMs).toLocaleString();
}

export function RemoteSection(props: SettingsSectionProps & { surface?: "desktop" | "web" }) {
  const { settings, setSettings, surface = "web" } = props;
  const showLocalGateway = surface === "desktop";
  const managedLocal = showLocalGateway && settings.remote.managedLocal;
  const { t } = useLocale();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const localGatewayPortDraft = usePositiveIntegerDraft(
    settings.remote.localGatewayPort,
    { min: 1, max: REMOTE_GATEWAY_PORT_MAX },
    (localGatewayPort) => updateRemoteSettings(setSettings, { localGatewayPort }),
  );
  const remoteGatewayPortDraft = usePositiveIntegerDraft(
    settings.remote.gatewayPort,
    { min: 1, max: REMOTE_GATEWAY_PORT_MAX },
    (gatewayPort) =>
      updateRemoteSettings(setSettings, {
        gatewayPort,
      }),
  );
  const remoteHeartbeatDraft = usePositiveIntegerDraft(
    settings.remote.heartbeatInterval,
    { min: 1 },
    (heartbeatInterval) =>
      updateRemoteSettings(setSettings, {
        heartbeatInterval,
      }),
  );
  const [status, setStatus] = useState<GatewayRuntimeStatus>({
    online: false,
    enabled: settings.remote.enabled,
    configured: false,
  });
  const remoteConfigured = managedLocal
    ? settings.remote.localGatewayToken.trim() !== ""
    : settings.remote.gatewayUrl.trim() !== "" && settings.remote.token.trim() !== "";

  useEffect(() => {
    let cancelled = false;

    void invoke<GatewayRuntimeStatus>("gateway_status")
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus((prev) => ({
            ...prev,
            online: false,
            enabled: settings.remote.enabled,
            configured: remoteConfigured,
            gatewayUrl: buildGatewayEndpointPreview(settings.remote, managedLocal),
            sessionId: null,
            connectedSince: null,
            lastHeartbeat: null,
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [managedLocal, remoteConfigured, settings.remote]);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;

    void listen<GatewayRuntimeStatus>("gateway:status", (event) => {
      if (!cancelled) {
        setStatus(event.payload);
      }
    })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else dispose = unlisten;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  const isConnected = Boolean(status.online);
  const gatewayEndpointPreview = useMemo(
    () => buildGatewayEndpointPreview(settings.remote, managedLocal),
    [settings.remote, managedLocal],
  );

  const retryGateway = async () => {
    setRetrying(true);
    try {
      await invoke("gateway_nudge_connection", {
        reason: "settings_retry",
        force_reconnect: true,
      });
    } catch (error) {
      setStatus((prev) => ({ ...prev, lastError: String(error) }));
    } finally {
      setRetrying(false);
    }
  };

  const connectedProtocol = status.protocol?.trim();
  const lastError = status.lastError?.trim()
    ? localizeLocalGatewayError(status.lastError.trim(), t)
    : null;
  const statusText = isConnected
    ? connectedProtocol
      ? t("settings.remoteConnectedProtocol").replace("{protocol}", connectedProtocol)
      : t("settings.remoteConnected")
    : settings.remote.enabled
      ? lastError || t("settings.remoteDisconnected")
      : t("settings.remoteDisconnected");

  return (
    <div className="space-y-6">
      <SettingsRow
        title={t("settings.remoteTitle")}
        description={t("settings.remoteDesc")}
        control={
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex max-w-260px items-center gap-2 rounded-lg px-2.5 py-1.5",
                "text-xs font-medium",
                isConnected
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-muted/50 text-muted-foreground",
              )}
              title={lastError ?? undefined}
            >
              {isConnected ? (
                <Wifi className="size-3.5 shrink-0" />
              ) : (
                <WifiOff className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{statusText}</span>
            </div>

            <AgentActivationSwitch
              checked={settings.remote.enabled}
              title={
                settings.remote.enabled ? t("settings.remoteDisable") : t("settings.remoteEnable")
              }
              onToggle={() =>
                updateRemoteSettings(setSettings, {
                  enabled: !settings.remote.enabled,
                })
              }
            />
          </div>
        }
      />

      <SettingsSection>
        {showLocalGateway ? (
          <SettingsRow
            title={t("settings.remoteManagedLocal")}
            description={t("settings.remoteManagedLocalHint")}
            control={
              <AgentActivationSwitch
                checked={managedLocal}
                title={t("settings.remoteManagedLocal")}
                onToggle={() => updateRemoteSettings(setSettings, { managedLocal: !managedLocal })}
              />
            }
          />
        ) : null}
        <SettingsRow
          title={t("settings.remoteGatewayConnection")}
          description={remoteConfigured ? gatewayEndpointPreview : t("settings.remoteSetupHint")}
          control={
            <Button size="sm" variant="outline" onClick={() => setConnectionOpen(true)}>
              {t("settings.remoteConfigure")}
            </Button>
          }
        />
        <SettingsRow
          title={t("settings.remoteOptionsTitle")}
          description={t("settings.remoteOptionsHint")}
          control={
            <Button size="sm" variant="outline" onClick={() => setOptionsOpen(true)}>
              {t("settings.remoteConfigure")}
            </Button>
          }
        />
      </SettingsSection>
      <Dialog open={connectionOpen} onOpenChange={setConnectionOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-lg flex-col" showCloseButton>
          <DialogHeader>
            <DialogTitle>{t("settings.remoteGatewayConnection")}</DialogTitle>
            <DialogDescription>{t("settings.remoteConfigHint")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            {managedLocal ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">{t("settings.remoteLocalHint")}</p>
                <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2 text-sm">
                  <Globe className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {gatewayEndpointPreview}
                  </span>
                  <SettingsCopyButton value={gatewayEndpointPreview} />
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="local-gateway-port"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t("settings.remotePortLabel")}
                  </label>
                  <Input
                    variant="plain"
                    id="local-gateway-port"
                    type="text"
                    inputMode="numeric"
                    value={localGatewayPortDraft.draft}
                    onBlur={localGatewayPortDraft.handleBlur}
                    onChange={(e) => localGatewayPortDraft.handleChange(e.target.value)}
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="local-gateway-token"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t("settings.remoteToken")}
                  </label>
                  <PasswordInput
                    id="local-gateway-token"
                    value={settings.remote.localGatewayToken}
                    onChange={() => {}}
                    readOnly
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("settings.remoteLocalTokenHint")}
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-4">
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <label
                        htmlFor="remote-gateway-url"
                        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
                      >
                        <Link2 className="size-3" />
                        {t("settings.remoteGatewayUrl")}
                      </label>
                      <div className="space-y-2">
                        <Input
                          variant="plain"
                          id="remote-gateway-url"
                          type="url"
                          value={settings.remote.gatewayUrl}
                          onChange={(e) =>
                            updateRemoteSettings(setSettings, {
                              gatewayUrl: e.target.value,
                            })
                          }
                          placeholder="https://gateway.example.com"
                          className="min-w-0 flex-1 font-mono text-sm"
                        />
                        <label
                          htmlFor="remote-gateway-port"
                          className="block pt-2 text-xs font-medium text-muted-foreground"
                        >
                          {t("settings.remotePortLabel")}
                        </label>
                        <Input
                          variant="plain"
                          id="remote-gateway-port"
                          type="text"
                          inputMode="numeric"
                          value={remoteGatewayPortDraft.draft}
                          onBlur={remoteGatewayPortDraft.handleBlur}
                          onChange={(e) => remoteGatewayPortDraft.handleChange(e.target.value)}
                          placeholder="443"
                          className="w-full font-mono text-sm"
                        />
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground/70">
                        {t("settings.remoteGatewayUrlHint")}
                      </p>
                    </div>

                    {gatewayEndpointPreview ? (
                      <div
                        className={cn(
                          "flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2",
                          "text-xs text-muted-foreground",
                        )}
                      >
                        <Globe className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate font-mono">
                          {gatewayEndpointPreview}
                        </span>
                        <SettingsCopyButton value={gatewayEndpointPreview} />
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <label
                        htmlFor="remote-gateway-token"
                        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
                      >
                        <Key className="size-3" />
                        {t("settings.remoteToken")}
                      </label>
                      <PasswordInput
                        id="remote-gateway-token"
                        value={settings.remote.token}
                        onChange={(value) =>
                          updateRemoteSettings(setSettings, {
                            token: value,
                          })
                        }
                        placeholder={t("settings.remoteTokenPlaceholder")}
                      />
                      <p className="text-xs leading-relaxed text-muted-foreground/70">
                        {t("settings.remoteTokenHint")}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label
                        htmlFor="remote-agent-id"
                        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
                      >
                        <MonitorSmartphone className="size-3" />
                        {t("settings.remoteAgentId")}
                      </label>
                      <div className="relative">
                        <Input
                          variant="plain"
                          id="remote-agent-id"
                          type="text"
                          readOnly
                          value={settings.remote.agentId}
                          className="pr-12 font-mono text-sm"
                        />
                        <div className="absolute right-1 top-1/2 -translate-y-1/2">
                          <SettingsCopyButton value={settings.remote.agentId} />
                        </div>
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground/70">
                        {t("settings.remoteAgentIdHint")}
                      </p>
                    </div>
                  </div>
                </div>
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button size="sm" onClick={() => setConnectionOpen(false)}>
              {t("settings.remoteDone")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={optionsOpen} onOpenChange={setOptionsOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-lg flex-col" showCloseButton>
          <DialogHeader>
            <DialogTitle>{t("settings.remoteOptionsTitle")}</DialogTitle>
            <DialogDescription>{t("settings.remoteConfigHint")}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-3">
              <ToggleOptionCard
                icon={RefreshCw}
                title={t("settings.remoteAutoReconnect")}
                hint={t("settings.remoteAutoReconnectHint")}
                checked={settings.remote.autoReconnect}
                onToggle={() =>
                  updateRemoteSettings(setSettings, {
                    autoReconnect: !settings.remote.autoReconnect,
                  })
                }
              />

              <div className="flex items-center justify-between gap-4 rounded-xl bg-settings-tile px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <Radio className="size-3.5 shrink-0 text-muted-foreground" />
                    {t("settings.remoteHeartbeat")}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {t("settings.remoteHeartbeatHint")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Input
                    variant="plain"
                    aria-label={t("settings.remoteHeartbeat")}
                    type="text"
                    inputMode="numeric"
                    value={remoteHeartbeatDraft.draft}
                    onBlur={remoteHeartbeatDraft.handleBlur}
                    onChange={(e) => remoteHeartbeatDraft.handleChange(e.target.value)}
                    placeholder="30"
                    className="w-24 font-mono text-sm"
                  />
                  <span className="text-xs text-muted-foreground">
                    {t("settings.remoteHeartbeatUnit")}
                  </span>
                </div>
              </div>

              <ToggleOptionCard
                icon={Terminal}
                title={t("settings.remoteWebTerminal")}
                hint={t("settings.remoteWebTerminalHint")}
                checked={settings.remote.enableWebTerminal}
                onToggle={() =>
                  updateRemoteSettings(setSettings, {
                    enableWebTerminal: !settings.remote.enableWebTerminal,
                  })
                }
              />

              <ToggleOptionCard
                icon={Server}
                title={t("settings.remoteWebSshTerminal")}
                hint={t("settings.remoteWebSshTerminalHint")}
                checked={settings.remote.enableWebSshTerminal}
                onToggle={() =>
                  updateRemoteSettings(setSettings, {
                    enableWebSshTerminal: !settings.remote.enableWebSshTerminal,
                  })
                }
              />

              <ToggleOptionCard
                icon={GitBranch}
                title={t("settings.remoteWebGit")}
                hint={t("settings.remoteWebGitHint")}
                checked={settings.remote.enableWebGit}
                onToggle={() =>
                  updateRemoteSettings(setSettings, {
                    enableWebGit: !settings.remote.enableWebGit,
                  })
                }
              />

              <ToggleOptionCard
                icon={Share2}
                title={t("settings.remoteWebTunnels")}
                hint={t("settings.remoteWebTunnelsHint")}
                checked={settings.remote.enableWebTunnels}
                onToggle={() =>
                  updateRemoteSettings(setSettings, {
                    enableWebTunnels: !settings.remote.enableWebTunnels,
                  })
                }
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button size="sm" onClick={() => setOptionsOpen(false)}>
              {t("settings.remoteDone")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <details className="rounded-xl bg-settings-tile p-4">
        <summary className="cursor-pointer text-sm font-medium">
          {t("settings.remoteConnectionStatus")}
        </summary>
        {lastError ? (
          <p className="mt-3 break-words text-xs text-destructive">{lastError}</p>
        ) : null}
        {managedLocal && settings.remote.enabled && !isConnected ? (
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            disabled={retrying}
            onClick={retryGateway}
          >
            <RefreshCw className={cn("size-3.5", retrying && "animate-spin")} />
            {t("settings.remoteRetry")}
          </Button>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-settings-tile px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("settings.remoteConnectedSince")}
            </div>
            <div className="mt-1 text-sm font-medium">{formatTimestamp(status.connectedSince)}</div>
          </div>
          <div className="rounded-xl bg-settings-tile px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("settings.remoteLastHeartbeat")}
            </div>
            <div className="mt-1 text-sm font-medium">{formatTimestamp(status.lastHeartbeat)}</div>
          </div>
        </div>
      </details>
    </div>
  );
}
