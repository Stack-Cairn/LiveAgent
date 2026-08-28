import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocale } from "../../i18n/index";
import type { TerminalClient, TerminalSession } from "../../lib/terminal/types";
import type { TerminalPaneBindingStore } from "../../lib/workbench/terminalPaneBindingStore";
import type { TerminalPaneLeaseStore } from "../../lib/workbench/terminalPaneLeaseStore";
import {
  ensureTerminalPaneSession,
  TerminalPaneSshPromptError,
} from "../../lib/workbench/terminalPaneRuntime";
import type { TerminalWorkbenchSurface } from "../../lib/workbench/types";
import {
  LocalTerminalPaneSurface,
  type TerminalPaneSurfacePhase,
} from "./surfaces/LocalTerminalPaneSurface";
import { SshTerminalPaneSurface } from "./surfaces/SshTerminalPaneSurface";

export type TerminalPaneHostProps = {
  paneId: string;
  surface: TerminalWorkbenchSurface;
  isFocused: boolean;
  /** 极窄 Pane:SSH 状态行进入紧凑渲染(由 rect 派生,不写回布局)。 */
  isCompact?: boolean;
  theme: "light" | "dark";
  /** 终端运行时:桌面端为 Tauri client,Web 端为网关 client。 */
  client: TerminalClient;
  /** 窗口级绑定表(surfaceId→sessionId),宿主间必须共享同一实例。 */
  bindings: TerminalPaneBindingStore;
  /** 窗口级视图租约,保证一个会话的输出流单消费。 */
  lease: TerminalPaneLeaseStore;
  /** 全窗口会话列表(未按项目过滤):Pane 可承载任意项目的终端。 */
  sessions: readonly TerminalSession[];
  sessionsLoaded: boolean;
  /**
   * 视口报错时上抛 sessionId,由页面按后端权威列表校验:会话确认消失
   * (幽灵记录)则整表刷新,本 Pane 随之进入 session-closed 停驻态,
   * 重试按钮变为按 launchSpec 重启,而不是对着死会话无限重连。
   */
  onSessionGhost?: (sessionId: string) => void;
};

type TerminalPaneErrorState =
  | { kind: "ssh-prompt" }
  | { kind: "create-failed"; message: string }
  | { kind: "session-closed" }
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
    client,
    bindings,
    lease,
    sessions,
    sessionsLoaded,
    onSessionGhost,
  } = props;
  const { t } = useLocale();

  const boundSessionId = useSyncExternalStore(bindings.subscribe, () =>
    bindings.get(surface.surfaceId),
  );
  // create 响应先于 terminal:event 到达时的直接渲染兜底;事件送达后列表版本优先。
  const [createdSession, setCreatedSession] = useState<TerminalSession | null>(null);
  const [errorState, setErrorState] = useState<TerminalPaneErrorState | null>(null);
  const [viewportError, setViewportError] = useState<string | null>(null);
  const [leasedSessionId, setLeasedSessionId] = useState<string | null>(null);

  const liveSession = boundSessionId
    ? (sessions.find((entry) => entry.id === boundSessionId) ?? null)
    : null;
  const session =
    liveSession ?? (createdSession && createdSession.id === boundSessionId ? createdSession : null);
  const sessionId = session?.id ?? null;

  // 本次挂载内出现在会话列表里过的 sessionId:用于区分"重启后的陈旧绑定"
  // (从未见过,可按 launchSpec 重建)与"运行期被显式关闭"(见过又消失,
  // 绝不能自动复活一个新 PTY)。
  const seenLiveSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (liveSession) seenLiveSessionIdRef.current = liveSession.id;
  }, [liveSession]);

  useEffect(() => {
    if (liveSession && createdSession) setCreatedSession(null);
  }, [createdSession, liveSession]);

  useEffect(() => {
    if (!sessionsLoaded || session || errorState) return;
    if (boundSessionId) {
      if (seenLiveSessionIdRef.current === boundSessionId) {
        // 会话生前在本次挂载中活过:这是 Right Dock 的显式关闭(或
        // close_project/close_all),不是恢复期残留。停在关闭态等用户
        // 决定重启或关 Pane;通常页面的 closed 事件联动会先把
        // Pane 收掉,这里只是事件丢失/竞态下的兜底。
        setErrorState({ kind: "session-closed" });
        return;
      }
      // 完整应用重启后后端注册表为空,但部分环境仍可能留下持久化绑定。
      // 清掉陈旧 sessionId,下一次 effect 自动按 launchSpec 重建,
      // 不要求用户手动介入。
      bindings.delete(surface.surfaceId);
      setCreatedSession(null);
      return;
    }
    let cancelled = false;
    void ensureTerminalPaneSession(surface, {
      client,
      bindings,
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
  }, [bindings, boundSessionId, client, errorState, session, sessionsLoaded, surface]);

  useEffect(() => {
    if (!sessionId) return;
    try {
      const release = lease.acquire(sessionId, paneId);
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
  }, [lease, paneId, sessionId]);

  const handleViewportError = useCallback(
    (errorSessionId: string, message: string | null) => {
      setViewportError(message);
      // attach 持续失败最常见的根因是幽灵会话(后端已丢、前端列表还在)。
      // 上抛给页面做权威校验;瞬时错误在校验中会被识别为仍存活而不动列表。
      if (message) onSessionGhost?.(errorSessionId);
    },
    [onSessionGhost],
  );

  // SSH 重连:错误按提示条展示;"already in progress" 表示自动重连循环已接管。
  const [reconnectPending, setReconnectPending] = useState(false);
  const reconnectSsh = useCallback(() => {
    const targetSessionId = bindings.get(surface.surfaceId);
    if (!targetSessionId || reconnectPending) return;
    setReconnectPending(true);
    void client
      .sshReconnect(targetSessionId)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("already in progress")) {
          setViewportError(message);
        }
      })
      .finally(() => setReconnectPending(false));
  }, [bindings, client, reconnectPending, surface.surfaceId]);

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
      void client
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
  }, [client, latencyEligible, sessionId]);

  const restartFromLaunchSpec = useCallback(() => {
    const staleSessionId = bindings.get(surface.surfaceId);
    if (staleSessionId) {
      // 退出的会话重启时顺手回收注册表条目;失败不阻塞重建。
      void client.close(staleSessionId).catch(() => {});
    }
    bindings.delete(surface.surfaceId);
    setCreatedSession(null);
    setViewportError(null);
    setErrorState(null);
  }, [bindings, client, surface.surfaceId]);

  const errorMessageFor = (state: TerminalPaneErrorState): string => {
    switch (state.kind) {
      case "ssh-prompt":
        return t("workbench.terminalSshPrompt");
      case "session-closed":
        return t("workbench.terminalSessionMissing");
      case "create-failed":
      case "lease":
        return state.message || t("workbench.terminalError");
      default:
        return t("workbench.terminalError");
    }
  };

  const leased = session !== null && leasedSessionId === session.id;
  let phase: TerminalPaneSurfacePhase;
  let renderSession: TerminalSession | null = null;
  let errorMessage: string | null = null;
  let onRetry: (() => void) | undefined = restartFromLaunchSpec;
  if (errorState) {
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

  const commonProps = {
    paneId,
    client,
    session: renderSession,
    phase,
    theme,
    isActive: isFocused,
    errorMessage,
    onRetry,
    onError: handleViewportError,
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
