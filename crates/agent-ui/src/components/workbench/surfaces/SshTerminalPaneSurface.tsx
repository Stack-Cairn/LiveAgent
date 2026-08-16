import { RefreshCw } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "../../../lib/shared/utils";
import { sshSessionEndpointLabel, sshSessionStatus } from "../../../lib/terminal/sshSessionStatus";
import type { TerminalClient, TerminalSession } from "../../../lib/terminal/types";
import { Button } from "../../ui/button";
import {
  LocalTerminalPaneSurface,
  type TerminalPaneSurfacePhase,
} from "./LocalTerminalPaneSurface";

export type SshTerminalPaneSurfaceProps = {
  paneId: string;
  client: TerminalClient;
  session: TerminalSession | null;
  phase: TerminalPaneSurfacePhase;
  theme: "light" | "dark";
  isActive: boolean;
  errorMessage?: string | null;
  onRetry?: () => void;
  onError: (sessionId: string, message: string | null) => void;
  /** 触发 ssh 重连;由宿主注入(组件不接触 Tauri)。省略时不显示重连按钮。 */
  onReconnect?: () => void;
  /** 宿主的重连调用进行中(与会话自身的 reconnecting 状态叠加显示)。 */
  isReconnecting?: boolean;
  /** 透传给 LocalTerminalPaneSurface 的显式 kill 入口。 */
  onKillSession?: () => void;
};

/**
 * SSH 终端 Pane:在 LocalTerminalPaneSurface 之上叠一条紧凑连接状态行
 * (状态点/端点标签/重连按钮)。exited/error/占位语义完全沿用 Local;
 * SFTP 保留在 workspace overlay,Pane 内只承载 shell 视口。
 * TODO(terminal-pane): 状态行可选显示 sshLatency 轮询结果;首期只做状态点+重连。
 */
export function SshTerminalPaneSurface(props: SshTerminalPaneSurfaceProps) {
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
    onReconnect,
    isReconnecting,
    onKillSession,
  } = props;
  const { t } = useLocale();

  const status = session ? sshSessionStatus(session) : null;
  const reconnecting = Boolean(isReconnecting) || status === "reconnecting";
  const statusLabel =
    status === "connected"
      ? t("workbench.sshStatusConnected")
      : status === "reconnecting"
        ? t("workbench.sshStatusReconnecting")
        : t("workbench.sshStatusDisconnected");

  return (
    <div
      data-workbench-ssh-pane={paneId}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {session ? (
        <div
          data-terminal-pane-ssh-status={status ?? "unknown"}
          className="flex h-7 shrink-0 items-center gap-2 border-b border-border/60 bg-muted/40 px-3 text-[11px] text-muted-foreground"
        >
          <span
            aria-hidden="true"
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              status === "connected"
                ? "bg-emerald-500"
                : status === "reconnecting"
                  ? "bg-amber-500"
                  : "bg-destructive",
            )}
          />
          <span className="sr-only">{statusLabel}</span>
          <span
            className="min-w-0 flex-1 truncate font-mono"
            title={sshSessionEndpointLabel(session)}
          >
            {sshSessionEndpointLabel(session)}
          </span>
          {onReconnect ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 gap-1 px-1.5 text-[11px]"
              title={t("workbench.sshReconnect")}
              aria-label={t("workbench.sshReconnect")}
              disabled={reconnecting}
              onClick={onReconnect}
            >
              <RefreshCw className={cn("h-3 w-3", reconnecting && "animate-spin")} />
              {t("workbench.sshReconnect")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <LocalTerminalPaneSurface
        paneId={paneId}
        client={client}
        session={session}
        phase={phase}
        theme={theme}
        isActive={isActive}
        errorMessage={errorMessage}
        onRetry={onRetry}
        onError={onError}
        onKillSession={onKillSession}
      />
    </div>
  );
}
