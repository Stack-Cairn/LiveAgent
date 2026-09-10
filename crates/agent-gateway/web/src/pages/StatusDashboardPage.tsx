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
import { StatusPanel } from "../components/StatusPanel";
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
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(
    Math.max(0, value),
  );
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

function useNow(tickMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(timer);
  }, [tickMs]);
  return now;
}

function StatusPill({ online, label }: { online: boolean; label: string }) {
  return (
    <span
      className={cn(
        "flex items-center h-33px gap-7px border border-solid border-status-cyan/20 rounded-999px px-12px py-0 bg-rgba-255-255-255-0p055 text-rgba-233-245-255-0p84 text-11px no-underline uppercase whitespace-nowrap shadow-status-board-pill backdrop-blur-16px transition-[transform,border-color,background-color] duration-160ms ease-default",
        online ? "status-board-pill--online" : "status-board-pill--offline",
      )}
    >
      <span className="status-board-pill-dot size-8px rounded-999px" />
      {label}
    </span>
  );
}

function MetricTile({ metric }: { metric: MetricCard }) {
  const Icon = metric.icon;
  return (
    <section
      className={cn(
        "status-board-card status-board-metric relative overflow-hidden rounded-14px min-w-0 grid items-center gap-9px min-h-82px p-10px",
        `status-board-tone-${metric.tone}`,
      )}
    >
      <div className="status-board-metric-icon grid place-items-center size-34px rounded-12px">
        <Icon size={18} strokeWidth={2.2} />
      </div>
      <div>
        <StatusLabel>{metric.label}</StatusLabel>
        <strong className="inline-block mr-5px text-(--ui-color-ffffff) text-22px leading-none tracking-minus-0p04em">
          {metric.value}
        </strong>
        <em className="text-(--ui-color-rgba-190-218-246-0p58) text-10px not-italic uppercase">
          {metric.unit}
        </em>
        <span className="text-(--ui-color-rgba-190-218-246-0p58) text-10px not-italic block overflow-hidden mt-4px leading-1p25 text-ellipsis whitespace-nowrap">
          {metric.detail}
        </span>
      </div>
    </section>
  );
}

function EmptyState({ children }: { children: string }) {
  return (
    <div className="status-board-empty rounded-14px py-8px px-9px text-(--ui-color-rgba-190-219-248-0p58) text-10px not-italic leading-1p25">
      {children}
    </div>
  );
}

