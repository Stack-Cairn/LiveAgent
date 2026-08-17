import {
  LocalTerminalPaneSurface,
  SshTerminalPaneSurface,
  type TerminalPaneSurfacePhase,
} from "@liveagent/ui/components/workbench/index";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { TerminalSession } from "@liveagent/ui/lib/terminal/types";
import type { TerminalWorkbenchSurface } from "@liveagent/ui/lib/workbench/types";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { tauriTerminalClient } from "../../../lib/terminal/tauriTerminalClient";
import {
  ensureTerminalPaneSession,
  TerminalPaneSshPromptError,
  terminalPaneAutoLaunch,
  terminalPaneBindings,
  terminalPaneLease,
} from "../workbench/terminalPaneRuntime";

export type TerminalPaneHostProps = {
  paneId: string;
  surface: TerminalWorkbenchSurface;
  isFocused: boolean;
  /** 极窄 Pane:SSH 状态行进入紧凑渲染(由 rect 派生,不写回布局)。 */
  isCompact?: boolean;
  theme: "light" | "dark";
  /** 全窗口会话列表(未按项目过滤):Pane 可承载任意项目的终端。 */
  sessions: readonly TerminalSession[];
  sessionsLoaded: boolean;
  /** 显式 kill(结束进程)后的布局收尾:由页面注入 closePane。 */
  onSessionKilled?: () => void;
};

type TerminalPaneErrorState =
  | { kind: "session-missing" }
  | { kind: "ssh-prompt" }
  | { kind: "create-failed"; message: string }
  | { kind: "lease"; message: string };

const SSH_LATENCY_POLL_MS = 15_000;

/**
 * 终端 Pane 的页面侧宿主:把布局层的 launchSpec 身份接到运行时——
 * 绑定(surfaceId→sessionId)解析既有会话;绑定缺失时区分两条进入路径:
 * 本次会话内显式创建的 surface(auto-launch 已授权)自动按 launchSpec 建
 * 会话,恢复的 surface(应用重启/绑定对账清空)停在休眠占位,用户点
 * "重新启动"才建 PTY。渲染前必须持有该会话的视图租约,保证输出流单消费、
 * 输入单写。
 */
