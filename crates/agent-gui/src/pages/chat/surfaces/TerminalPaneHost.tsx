import {
  LocalTerminalPaneSurface,
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
  terminalPaneBindings,
  terminalPaneLease,
} from "../workbench/terminalPaneRuntime";

export type TerminalPaneHostProps = {
  paneId: string;
  surface: TerminalWorkbenchSurface;
  isFocused: boolean;
  theme: "light" | "dark";
  /** 全窗口会话列表(未按项目过滤):Pane 可承载任意项目的终端。 */
  sessions: readonly TerminalSession[];
  sessionsLoaded: boolean;
};

type TerminalPaneErrorState =
  | { kind: "session-missing" }
  | { kind: "ssh-prompt" }
  | { kind: "create-failed"; message: string }
  | { kind: "lease"; message: string };

/**
 * 终端 Pane 的页面侧宿主:把布局层的 launchSpec 身份接到运行时——
 * 绑定(surfaceId→sessionId)解析既有会话,缺失时按 launchSpec 异步建会话
 * (布局先行,创建失败停在可重试的 error 态);渲染前必须持有该会话的
 * 视图租约,保证输出流单消费、输入单写。
 */
export function TerminalPaneHost(props: TerminalPaneHostProps) {
  const { paneId, surface, isFocused, theme, sessions, sessionsLoaded } = props;
  const { t } = useLocale();

  const boundSessionId = useSyncExternalStore(terminalPaneBindings.subscribe, () =>
    terminalPaneBindings.get(surface.surfaceId),
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

  useEffect(() => {
    if (liveSession && createdSession) setCreatedSession(null);
  }, [createdSession, liveSession]);

  useEffect(() => {
    if (!sessionsLoaded || session || errorState) return;
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
  }, [boundSessionId, errorState, session, sessionsLoaded, surface]);

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

  const restartFromLaunchSpec = useCallback(() => {
    const staleSessionId = terminalPaneBindings.get(surface.surfaceId);
    if (staleSessionId) {
      // 退出的会话重启时顺手回收注册表条目;失败不阻塞重建。
      void tauriTerminalClient.close(staleSessionId).catch(() => {});
    }
    terminalPaneBindings.delete(surface.surfaceId);
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

  return (
    <LocalTerminalPaneSurface
      paneId={paneId}
      client={tauriTerminalClient}
      session={renderSession}
      phase={phase}
      theme={theme}
      isActive={isFocused}
      errorMessage={errorMessage}
      onRetry={onRetry}
      onError={handleViewportError}
    />
  );
}
