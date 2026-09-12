import {
  AlertCircle,
  Bot,
  Brain,
  CheckCircle2,
  Cloud,
  ExternalLink,
  Globe2,
  HardDrive,
  History,
  type IconComponent,
  Loader2,
  LogOut,
  MessageSquareText,
  Plug,
  Radio,
  RefreshCw,
  Server,
  Shield,
  Sparkles,
  Terminal,
  Timer,
  Wifi,
  WifiOff,
  Wrench,
  Zap,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useAutomation } from "@liveagent/ui/lib/automation/index";
import type { GatewaySettingsSyncPayload } from "@liveagent/ui/lib/settings/sync";
import { cachedDateTimeFormat, cachedNumberFormat } from "@liveagent/ui/lib/shared/intlFormatters";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { TerminalSession } from "@liveagent/ui/lib/terminal/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeGatewayAccessToken, verifyGatewayAccessToken } from "@/lib/gatewayAuth";
import {
  type GatewayWebSocketClientLike,
  getGatewayWebSocketClient,
  resetGatewayWebSocketClient,
  type TunnelStateSnapshot,
} from "@/lib/gatewaySocket";
import type {
  AgentStatus,
  ConversationSummary,
  GatewayHistoryEvent,
  GatewayProviderSummary,
  HistoryList,
  HistoryWorkdirSummary,
} from "@/lib/gatewayTypes";
import { clearToken, loadToken, saveToken } from "@/lib/storage";
import { StatusPanel, statusPanelSurfaceClass } from "../components/StatusPanel";
import { StatusHeading, StatusLabel, StatusSectionHeader } from "../components/StatusTypography";
import { LoginPage } from "./LoginPage";

type DashboardTone = "cyan" | "violet" | "rose" | "amber" | "emerald" | "slate";

type DashboardEvent = {
  id: string;
  at: number;
  title: string;
  detail: string;
  tone: DashboardTone;
  conversationId?: string;
  workdir?: string;
};

type LiveCounters = {
  events: number;
  tokenChunks: number;
  tokenChars: number;
  thinking: number;
  toolCalls: number;
  toolResults: number;
  searches: number;
  completions: number;
  errors: number;
  startedAt: number;
};

type PendingCounters = Omit<LiveCounters, "startedAt">;

type SnapshotState = {
  loading: boolean;
  error: string | null;
  lastRefreshAt: number;
};

type MetricCard = {
  label: string;
  value: string;
  unit: string;
  detail: string;
  tone: DashboardTone;
  icon: IconComponent;
};

type FactItem = {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  tone?: DashboardTone;
};

type LoadSegment = {
  label: string;
  value: number;
  unit: string;
  width: number;
  tone: DashboardTone;
};

const HISTORY_PAGE_SIZE = 80;
const SNAPSHOT_REFRESH_MS = 10_000;
const LIVE_FLUSH_MS = 500;
const MAX_RECENT_EVENTS = 12;

const dashboardToneClass: Record<DashboardTone, string> = {
  cyan: "[--status-board-tone:var(--status-cyan)]",
  violet: "[--status-board-tone:var(--status-violet)]",
  rose: "[--status-board-tone:var(--status-rose)]",
  amber: "[--status-board-tone:var(--status-amber)]",
  emerald: "[--status-board-tone:var(--status-emerald)]",
  slate: "[--status-board-tone:191,210,232]",
};

const statusActionClass =
  "flex h-33px items-center gap-7px rounded-full border border-[rgba(var(--status-cyan),0.2)] bg-white/[0.055] px-12px py-0 text-xs text-foreground uppercase no-underline whitespace-nowrap shadow-status-board-pill backdrop-blur-16px transition-[transform,border-color,background-color] duration-160ms ease-default hover:-translate-y-1px hover:border-[rgba(var(--status-cyan),0.48)] hover:bg-[rgba(var(--status-cyan),0.1)] hover:text-foreground";

const statusEntrySurfaceClass =
  "border border-[rgba(var(--status-board-tone,191,210,232),0.14)] bg-[rgba(var(--status-board-tone,191,210,232),0.055)]";

const initialCounters = (): LiveCounters => ({
  events: 0,
  tokenChunks: 0,
  tokenChars: 0,
  thinking: 0,
  toolCalls: 0,
  toolResults: 0,
  searches: 0,
  completions: 0,
  errors: 0,
  startedAt: Date.now(),
});

const initialPendingCounters = (): PendingCounters => ({
  events: 0,
  tokenChunks: 0,
  tokenChars: 0,
  thinking: 0,
  toolCalls: 0,
  toolResults: 0,
  searches: 0,
  completions: 0,
  errors: 0,
});

function readDashboardTokenSeed() {
  return normalizeGatewayAccessToken(loadToken());
}

function stripDashboardTokenFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("token") && !url.searchParams.has("access_token")) {
    return;
  }
  url.searchParams.delete("token");
  url.searchParams.delete("access_token");
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
}

function asErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return fallback;
}

