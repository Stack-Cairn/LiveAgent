import { useEffect, useMemo, useRef, useState } from "react";

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
  type IconComponent,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { normalizeGatewayAccessToken, verifyGatewayAccessToken } from "@/lib/gatewayAuth";
import {
  getGatewayWebSocketClient,
  resetGatewayWebSocketClient,
  type GatewayWebSocketClientLike,
  type TunnelSummary,
} from "@/lib/gatewaySocket";
import type {
  AgentStatus,
  ChatEvent,
  ConversationSummary,
  GatewayProviderSummary,
  HistoryList,
  HistoryWorkdirSummary,
} from "@/lib/gatewayTypes";
import { cn } from "@/lib/shared/utils";
import type { GatewaySettingsSyncPayload } from "@/lib/settings/sync";
import { clearToken, loadToken, saveToken } from "@/lib/storage";
import type { TerminalSession } from "@/lib/terminal/types";
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
const TOKEN_EVENT_MIN_INTERVAL_MS = 1_200;
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

function formatDateTime(ms: number) {
  if (!ms) {
    return "未知";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
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
  const runningIds = new Set<string>();
  for (const id of history.running_conversation_ids ?? []) {
    if (id.trim()) {
      runningIds.add(id.trim());
    }
  }
  for (const item of history.running_conversations ?? []) {
    if (item.conversation_id.trim()) {
      runningIds.add(item.conversation_id.trim());
    }
  }
  return Array.from(runningIds).map((id) => {
    const conversation = byId.get(id);
    const runtime = history.running_conversations?.find((item) => item.conversation_id === id);
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

function updateHistoryListWithEvent(history: HistoryList | null, event: any): HistoryList | null {
  if (!history) {
    return history;
  }
  const conversationId = typeof event.conversation_id === "string" ? event.conversation_id.trim() : "";
  if (!conversationId) {
    return history;
  }

  if (event.kind === "delete") {
    return {
      ...history,
      total_count: Math.max(0, history.total_count - 1),
      conversations: history.conversations.filter((item) => item.id !== conversationId),
      running_conversation_ids: (history.running_conversation_ids ?? []).filter((id) => id !== conversationId),
      running_conversations: (history.running_conversations ?? []).filter(
        (item) => item.conversation_id !== conversationId,
      ),
    };
  }

  if (event.kind === "running" || event.kind === "idle") {
    const currentIds = new Set(history.running_conversation_ids ?? []);
    if (event.kind === "running") {
      currentIds.add(conversationId);
    } else {
      currentIds.delete(conversationId);
    }
    return {
      ...history,
      running_conversation_ids: Array.from(currentIds),
      running_conversations: (history.running_conversations ?? []).filter((item) => {
        if (item.conversation_id !== conversationId) {
          return true;
        }
        return event.kind === "running";
      }),
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

function classifyChatEvent(event: ChatEvent) {
  const type = String(event.type);
  switch (type) {
    case "token":
      return { tone: "cyan" as const, title: "Token 流" };
    case "thinking":
      return { tone: "violet" as const, title: "推理脉冲" };
    case "tool_call":
      return { tone: "amber" as const, title: "工具调用" };
    case "tool_result": {
      const isError = "isError" in event && event.isError === true;
      return { tone: isError ? ("rose" as const) : ("emerald" as const), title: "工具回传" };
    }
    case "hosted_search":
      return { tone: "cyan" as const, title: "联网检索" };
    case "tool_status":
      return { tone: "slate" as const, title: "工具状态" };
    case "done":
    case "completed":
      return { tone: "emerald" as const, title: "会话完成" };
    case "error":
    case "failed":
      return { tone: "rose" as const, title: "异常事件" };
    case "accepted":
    case "delivered":
    case "claimed":
    case "starting":
    case "started":
    case "progress":
      return { tone: "violet" as const, title: "调度推进" };
    case "cancelled":
      return { tone: "amber" as const, title: "任务取消" };
    default:
      return { tone: "slate" as const, title: "实时事件" };
  }
}

function getToolName(event: ChatEvent) {
  if ("name" in event && typeof event.name === "string" && event.name.trim()) {
    return event.name.trim();
  }
  if ("id" in event && typeof event.id === "string" && event.id.trim()) {
    return event.id.trim();
  }
  return "system tool";
}

function summarizeChatEvent(event: ChatEvent): DashboardEvent | null {
  const type = String(event.type);
  const classified = classifyChatEvent(event);
  let detail = "";

  if (type === "token") {
    detail = "模型正在输出 token chunk。";
  } else if (type === "thinking") {
    const text = "text" in event && typeof event.text === "string" ? event.text.trim() : "";
    detail = text ? truncateMiddle(text.replace(/\s+/g, " "), 80) : "模型正在整理推理上下文。";
  } else if (type === "tool_call") {
    detail = `${getToolName(event)} 已发起调用。`;
  } else if (type === "tool_result") {
    const isError = "isError" in event && event.isError === true;
    detail = `${getToolName(event)} ${isError ? "返回异常" : "返回结果"}。`;
  } else if (type === "hosted_search") {
    const queries = "queries" in event && Array.isArray(event.queries) ? event.queries : [];
    detail = queries.length ? truncateMiddle(queries.join(" / "), 80) : "联网检索通道产生事件。";
  } else if (type === "tool_status") {
    const statusText = "status" in event && typeof event.status === "string" ? event.status.trim() : "";
    detail = statusText || "工具链状态更新。";
  } else if (type === "error" || type === "failed") {
    detail = "message" in event && typeof event.message === "string" ? event.message : "执行出现异常。";
  } else if (type === "done" || type === "completed") {
    detail = "一段会话工作流完成。";
  } else if ("message" in event && typeof event.message === "string" && event.message.trim()) {
    detail = event.message.trim();
  } else {
    detail = `事件类型：${type}`;
  }

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: Date.now(),
    title: classified.title,
    detail: truncateMiddle(detail, 112),
    tone: classified.tone,
    conversationId: event.conversation_id,
    workdir: event.workdir,
  };
}

function addPendingCounters(target: PendingCounters, event: ChatEvent) {
  const type = String(event.type);
  target.events += 1;
  if (type === "token") {
    target.tokenChunks += 1;
    const text = "text" in event && typeof event.text === "string" ? event.text : "";
    target.tokenChars += text.length;
  } else if (type === "thinking") {
    target.thinking += 1;
  } else if (type === "tool_call") {
    target.toolCalls += 1;
  } else if (type === "tool_result") {
    target.toolResults += 1;
  } else if (type === "hosted_search") {
    target.searches += 1;
  } else if (type === "done" || type === "completed") {
    target.completions += 1;
  } else if (type === "error" || type === "failed") {
    target.errors += 1;
  }
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
    <span className={cn("status-board-pill", online ? "status-board-pill--online" : "status-board-pill--offline")}>
      <span className="status-board-pill-dot" />
      {label}
    </span>
  );
}

function MetricTile({ metric }: { metric: MetricCard }) {
  const Icon = metric.icon;
  return (
    <section className={cn("status-board-card status-board-metric", `status-board-tone-${metric.tone}`)}>
      <div className="status-board-metric-icon">
        <Icon size={18} strokeWidth={2.2} />
      </div>
      <div>
        <p className="status-board-label">{metric.label}</p>
        <strong>{metric.value}</strong>
        <em>{metric.unit}</em>
        <span>{metric.detail}</span>
      </div>
    </section>
  );
}

function EmptyState({ children }: { children: string }) {
  return <div className="status-board-empty">{children}</div>;
}

function FactList({ items }: { items: FactItem[] }) {
  return (
    <div className="status-board-fact-list">
      {items.map((item) => (
        <div key={item.label} className={cn("status-board-fact", item.tone && `status-board-fact--${item.tone}`)}>
          <span>{item.label}</span>
          <strong title={item.value}>{item.value}</strong>
          {item.unit && <b>{item.unit}</b>}
          {item.note && <em title={item.note}>{item.note}</em>}
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
  const { token, loginToken, authSubmitting, authError, setLoginToken, setAuthError, submit, logout } =
    useDashboardAuth();
  const api = useMemo(() => (token ? getGatewayWebSocketClient(token) : null), [token]);
  const pendingEventsRef = useRef<DashboardEvent[]>([]);
  const pendingCountersRef = useRef<PendingCounters>(initialPendingCounters());
  const lastTokenEventAtRef = useRef(0);

  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryList | null>(null);
  const [workdirs, setWorkdirs] = useState<HistoryWorkdirSummary[]>([]);
  const [tunnels, setTunnels] = useState<TunnelSummary[]>([]);
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
        setRecentEvents((current) => [...nextEvents.reverse(), ...current].slice(0, MAX_RECENT_EVENTS));
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

    return () => {
      unsubscribeStatus();
      unsubscribeHistory();
      unsubscribeTerminal();
      unsubscribeSettings();
    };
  }, [api]);

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
        tunnelsResult,
        terminalsResult,
        providersResult,
        settingsResult,
      ] = await Promise.all([
        runSnapshotRequest(currentApi.getStatus()),
        runSnapshotRequest(currentApi.listHistory(1, HISTORY_PAGE_SIZE)),
        runSnapshotRequest(currentApi.listHistoryWorkdirs()),
        runSnapshotRequest(currentApi.listTunnels()),
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
      if (tunnelsResult.ok) {
        setTunnels(tunnelsResult.value);
      } else {
        errors.push(asErrorMessage(tunnelsResult.error, "公网通道读取失败"));
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
  const activeTunnels = useMemo(
    () => tunnels.filter((item) => item.status === "active" && (!item.expiresAt || item.expiresAt > now)),
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
    () => (history?.conversations ?? []).reduce((total, item) => total + (item.message_count || 0), 0),
    [history],
  );
  const todayConversationCount = useMemo(() => {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return (history?.conversations ?? []).filter((item) => normalizeEpochMs(item.created_at) >= start.getTime()).length;
  }, [history, now]);
  const runtimeState = formatRuntimeState(status);
  const runtimeHeartbeatAgeMs = status?.runtime_last_heartbeat ? now - normalizeEpochMs(status.runtime_last_heartbeat) : 0;
  const runtimeActiveRunCount = status?.runtime_active_run_count ?? runningConversations.length;
  const totalTunnelConnections = activeTunnels.reduce((sum, item) => sum + item.activeConnections, 0);
  const activeWorkspaceProjects = settingsSnapshot?.system.workspaceProjects ?? [];
  const activeWorkspaceProject =
    activeWorkspaceProjects.find((project) => project.id === settingsSnapshot?.system.activeWorkspaceProjectId) ??
    activeWorkspaceProjects[0];
  const selectedModel = settingsSnapshot?.selectedModel ?? null;
  const selectedProvider = selectedModel
    ? providers.find((provider) => provider.id === selectedModel.customProviderId) ??
      settingsSnapshot?.customProviders.find((provider) => provider.id === selectedModel.customProviderId)
    : undefined;
  const selectedProviderName = selectedProvider?.name?.trim() || selectedModel?.customProviderId || "--";
  const selectedProviderType = selectedProvider?.type || "--";
  const selectedModelConfig = selectedProvider?.models?.find((model) => model.id === selectedModel?.model);
  const enabledCronCount = settingsSnapshot?.cron.filter((task) => task.enabled).length ?? 0;
  const enabledHookCount = settingsSnapshot?.hooks.filter((hook) => hook.enabled).length ?? 0;
  const enabledMcpCount = settingsSnapshot?.mcp.servers.filter((server) => server.enabled).length ?? 0;
  const configuredProviderCount = settingsSnapshot?.customProviders.filter((provider) => provider.apiKeyConfigured).length ?? 0;
  const selectedSkillCount = settingsSnapshot?.skills.enabled ? settingsSnapshot.skills.selected.length : 0;
  const remoteFeatureCount = settingsSnapshot?.remote
    ? [
        settingsSnapshot.remote.enableWebTerminal,
        settingsSnapshot.remote.enableWebGit,
        settingsSnapshot.remote.enableWebTunnels,
      ].filter(Boolean).length
    : 0;
  const latestTerminal = runningTerminals[0] ?? terminals[0];
  const activeWorkspaceName =
    activeWorkspaceProject?.name?.trim() || (activeWorkspaceProject?.path ? basename(activeWorkspaceProject.path) : "--");
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
  const toLoadWidth = (value: number) => Math.max(value > 0 ? 12 : 4, Math.round((value / maxLoadValue) * 100));
  const throughputSegments: LoadSegment[] = [
    { label: "Token Chunks", value: liveCounters.tokenChunks, unit: "chunks", width: toLoadWidth(liveCounters.tokenChunks), tone: "cyan" },
    { label: "Reasoning", value: liveCounters.thinking, unit: "events", width: toLoadWidth(liveCounters.thinking), tone: "violet" },
    { label: "Tool I/O", value: liveCounters.toolCalls + liveCounters.toolResults, unit: "events", width: toLoadWidth(liveCounters.toolCalls + liveCounters.toolResults), tone: "amber" },
    { label: "Web Search", value: liveCounters.searches, unit: "events", width: toLoadWidth(liveCounters.searches), tone: "emerald" },
    { label: "Errors", value: liveCounters.errors, unit: "events", width: toLoadWidth(liveCounters.errors), tone: "rose" },
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
      note: status?.runtime_active_run_count !== undefined ? "runtime_active_run_count" : "history running fallback",
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
      value: selectedModelConfig?.contextWindow ? compactNumber(selectedModelConfig.contextWindow) : "--",
      unit: "tokens",
      note: selectedModelConfig?.maxOutputToken ? `${compactNumber(selectedModelConfig.maxOutputToken)} max output tokens` : "model config",
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
      value: settingsSnapshot ? `${enabledCronCount}/${settingsSnapshot.cron.length}` : "--",
      unit: "enabled/total",
      tone: enabledCronCount > 0 ? "amber" : "slate",
    },
    {
      label: "Hooks",
      value: settingsSnapshot ? `${enabledHookCount}/${settingsSnapshot.hooks.length}` : "--",
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
      detail: status?.online ? `uptime ${formatDuration(uptimeMs)} · heartbeat age ${formatDuration(heartbeatAgeMs)}` : statusError || "desktop agent not connected",
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
    <main className="status-board-shell">
      <div className="status-board-aurora" aria-hidden="true" />
      <div className="status-board-noise" aria-hidden="true" />
      <div className="status-board-orb status-board-orb--a" aria-hidden="true" />
      <div className="status-board-orb status-board-orb--b" aria-hidden="true" />
      <div className="status-board-orb status-board-orb--c" aria-hidden="true" />

      <section className="status-board-stage">
        <header className="status-board-header status-board-command">
          <div className="status-board-brand">
            <div className="status-board-logo status-board-logo--hot">
              <Sparkles size={19} strokeWidth={2.4} />
            </div>
            <div>
              <p>LiveAgent Nexus</p>
              <h1>实时遥测指挥舱</h1>
            </div>
          </div>
          <div className="status-board-command-center">
            <span>1912×948 Telemetry Surface</span>
            <strong>{formatClock(now)}</strong>
            <em>{snapshot.lastRefreshAt ? `sync age ${formatDuration(now - snapshot.lastRefreshAt)}` : "syncing snapshot"}</em>
          </div>
          <div className="status-board-actions">
            <StatusPill online={status?.online === true} label={status?.online ? "Agent online" : "Agent offline"} />
            <Button
              type="button"
              variant="ghost"
              className="status-board-action-button"
              onClick={() => setRefreshVersion((value) => value + 1)}
              disabled={snapshot.loading}
            >
              {snapshot.loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Sync
            </Button>
            <a className="status-board-link-button" href="./" title="回到 Gateway 控制台">
              Console
              <ExternalLink size={14} />
            </a>
            <Button type="button" variant="ghost" className="status-board-action-button" onClick={logout}>
              <LogOut size={15} />
              Exit
            </Button>
          </div>
        </header>

        {snapshot.error && (
          <div className="status-board-warning">
            <AlertCircle size={16} />
            <span>{snapshot.error}</span>
          </div>
        )}

        <section className="status-board-cockpit">
          <aside className="status-board-left-rail">
            <section className="status-board-card status-board-panel status-board-reactor-panel">
              <div className="status-board-section-head">
                <div>
                  <p className="status-board-label">Core Reactor</p>
                  <h3>运行中枢</h3>
                </div>
                <Shield size={18} />
              </div>
              <div className="status-board-reactor-core">
                <div
                  className={cn("status-board-reactor", status?.online && "status-board-reactor--online")}
                  style={{
                    background: `conic-gradient(from -90deg, rgba(41, 255, 214, 0.96) 0deg, rgba(20, 184, 255, 0.96) ${integrityScore * 3.6}deg, rgba(30, 39, 68, 0.88) ${integrityScore * 3.6}deg 360deg)`,
                  }}
                >
                  <div className="status-board-reactor-ring status-board-reactor-ring--a" />
                  <div className="status-board-reactor-ring status-board-reactor-ring--b" />
                  <div className="status-board-reactor-number">
                    <strong>{integrityScore}</strong>
                    <span>derived %</span>
                  </div>
                </div>
                <div className="status-board-reactor-copy">
                  <span>Runtime: {runtimeState}</span>
                  <strong>{status?.agent_id ? truncateMiddle(status.agent_id, 24) : "等待 Agent 接入"}</strong>
                  <em>我在监听 Gateway 心跳：{status?.last_heartbeat ? `${formatDuration(heartbeatAgeMs)} ago` : "no heartbeat"}</em>
                </div>
              </div>
              <FactList items={runtimeFacts} />
            </section>

            <section className="status-board-card status-board-panel status-board-fabric-panel">
              <div className="status-board-section-head">
                <div>
                  <p className="status-board-label">Gateway Fabric</p>
                  <h3>能力矩阵</h3>
                </div>
                <Server size={18} />
              </div>
              <FactList items={fabricFacts} />
              <div className="status-board-mini-grid status-board-mini-grid--matrix">
                <div className="status-board-mini-card">
                  <Globe2 size={17} />
                  <span>Tunnels</span>
                  <strong>{activeTunnels.length}</strong>
                </div>
                <div className="status-board-mini-card">
                  <Terminal size={17} />
                  <span>Terminals</span>
                  <strong>{runningTerminals.length}</strong>
                </div>
                <div className="status-board-mini-card">
                  <Brain size={17} />
                  <span>Providers</span>
                  <strong>{activeProviders.length}</strong>
                </div>
                <div className="status-board-mini-card">
                  <Plug size={17} />
                  <span>Remote</span>
                  <strong>{settingsSnapshot ? `${remoteFeatureCount}/3` : "--"}</strong>
                </div>
              </div>
            </section>
          </aside>

          <section className="status-board-center-stack">
            <section className="status-board-card status-board-panel status-board-radar-panel">
              <div className="status-board-section-head">
                <div>
                  <p className="status-board-label">Live Telemetry</p>
                  <h3>系统数据雷达</h3>
                </div>
                <span>{eventsPerMinute.toFixed(1)} events/min</span>
              </div>

              <section className="status-board-metrics-grid">
                {metrics.map((metric) => (
                  <MetricTile key={metric.label} metric={metric} />
                ))}
              </section>

              <div className="status-board-radar-deck">
                <div className="status-board-radar-screen" aria-label="live signal radar">
                  <div className="status-board-radar-grid" />
                  <div className="status-board-radar-sweep" />
                  <div className="status-board-radar-core">
                    <Bot size={44} strokeWidth={1.65} />
                    <strong>{runtimeActiveRunCount}</strong>
                    <span>active runs</span>
                  </div>
                  {throughputSegments.map((segment, index) => (
                    <span
                      key={segment.label}
                      className={cn("status-board-radar-node", `status-board-tone-${segment.tone}`)}
                      style={{ transform: `rotate(${index * 72 - 18}deg) translateX(${118 + segment.width * 0.62}px)` }}
                    />
                  ))}
                </div>

                <div className="status-board-throughput">
                  <div className="status-board-throughput-head">
                    <span>Stream Load</span>
                    <strong>{compactNumber(liveCounters.events)} events</strong>
                  </div>
                  {throughputSegments.map((segment) => (
                    <div key={segment.label} className={cn("status-board-load-row", `status-board-tone-${segment.tone}`)}>
                      <span>{segment.label}</span>
                      <div>
                        <i style={{ width: `${segment.width}%` }} />
                      </div>
                      <em>
                        {compactNumber(segment.value)} {segment.unit}
                      </em>
                    </div>
                  ))}
                  <FactList items={telemetryFacts} />
                </div>
              </div>
            </section>

            <section className="status-board-card status-board-panel status-board-stream-panel">
              <div className="status-board-section-head">
                <div>
                  <p className="status-board-label">Event Stream</p>
                  <h3>实时事件流</h3>
                </div>
                <MessageSquareText size={18} />
              </div>
              <div className="status-board-event-list">
                {recentEvents.length === 0 ? (
                  <EmptyState>我还没收到实时事件；当 token、thinking 或 tool_call 抵达时，这里会亮起来。</EmptyState>
                ) : (
                  recentEvents.slice(0, 6).map((event) => (
                    <article key={event.id} className={cn("status-board-event", `status-board-tone-${event.tone}`)}>
                      <span className="status-board-event-dot" />
                      <div>
                        <div className="status-board-event-title-row">
                          <strong>{event.title}</strong>
                          <time>{formatClock(event.at)}</time>
                        </div>
                        <p>{event.detail}</p>
                        {(event.conversationId || event.workdir) && (
                          <span className="status-board-event-meta">
                            {event.workdir ? basename(event.workdir) : truncateMiddle(event.conversationId ?? "", 18)}
                          </span>
                        )}
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          </section>

          <aside className="status-board-right-rail">
            <section className="status-board-card status-board-panel status-board-model-panel">
              <div className="status-board-section-head">
                <div>
                  <p className="status-board-label">Model Route</p>
                  <h3>模型与任务</h3>
                </div>
                <Radio size={18} />
              </div>
              <FactList items={modelFacts} />
              <div className="status-board-running-list">
                {runningConversations.length === 0 ? (
                  <EmptyState>暂无运行中会话。</EmptyState>
                ) : (
                  runningConversations.slice(0, 4).map((item) => (
                    <article key={item.id} className="status-board-running-item">
                      <div className="status-board-running-dot" />
                      <div>
                        <strong>{truncateMiddle(item.title, 34)}</strong>
                        <span>
                          {item.cwd ? basename(item.cwd) : "默认空间"} · {item.messageCount} messages · {formatDuration(now - item.updatedAt)} ago
                        </span>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>

            <section className="status-board-card status-board-panel status-board-workspace-panel">
              <div className="status-board-section-head">
                <div>
                  <p className="status-board-label">Workspace Heat</p>
                  <h3>项目热力图</h3>
                </div>
                <HardDrive size={18} />
              </div>
              <div className="status-board-active-workspace">
                <span>Active Workspace</span>
                <strong title={activeWorkspaceHint}>{activeWorkspaceName}</strong>
                <em>{activeWorkspaceHint}</em>
              </div>
              <div className="status-board-workdir-list">
                {workdirs.length === 0 ? (
                  <EmptyState>暂无项目维度历史。</EmptyState>
                ) : (
                  workdirs.slice(0, 6).map((item) => (
                    <article key={item.path} className="status-board-workdir">
                      <div>
                        <strong>{basename(item.path)}</strong>
                        <span>{truncateMiddle(item.path, 46)}</span>
                      </div>
                      <div className="status-board-workdir-meter">
                        <span style={{ width: percentage(((item.conversationCount || 0) / maxWorkdirCount) * 100) }} />
                      </div>
                      <em>{item.conversationCount} conversations</em>
                    </article>
                  ))
                )}
              </div>
            </section>
          </aside>
        </section>

        <footer className="status-board-footer">
          <span>
            <CheckCircle2 size={14} />
            Sources: status.get / settings.get / history.list / terminal.list / tunnel.list / providers.list
          </span>
          <span>
            <Timer size={14} />
            Snapshot interval {SNAPSHOT_REFRESH_MS / 1000} s · realtime batch {LIVE_FLUSH_MS} ms
          </span>
          <span>
            <Wrench size={14} />
            Tool stream {compactNumber(liveCounters.toolCalls + liveCounters.toolResults)} events
          </span>
          <span>
            <Zap size={14} />
            /dashboard · {status?.session_id ? truncateMiddle(status.session_id, 18) : "no session"}
          </span>
        </footer>
      </section>
    </main>
  );
}
