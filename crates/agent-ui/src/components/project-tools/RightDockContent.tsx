import type { RightDockTabKind } from "@liveagent/app/lib/settings";
import { Terminal } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { RefObject } from "react";
import { cn } from "../../lib/shared/utils";
import type { TerminalSession, TerminalSnapshot } from "../../lib/terminal/types";
import { Button } from "../ui/button";
import { BackgroundTasksPanel } from "./BackgroundTasksPanel";
import { useRightDockToolContext } from "./RightDockContext";
import { RIGHT_DOCK_TOOL_DEFINITIONS, type RightDockSingletonTabKind } from "./rightDockRegistry";
import { XTermViewport } from "./XTermViewport";

type RightDockContentProps = {
  currentActiveTab: RightDockTabKind;
  initializedTools: Readonly<Record<RightDockSingletonTabKind, boolean>>;
  localSessions: TerminalSession[];
  activeSession: TerminalSession | null;
  initialTerminalSnapshotsRef: RefObject<Map<string, TerminalSnapshot>>;
  error: string | null;
  creating: boolean;
  loading: boolean;
  onTerminalError: (sessionId: string, message: string | null) => void;
  onInitialTerminalSnapshotConsumed: (sessionId: string) => void;
  onCreateTerminal: () => void;
};

export function RightDockContent(props: RightDockContentProps) {
  const {
    currentActiveTab,
    initializedTools,
    localSessions,
    activeSession,
    initialTerminalSnapshotsRef,
    error,
    creating,
    loading,
    onTerminalError,
    onInitialTerminalSnapshotConsumed,
    onCreateTerminal,
  } = props;
  const { t } = useLocale();
  const context = useRightDockToolContext();
  const { terminalReady, terminalDisabledMessage } = context.capabilities;
  const terminalClient = context.clients.terminal;

  return (
    <>
      {RIGHT_DOCK_TOOL_DEFINITIONS.map((definition) => {
        if (!initializedTools[definition.kind] || !definition.isAvailable(context)) {
          return null;
        }
        const active = currentActiveTab === definition.kind;
        return (
          <div
            key={definition.kind}
            className={cn(
              "min-h-0 flex-1",
              active ? definition.containerActiveClassName : "hidden",
            )}
          >
            {definition.render({ active })}
          </div>
        );
      })}
      {currentActiveTab === "backgroundTasks" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <BackgroundTasksPanel active />
        </div>
      ) : null}
      {localSessions.length > 0 ? (
        <div
          className={cn(
            "min-h-0 flex-1 flex-col",
            currentActiveTab === "terminal" ? "flex" : "hidden",
          )}
        >
          {error ? (
            <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
          <div className="relative min-h-0 flex-1">
            {/* 懒挂载：仅活跃 tab 真实挂载 XTermViewport。非活跃 tab 卸载以释放
                attach 流与渲染开销（画板 Pane + dock 多 tab 叠加后 attach 数量
                可观）。attach 协议带 offset 快照，切回 tab 时一次快照加载即可
                无损重建 scrollback；焦点/滚动位置丢失可接受。key 用 session.id
                保证切 tab 走完整卸载/重挂而不是复用实例。 */}
            {localSessions.map((session) => {
              const isActiveTerminal =
                currentActiveTab === "terminal" && activeSession?.id === session.id;
              if (!isActiveTerminal) return null;
              // 拖入画板(持有租约)的会话已从 localSessions 隐藏,这里挂载的
              // 视口必然是该会话的唯一消费者。
              return (
                <div key={session.id} className="absolute inset-0 min-h-0">
                  <XTermViewport
                    client={terminalClient}
                    session={session}
                    theme={context.theme}
                    isActive={isActiveTerminal}
                    initialSnapshot={
                      initialTerminalSnapshotsRef.current.get(session.id) ?? undefined
                    }
                    onError={onTerminalError}
                    onInitialSnapshotConsumed={onInitialTerminalSnapshotConsumed}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : currentActiveTab === "terminal" ? (
        // Only reachable while the terminal is unavailable — otherwise
        // RightDockPanel renders RightDockChooser instead, which is where the
        // drag-to-workbench affordance for "new terminal" lives.
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted/80">
            <Terminal className="h-6 w-6 text-muted-foreground" />
          </div>
          <div className="flex flex-col gap-1">
            <div className="text-sm font-medium text-foreground">
              {t("projectTools.newTerminal")}
            </div>
            {error ? (
              <div className="text-xs text-destructive">{error}</div>
            ) : terminalDisabledMessage ? (
              <div className="max-w-xs text-xs text-muted-foreground">
                {terminalDisabledMessage}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                {t("projectTools.terminalDescription")}
              </div>
            )}
          </div>
          <Button onClick={onCreateTerminal} disabled={!terminalReady || creating} size="sm">
            {t("projectTools.newTerminal")}
          </Button>
          {loading ? (
            <div className="text-xs text-muted-foreground">{t("projectTools.loading")}</div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
