import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Clock3,
  Cloud,
  Copy,
  Eye,
  EyeOff,
  GitBranch,
  Globe,
  type IconComponent,
  Key,
  Link2,
  MonitorSmartphone,
  Radio,
  RefreshCw,
  Server,
  Share2,
  Shield,
  Terminal,
  Wifi,
  WifiOff,
} from "../../components/icons";

import { Input } from "../../components/ui/input";
import { useLocale } from "../../i18n";
import type { AppSettings } from "../../lib/settings";
import { normalizeIntegerDraftInput, parseIntegerDraftValue } from "./remoteInput";
import { AgentActivationSwitch } from "./shared";
import type { SettingsSectionProps } from "./types";

const REMOTE_GATEWAY_PORT_MAX = 65_535;

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
  id,
  value,
  onChange,
  placeholder,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative flex-1">
      <Input
        id={id}
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

function SectionCardHeader({ icon: Icon, title }: { icon: IconComponent; title: string }) {
  return (
    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
      <Icon className="h-4 w-4 text-muted-foreground" />
      {title}
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
  icon: IconComponent;
  title: string;
  hint: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/30 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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

function buildGatewayEndpointPreview(settings: AppSettings["remote"]) {
  const gatewayUrl = settings.gatewayUrl.trim();
  if (!gatewayUrl) return "";

  try {
    const url = new URL(gatewayUrl);
    const port = String(settings.gatewayPort || 443);
    url.port = port;
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return `${gatewayUrl}:${settings.gatewayPort || 443}`;
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
  }, [remoteConfigured, settings.remote.enabled, settings.remote.gatewayUrl]);

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
  const gatewayEndpointPreview = useMemo(
    () => buildGatewayEndpointPreview(settings.remote),
    [settings.remote],
  );

  const connectedProtocol = status.protocol?.trim();
  const statusText = isConnected
    ? connectedProtocol
      ? t("settings.remoteConnectedProtocol").replace("{protocol}", connectedProtocol)
      : t("settings.remoteConnected")
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
        <SectionCardHeader icon={Server} title={t("settings.remoteGatewayConnection")} />

        <div className="space-y-1.5">
          <label
            htmlFor="remote-gateway-url"
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
          >
            <Link2 className="h-3 w-3" />
            {t("settings.remoteGatewayUrl")}
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="remote-gateway-url"
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
              value={remoteGatewayPortDraft.draft}
              onBlur={remoteGatewayPortDraft.handleBlur}
              onChange={(e) => remoteGatewayPortDraft.handleChange(e.target.value)}
              placeholder="443"
              className="w-24 shrink-0 font-mono text-[13px]"
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            {t("settings.remoteGatewayUrlHint")}
          </p>
        </div>

        {gatewayEndpointPreview ? (
          <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            <Globe className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-mono">{gatewayEndpointPreview}</span>
            <CopyButton value={gatewayEndpointPreview} />
          </div>
        ) : null}
      </div>

      <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
        <SectionCardHeader icon={Shield} title={t("settings.remoteAuth")} />

        <div className="space-y-1.5">
          <label
            htmlFor="remote-gateway-token"
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
          >
            <Key className="h-3 w-3" />
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
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            {t("settings.remoteTokenHint")}
          </p>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="remote-agent-id"
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
          >
            <MonitorSmartphone className="h-3 w-3" />
            {t("settings.remoteAgentId")}
          </label>
          <div className="relative">
            <Input
              id="remote-agent-id"
              type="text"
              readOnly
              value={settings.remote.agentId}
              className="bg-muted/30 pr-12 font-mono text-[13px]"
            />
            <div className="absolute right-1 top-1/2 -translate-y-1/2">
              <CopyButton value={settings.remote.agentId} />
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            {t("settings.remoteAgentIdHint")}
          </p>
        </div>
      </div>

      <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
        <SectionCardHeader icon={Globe} title={t("settings.remoteAdvanced")} />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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

          <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/30 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Radio className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {t("settings.remoteHeartbeat")}
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("settings.remoteHeartbeatHint")}
              </p>
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
      </div>

      <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
        <SectionCardHeader icon={Clock3} title={t("settings.remoteConnectionStatus")} />

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-muted/30 px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("settings.remoteConnectedSince")}
            </div>
            <div className="mt-1 text-sm font-medium">{formatTimestamp(status.connectedSince)}</div>
          </div>
          <div className="rounded-lg bg-muted/30 px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("settings.remoteLastHeartbeat")}
            </div>
            <div className="mt-1 text-sm font-medium">{formatTimestamp(status.lastHeartbeat)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
