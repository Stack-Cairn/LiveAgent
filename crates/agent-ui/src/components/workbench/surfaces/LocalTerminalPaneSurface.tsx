import { Loader2, Terminal } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../../lib/shared/utils";
import type { TerminalClient, TerminalSession } from "../../../lib/terminal/types";
import { XTermViewport } from "../../project-tools/XTermViewport";
import { Button } from "../../ui/button";

export type TerminalPaneSurfacePhase = "connecting" | "ready" | "exited" | "error";

export type LocalTerminalPaneSurfaceProps = {
  paneId: string;
  client: TerminalClient;
  /** 会话未建立(connecting/失败)时为 null;非 null 时视口保持挂载以保留输出。 */
  session: TerminalSession | null;
  phase: TerminalPaneSurfacePhase;
  theme: "light" | "dark";
  isActive: boolean;
  errorMessage?: string | null;
  onRetry?: () => void;
  onError: (sessionId: string, message: string | null) => void;
  /**
   * 显式结束会话(kill 进程)。与 Pane 关闭(Detach,进程保留回 dock)语义
   * 分离;入口为悬停显示的两态确认按钮。省略时无 kill 入口。
   */
  onKillSession?: () => void;
};

const KILL_CONFIRM_RESET_MS = 3_000;

/**
 * 终端 Pane 的纯受控展示层:本地与 SSH 首期共用。会话存在时始终渲染
 * XTermViewport(exited/error 只叠加提示条,不清屏),仅无会话可显示时
 * 才使用居中占位,保证 phase 切换不重挂视口。
 */
export function LocalTerminalPaneSurface(props: LocalTerminalPaneSurfaceProps) {
  const {
    paneId,
    client,
    session,
    phase,
    theme,
    isActive,
    errorMessage,
    onRetry,
    onError,
    onKillSession,
  } = props;
  const { t } = useLocale();
  // 两态确认(点一次武装、再点执行),超时自动复位;纯视图态,不进入宿主。
  const [killArmed, setKillArmed] = useState(false);
  const killResetTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (killResetTimerRef.current !== null) window.clearTimeout(killResetTimerRef.current);
    },
    [],
  );
  const handleKillClick = () => {
    if (killResetTimerRef.current !== null) {
      window.clearTimeout(killResetTimerRef.current);
      killResetTimerRef.current = null;
    }
    if (killArmed) {
      setKillArmed(false);
      onKillSession?.();
      return;
    }
    setKillArmed(true);
    killResetTimerRef.current = window.setTimeout(() => {
      killResetTimerRef.current = null;
      setKillArmed(false);
    }, KILL_CONFIRM_RESET_MS);
  };

  const banner =
    session && phase === "error" ? (
      <div
        data-terminal-pane-banner="error"
        className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
      >
        <span className="min-w-0 flex-1 truncate">
          {errorMessage || t("workbench.terminalError")}
        </span>
        {onRetry ? (
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onRetry}>
            {t("workbench.terminalRetry")}
          </Button>
        ) : null}
      </div>
    ) : session && phase === "exited" ? (
      <div
        data-terminal-pane-banner="exited"
        className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground"
      >
        <span className="min-w-0 flex-1 truncate">
          {t("workbench.terminalExited")}
          {session.exitCode != null ? (
            <span className="ml-1.5 font-mono">({session.exitCode})</span>
          ) : null}
        </span>
        {onRetry ? (
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onRetry}>
            {t("workbench.terminalRestart")}
          </Button>
        ) : null}
      </div>
    ) : null;

  const killButton =
    session && onKillSession && phase !== "connecting" ? (
      <button
        type="button"
        data-terminal-pane-kill={killArmed ? "armed" : "idle"}
        title={killArmed ? t("workbench.terminalKillConfirm") : t("workbench.terminalKill")}
        aria-label={killArmed ? t("workbench.terminalKillConfirm") : t("workbench.terminalKill")}
        onClick={handleKillClick}
        onBlur={() => setKillArmed(false)}
        className={cn(
          "absolute right-2 top-7 z-20 rounded-md border px-2 py-0.5 text-[11px] shadow-sm transition-all",
          "opacity-0 focus-visible:opacity-100 group-hover/workbench-pane:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          killArmed
            ? "border-destructive/40 bg-destructive/15 text-destructive"
            : "border-border/70 bg-background/90 text-muted-foreground hover:text-destructive",
        )}
      >
        {killArmed ? t("workbench.terminalKillConfirm") : t("workbench.terminalKill")}
      </button>
    ) : null;

  return (
    <div
      data-workbench-pane-id={paneId}
      data-workbench-surface="terminal"
      data-workbench-surface-id={session ? `terminal-session:${session.id}` : undefined}
      data-terminal-phase={phase}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {killButton}
      {banner}
      {session ? (
        <div className="relative min-h-0 flex-1">
          <XTermViewport
            client={client}
            session={session}
            theme={theme}
            isActive={isActive}
            onError={onError}
          />
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/70">
            {phase === "connecting" ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Terminal className="h-5 w-5" />
            )}
          </div>
          <div className={cn(phase === "error" && "text-destructive")}>
            {phase === "connecting"
              ? t("workbench.terminalConnecting")
              : phase === "exited"
                ? t("workbench.terminalExited")
                : errorMessage || t("workbench.terminalError")}
          </div>
          {phase !== "connecting" && onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              {phase === "exited" ? t("workbench.terminalRestart") : t("workbench.terminalRetry")}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
