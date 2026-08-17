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
  | { kind: "ssh-prompt" }
  | { kind: "create-failed"; message: string }
  | { kind: "lease"; message: string };

const SSH_LATENCY_POLL_MS = 15_000;

/**
 * 终端 Pane 的页面侧宿主:把布局层的 launchSpec 身份接到运行时——
 * 绑定(surfaceId→sessionId)解析既有会话;绑定缺失时按持久化 launchSpec
 * 自动重建新的 PTY/SSH 会话。完整应用重启无法复活旧进程,但 Pane、cwd、
 * shell/host 与交互能力会自动恢复。渲染前必须持有该会话的视图租约,保证输出流单消费、
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
  // 恢复 Pane 默认自动按 launchSpec 重建。显式 kill 会置 false 并关闭 Pane,
  // 防止关闭收尾前的同一宿主瞬间重建进程。
  const [launchRequested, setLaunchRequested] = useState(true);

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

  // 仅显式 kill 的短暂收尾阶段会休眠;正常恢复始终自动重建。
  const dormant = !boundSessionId && !launchRequested;

  useEffect(() => {
    if (!sessionsLoaded || session || errorState || dormant) return;
    if (boundSessionId) {
      // 完整应用重启后 Rust 注册表为空,但部分 WebView 实现仍可能留下
      // sessionStorage 绑定。清掉陈旧 sessionId,下一次 effect 自动按
      // launchSpec 重建,不要求用户手动介入。
      terminalPaneBindings.delete(surface.surfaceId);
      setCreatedSession(null);
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
        // 撤销启动资格,防止仍挂载的宿主把 kill 立刻变成一次静默重启;
        // 正常路径下 onSessionKilled 会关闭 Pane,这里是宿主未关 Pane 时的兜底。
        setLaunchRequested(false);
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
    // 手动重试重新授权,此后进入常规 ensure 流程。
    terminalPaneAutoLaunch.authorize(surface.surfaceId);
    setLaunchRequested(true);
    setCreatedSession(null);
    setViewportError(null);
    setErrorState(null);
  }, [surface.surfaceId]);

  const errorMessageFor = (state: TerminalPaneErrorState): string => {
    switch (state.kind) {
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
    // 显式 kill 收尾兜底;正常恢复不会进入该分支。
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