export function TerminalPaneHost(props: TerminalPaneHostProps) {
  const {
    paneId,
    surface,
    isFocused,
    isCompact,
    theme,
    sessions,
    sessionsLoaded,
    onSessionKilled,
  } = props;
  const { t } = useLocale();

  const boundSessionId = useSyncExternalStore(terminalPaneBindings.subscribe, () =>
    terminalPaneBindings.get(surface.surfaceId),
  );
  // create 响应先于 terminal:event 到达时的直接渲染兜底;事件送达后列表版本优先。
  const [createdSession, setCreatedSession] = useState<TerminalSession | null>(null);
  const [errorState, setErrorState] = useState<TerminalPaneErrorState | null>(null);
  const [viewportError, setViewportError] = useState<string | null>(null);
  const [leasedSessionId, setLeasedSessionId] = useState<string | null>(null);
  // 恢复占位 → 用户点重启后置 true;与 auto-launch 授权一起驱动 ensure。
  const [launchRequested, setLaunchRequested] = useState(() =>
    terminalPaneAutoLaunch.isAuthorized(surface.surfaceId),
  );

  const liveSession = boundSessionId
    ? (sessions.find((entry) => entry.id === boundSessionId) ?? null)
    : null;
  const session =
    liveSession ?? (createdSession && createdSession.id === boundSessionId ? createdSession : null);
  const sessionId = session?.id ?? null;

  useEffect(() => {
    if (liveSession && createdSession) setCreatedSession(null);
  }, [createdSession, liveSession]);

  // 绑定命中即视为授权:后续会话退出/消失时的"重新启动"不再回到休眠占位。
  useEffect(() => {
    if (!boundSessionId) return;
    terminalPaneAutoLaunch.authorize(surface.surfaceId);
    setLaunchRequested(true);
  }, [boundSessionId, surface.surfaceId]);

  // 休眠占位(恢复的 Pane,绑定为空且未授权):不自动建 PTY。
  const dormant = !boundSessionId && !launchRequested;

  useEffect(() => {
    if (!sessionsLoaded || session || errorState || dormant) return;
    if (boundSessionId) {
      // 绑定指向的会话已不在注册表:会话被外部关闭,或应用重启后的陈旧绑定。
      setErrorState({ kind: "session-missing" });
      return;
    }
    let cancelled = false;
    void ensureTerminalPaneSession(surface, {
      client: tauriTerminalClient,
      bindings: terminalPaneBindings,
    })
      .then((created) => {
        if (!cancelled) setCreatedSession(created);
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorState(
          error instanceof TerminalPaneSshPromptError
            ? { kind: "ssh-prompt" }
            : {
                kind: "create-failed",
                message: error instanceof Error ? error.message : String(error),
              },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [boundSessionId, dormant, errorState, session, sessionsLoaded, surface]);

  useEffect(() => {
    if (!sessionId) return;
    try {
      const release = terminalPaneLease.acquire(sessionId, paneId);
      setLeasedSessionId(sessionId);
      return () => {
        release();
        setLeasedSessionId((current) => (current === sessionId ? null : current));
      };
    } catch (error) {
      // reducer 的 surface 唯一性已挡住双 Pane;这里只做防御性降级。
      setErrorState({
        kind: "lease",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }, [paneId, sessionId]);

  const handleViewportError = useCallback((_sessionId: string, message: string | null) => {
    setViewportError(message);
  }, []);

  // 显式 kill:结束进程 → 回收绑定(租约随 Pane 关闭卸载释放)→ 页面收尾关 Pane。
  // 与 Detach(Pane 关闭,进程保留回 dock)语义分离。
  const [killPending, setKillPending] = useState(false);
  const killSession = useCallback(() => {
    const targetSessionId = terminalPaneBindings.get(surface.surfaceId);
    if (!targetSessionId || killPending) return;
    setKillPending(true);
    void tauriTerminalClient
      .close(targetSessionId)
      .catch(() => {
        // 进程可能已自行退出;绑定与 Pane 仍按 kill 语义收尾。
      })
      .finally(() => {
        terminalPaneBindings.delete(surface.surfaceId);
        setKillPending(false);
        onSessionKilled?.();
      });
  }, [killPending, onSessionKilled, surface.surfaceId]);

  // SSH 重连:错误按提示条展示;"already in progress" 表示自动重连循环已接管。
  const [reconnectPending, setReconnectPending] = useState(false);
  const reconnectSsh = useCallback(() => {
    const targetSessionId = terminalPaneBindings.get(surface.surfaceId);
    if (!targetSessionId || reconnectPending) return;
    setReconnectPending(true);
    void tauriTerminalClient
      .sshReconnect(targetSessionId)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("already in progress")) {
          setViewportError(message);
        }
      })
      .finally(() => setReconnectPending(false));
  }, [reconnectPending, surface.surfaceId]);

  // SSH 延迟:仅聚焦且视口就绪时以固定间隔探测;失败静默置未知("--")。
  const isSshPane = surface.kind === "sshTerminal";
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const latencyEligible =
    isSshPane && isFocused && sessionId !== null && session?.running === true && !errorState;
  useEffect(() => {
    if (!latencyEligible || !sessionId) {
      setLatencyMs(null);
      return;
    }
    let cancelled = false;
    const probe = () => {
      void tauriTerminalClient
        .sshLatency(sessionId)
        .then((result) => {
          if (!cancelled) setLatencyMs(result.latencyMs);
        })
        .catch(() => {
          if (!cancelled) setLatencyMs(null);
        });
    };
    probe();
    const timer = window.setInterval(probe, SSH_LATENCY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [latencyEligible, sessionId]);

  const restartFromLaunchSpec = useCallback(() => {
    const staleSessionId = terminalPaneBindings.get(surface.surfaceId);
    if (staleSessionId) {
      // 退出的会话重启时顺手回收注册表条目;失败不阻塞重建。
      void tauriTerminalClient.close(staleSessionId).catch(() => {});
    }
    terminalPaneBindings.delete(surface.surfaceId);
    // 休眠占位的显式重启 = 授权 auto-launch,此后进入常规 ensure 流程。
    terminalPaneAutoLaunch.authorize(surface.surfaceId);
    setLaunchRequested(true);
    setCreatedSession(null);
    setViewportError(null);
    setErrorState(null);
  }, [surface.surfaceId]);

  const errorMessageFor = (state: TerminalPaneErrorState): string => {
    switch (state.kind) {
      case "session-missing":
        return t("workbench.terminalSessionMissing");
      case "ssh-prompt":
        return t("workbench.terminalSshPrompt");
      case "create-failed":
      case "lease":
        return state.message || t("workbench.terminalError");
    }
  };

  const leased = session !== null && leasedSessionId === session.id;
  let phase: TerminalPaneSurfacePhase;
  let renderSession: TerminalSession | null = null;
  let errorMessage: string | null = null;
  let onRetry: (() => void) | undefined = restartFromLaunchSpec;
  if (dormant) {
    // 恢复的 Pane:进程已随应用退出;布局与 launchSpec 保留,等待显式重启。
    phase = "exited";
  } else if (errorState) {
    phase = "error";
    errorMessage = errorMessageFor(errorState);
  } else if (leased && session) {
    renderSession = session;
    if (viewportError) {
      // 视口自身会退避重试 attach;提示条只反映瞬时错误,重试仅清除提示。
      phase = "error";
      errorMessage = viewportError;
      onRetry = () => setViewportError(null);
    } else {
      phase = session.running ? "ready" : "exited";
    }
  } else {
    phase = "connecting";
    onRetry = undefined;
  }

  const killAvailable = Boolean(session && boundSessionId);
  const commonProps = {
    paneId,
    client: tauriTerminalClient,
    session: renderSession,
    phase,
    theme,
    isActive: isFocused,
    errorMessage,
    onRetry,
    onError: handleViewportError,
    onKillSession: killAvailable && !killPending ? killSession : undefined,
  };
  if (surface.kind === "sshTerminal") {
    return (
      <SshTerminalPaneSurface
        {...commonProps}
        onReconnect={renderSession ? reconnectSsh : undefined}
        isReconnecting={reconnectPending}
        latencyMs={latencyMs}
        isCompact={isCompact}
      />
    );
  }
  return <LocalTerminalPaneSurface {...commonProps} />;
}
