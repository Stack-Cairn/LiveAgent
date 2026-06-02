import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Cloud,
  Copy,
  Eye,
  EyeOff,
  Globe,
  Key,
  Link2,
  MonitorSmartphone,
  Radio,
  Server,
  Shield,
  Wifi,
  WifiOff,
} from "../../components/icons";

import { Input } from "../../components/ui/input";
import { useLocale } from "../../i18n";
import type { AppSettings } from "../../lib/settings";
import { normalizeIntegerDraftInput, parseIntegerDraftValue } from "./remoteInput";
import { AgentActivationSwitch } from "./shared";
import type { SettingsSectionProps } from "./types";

const REMOTE_GRPC_PORT_MAX = 65_535;

function CopyButton({ value }: { value: string }) {
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
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function PasswordInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative flex-1">
      <Input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-16 font-mono text-[13px]"
      />
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
        <button
          type="button"
          onClick={() => setVisible((prev) => !prev)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
        {value ? <CopyButton value={value} /> : null}
      </div>
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

function buildGrpcEndpoint(settings: AppSettings["remote"]) {
  const explicitEndpoint = settings.grpcEndpoint.trim();
  if (explicitEndpoint) {
    if (/^https?:\/\//i.test(explicitEndpoint)) {
      return explicitEndpoint.replace(/\/$/, "");
    }
    return `http://${explicitEndpoint.replace(/\/$/, "")}`;
  }

  const gatewayUrl = settings.gatewayUrl.trim();
  if (!gatewayUrl) return "";

  try {
    const url = new URL(gatewayUrl);
    const port = String(settings.grpcPort || 50051);
    url.port = port;
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return `${gatewayUrl}:${settings.grpcPort || 50051}`;
  }
}

function formatTimestamp(value?: number | null) {
  if (!value) return "N/A";
  const timestampMs = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(timestampMs).toLocaleString();
}

export function RemoteSection(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const remoteGrpcPortDraft = usePositiveIntegerDraft(
    settings.remote.grpcPort,
    { min: 1, max: REMOTE_GRPC_PORT_MAX },
    (grpcPort) =>
      updateRemoteSettings(setSettings, {
        grpcPort,
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
  const remoteConfigured =
    settings.remote.gatewayUrl.trim() !== "" && settings.remote.token.trim() !== "";

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
            gatewayUrl: settings.remote.gatewayUrl.trim(),
            sessionId: null,
            connectedSince: null,
            lastHeartbeat: null,
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    remoteConfigured,
    settings.remote.agentId,
    settings.remote.autoReconnect,
    settings.remote.enabled,
    settings.remote.gatewayUrl,
    settings.remote.grpcPort,
    settings.remote.heartbeatInterval,
    settings.remote.token,
  ]);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;

    void listen<GatewayRuntimeStatus>("gateway:status", (event) => {
      if (!cancelled) {
        setStatus(event.payload);
      }
    }).then((unlisten) => {
      dispose = unlisten;
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  const isConnected = Boolean(status.online);
  const grpcEndpoint = useMemo(() => buildGrpcEndpoint(settings.remote), [settings.remote]);

  const statusText = isConnected
    ? t("settings.remoteConnected")
    : settings.remote.enabled
      ? status.lastError?.trim() || t("settings.remoteDisconnected")
      : t("settings.remoteDisconnected");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-500/10">
            <Cloud className="h-[18px] w-[18px] text-sky-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t("settings.remoteTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("settings.remoteDesc")}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div
            className={`flex max-w-[260px] items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium ${
              isConnected
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-muted/50 text-muted-foreground"
            }`}
            title={status.lastError ?? undefined}
          >
            {isConnected ? (
              <Wifi className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 shrink-0" />
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
      </div>

      <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Server className="h-4 w-4 text-muted-foreground" />
          {t("settings.remoteGatewayConnection")}
        </div>

        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Link2 className="h-3 w-3" />
            {t("settings.remoteGatewayUrl")}
          </label>
          <div className="flex items-center gap-2">
            <Input
              type="url"
              value={settings.remote.gatewayUrl}
              onChange={(e) =>
                updateRemoteSettings(setSettings, {
                  gatewayUrl: e.target.value,
                })
              }
              placeholder="https://gateway.example.com"
              className="min-w-0 flex-1 font-mono text-[13px]"
            />
            <span className="shrink-0 text-xs text-muted-foreground/50">:</span>
            <Input
              type="text"
              inputMode="numeric"
              value={remoteGrpcPortDraft.draft}
              onBlur={remoteGrpcPortDraft.handleBlur}
              onChange={(e) => remoteGrpcPortDraft.handleChange(e.target.value)}
              placeholder="50051"
              className="w-24 shrink-0 font-mono text-[13px]"
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            {t("settings.remoteGatewayUrlHint")}
          </p>
          <div className="space-y-1.5 pt-2">
            <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Globe className="h-3 w-3" />
              {t("settings.remoteGrpcEndpoint")}
            </label>
            <Input
              type="text"
              value={settings.remote.grpcEndpoint}
              onChange={(e) =>
                updateRemoteSettings(setSettings, {
                  grpcEndpoint: e.target.value,
                })
              }
              placeholder="http://tcp.proxy.rlwy.net:12345"
              className="font-mono text-[13px]"
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground/70">
              {t("settings.remoteGrpcEndpointHint")}
            </p>
          </div>
          {grpcEndpoint ? (
            <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
              <Globe className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono">{grpcEndpoint}</span>
              <CopyButton value={grpcEndpoint} />
            </div>
          ) : null}
        </div>
      </div>

      <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Shield className="h-4 w-4 text-muted-foreground" />
          {t("settings.remoteAuth")}
        </div>

        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Key className="h-3 w-3" />
            {t("settings.remoteToken")}
          </label>
          <PasswordInput
            value={settings.remote.token}
            onChange={(value) =>
              updateRemoteSettings(setSettings, {
                token: value,
              })
            }
            placeholder={t("settings.remoteTokenPlaceholder")}
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            {t("settings.remoteTokenHint")}
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <MonitorSmartphone className="h-3 w-3" />
            {t("settings.remoteAgentId")}
          </label>
          <Input
            type="text"
            value={settings.remote.agentId}
            onChange={(e) =>
              updateRemoteSettings(setSettings, {
                agentId: e.target.value,
              })
            }
            placeholder={t("settings.remoteAgentIdPlaceholder")}
            className="font-mono text-[13px]"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            {t("settings.remoteAgentIdHint")}
          </p>
        </div>
      </div>

      <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Globe className="h-4 w-4 text-muted-foreground" />
          {t("settings.remoteAdvanced")}
        </div>

        <div className="grid gap-3 lg:grid-cols-4">
          <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/30 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{t("settings.remoteAutoReconnect")}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("settings.remoteAutoReconnectHint")}
              </p>
            </div>
            <AgentActivationSwitch
              checked={settings.remote.autoReconnect}
              title={t("settings.remoteAutoReconnect")}
              onToggle={() =>
                updateRemoteSettings(setSettings, {
                  autoReconnect: !settings.remote.autoReconnect,
                })
              }
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/30 px-4 py-3">
            <div className="min-w-0 flex-1">
              <label className="flex items-center gap-1.5 text-sm font-medium">
                <Radio className="h-3.5 w-3.5 text-muted-foreground" />
                {t("settings.remoteHeartbeat")}
              </label>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Input
                type="text"
                inputMode="numeric"
                value={remoteHeartbeatDraft.draft}
                onBlur={remoteHeartbeatDraft.handleBlur}
                onChange={(e) => remoteHeartbeatDraft.handleChange(e.target.value)}
                placeholder="30"
                className="w-24 font-mono text-[13px]"
              />
              <span className="text-xs text-muted-foreground">
                {t("settings.remoteHeartbeatUnit")}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/30 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{t("settings.remoteWebTerminal")}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("settings.remoteWebTerminalHint")}
              </p>
            </div>
            <AgentActivationSwitch
              checked={settings.remote.enableWebTerminal}
              title={t("settings.remoteWebTerminal")}
              onToggle={() =>
                updateRemoteSettings(setSettings, {
                  enableWebTerminal: !settings.remote.enableWebTerminal,
                })
              }
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/30 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{t("settings.remoteWebGit")}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("settings.remoteWebGitHint")}
              </p>
            </div>
            <AgentActivationSwitch
              checked={settings.remote.enableWebGit}
              title={t("settings.remoteWebGit")}
              onToggle={() =>
                updateRemoteSettings(setSettings, {
                  enableWebGit: !settings.remote.enableWebGit,
                })
              }
            />
          </div>
        </div>
      </div>

      <div className="grid gap-3 rounded-xl border border-border/60 bg-card p-5 sm:grid-cols-2">
        <div className="rounded-lg bg-muted/30 px-4 py-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Connected Since
          </div>
          <div className="mt-1 text-sm font-medium">{formatTimestamp(status.connectedSince)}</div>
        </div>
        <div className="rounded-lg bg-muted/30 px-4 py-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Last Heartbeat
          </div>
          <div className="mt-1 text-sm font-medium">{formatTimestamp(status.lastHeartbeat)}</div>
        </div>
      </div>
    </div>
  );
}