function normalizeEpochMs(value: number | null | undefined) {
  if (!value || !Number.isFinite(value)) {
    return 0;
  }
  return value > 10_000_000_000 ? value : value * 1000;
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0 s";
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ${seconds % 60} s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ${minutes % 60} min`;
  }
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

function formatClock(ms: number) {
  if (!ms) {
    return "--:--:--";
  }
  return cachedDateTimeFormat("zh-CN", "status-dashboard-clock", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function compactNumber(value: number) {
  return cachedNumberFormat("zh-CN", "status-dashboard-compact", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Math.max(0, value));
}

function percentage(value: number) {
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

function formatRuntimeState(status: AgentStatus | null) {
  const explicit = status?.runtime_state?.trim();
  if (explicit) {
    return explicit;
  }
  if (status?.online) {
    return status.chat_runtime_ready ? "ready" : "connected";
  }
  return "offline";
}

function formatBooleanFlag(enabled: boolean | undefined) {
  if (typeof enabled !== "boolean") {
    return "--";
  }
  return enabled ? "ON" : "OFF";
}

function truncateMiddle(value: string, maxLength = 34) {
  const text = value.trim();
  if (text.length <= maxLength) {
    return text;
  }
  const head = Math.ceil((maxLength - 1) * 0.56);
  const tail = Math.floor((maxLength - 1) * 0.44);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function basename(path: string) {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) {
    return "未命名项目";
  }
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

function getConversationTitle(conversation: ConversationSummary | undefined, fallback: string) {
  const title = conversation?.title?.trim();
  return title || fallback;
}

function buildRunningConversations(history: HistoryList | null) {
  if (!history) {
    return [];
  }
  const byId = new Map(history.conversations.map((item) => [item.id, item]));
  return (history.running_conversations ?? []).map((runtime) => {
    const id = runtime.conversation_id.trim();
    const conversation = byId.get(id);
    return {
      id,
      title: getConversationTitle(conversation, `会话 ${truncateMiddle(id, 12)}`),
      cwd: runtime?.cwd?.trim() || conversation?.cwd?.trim() || "",
      updatedAt: normalizeEpochMs(runtime?.updated_at || conversation?.updated_at),
      messageCount: conversation?.message_count ?? 0,
      provider: conversation?.provider_id?.trim() || "",
      model: conversation?.model?.trim() || "",
    };
  });
}

function updateHistoryListWithEvent(
  history: HistoryList | null,
  event: GatewayHistoryEvent,
): HistoryList | null {
  if (!history) {
    return history;
  }
  const conversationId =
    typeof event.conversation_id === "string" ? event.conversation_id.trim() : "";
  if (!conversationId) {
    return history;
  }

  if (event.kind === "delete") {
    return {
      ...history,
      total_count: Math.max(0, history.total_count - 1),
      conversations: history.conversations.filter((item) => item.id !== conversationId),
      running_conversations: (history.running_conversations ?? []).filter(
        (item) => item.conversation_id !== conversationId,
      ),
    };
  }

  const conversation = event.conversation as ConversationSummary | undefined;
  if (event.kind !== "upsert" || !conversation?.id) {
    return history;
  }

  const without = history.conversations.filter((item) => item.id !== conversation.id);
  const conversations = [conversation, ...without]
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
    .slice(0, HISTORY_PAGE_SIZE);
  return {
    ...history,
    total_count: Math.max(history.total_count, conversations.length),
    conversations,
  };
}

function useNow(enabled: boolean, tickMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(timer);
  }, [enabled, tickMs]);
  return now;
}

function StatusPill({ online, label }: { online: boolean; label: string }) {
  return (
    <span
      className={cn(
        "flex h-33px items-center gap-7px",
        "rounded-full border border-border bg-card/60 px-12px py-0 text-xs text-foreground",
        "uppercase no-underline whitespace-nowrap shadow-status-board-pill backdrop-blur-16px",
        "transition-[transform,border-color,background-color] duration-160ms ease-default",
        online
          ? "border-success/25 bg-success/10 text-success"
          : "border-destructive/25 bg-destructive/10 text-destructive",
      )}
    >
      <span className="size-8px rounded-full bg-current shadow-[0_0_var(--spacing-18px)_currentColor]" />
      {label}
    </span>
  );
}

function MetricTile({ metric }: { metric: MetricCard }) {
  const Icon = metric.icon;
  return (
    <section
      className={cn(
        statusPanelSurfaceClass,
        "relative grid min-h-82px min-w-0 grid-cols-[var(--spacing-34px)_minmax(0,1fr)] items-center gap-9px overflow-hidden",
        "rounded-14px border border-[rgba(var(--status-cyan),0.12)] bg-rgba-255-255-255-0p045 p-10px",
        dashboardToneClass[metric.tone],
      )}
    >
      <div
        className={cn(
          "grid size-34px place-items-center",
          "rounded-12px border border-[rgba(var(--status-cyan),0.3)] bg-[rgba(var(--status-board-tone),0.11)] text-[rgb(var(--status-board-tone))] shadow-[0_0_var(--spacing-28px)_rgba(var(--status-cyan),0.2),inset_0_0_var(--spacing-22px)_color-mix(in_oklab,_var(--color-white)_8%,_transparent)] backdrop-blur-18px",
        )}
      >
        <Icon size={18} strokeWidth={2.2} />
      </div>
      <div>
        <StatusLabel>{metric.label}</StatusLabel>
        <strong className="inline-block mr-5px text-foreground text-2xl leading-none tracking-minus-0p04em">
          {metric.value}
        </strong>
        <em className="text-muted-foreground text-tiny not-italic uppercase">{metric.unit}</em>
        <span
          className={cn(
            "text-muted-foreground text-tiny not-italic block overflow-hidden mt-4px",
            "leading-1p25 text-ellipsis whitespace-nowrap",
          )}
        >
          {metric.detail}
        </span>
      </div>
    </section>
  );
}

function EmptyState({ children }: { children: string }) {
  return (
    <div
      className={cn(
        statusEntrySurfaceClass,
        "rounded-14px px-9px py-8px text-tiny leading-1p25 text-muted-foreground not-italic",
      )}
    >
      {children}
    </div>
  );
}

function FactList({ items, className }: { items: FactItem[]; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-7px", className)}>
      {items.map((item) => (
        <div
          key={item.label}
          className={cn(
            "min-w-0 rounded-13px border border-[rgba(var(--status-board-tone),0.15)] bg-[image:linear-gradient(135deg,rgba(var(--status-board-tone),0.08),transparent),color-mix(in_oklab,_var(--color-white)_4.5%,_transparent)] p-8px [--status-board-tone:191,210,232]",
            item.tone && dashboardToneClass[item.tone],
          )}
        >
          <span className="block text-muted-foreground text-tiny tracking-0p12em uppercase">
            {item.label}
          </span>
          <strong
            className={cn(
              "inline-block overflow-hidden max-w-full mt-3px",
              "text-foreground text-sm leading-1p12 text-ellipsis whitespace-nowrap",
            )}
            title={item.value}
          >
            {item.value}
          </strong>
          {item.unit && (
            <b className="ml-5px inline-block text-tiny font-medium text-[rgba(var(--status-board-tone),0.9)] uppercase">
              {item.unit}
            </b>
          )}
          {item.note && (
            <em
              className={cn(
                "block overflow-hidden mt-3px text-muted-foreground text-tiny not-italic",
                "leading-1p22 text-ellipsis whitespace-nowrap",
              )}
              title={item.note}
            >
              {item.note}
            </em>
          )}
        </div>
      ))}
    </div>
  );
}

function runSnapshotRequest<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

function useDashboardAuth() {
  const initialTokenRef = useRef(readDashboardTokenSeed());
  const [token, setToken] = useState("");
  const [loginToken, setLoginToken] = useState(initialTokenRef.current);
  const [authSubmitting, setAuthSubmitting] = useState(() => initialTokenRef.current !== "");
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    stripDashboardTokenFromUrl();
    const seed = initialTokenRef.current;
    if (!seed) {
      return;
    }
    let cancelled = false;
    setAuthSubmitting(true);
    verifyGatewayAccessToken(seed)
      .then((verifiedToken) => {
        if (cancelled) {
          return;
        }
        saveToken(verifiedToken);
        stripDashboardTokenFromUrl();
        setToken(verifiedToken);
        setLoginToken(verifiedToken);
        setAuthError(null);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        clearToken();
        stripDashboardTokenFromUrl();
        setAuthError(asErrorMessage(error, "Access Token 验证失败。"));
      })
      .finally(() => {
        if (!cancelled) {
          setAuthSubmitting(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = () => {
    setAuthSubmitting(true);
    setAuthError(null);
    verifyGatewayAccessToken(loginToken)
      .then((verifiedToken) => {
        saveToken(verifiedToken);
        setToken(verifiedToken);
        setLoginToken(verifiedToken);
      })
      .catch((error) => {
        setAuthError(asErrorMessage(error, "Access Token 验证失败。"));
      })
      .finally(() => setAuthSubmitting(false));
  };

  const logout = () => {
    clearToken();
    resetGatewayWebSocketClient();
    setToken("");
    setLoginToken("");
    setAuthError(null);
    setAuthSubmitting(false);
  };

  return {
    token,
    loginToken,
    authSubmitting,
    authError,
    setLoginToken,
    setAuthError,
    submit,
    logout,
  };
}

export function StatusDashboardPage() {
  const {
    token,
    loginToken,
    authSubmitting,
    authError,
    setLoginToken,
    setAuthError,
    submit,
    logout,
  } = useDashboardAuth();
  const now = useNow(token !== "");
  const api = useMemo(() => (token ? getGatewayWebSocketClient(token) : null), [token]);
  const pendingEventsRef = useRef<DashboardEvent[]>([]);
  const pendingCountersRef = useRef<PendingCounters>(initialPendingCounters());
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryList | null>(null);
  const [workdirs, setWorkdirs] = useState<HistoryWorkdirSummary[]>([]);
  const [tunnelState, setTunnelState] = useState<TunnelStateSnapshot | null>(null);
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const [providers, setProviders] = useState<GatewayProviderSummary[]>([]);
  const [settingsSnapshot, setSettingsSnapshot] = useState<GatewaySettingsSyncPayload | null>(null);
  const [recentEvents, setRecentEvents] = useState<DashboardEvent[]>([]);
  const [liveCounters, setLiveCounters] = useState<LiveCounters>(() => initialCounters());
  const [snapshot, setSnapshot] = useState<SnapshotState>({
    loading: false,
    error: null,
    lastRefreshAt: 0,
  });
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const nextEvents = pendingEventsRef.current.splice(0, pendingEventsRef.current.length);
      const pendingCounters = pendingCountersRef.current;
      pendingCountersRef.current = initialPendingCounters();

      if (nextEvents.length > 0) {
        setRecentEvents((current) =>
          [...nextEvents.reverse(), ...current].slice(0, MAX_RECENT_EVENTS),
        );
      }
      if (pendingCounters.events > 0) {
        setLiveCounters((current) => ({
          ...current,
          events: current.events + pendingCounters.events,
          tokenChunks: current.tokenChunks + pendingCounters.tokenChunks,
          tokenChars: current.tokenChars + pendingCounters.tokenChars,
          thinking: current.thinking + pendingCounters.thinking,
          toolCalls: current.toolCalls + pendingCounters.toolCalls,
          toolResults: current.toolResults + pendingCounters.toolResults,
          searches: current.searches + pendingCounters.searches,
          completions: current.completions + pendingCounters.completions,
          errors: current.errors + pendingCounters.errors,
        }));
      }
    }, LIVE_FLUSH_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!api) {
      return;
    }
    const unsubscribeStatus = api.subscribeStatus((nextStatus, error) => {
      setStatus(nextStatus);
      setStatusError(error);
    });
    const unsubscribeHistory = api.subscribeHistory((event) => {
      setHistory((current) => updateHistoryListWithEvent(current, event));
    });
    const unsubscribeTerminal = api.subscribeTerminal((event) => {
      if (event.session) {
        const session = event.session;
        setTerminals((current) => {
          const without = current.filter((item) => item.id !== session.id);
          return [session, ...without].sort((a, b) => b.updatedAt - a.updatedAt);
        });
      }
    });
    const unsubscribeSettings = api.subscribeSettings((payload) => {
      setSettingsSnapshot(payload);
    });
    const unsubscribeTunnelState = api.subscribeTunnelState((snapshot) => {
      setTunnelState((current) =>
        current && snapshot.revision <= current.revision ? current : snapshot,
      );
    });

    return () => {
      unsubscribeStatus();
      unsubscribeHistory();
      unsubscribeTerminal();
      unsubscribeSettings();
      unsubscribeTunnelState();
    };
  }, [api]);

  // refreshVersion is an explicit manual-refresh signal, so it intentionally
  // retriggers this effect without being read inside the callback.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keep the manual refresh trigger
  useEffect(() => {
    if (!api) {
      return;
    }
    let cancelled = false;
    async function refresh(currentApi: GatewayWebSocketClientLike) {
      setSnapshot((current) => ({ ...current, loading: true, error: null }));
      const [
        statusResult,
        historyResult,
        workdirsResult,
        terminalsResult,
        providersResult,
        settingsResult,
      ] = await Promise.all([
        runSnapshotRequest(currentApi.getStatus()),
        runSnapshotRequest(currentApi.listHistory(1, HISTORY_PAGE_SIZE)),
        runSnapshotRequest(currentApi.listHistoryWorkdirs()),
        runSnapshotRequest(currentApi.listTerminals()),
        runSnapshotRequest(currentApi.listProviders()),
        runSnapshotRequest(currentApi.getSettings()),
      ]);
      if (cancelled) {
        return;
      }
      const errors: string[] = [];
      if (statusResult.ok) {
        setStatus(statusResult.value);
        setStatusError(null);
      } else {
        errors.push(asErrorMessage(statusResult.error, "状态读取失败"));
      }
      if (historyResult.ok) {
        setHistory(historyResult.value);
      } else {
        errors.push(asErrorMessage(historyResult.error, "历史读取失败"));
      }
      if (workdirsResult.ok) {
        setWorkdirs(workdirsResult.value.workdirs);
      } else {
        errors.push(asErrorMessage(workdirsResult.error, "项目活动读取失败"));
      }
      if (terminalsResult.ok) {
        setTerminals(terminalsResult.value);
      } else {
        errors.push(asErrorMessage(terminalsResult.error, "终端读取失败"));
      }
      if (providersResult.ok) {
        setProviders(providersResult.value);
      } else {
        errors.push(asErrorMessage(providersResult.error, "模型源读取失败"));
      }
      if (settingsResult.ok) {
        setSettingsSnapshot(settingsResult.value);
      } else {
        errors.push(asErrorMessage(settingsResult.error, "设置读取失败"));
      }
      setSnapshot({
        loading: false,
        error: errors.length > 0 ? Array.from(new Set(errors)).slice(0, 2).join(" / ") : null,
        lastRefreshAt: Date.now(),
      });
    }

    void refresh(api);
    const timer = window.setInterval(() => void refresh(api), SNAPSHOT_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, refreshVersion]);

  const runningConversations = useMemo(() => buildRunningConversations(history), [history]);
  const tunnels = useMemo(() => tunnelState?.tunnels ?? [], [tunnelState]);
  const activeTunnels = useMemo(
    () => tunnels.filter((item) => !item.expiresAt || item.expiresAt > now / 1000),
    [now, tunnels],
  );
  const runningTerminals = useMemo(() => terminals.filter((item) => item.running), [terminals]);
  const activeProviders = useMemo(
    () => providers.filter((provider) => provider.activeModels.length > 0),
    [providers],
  );
  const activeModelCount = useMemo(
    () => activeProviders.reduce((total, provider) => total + provider.activeModels.length, 0),
    [activeProviders],
  );
  const uptimeMs = status?.online ? now - normalizeEpochMs(status.connected_since) : 0;
  const heartbeatAgeMs = status?.last_heartbeat ? now - normalizeEpochMs(status.last_heartbeat) : 0;
  const isFreshHeartbeat = status?.online === true && heartbeatAgeMs < 20_000;
  const observedMinutes = Math.max(1, (now - liveCounters.startedAt) / 60_000);
  const eventsPerMinute = liveCounters.events / observedMinutes;
  const messageSampleCount = useMemo(
    () =>
      (history?.conversations ?? []).reduce((total, item) => total + (item.message_count || 0), 0),
    [history],
  );
  const todayConversationCount = useMemo(() => {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return (history?.conversations ?? []).filter(
      (item) => normalizeEpochMs(item.created_at) >= start.getTime(),
    ).length;
  }, [history, now]);
  const runtimeState = formatRuntimeState(status);
  const runtimeHeartbeatAgeMs = status?.runtime_last_heartbeat
    ? now - normalizeEpochMs(status.runtime_last_heartbeat)
    : 0;
  const runtimeActiveRunCount = status?.runtime_active_run_count ?? runningConversations.length;
  const totalTunnelConnections = activeTunnels.reduce(
    (sum, item) => sum + item.activeConnections,
    0,
  );
  const activeWorkspaceProjects = settingsSnapshot?.system.workspaceProjects ?? [];
  const activeWorkspaceProject =
    activeWorkspaceProjects.find(
      (project) => project.id === settingsSnapshot?.system.activeWorkspaceProjectId,
    ) ?? activeWorkspaceProjects[0];
  const automation = useAutomation();
  const selectedModel = settingsSnapshot?.selectedModel ?? null;
  const selectedProvider = selectedModel
    ? (providers.find((provider) => provider.id === selectedModel.customProviderId) ??
      settingsSnapshot?.customProviders.find(
        (provider) => provider.id === selectedModel.customProviderId,
      ))
    : undefined;
  const selectedProviderName =
    selectedProvider?.name?.trim() || selectedModel?.customProviderId || "--";
  const selectedProviderType = selectedProvider?.type || "--";
  const selectedModelConfig = selectedProvider?.models?.find(
    (model) => model.id === selectedModel?.model,
  );
  const enabledCronCount = automation.cron.tasks.filter((task) => task.enabled).length;
  const enabledHookCount = automation.hooks.hooks.filter((hook) => hook.enabled).length;
  const enabledMcpCount =
    settingsSnapshot?.mcp.servers.filter((server) => server.enabled).length ?? 0;
  const configuredProviderCount =
    settingsSnapshot?.customProviders.filter((provider) => provider.apiKeyConfigured).length ?? 0;
  const selectedSkillCount = settingsSnapshot?.skills.enabled
    ? settingsSnapshot.skills.selected.length
    : 0;
  const remoteFeatureCount = settingsSnapshot?.remote
    ? [
        settingsSnapshot.remote.enableWebTerminal,
        settingsSnapshot.remote.enableWebGit,
        settingsSnapshot.remote.enableWebTunnels,
      ].filter(Boolean).length
    : 0;
  const latestTerminal = runningTerminals[0] ?? terminals[0];
  const activeWorkspaceName =
    activeWorkspaceProject?.name?.trim() ||
    (activeWorkspaceProject?.path ? basename(activeWorkspaceProject.path) : "--");
  const activeWorkspaceHint = activeWorkspaceProject?.path
    ? truncateMiddle(activeWorkspaceProject.path, 48)
    : settingsSnapshot
      ? "未配置工作区"
      : "等待 settings.get";
  const loadedConversationRows = history?.conversations.length ?? 0;
  const maxWorkdirCount = Math.max(1, ...workdirs.map((item) => item.conversationCount || 0));
  const activeSubsystemCount =
    Number(status?.online === true) +
    Number(status?.chat_runtime_ready === true) +
    Number(activeProviders.length > 0) +
    Number(runningTerminals.length > 0) +
    Number(activeTunnels.length > 0) +
    Number(enabledMcpCount > 0) +
    Number(enabledCronCount > 0) +
    Number(settingsSnapshot?.skills.enabled === true);
  const integrityScore = Math.min(
    100,
    (status?.online ? 34 : 0) +
      (isFreshHeartbeat ? 18 : 0) +
      (status?.chat_runtime_ready ? 18 : 0) +
      (settingsSnapshot ? 12 : 0) +
      (activeProviders.length > 0 ? 10 : 0) +
      (snapshot.error ? 0 : 8),
  );
  const activeLoadValues = [
    liveCounters.tokenChunks,
    liveCounters.thinking,
    liveCounters.toolCalls + liveCounters.toolResults,
    liveCounters.searches,
    liveCounters.errors,
  ];
  const maxLoadValue = Math.max(1, ...activeLoadValues);
  const toLoadWidth = (value: number) =>
    Math.max(value > 0 ? 12 : 4, Math.round((value / maxLoadValue) * 100));
  const throughputSegments: LoadSegment[] = [
    {
      label: "Token Chunks",
      value: liveCounters.tokenChunks,
      unit: "chunks",
      width: toLoadWidth(liveCounters.tokenChunks),
      tone: "cyan",
    },
    {
      label: "Reasoning",
      value: liveCounters.thinking,
      unit: "events",
      width: toLoadWidth(liveCounters.thinking),
      tone: "violet",
    },
    {
      label: "Tool I/O",
      value: liveCounters.toolCalls + liveCounters.toolResults,
      unit: "events",
      width: toLoadWidth(liveCounters.toolCalls + liveCounters.toolResults),
      tone: "amber",
    },
    {
      label: "Web Search",
      value: liveCounters.searches,
      unit: "events",
      width: toLoadWidth(liveCounters.searches),
      tone: "emerald",
    },
    {
      label: "Errors",
      value: liveCounters.errors,
      unit: "events",
      width: toLoadWidth(liveCounters.errors),
      tone: "rose",
    },
  ];

  const runtimeFacts: FactItem[] = [
    {
      label: "Runtime State",
      value: runtimeState,
      note: `chat_runtime_ready=${formatBooleanFlag(status?.chat_runtime_ready)}`,
      tone: status?.online ? "emerald" : "rose",
    },
    {
      label: "Active Runs",
      value: String(runtimeActiveRunCount),
      unit: "runs",
      note:
        status?.runtime_active_run_count !== undefined
          ? "runtime_active_run_count"
          : "history running fallback",
      tone: runtimeActiveRunCount > 0 ? "violet" : "slate",
    },
    {
      label: "Worker ID",
      value: status?.runtime_worker_id ? truncateMiddle(status.runtime_worker_id, 22) : "--",
      note: `runtime_visible=${formatBooleanFlag(status?.runtime_visible)}`,
    },
    {
      label: "Runtime Heartbeat Age",
      value: status?.runtime_last_heartbeat ? formatDuration(runtimeHeartbeatAgeMs) : "--",
      unit: "age",
      note: "runtime_last_heartbeat",
    },
  ];

  const modelFacts: FactItem[] = [
    {
      label: "Selected Model",
      value: selectedModel?.model ? truncateMiddle(selectedModel.model, 30) : "--",
      note: selectedProviderName,
      tone: selectedModel ? "violet" : "slate",
    },
    {
      label: "Provider",
      value: truncateMiddle(selectedProviderName, 24),
      note: selectedProviderType,
    },
    {
      label: "Context Window",
      value: selectedModelConfig?.contextWindow
        ? compactNumber(selectedModelConfig.contextWindow)
        : "--",
      unit: "tokens",
      note: selectedModelConfig?.maxOutputToken
        ? `${compactNumber(selectedModelConfig.maxOutputToken)} max output tokens`
        : "model config",
    },
    {
      label: "Reasoning Mode",
      value: settingsSnapshot?.chatRuntimeControls.reasoning ?? "--",
      note: `thinking=${formatBooleanFlag(settingsSnapshot?.chatRuntimeControls.thinkingEnabled)} · web_search=${formatBooleanFlag(settingsSnapshot?.chatRuntimeControls.nativeWebSearchEnabled)}`,
    },
  ];

  const fabricFacts: FactItem[] = [
    {
      label: "MCP Servers",
      value: settingsSnapshot ? `${enabledMcpCount}/${settingsSnapshot.mcp.servers.length}` : "--",
      unit: "enabled/total",
      note: `selected ${settingsSnapshot?.mcp.selected.length ?? "--"}`,
      tone: enabledMcpCount > 0 ? "cyan" : "slate",
    },
    {
      label: "Cron Tasks",
      value: automation.ready ? `${enabledCronCount}/${automation.cron.tasks.length}` : "--",
      unit: "enabled/total",
      tone: enabledCronCount > 0 ? "amber" : "slate",
    },
    {
      label: "Hooks",
      value: automation.ready ? `${enabledHookCount}/${automation.hooks.hooks.length}` : "--",
      unit: "enabled/total",
    },
    {
      label: "Skills",
      value: settingsSnapshot?.skills.enabled ? String(selectedSkillCount) : "OFF",
      unit: settingsSnapshot?.skills.enabled ? "selected" : undefined,
      note: `skills.enabled=${formatBooleanFlag(settingsSnapshot?.skills.enabled)}`,
    },
  ];

  const telemetryFacts: FactItem[] = [
    {
      label: "Derived Integrity",
      value: String(integrityScore),
      unit: "%",
      note: `${activeSubsystemCount}/8 observed subsystems`,
      tone: integrityScore >= 70 ? "emerald" : integrityScore >= 40 ? "amber" : "rose",
    },
    {
      label: "Event Rate",
      value: eventsPerMinute.toFixed(1),
      unit: "events/min",
      note: "live WebSocket events since page open",
      tone: liveCounters.events > 0 ? "cyan" : "slate",
    },
    {
      label: "Text Output",
      value: compactNumber(liveCounters.tokenChars),
      unit: "chars",
      note: `${compactNumber(liveCounters.tokenChunks)} token chunks`,
      tone: "violet",
    },
    {
      label: "Tool Traffic",
      value: compactNumber(liveCounters.toolCalls + liveCounters.toolResults),
      unit: "events",
      note: `${compactNumber(liveCounters.errors)} error events`,
      tone: liveCounters.errors > 0 ? "rose" : "amber",
    },
  ];

  const metrics: MetricCard[] = [
    {
      label: "Agent Link",
      value: status?.online ? (isFreshHeartbeat ? "LIVE" : "WARM") : "OFFLINE",
      unit: "state",
      detail: status?.online
        ? `uptime ${formatDuration(uptimeMs)} · heartbeat age ${formatDuration(heartbeatAgeMs)}`
        : statusError || "desktop agent not connected",
      tone: status?.online ? "emerald" : "rose",
      icon: status?.online ? Wifi : WifiOff,
    },
    {
      label: "Runtime Runs",
      value: String(runtimeActiveRunCount),
      unit: "runs",
      detail: `${runningConversations.length} running conversations in history snapshot`,
      tone: runtimeActiveRunCount > 0 ? "violet" : "slate",
      icon: Radio,
    },
    {
      label: "History Index",
      value: compactNumber(history?.total_count ?? 0),
      unit: "conversations",
      detail: `loaded ${loadedConversationRows} rows · today sample ${todayConversationCount} · ${compactNumber(messageSampleCount)} msgs in loaded rows`,
      tone: "cyan",
      icon: History,
    },
    {
      label: "Public Tunnels",
      value: String(activeTunnels.length),
      unit: "active",
      detail: `${tunnels.length} tunnel records · ${totalTunnelConnections} active connections`,
      tone: activeTunnels.length > 0 ? "amber" : "slate",
      icon: Cloud,
    },
    {
      label: "Web Terminals",
      value: String(runningTerminals.length),
      unit: "running sessions",
      detail: `${terminals.length} total sessions · ${latestTerminal ? basename(latestTerminal.cwd) : "no cwd"}`,
      tone: runningTerminals.length > 0 ? "emerald" : "slate",
      icon: Terminal,
    },
    {
      label: "Active Models",
      value: String(activeModelCount),
      unit: "models",
      detail: `${activeProviders.length} active providers · ${configuredProviderCount} provider keys configured`,
      tone: "violet",
      icon: Sparkles,
    },
  ];

  if (!token) {
    return (
      <LoginPage
        token={loginToken}
        error={authError}
        isSubmitting={authSubmitting}
        onTokenChange={(nextToken) => {
          setLoginToken(nextToken);
          if (authError) {
            setAuthError(null);
          }
        }}
        onSubmit={submit}
      />
    );
  }

  return (
    <main
      className={cn(
        "status-dashboard-root dark relative grid h-100dvh min-h-0 w-100vw place-items-center overflow-hidden",
        "bg-[radial-gradient(circle_at_16%_15%,rgba(var(--status-cyan),0.18),transparent_25%),radial-gradient(circle_at_76%_18%,rgba(var(--status-violet),0.18),transparent_27%),radial-gradient(circle_at_56%_85%,rgba(var(--status-emerald),0.1),transparent_30%),linear-gradient(hsl(var(--background)),hsl(var(--background)))] font-app text-foreground",
        "before:pointer-events-none before:absolute before:inset-0 before:bg-[linear-gradient(rgba(var(--status-cyan),0.08)_var(--spacing-1px),transparent_var(--spacing-1px)),linear-gradient(90deg,rgba(var(--status-cyan),0.06)_var(--spacing-1px),transparent_var(--spacing-1px)),radial-gradient(circle_at_50%_50%,transparent_0_44%,rgba(var(--status-cyan),0.08)_45%,transparent_46%)] before:bg-[length:var(--spacing-48px)_var(--spacing-48px),var(--spacing-48px)_var(--spacing-48px),var(--spacing-620px)_var(--spacing-620px)]",
        "before:opacity-(--ui-opacity-0p9) before:[mask-image:radial-gradient(circle_at_50%_50%,color-mix(in_oklab,_var(--color-black)_94%,_transparent),transparent_78%)] before:content-['']",
      )}
    >
      <div
        className="pointer-events-none absolute inset-[-30%_-18%] bg-[conic-gradient(from_90deg_at_50%_50%,transparent,rgba(var(--status-cyan),0.16),transparent,rgba(var(--status-violet),0.16),transparent,rgba(var(--status-emerald),0.12),transparent),radial-gradient(circle_at_48%_46%,color-mix(in_oklab,_var(--color-white)_8%,_transparent),transparent_28%)] opacity-(--ui-opacity-0p95) blur-28px"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_26%,color-mix(in_oklab,_var(--color-white)_20%,_transparent)_0_var(--spacing-1px),transparent_var(--spacing-1px)),radial-gradient(circle_at_72%_62%,rgba(var(--status-cyan),0.18)_0_var(--spacing-1px),transparent_var(--spacing-1px)),radial-gradient(circle_at_46%_82%,rgba(var(--status-violet),0.16)_0_var(--spacing-1px),transparent_var(--spacing-1px))] bg-[length:var(--spacing-37px)_var(--spacing-37px),var(--spacing-61px)_var(--spacing-61px),var(--spacing-89px)_var(--spacing-89px)] opacity-(--ui-opacity-0p26) mix-blend-screen"
        aria-hidden="true"
      />
      <div
        className={cn(
          "pointer-events-none absolute top-[9%] left-[4%] size-220px",
          "rounded-full bg-[radial-gradient(circle,rgba(var(--status-cyan),0.3),transparent_64%)] opacity-(--ui-opacity-0p8) blur-2px",
        )}
        aria-hidden="true"
      />
      <div
        className={cn(
          "pointer-events-none absolute top-[11%] right-[8%] size-280px",
          "rounded-full bg-[radial-gradient(circle,rgba(var(--status-violet),0.26),transparent_66%)] opacity-(--ui-opacity-0p8) blur-2px",
        )}
        aria-hidden="true"
      />
      <div
        className={cn(
          "pointer-events-none absolute right-[18%] bottom-[-4%] size-340px",
          "rounded-full bg-[radial-gradient(circle,rgba(var(--status-emerald),0.16),transparent_68%)] opacity-(--ui-opacity-0p8) blur-2px",
        )}
        aria-hidden="true"
      />

      <section
        className={cn(
          "relative z-1 box-border grid grid-rows-status-board-stage gap-12px w-status-board-stage-w h-status-board-stage-h",
          "min-h-0 px-18px pt-14px pb-12px",
          "status-compact:w-100vw status-compact:h-100dvh status-compact:p-10px",
        )}
      >
        <header
          className={cn(
            "relative flex items-center justify-between gap-16px",
            "rounded-20px border border-[rgba(var(--status-cyan),0.2)] bg-[linear-gradient(90deg,rgba(var(--status-cyan),0.09),transparent_28%,rgba(var(--status-violet),0.09)),var(--ui-color-rgba-4-11-24-0p72)] px-12px py-9px shadow-[0_var(--spacing-18px)_var(--spacing-60px)_color-mix(in_oklab,_var(--color-black)_26%,_transparent),inset_0_var(--spacing-1px)_0_color-mix(in_oklab,_var(--color-white)_8%,_transparent),inset_0_0_var(--spacing-48px)_rgba(var(--status-cyan),0.05)] backdrop-blur-22px",
            "before:absolute before:inset-x-[22%] before:bottom-minus-1px before:h-1px before:bg-[linear-gradient(90deg,transparent,rgba(var(--status-cyan),0.82),transparent)] before:shadow-[0_0_var(--spacing-18px)_rgba(var(--status-cyan),0.72)] before:content-['']",
          )}
        >
          <div className="flex min-w-0 items-center gap-12px">
            <div
              className={cn(
                "flex size-38px flex-col place-items-center items-start gap-2px",
                "rounded-14px border border-[rgba(var(--status-cyan),0.3)] bg-[image:linear-gradient(135deg,rgba(var(--status-cyan),0.18),rgba(var(--status-violet),0.14)),color-mix(in_oklab,_var(--color-white)_6%,_transparent)] text-[rgb(var(--status-cyan))] shadow-[0_0_var(--spacing-28px)_rgba(var(--status-cyan),0.2),inset_0_0_var(--spacing-22px)_color-mix(in_oklab,_var(--color-white)_8%,_transparent)] backdrop-blur-18px",
              )}
            >
              <Sparkles size={19} strokeWidth={2.4} />
            </div>
            <div className="items-start flex-col gap-2px flex">
              <p className="m-0 text-muted-foreground text-tiny tracking-0p18em uppercase">
                LiveAgent Nexus
              </p>
              <h1 className="m-0 text-foreground tracking-minus-0p035em overflow-hidden max-w-360px text-2xl text-ellipsis whitespace-nowrap">
                实时遥测指挥舱
              </h1>
            </div>
          </div>
          <div className="absolute left-1/2 grid min-w-360px -translate-x-1/2 justify-items-center text-center [&>strong]:[text-shadow:0_0_var(--spacing-24px)_rgba(var(--status-cyan),0.42)]">
            <span className="text-muted-foreground text-tiny not-italic tracking-0p2em uppercase">
              1912×948 Telemetry Surface
            </span>
            <strong className="text-foreground text-2xl tracking-0p05em leading-none">
              {formatClock(now)}
            </strong>
            <em className="text-muted-foreground text-tiny not-italic tracking-0p2em uppercase">
              {snapshot.lastRefreshAt
                ? `sync age ${formatDuration(now - snapshot.lastRefreshAt)}`
                : "syncing snapshot"}
            </em>
          </div>
          <div className="flex items-center flex-nowrap justify-end gap-8px">
            <StatusPill
              online={status?.online === true}
              label={status?.online ? "Agent online" : "Agent offline"}
            />
            <Button
              type="button"
              variant="ghost"
              className={statusActionClass}
              onClick={() => setRefreshVersion((value) => value + 1)}
              disabled={snapshot.loading}
            >
              {snapshot.loading ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <RefreshCw size={15} />
              )}
              Sync
            </Button>
            <a className={statusActionClass} href="./" title="回到 Gateway 控制台">
              Console
              <ExternalLink size={14} />
            </a>
            <Button type="button" variant="ghost" className={statusActionClass} onClick={logout}>
              <LogOut size={15} />
              Exit
            </Button>
          </div>
        </header>

        {snapshot.error && (
          <div
            className={cn(
              "absolute top-82px right-24px z-6 flex max-w-540px items-center gap-9px",
              "border border-solid border-status-amber/30 rounded-16px px-12px py-9px",
              "bg-rgba-56-35-4-0p5 text-rgba-255-232-190-0p92 text-xs shadow-status-board-warning backdrop-blur-18px",
            )}
          >
            <AlertCircle size={16} />
            <span>{snapshot.error}</span>
          </div>
        )}

        <section className="grid grid-cols-status-board-cockpit gap-12px min-h-0 status-compact:grid-cols-status-board-cockpit-2 status-compact:gap-8px">
          <aside className="grid min-h-0 gap-12px grid-rows-status-board-left-rail status-compact:gap-8px">
            <StatusPanel>
              <StatusSectionHeader>
                <div>
                  <StatusLabel>Core Reactor</StatusLabel>
                  <StatusHeading>运行中枢</StatusHeading>
                </div>
                <Shield size={18} />
              </StatusSectionHeader>
              <div className="grid grid-cols-status-board-reactor-core items-center gap-14px mb-12px">
                <div
                  className={cn(
                    "relative grid size-154px place-items-center rounded-full shadow-[0_0_var(--spacing-46px)_rgba(var(--status-cyan),0.22),inset_0_0_var(--spacing-34px)_color-mix(in_oklab,_var(--color-black)_58%,_transparent)]",
                    "before:absolute before:inset-12px before:rounded-[inherit] before:bg-[radial-gradient(circle,color-mix(in_oklab,_var(--color-white)_12%,_transparent),transparent_42%),var(--ui-color-071226)] before:shadow-[inset_0_0_var(--spacing-28px)_rgba(var(--status-cyan),0.12)] before:content-['']",
                  )}
                  style={{
                    background: `conic-gradient(from -90deg, var(--color-status-integrity-start) 0deg, var(--color-status-integrity-end) ${integrityScore * 3.6}deg, var(--color-status-integrity-track) ${integrityScore * 3.6}deg 360deg)`,
                  }}
                >
                  <div className="absolute inset-minus-8px rounded-[inherit] border border-[rgba(var(--status-cyan),0.24)]" />
                  <div className="absolute inset-28px rounded-[inherit] border border-status-violet/28!" />
                  <div className="relative z-1 grid justify-items-center">
                    <strong className="text-5xl leading-0p92 tracking-minus-0p06em text-foreground [text-shadow:0_0_var(--spacing-30px)_rgba(var(--status-cyan),0.5)]">
                      {integrityScore}
                    </strong>
                    <span className="text-muted-foreground text-tiny not-italic tracking-0p12em uppercase">
                      derived %
                    </span>
                  </div>
                </div>
                <div className="min-w-0">
                  <span className="text-muted-foreground text-tiny not-italic tracking-0p12em uppercase">
                    Runtime: {runtimeState}
                  </span>
                  <strong className="block overflow-hidden my-7px mx-0 text-foreground text-lg text-ellipsis whitespace-nowrap">
                    {status?.agent_id ? truncateMiddle(status.agent_id, 24) : "等待 Agent 接入"}
                  </strong>
                  <em className="text-muted-foreground text-tiny not-italic tracking-0p12em uppercase">
                    我在监听 Gateway 心跳：
                    {status?.last_heartbeat
                      ? `${formatDuration(heartbeatAgeMs)} ago`
                      : "no heartbeat"}
                  </em>
                </div>
              </div>
              <FactList items={runtimeFacts} />
            </StatusPanel>

            <StatusPanel>
              <StatusSectionHeader>
                <div>
                  <StatusLabel>Gateway Fabric</StatusLabel>
                  <StatusHeading>能力矩阵</StatusHeading>
                </div>
                <Server size={18} />
              </StatusSectionHeader>
              <FactList items={fabricFacts} />
              <div
                className={cn(
                  "mt-10px grid grid-cols-2 gap-8px",
                  "[&>div]:min-w-0 [&>div]:rounded-14px [&>div]:border [&>div]:border-[rgba(var(--status-cyan),0.12)] [&>div]:bg-rgba-255-255-255-0p045 [&>div]:p-10px [&>div]:text-(--ui-color-rgba-226-242-255-0p7) [&>div>svg]:text-[rgba(var(--status-cyan),0.84)]",
                )}
              >
                <div>
                  <Globe2 size={17} />
                  <span className="text-muted-foreground text-tiny not-italic">Tunnels</span>
                  <strong className="block mt-5px text-foreground text-2xl leading-none">
                    {activeTunnels.length}
                  </strong>
                </div>
                <div>
                  <Terminal size={17} />
                  <span className="text-muted-foreground text-tiny not-italic">Terminals</span>
                  <strong className="block mt-5px text-foreground text-2xl leading-none">
                    {runningTerminals.length}
                  </strong>
                </div>
                <div>
                  <Brain size={17} />
                  <span className="text-muted-foreground text-tiny not-italic">Providers</span>
                  <strong className="block mt-5px text-foreground text-2xl leading-none">
                    {activeProviders.length}
                  </strong>
                </div>
                <div>
                  <Plug size={17} />
                  <span className="text-muted-foreground text-tiny not-italic">Remote</span>
                  <strong className="block mt-5px text-foreground text-2xl leading-none">
                    {settingsSnapshot ? `${remoteFeatureCount}/3` : "--"}
                  </strong>
                </div>
              </div>
            </StatusPanel>
          </aside>

          <section className="grid min-h-0 gap-12px grid-rows-status-board-center-stack status-compact:gap-8px">
            <StatusPanel>
              <StatusSectionHeader>
                <div>
                  <StatusLabel>Live Telemetry</StatusLabel>
                  <StatusHeading>系统数据雷达</StatusHeading>
                </div>
                <span>{eventsPerMinute.toFixed(1)} events/min</span>
              </StatusSectionHeader>

              <section className="grid gap-8px grid-cols-6 flex-none status-compact:grid-cols-3">
                {metrics.map((metric) => (
                  <MetricTile key={metric.label} metric={metric} />
                ))}
              </section>

              <div className="grid grid-cols-status-board-radar-deck items-center gap-14px min-h-0 flex-auto mt-12px">
                <div
                  className={cn(
                    "relative grid size-[min(var(--spacing-42vh),var(--spacing-410px))] place-items-center justify-self-center overflow-hidden",
                    "rounded-full border border-[rgba(var(--status-cyan),0.22)] bg-[radial-gradient(circle,rgba(var(--status-cyan),0.13),transparent_7%),repeating-radial-gradient(circle,transparent_0_var(--spacing-54px),rgba(var(--status-cyan),0.13)_var(--spacing-55px)_var(--spacing-56px)),radial-gradient(circle_at_center,var(--ui-color-rgba-7-17-33-0p4),var(--ui-color-rgba-2-7-15-0p92))] shadow-[0_0_var(--spacing-70px)_rgba(var(--status-cyan),0.16),inset_0_0_var(--spacing-70px)_rgba(var(--status-cyan),0.08)] status-compact:size-[min(var(--spacing-38vh),var(--spacing-320px))]",
                  )}
                  role="img"
                  aria-label="live signal radar"
                >
                  <div className="absolute inset-0 rounded-[inherit] bg-[linear-gradient(rgba(var(--status-cyan),0.12)_var(--spacing-1px),transparent_var(--spacing-1px)),linear-gradient(90deg,rgba(var(--status-cyan),0.12)_var(--spacing-1px),transparent_var(--spacing-1px))] bg-[length:var(--spacing-46px)_var(--spacing-46px)] opacity-(--ui-opacity-0p42) [mask-image:radial-gradient(circle,black_0_68%,transparent_69%)]" />
                  <div
                    className={cn(
                      "relative z-2 grid size-126px place-items-center",
                      "rounded-full border border-[rgba(var(--status-cyan),0.26)] bg-rgba-4-13-28-0p84 shadow-[0_0_var(--spacing-40px)_rgba(var(--status-cyan),0.23),inset_0_0_var(--spacing-26px)_rgba(var(--status-cyan),0.08)] [&>svg]:text-[rgba(var(--status-cyan),0.9)]",
                    )}
                  >
                    <Bot size={44} strokeWidth={1.65} />
                    <strong className="text-foreground text-4xl leading-0p8">
                      {runtimeActiveRunCount}
                    </strong>
                    <span className="text-muted-foreground text-tiny tracking-0p12em uppercase">
                      active runs
                    </span>
                  </div>
                  {throughputSegments.map((segment, index) => (
                    <span
                      key={segment.label}
                      className={cn(
                        "absolute z-3 size-10px rounded-full bg-[rgb(var(--status-board-tone))] shadow-[0_0_var(--spacing-20px)_rgba(var(--status-board-tone),0.82),0_0_var(--spacing-46px)_rgba(var(--status-board-tone),0.38)] [--status-board-tone:var(--status-cyan)]",
                        dashboardToneClass[segment.tone],
                      )}
                      style={{
                        transform: `rotate(${index * 72 - 18}deg) translateX(${118 + segment.width * 0.62}px)`,
                      }}
                    />
                  ))}
                </div>

                <div className="min-w-0">
                  <div className="mb-10px flex items-baseline justify-between">
                    <span className="text-muted-foreground text-xs tracking-0p18em uppercase">
                      Stream Load
                    </span>
                    <strong className="text-foreground text-lg">
                      {compactNumber(liveCounters.events)} events
                    </strong>
                  </div>
                  {throughputSegments.map((segment) => (
                    <div
                      key={segment.label}
                      className={cn(
                        "mb-8px grid grid-cols-[var(--spacing-112px)_minmax(0,1fr)_var(--spacing-92px)] items-center gap-9px [--status-board-tone:var(--status-cyan)]",
                        dashboardToneClass[segment.tone],
                      )}
                    >
                      <span className="text-muted-foreground text-xs not-italic">
                        {segment.label}
                      </span>
                      <div className="h-10px overflow-hidden rounded-full border border-[rgba(var(--status-board-tone),0.14)] bg-white/5">
                        <i
                          className="block h-full rounded-[inherit] bg-[linear-gradient(90deg,rgba(var(--status-board-tone),0.25),rgba(var(--status-board-tone),0.95))] shadow-[0_0_var(--spacing-16px)_rgba(var(--status-board-tone),0.44)]"
                          style={{ width: `${segment.width}%` }}
                        />
                      </div>
                      <em className="text-muted-foreground text-xs not-italic text-right">
                        {compactNumber(segment.value)} {segment.unit}
                      </em>
                    </div>
                  ))}
                  <FactList items={telemetryFacts} className="mt-10px grid-cols-4" />
                </div>
              </div>
            </StatusPanel>

            <StatusPanel className="pb-12px">
              <StatusSectionHeader>
                <div>
                  <StatusLabel>Event Stream</StatusLabel>
                  <StatusHeading>实时事件流</StatusHeading>
                </div>
                <MessageSquareText size={18} />
              </StatusSectionHeader>
              <div className="flex min-h-0 flex-auto flex-col gap-7px overflow-hidden">
                {recentEvents.length === 0 ? (
                  <EmptyState>
                    我还没收到实时事件；当 token、thinking 或 tool_call 抵达时，这里会亮起来。
                  </EmptyState>
                ) : (
                  recentEvents.slice(0, 6).map((event) => (
                    <article
                      key={event.id}
                      className={cn(
                        statusEntrySurfaceClass,
                        "grid grid-cols-[auto_minmax(0,1fr)] gap-9px rounded-14px px-9px py-8px [--status-board-tone:191,210,232]",
                        dashboardToneClass[event.tone],
                      )}
                    >
                      <span className="mt-5px size-8px rounded-full bg-status-board-tone shadow-status-board-event-dot" />
                      <div>
                        <div className="flex items-center justify-between gap-12px">
                          <strong className="block overflow-hidden text-foreground text-xs text-ellipsis whitespace-nowrap">
                            {event.title}
                          </strong>
                          <time className="text-muted-foreground text-tiny not-italic leading-1p25">
                            {formatClock(event.at)}
                          </time>
                        </div>
                        <p
                          className={cn(
                            "mx-0 mt-3px mb-0 line-clamp-1 overflow-hidden",
                            "text-tiny leading-1p25 text-muted-foreground not-italic",
                          )}
                        >
                          {event.detail}
                        </p>
                        {(event.conversationId || event.workdir) && (
                          <span
                            className={cn(
                              "text-rgba-190-219-248-0p58 text-tiny not-italic leading-1p25 inline-flex mt-4px rounded-full",
                              "px-6px py-2px bg-white/6",
                            )}
                          >
                            {event.workdir
                              ? basename(event.workdir)
                              : truncateMiddle(event.conversationId ?? "", 18)}
                          </span>
                        )}
                      </div>
                    </article>
                  ))
                )}
              </div>
            </StatusPanel>
          </section>

          <aside className="grid min-h-0 gap-12px grid-rows-status-board-right-rail status-compact:gap-8px">
            <StatusPanel>
              <StatusSectionHeader>
                <div>
                  <StatusLabel>Model Route</StatusLabel>
                  <StatusHeading>模型与任务</StatusHeading>
                </div>
                <Radio size={18} />
              </StatusSectionHeader>
              <FactList items={modelFacts} />
              <div className="flex min-h-0 flex-auto flex-col gap-7px overflow-hidden">
                {runningConversations.length === 0 ? (
                  <EmptyState>暂无运行中会话。</EmptyState>
                ) : (
                  runningConversations.slice(0, 4).map((item) => (
                    <article
                      key={item.id}
                      className={cn(
                        statusEntrySurfaceClass,
                        "grid grid-cols-[auto_minmax(0,1fr)] gap-9px rounded-14px px-9px py-8px [--status-board-tone:var(--status-violet)]",
                      )}
                    >
                      <div className="mt-5px size-8px flex-none rounded-full bg-status-board-tone shadow-status-board-event-dot" />
                      <div>
                        <strong className="block overflow-hidden text-foreground text-xs text-ellipsis whitespace-nowrap">
                          {truncateMiddle(item.title, 34)}
                        </strong>
                        <span className="text-muted-foreground text-tiny not-italic leading-1p25">
                          {item.cwd ? basename(item.cwd) : "默认空间"} · {item.messageCount}{" "}
                          messages · {formatDuration(now - item.updatedAt)} ago
                        </span>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </StatusPanel>

            <StatusPanel>
              <StatusSectionHeader>
                <div>
                  <StatusLabel>Workspace Heat</StatusLabel>
                  <StatusHeading>项目热力图</StatusHeading>
                </div>
                <HardDrive size={18} />
              </StatusSectionHeader>
              <div
                className={cn(
                  statusEntrySurfaceClass,
                  "mb-8px flex-none rounded-14px px-9px py-8px [--status-board-tone:var(--status-cyan)]",
                )}
              >
                <span className="block text-muted-foreground text-tiny tracking-0p12em uppercase">
                  Active Workspace
                </span>
                <strong
                  className={cn(
                    "inline-block overflow-hidden max-w-full mt-3px",
                    "text-foreground text-sm leading-1p12 text-ellipsis whitespace-nowrap",
                  )}
                  title={activeWorkspaceHint}
                >
                  {activeWorkspaceName}
                </strong>
                <em
                  className={cn(
                    "block overflow-hidden mt-3px text-muted-foreground text-tiny not-italic",
                    "leading-1p22 text-ellipsis whitespace-nowrap",
                  )}
                >
                  {activeWorkspaceHint}
                </em>
              </div>
              <div className="flex min-h-0 flex-auto flex-col gap-7px overflow-hidden">
                {workdirs.length === 0 ? (
                  <EmptyState>暂无项目维度历史。</EmptyState>
                ) : (
                  workdirs.slice(0, 6).map((item) => (
                    <article
                      key={item.path}
                      className={cn(
                        statusEntrySurfaceClass,
                        "grid grid-cols-[minmax(0,1fr)_var(--spacing-86px)_var(--spacing-82px)] items-center gap-9px rounded-14px px-9px py-8px",
                      )}
                    >
                      <div>
                        <strong className="block overflow-hidden text-foreground text-xs text-ellipsis whitespace-nowrap">
                          {basename(item.path)}
                        </strong>
                        <span className="text-muted-foreground text-tiny not-italic leading-1p25">
                          {truncateMiddle(item.path, 46)}
                        </span>
                      </div>
                      <div className="h-8px overflow-hidden rounded-full border border-[rgba(var(--status-cyan),0.12)] bg-white/5">
                        <span
                          className={cn(
                            "block h-full rounded-[inherit] bg-[linear-gradient(90deg,rgb(var(--status-cyan)),rgb(var(--status-violet)))] text-tiny leading-1p25 text-muted-foreground shadow-[0_0_var(--spacing-16px)_rgba(var(--status-cyan),0.34)]",
                            "not-italic",
                          )}
                          style={{
                            width: percentage(
                              ((item.conversationCount || 0) / maxWorkdirCount) * 100,
                            ),
                          }}
                        />
                      </div>
                      <em className="text-muted-foreground text-tiny not-italic leading-1p25 text-right">
                        {item.conversationCount} conversations
                      </em>
                    </article>
                  ))
                )}
              </div>
            </StatusPanel>
          </aside>
        </section>

        <footer
          className={cn(
            "flex flex-nowrap items-center justify-between gap-10px overflow-hidden",
            "rounded-14px border border-[rgba(var(--status-cyan),0.14)] bg-rgba-4-11-24-0p64 px-10px py-6px",
            "text-tiny text-muted-foreground backdrop-blur-16px",
          )}
        >
          <span className="inline-flex min-w-0 items-center gap-7px overflow-hidden text-ellipsis whitespace-nowrap">
            <CheckCircle2 size={14} />
            Sources: status.get / settings.get / history.list / terminal.list / tunnel.state /
            providers.list
          </span>
          <span className="inline-flex min-w-0 items-center gap-7px overflow-hidden text-ellipsis whitespace-nowrap">
            <Timer size={14} />
            Snapshot interval {SNAPSHOT_REFRESH_MS / 1000} s · realtime batch {LIVE_FLUSH_MS} ms
          </span>
          <span className="inline-flex min-w-0 items-center gap-7px overflow-hidden text-ellipsis whitespace-nowrap">
            <Wrench size={14} />
            Tool stream {compactNumber(liveCounters.toolCalls + liveCounters.toolResults)} events
          </span>
          <span className="inline-flex min-w-0 items-center gap-7px overflow-hidden text-ellipsis whitespace-nowrap">
            <Zap size={14} />
            /dashboard · {status?.session_id ? truncateMiddle(status.session_id, 18) : "no session"}
          </span>
        </footer>
      </section>
    </main>
  );
}
