import { Terminal } from "@liveagent/ui/components/IconSet";
import type { ConfirmDialogOptions } from "@liveagent/ui/components/ui/confirm-dialog";
import {
  applyTerminalEventToSessions,
  sortTerminalSessions,
} from "@liveagent/ui/lib/terminal/sessionStore";
import type { TerminalSession } from "@liveagent/ui/lib/terminal/types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";
import { tauriTerminalClient } from "../../../lib/terminal/tauriTerminalClient";
import { asErrorMessage } from "../chatPageUtils";
import { terminalAppExitGuard } from "../workbench/terminalPaneRuntime";

type UseProjectTerminalsParams = {
  terminalProjectPathKey: string;
  requestConfirmDialog: (options: ConfirmDialogOptions) => Promise<boolean>;
  t: (key: string) => string;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
};

/**
 * Terminal session list for the active project (initial load + event
 * subscription) plus the app-exit confirmation flow when terminals are still
 * running.
 */
export function useProjectTerminals(params: UseProjectTerminalsParams) {
  const { terminalProjectPathKey, requestConfirmDialog, t, setErrorMessage } = params;
  const [terminalSessions, setTerminalSessions] = useState<TerminalSession[]>([]);
  const [terminalSessionsLoaded, setTerminalSessionsLoaded] = useState(false);

  const handleRightDockSessionsChange = useCallback((sessions: TerminalSession[]) => {
    setTerminalSessions(sortTerminalSessions(sessions));
  }, []);

  useEffect(() => {
    setTerminalSessionsLoaded(false);
    if (!terminalProjectPathKey) {
      setTerminalSessions([]);
      return;
    }
    let cancelled = false;
    void tauriTerminalClient
      .list()
      .then((sessions) => {
        if (!cancelled) {
          setTerminalSessions(sortTerminalSessions(sessions));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTerminalSessions([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setTerminalSessionsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [terminalProjectPathKey]);

  useEffect(() => {
    if (!terminalProjectPathKey) return;
    return tauriTerminalClient.subscribe((event) => {
      if (event.kind === "output") return;
      setTerminalSessions((current) => applyTerminalEventToSessions(current, event));
    });
  }, [terminalProjectPathKey]);

  // 幽灵会话自愈:前端列表可能残留后端已不存在的记录(closed 事件丢失、
  // dock 写回竞态等)。终端视口报错时按后端权威列表校验一次;确认消失则
  // 整表刷新,幽灵从 dock 与 Pane 同步退场。会话仍在则视为瞬时错误,不动列表。
  const verifyTerminalSessionAlive = useCallback((sessionId: string) => {
    const key = sessionId.trim();
    if (!key) return;
    void tauriTerminalClient
      .list()
      .then((live) => {
        if (live.some((session) => session.id === key)) return;
        setTerminalSessions(sortTerminalSessions(live));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    listen<{ runningCount?: number }>("terminal:exit-requested", async (event) => {
      if (cancelled) return;
      const runningCount = Math.max(0, Number(event.payload?.runningCount ?? 0));
      const confirmed =
        runningCount === 0 ||
        (await requestConfirmDialog({
          title: t("chat.exitConfirmTitle"),
          subtitle: t("chat.exitConfirmSubtitle"),
          description: (
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                <Terminal className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {t("chat.exitConfirmRunningLabel")}
                  </span>
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/15 px-1.5 text-[calc(11px*var(--zone-font-scale,1))] font-semibold text-amber-700 dark:text-amber-300">
                    {runningCount}
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  {t("chat.exitConfirmDescription")}
                </p>
              </div>
            </div>
          ),
          detail: t("chat.exitConfirmNote"),
          confirmLabel: t("chat.exitConfirmContinue"),
          cancelLabel: t("chat.cancel"),
          closeLabel: t("chat.exitConfirmClose"),
          tone: "warning",
        }));
      if (!confirmed || cancelled) return;
      // 退出路径的 close_all 会广播 closed;先置位护栏,ChatPage 的
      // closed→关 Pane 联动停摆,布局落盘保住全部终端 Pane。
      terminalAppExitGuard.mark();
      try {
        await invoke("app_confirmed_exit");
      } catch (error) {
        terminalAppExitGuard.reset();
        if (!cancelled) {
          setErrorMessage(asErrorMessage(error, "退出 LiveAgent 失败"));
        }
      }
    })
      .then((dispose) => {
        if (cancelled) {
          dispose();
        } else {
          unlisten = dispose;
        }
      })
      .catch((error) => {
        console.error("failed to listen for terminal exit requests", error);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [requestConfirmDialog, setErrorMessage, t]);

  return {
    terminalSessions,
    setTerminalSessions,
    terminalSessionsLoaded,
    handleRightDockSessionsChange,
    verifyTerminalSessionAlive,
  };
}