function FactList({ items }: { items: FactItem[] }) {
  return (
    <div className="status-board-fact-list grid grid-cols-2 gap-7px">
      {items.map((item) => (
        <div
          key={item.label}
          className={cn(
            "status-board-fact min-w-0 rounded-13px p-8px",
            item.tone && `status-board-fact--${item.tone}`,
          )}
        >
          <span className="block text-(--ui-color-rgba-192-220-248-0p56) text-9px tracking-0p12em uppercase">
            {item.label}
          </span>
          <strong
            className="inline-block overflow-hidden max-w-full mt-3px text-(--ui-color-rgba-255-255-255-0p94) text-13px leading-1p12 text-ellipsis whitespace-nowrap"
            title={item.value}
          >
            {item.value}
          </strong>
          {item.unit && (
            <b className="inline-block ml-5px text-9px font-medium uppercase">{item.unit}</b>
          )}
          {item.note && (
            <em
              className="block overflow-hidden mt-3px text-(--ui-color-rgba-186-213-242-0p58) text-10px not-italic leading-1p22 text-ellipsis whitespace-nowrap"
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
  const now = useNow();
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
    <main className="status-board-shell relative grid w-100vw h-100dvh min-h-0 place-items-center overflow-hidden text-(--status-text)">
      <div className="status-board-aurora absolute pointer-events-none" aria-hidden="true" />
      <div className="status-board-noise absolute pointer-events-none inset-0" aria-hidden="true" />
      <div
        className="status-board-orb status-board-orb--a absolute pointer-events-none rounded-999px size-220px"
        aria-hidden="true"
      />
      <div
        className="status-board-orb status-board-orb--b absolute pointer-events-none rounded-999px size-280px"
        aria-hidden="true"
      />
      <div
        className="status-board-orb status-board-orb--c absolute pointer-events-none rounded-999px size-340px"
        aria-hidden="true"
      />

      <section className="relative z-1 box-border grid grid-rows-status-board-stage gap-12px w-status-board-stage-w h-status-board-stage-h min-h-0 px-18px pt-14px pb-12px status-compact:w-100vw status-compact:h-100dvh status-compact:p-10px">
        <header className="status-board-command flex items-center relative justify-between gap-16px rounded-20px py-9px px-12px">
          <div className="status-board-brand min-w-0 gap-12px">
            <div className="status-board-logo animate-status-board-logo-hot items-start flex-col gap-2px flex place-items-center size-38px rounded-14px">
              <Sparkles size={19} strokeWidth={2.4} />
            </div>
            <div className="items-start flex-col gap-2px flex">
              <p className="m-0 text-(--ui-color-rgba-186-216-246-0p6) text-10px tracking-0p18em uppercase">
                LiveAgent Nexus
              </p>
              <h1 className="m-0 text-(--ui-color-rgba-255-255-255-0p96) tracking-minus-0p035em overflow-hidden max-w-360px text-23px text-ellipsis whitespace-nowrap">
                实时遥测指挥舱
              </h1>
            </div>
          </div>
          <div className="status-board-command-center absolute grid min-w-360px justify-items-center text-center">
            <span className="text-(--ui-color-rgba-181-213-244-0p58) text-10px not-italic tracking-0p2em uppercase">
              1912×948 Telemetry Surface
            </span>
            <strong className="text-(--ui-color-rgba-255-255-255-0p98) text-25px tracking-0p05em leading-none">
              {formatClock(now)}
            </strong>
            <em className="text-(--ui-color-rgba-181-213-244-0p58) text-10px not-italic tracking-0p2em uppercase">
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
              className="status-board-action-button"
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
            <a className="status-board-link-button" href="./" title="回到 Gateway 控制台">
              Console
              <ExternalLink size={14} />
            </a>
            <Button
              type="button"
              variant="ghost"
              className="status-board-action-button"
              onClick={logout}
            >
              <LogOut size={15} />
              Exit
            </Button>
          </div>
        </header>

        {snapshot.error && (
          <div className="absolute top-82px right-24px z-6 flex max-w-540px items-center gap-9px border border-solid border-status-amber/30 rounded-16px px-12px py-9px bg-rgba-56-35-4-0p5 text-rgba-255-232-190-0p92 text-12px shadow-status-board-warning backdrop-blur-18px">
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
                    "status-board-reactor relative grid size-154px place-items-center rounded-999px",
                    status?.online && "status-board-reactor--online",
                  )}
                  style={{
                    background: `conic-gradient(from -90deg, var(--color-status-integrity-start) 0deg, var(--color-status-integrity-end) ${integrityScore * 3.6}deg, var(--color-status-integrity-track) ${integrityScore * 3.6}deg 360deg)`,
                  }}
                >
                  <div className="status-board-reactor-ring inset-minus-8px animate-status-board-reactor-ring-a absolute rounded-[inherit]" />
                  <div className="status-board-reactor-ring inset-28px border-status-violet/28! animate-status-board-reactor-ring-b absolute rounded-[inherit]" />
                  <div className="status-board-reactor-number relative z-1 grid justify-items-center">
                    <strong className="text-(--ui-color-ffffff) text-46px leading-0p92 tracking-minus-0p06em">
                      {integrityScore}
                    </strong>
                    <span className="text-(--status-muted) text-10px not-italic tracking-0p12em uppercase">
                      derived %
                    </span>
                  </div>
                </div>
                <div className="status-board-reactor-copy min-w-0">
                  <span className="text-(--status-muted) text-10px not-italic tracking-0p12em uppercase">
                    Runtime: {runtimeState}
                  </span>
                  <strong className="block overflow-hidden my-7px mx-0 text-(--ui-color-rgba-255-255-255-0p94) text-17px text-ellipsis whitespace-nowrap">
                    {status?.agent_id ? truncateMiddle(status.agent_id, 24) : "等待 Agent 接入"}
                  </strong>
                  <em className="text-(--status-muted) text-10px not-italic tracking-0p12em uppercase">
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
              <div className="status-board-mini-grid--matrix grid gap-8px grid-cols-2 mt-10px">
                <div className="status-board-mini-card min-w-0 rounded-14px p-10px text-(--ui-color-rgba-226-242-255-0p7)">
                  <Globe2 size={17} />
                  <span className="text-(--ui-color-rgba-190-218-246-0p58) text-10px not-italic">
                    Tunnels
                  </span>
                  <strong className="block mt-5px text-(--ui-color-ffffff) text-23px leading-none">
                    {activeTunnels.length}
                  </strong>
                </div>
                <div className="status-board-mini-card min-w-0 rounded-14px p-10px text-(--ui-color-rgba-226-242-255-0p7)">
                  <Terminal size={17} />
                  <span className="text-(--ui-color-rgba-190-218-246-0p58) text-10px not-italic">
                    Terminals
                  </span>
                  <strong className="block mt-5px text-(--ui-color-ffffff) text-23px leading-none">
                    {runningTerminals.length}
                  </strong>
                </div>
                <div className="status-board-mini-card min-w-0 rounded-14px p-10px text-(--ui-color-rgba-226-242-255-0p7)">
                  <Brain size={17} />
                  <span className="text-(--ui-color-rgba-190-218-246-0p58) text-10px not-italic">
                    Providers
                  </span>
                  <strong className="block mt-5px text-(--ui-color-ffffff) text-23px leading-none">
                    {activeProviders.length}
                  </strong>
                </div>
                <div className="status-board-mini-card min-w-0 rounded-14px p-10px text-(--ui-color-rgba-226-242-255-0p7)">
                  <Plug size={17} />
                  <span className="text-(--ui-color-rgba-190-218-246-0p58) text-10px not-italic">
                    Remote
                  </span>
                  <strong className="block mt-5px text-(--ui-color-ffffff) text-23px leading-none">
                    {settingsSnapshot ? `${remoteFeatureCount}/3` : "--"}
                  </strong>
                </div>
              </div>
            </StatusPanel>
          </aside>

          <section className="grid min-h-0 gap-12px grid-rows-status-board-center-stack status-compact:gap-8px">
            <StatusPanel className="status-board-radar-panel">
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
                  className="status-board-radar-screen relative grid place-items-center justify-self-center overflow-hidden rounded-999px"
                  role="img"
                  aria-label="live signal radar"
                >
                  <div className="status-board-radar-grid absolute inset-0 rounded-[inherit]" />
                  <div className="status-board-radar-sweep absolute inset-0 rounded-[inherit]" />
                  <div className="status-board-radar-core relative grid size-126px place-items-center rounded-999px">
                    <Bot size={44} strokeWidth={1.65} />
                    <strong className="text-(--ui-color-ffffff) text-36px leading-0p8">
                      {runtimeActiveRunCount}
                    </strong>
                    <span className="text-(--status-muted) text-9px tracking-0p12em uppercase">
                      active runs
                    </span>
                  </div>
                  {throughputSegments.map((segment, index) => (
                    <span
                      key={segment.label}
                      className={cn(
                        "status-board-radar-node absolute size-10px rounded-999px",
                        `status-board-tone-${segment.tone}`,
                      )}
                      style={{
                        transform: `rotate(${index * 72 - 18}deg) translateX(${118 + segment.width * 0.62}px)`,
                      }}
                    />
                  ))}
                </div>

                <div className="min-w-0">
                  <div className="status-board-throughput-head flex items-baseline justify-between mb-10px">
                    <span className="text-(--status-muted) text-11px tracking-0p18em uppercase">
                      Stream Load
                    </span>
                    <strong className="text-(--ui-color-rgba-255-255-255-0p95) text-18px">
                      {compactNumber(liveCounters.events)} events
                    </strong>
                  </div>
                  {throughputSegments.map((segment) => (
                    <div
                      key={segment.label}
                      className={cn(
                        "status-board-load-row grid items-center gap-9px mb-8px",
                        `status-board-tone-${segment.tone}`,
                      )}
                    >
                      <span className="text-(--ui-color-rgba-211-232-255-0p66) text-11px not-italic">
                        {segment.label}
                      </span>
                      <div className="h-10px overflow-hidden rounded-999px">
                        <i
                          className="block h-full rounded-[inherit]"
                          style={{ width: `${segment.width}%` }}
                        />
                      </div>
                      <em className="text-(--ui-color-rgba-211-232-255-0p66) text-11px not-italic text-right">
                        {compactNumber(segment.value)} {segment.unit}
                      </em>
                    </div>
                  ))}
                  <FactList items={telemetryFacts} />
                </div>
              </div>
            </StatusPanel>

            <StatusPanel className="status-board-stream-panel pb-12px">
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
                        "status-board-event rounded-14px py-8px px-9px grid gap-9px",
                        `status-board-tone-${event.tone}`,
                      )}
                    >
                      <span className="size-8px mt-5px rounded-999px bg-status-board-tone shadow-status-board-event-dot animate-status-board-event-dot" />
                      <div>
                        <div className="status-board-event-title-row flex items-center justify-between gap-12px">
                          <strong className="block overflow-hidden text-(--ui-color-rgba-255-255-255-0p92) text-12px text-ellipsis whitespace-nowrap">
                            {event.title}
                          </strong>
                          <time className="text-(--ui-color-rgba-190-219-248-0p58) text-10px not-italic leading-1p25">
                            {formatClock(event.at)}
                          </time>
                        </div>
                        <p className="text-(--ui-color-rgba-190-219-248-0p58) text-10px not-italic leading-1p25 overflow-hidden mt-3px mx-0 mb-0">
                          {event.detail}
                        </p>
                        {(event.conversationId || event.workdir) && (
                          <span className="text-rgba-190-219-248-0p58 text-10px not-italic leading-1p25 inline-flex mt-4px rounded-999px px-6px py-2px bg-rgba-255-255-255-0p06">
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
                      className="status-board-running-item grid grid-cols-[auto_minmax(0,1fr)] gap-9px rounded-14px py-8px px-9px"
                    >
                      <div className="status-board-running-dot size-8px mt-5px rounded-999px flex-none" />
                      <div>
                        <strong className="block overflow-hidden text-(--ui-color-rgba-255-255-255-0p92) text-12px text-ellipsis whitespace-nowrap">
                          {truncateMiddle(item.title, 34)}
                        </strong>
                        <span className="text-(--ui-color-rgba-190-219-248-0p58) text-10px not-italic leading-1p25">
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
              <div className="status-board-active-workspace rounded-14px py-8px px-9px flex-none mb-8px">
                <span className="block text-(--ui-color-rgba-192-220-248-0p56) text-9px tracking-0p12em uppercase">
                  Active Workspace
                </span>
                <strong
                  className="inline-block overflow-hidden max-w-full mt-3px text-(--ui-color-rgba-255-255-255-0p94) text-13px leading-1p12 text-ellipsis whitespace-nowrap"
                  title={activeWorkspaceHint}
                >
                  {activeWorkspaceName}
                </strong>
                <em className="block overflow-hidden mt-3px text-(--ui-color-rgba-186-213-242-0p58) text-10px not-italic leading-1p22 text-ellipsis whitespace-nowrap">
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
                      className="status-board-workdir rounded-14px py-8px px-9px grid items-center gap-9px"
                    >
                      <div>
                        <strong className="block overflow-hidden text-(--ui-color-rgba-255-255-255-0p92) text-12px text-ellipsis whitespace-nowrap">
                          {basename(item.path)}
                        </strong>
                        <span className="text-(--ui-color-rgba-190-219-248-0p58) text-10px not-italic leading-1p25">
                          {truncateMiddle(item.path, 46)}
                        </span>
                      </div>
                      <div className="status-board-workdir-meter h-8px overflow-hidden rounded-999px">
                        <span
                          className="text-(--ui-color-rgba-190-219-248-0p58) text-10px not-italic leading-1p25 block h-full rounded-[inherit]"
                          style={{
                            width: percentage(
                              ((item.conversationCount || 0) / maxWorkdirCount) * 100,
                            ),
                          }}
                        />
                      </div>
                      <em className="text-(--ui-color-rgba-190-219-248-0p58) text-10px not-italic leading-1p25 text-right">
                        {item.conversationCount} conversations
                      </em>
                    </article>
                  ))
                )}
              </div>
            </StatusPanel>
          </aside>
        </section>

        <footer className="status-board-footer flex-nowrap justify-between gap-10px overflow-hidden rounded-14px py-6px px-10px text-(--ui-color-rgba-198-225-250-0p62) text-10px">
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
