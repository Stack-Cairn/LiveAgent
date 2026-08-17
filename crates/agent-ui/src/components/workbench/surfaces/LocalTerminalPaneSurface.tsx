import { Loader2, Terminal } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
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
};

/**
 * 终端 Pane 的纯受控展示层:本地与 SSH 首期共用。会话存在时始终渲染
 * XTermViewport(exited/error 只叠加提示条,不清屏),仅无会话可显示时
 * 才使用居中占位,保证 phase 切换不重挂视口。
 */
export function LocalTerminalPaneSurface(props: LocalTerminalPaneSurfaceProps) {
  const { paneId, client, session, phase, theme, isActive, errorMessage, onRetry, onError } = props;
  const { t } = useLocale();

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

  return (
    <div
      data-workbench-pane-id={paneId}
      data-workbench-surface="terminal"
      data-workbench-surface-id={session ? `terminal-session:${session.id}` : undefined}
      data-terminal-phase={phase}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
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
