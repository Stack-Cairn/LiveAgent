import {
  WorkspaceOverlayTitleBar,
  workspaceOverlayStackClassName,
} from "@liveagent/adapters/workspacePreview";
import {
  AlertTriangle,
  FolderTree,
  RefreshCw,
  Terminal,
  X,
} from "@liveagent/ui/components/IconSet";
import { XTermViewport } from "@liveagent/ui/components/project-tools/XTermViewport";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { SftpClient } from "@liveagent/ui/lib/sftp/types";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  sshSessionEndpointLabel,
  sshSessionStatus,
} from "@liveagent/ui/lib/terminal/sshSessionStatus";
import type {
  SshTerminalTab,
  SshTerminalTabKind,
  SshTerminalTabsSnapshot,
  TerminalClient,
  TerminalSession,
} from "@liveagent/ui/lib/terminal/types";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SftpOpenFileRequest } from "./WorkspaceSftpPanel";

const WorkspaceSftpPanel = lazy(async () => {
  const module = await import("./WorkspaceSftpPanel");
  return {
    default: module.WorkspaceSftpPanel,
  };
});

export type WorkspaceSshTerminalOpenRequest = {
  id: number;
  sessionId: string;
  kind?: SshTerminalTabKind;
};

type WorkspaceSshTerminalOverlayProps = {
  openRequest: WorkspaceSshTerminalOpenRequest | null;
  projectPathKey: string;
  sessions: TerminalSession[];
  client: TerminalClient;
  sftpClient: SftpClient;
  theme: "light" | "dark";
  isOpen: boolean;
  onHide: () => void;
  onOpenSftpFile?: (session: TerminalSession, request: SftpOpenFileRequest) => void;
  /**
   * 被工作台 Pane 租用的会话:shell 视口与 Pane 互斥(输出流单消费),
   * overlay 内显示"已在画板中打开"占位。SFTP tab 不受影响——SFTP 走独立
   * 通道,不与 XTermViewport 争夺输出流。
   */
  paneLeasedSessionIds?: ReadonlySet<string>;
  /** 点击占位跳转聚焦画板中的 Pane;省略时只显示占位文案。 */
  onFocusLeasedSession?: (sessionId: string) => void;
  /**
   * 存在时 shell tab 可拖出到工作台画板(SFTP tab 不可拖)。pointerdown 上报,
   * 激活阈值与点击抑制由工作台拖拽会话统一处理,tab 点击激活不受影响。
   */
  onSessionTabDragStart?: (
    session: TerminalSession,
    event: { pointerId: number; clientX: number; clientY: number },
  ) => void;
};

const SSH_TERMINAL_OVERLAY_ANIMATION_MS = 180;

function sessionTitle(session: TerminalSession, fallback: string) {
  return session.title || session.ssh?.hostName || fallback;
}

function sessionEndpointLabel(session: TerminalSession) {
  return sshSessionEndpointLabel(session);
}

function statusDotClassName(session: TerminalSession) {
  const status = sshSessionStatus(session);
  if (status === "connected") return "bg-emerald-500";
  if (status === "reconnecting") return "bg-amber-500";
  return "bg-destructive";
}

function tabIdFor(sessionId: string, kind: SshTerminalTabKind) {
  return `${kind}:${sessionId.trim()}`;
}

export function WorkspaceSshTerminalOverlay(props: WorkspaceSshTerminalOverlayProps) {
  const {
    openRequest,
    projectPathKey,
    sessions,
    client,
    sftpClient,
    theme,
    isOpen,
    onHide,
    onOpenSftpFile,
    paneLeasedSessionIds,
    onFocusLeasedSession,
    onSessionTabDragStart,
  } = props;
  const { t } = useLocale();
  const [isVisible, setIsVisible] = useState(isOpen);
  const [tabsSnapshot, setTabsSnapshot] = useState<SshTerminalTabsSnapshot>({
    projectPathKey,
    tabs: [],
    revision: 0,
  });
  const [activeTabId, setActiveTabId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reconnectingSessionId, setReconnectingSessionId] = useState<string | null>(null);
  const openRequestIdRef = useRef<number | null>(null);
  const optimisticTabIdsRef = useRef<Set<string>>(new Set());
  const locallyClosedTabIdsRef = useRef<Set<string>>(new Set());
  const hideTimerRef = useRef<number | null>(null);
  const tabElementRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const sshSessions = useMemo(
    () => sessions.filter((session) => session.kind === "ssh" && session.ssh),
    [sessions],
  );
  const sessionsById = useMemo(
    () => new Map(sshSessions.map((session) => [session.id, session])),
    [sshSessions],
  );
  const openTabRecords = useMemo(
    () =>
      tabsSnapshot.tabs
        .map((tab) => ({ tab, session: sessionsById.get(tab.sessionId) }))
        .filter((record): record is { tab: SshTerminalTab; session: TerminalSession } =>
          Boolean(record.session),
        ),
    [tabsSnapshot.tabs, sessionsById],
  );
  const activeRecord =
    openTabRecords.find((record) => record.tab.id === activeTabId) ?? openTabRecords[0] ?? null;
  const effectiveActiveTabId = activeRecord?.tab.id ?? "";
  const activeSession = activeRecord?.session ?? null;
  const shouldRenderPanes = isVisible && isOpen;

  const applyTabsSnapshot = useCallback(
    (snapshot: SshTerminalTabsSnapshot) => {
      if (projectPathKey && snapshot.projectPathKey && snapshot.projectPathKey !== projectPathKey) {
        return;
      }
      setTabsSnapshot(snapshot);
    },
    [projectPathKey],
  );

  const cancelPendingHide = useCallback(() => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const hideOverlay = useCallback(() => {
    cancelPendingHide();
    setIsVisible(false);
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      onHide();
    }, SSH_TERMINAL_OVERLAY_ANIMATION_MS);
  }, [cancelPendingHide, onHide]);

  const closeTab = useCallback(
    (tabId: string) => {
      locallyClosedTabIdsRef.current.add(tabId);
      void client
        .closeSshTerminalTab(tabId)
        .then(applyTabsSnapshot)
        .catch((error: unknown) => {
          setError(error instanceof Error ? error.message : String(error));
        });
    },
    [applyTabsSnapshot, client],
  );

  const activateTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, []);

  const reconnectActiveSession = useCallback(async () => {
    const session = activeSession;
    if (!session || reconnectingSessionId) return;
    setReconnectingSessionId(session.id);
    setError(null);
    try {
      await client.sshReconnect(session.id, session.projectPathKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("already in progress")) {
        // The automatic reconnect loop owns the session and re-reads the
        // latest settings on every attempt — nothing else to do here.
      } else if (message.includes("keyboard-interactive")) {
        // Tabs are keyed by session id, so a close-and-recreate flow would
        // tear this tab down; point at the tunnel panel instead.
        setError(t("workspaceSshTerminal.reconnectKbiHint"));
      } else {
        setError(message);
      }
    } finally {
      setReconnectingSessionId((current) => (current === session.id ? null : current));
    }
  }, [activeSession, client, reconnectingSessionId, t]);

  const activeSessionReconnecting = Boolean(
    activeSession &&
      (reconnectingSessionId === activeSession.id ||
        sshSessionStatus(activeSession) === "reconnecting"),
  );

  useEffect(() => {
    setTabsSnapshot({ projectPathKey, tabs: [], revision: 0 });
    setActiveTabId("");
  }, [projectPathKey]);

  useEffect(() => {
    if (!openRequest || openRequestIdRef.current === openRequest.id) return;
    const kind = openRequest.kind ?? "bash";
    openRequestIdRef.current = openRequest.id;
    cancelPendingHide();
    setIsVisible(true);
    setError(null);
    const requestedTabId = tabIdFor(openRequest.sessionId, kind);
    locallyClosedTabIdsRef.current.delete(requestedTabId);
    const requestedSession = sessionsById.get(openRequest.sessionId);
    if (requestedSession) {
      const now = Date.now();
      setTabsSnapshot((current) => {
        if (current.tabs.some((tab) => tab.id === requestedTabId)) {
          return current;
        }
        optimisticTabIdsRef.current.add(requestedTabId);
        return {
          projectPathKey:
            current.projectPathKey || requestedSession.projectPathKey || projectPathKey,
          tabs: [
            ...current.tabs,
            {
              id: requestedTabId,
              sessionId: requestedSession.id,
              projectPathKey: requestedSession.projectPathKey || projectPathKey,
              kind,
              createdAt: now,
              updatedAt: now,
            },
          ],
          revision: current.revision,
        };
      });
      setActiveTabId(requestedTabId);
    }
    void client
      .openSshTerminalTab({ sessionId: openRequest.sessionId, kind })
      .then((snapshot) => {
        optimisticTabIdsRef.current.delete(requestedTabId);
        if (locallyClosedTabIdsRef.current.has(requestedTabId)) {
          return;
        }
        applyTabsSnapshot(snapshot);
        setActiveTabId(requestedTabId);
      })
      .catch((error: unknown) => {
        if (optimisticTabIdsRef.current.delete(requestedTabId)) {
          setTabsSnapshot((current) => ({
            ...current,
            tabs: current.tabs.filter((tab) => tab.id !== requestedTabId),
          }));
        }
        setError(error instanceof Error ? error.message : String(error));
      });
  }, [applyTabsSnapshot, cancelPendingHide, client, openRequest, projectPathKey, sessionsById]);

  useEffect(() => {
    if (!projectPathKey || !isOpen) return;
    if (openRequest && sessionsById.has(openRequest.sessionId)) return;
    let cancelled = false;
    void client
      .listSshTerminalTabs(projectPathKey)
      .then((snapshot) => {
        if (!cancelled) {
          applyTabsSnapshot(snapshot);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyTabsSnapshot, client, isOpen, openRequest, projectPathKey, sessionsById]);

  useEffect(() => {
    return client.subscribe((event) => {
      if (event.kind !== "ssh_tabs_updated" || !event.sshTabs) return;
      applyTabsSnapshot(event.sshTabs);
    });
  }, [applyTabsSnapshot, client]);

  useEffect(() => {
    if (isOpen) {
      cancelPendingHide();
      setIsVisible(true);
      return;
    }
    setIsVisible(false);
  }, [cancelPendingHide, isOpen]);

  useEffect(() => {
    if (activeTabId && openTabRecords.some((record) => record.tab.id === activeTabId)) return;
    setActiveTabId(openTabRecords[0]?.tab.id ?? "");
  }, [activeTabId, openTabRecords]);

  useEffect(() => {
    if (!effectiveActiveTabId) return;
    const activeTab = tabElementRefs.current.get(effectiveActiveTabId);
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [effectiveActiveTabId, openTabRecords.length]);

  useEffect(
    () => () => {
      cancelPendingHide();
    },
    [cancelPendingHide],
  );

  return (
    <div
      className={cn(
        "workspace-ssh-terminal-overlay absolute inset-0 flex min-h-0 min-w-0 transform-gpu flex-col overflow-hidden border-r border-border bg-background transition-[opacity,transform,box-shadow] duration-200 ease-out motion-reduce:transition-none",
        workspaceOverlayStackClassName,
        isVisible
          ? "pointer-events-auto translate-x-0 opacity-100 shadow-2xl"
          : "pointer-events-none -translate-x-2 opacity-0 shadow-lg",
      )}
    >
      <WorkspaceOverlayTitleBar />
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/45 px-3">
        <Terminal className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">
            {t("workspaceSshTerminal.title")}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {activeSession ? sessionEndpointLabel(activeSession) : t("workspaceSshTerminal.empty")}
          </div>
        </div>
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-amber-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 dark:hover:text-amber-400"
          title={t("workspaceSshTerminal.reconnect")}
          aria-label={t("workspaceSshTerminal.reconnect")}
          disabled={!activeSession || activeSessionReconnecting}
          onClick={() => void reconnectActiveSession()}
        >
          <RefreshCw className={cn("h-4 w-4", activeSessionReconnecting && "animate-spin")} />
        </button>
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title={t("workspaceSshTerminal.close")}
          aria-label={t("workspaceSshTerminal.close")}
          onClick={hideOverlay}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="workspace-ssh-terminal-tabs flex h-10 shrink-0 items-end gap-1 overflow-x-auto overflow-y-hidden border-b border-border bg-background px-2 pt-1">
        {openTabRecords.map(({ tab, session }) => (
          <div
            key={tab.id}
            ref={(node) => {
              if (node) {
                tabElementRefs.current.set(tab.id, node);
              } else {
                tabElementRefs.current.delete(tab.id);
              }
            }}
            className={cn(
              "workspace-ssh-terminal-tab group flex h-8 max-w-[14rem] shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-xs transition-colors",
              tab.id === effectiveActiveTabId
                ? "border-border bg-muted text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
            title={sessionEndpointLabel(session)}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              title={sessionEndpointLabel(session)}
              aria-label={sessionEndpointLabel(session)}
              onClick={() => activateTab(tab.id)}
              onPointerDown={
                onSessionTabDragStart && tab.kind !== "sftp"
                  ? (event) => {
                      // 触控仍用于滚动 tab 条;拖出仅响应鼠标/笔主键。
                      if (event.button !== 0 || event.pointerType === "touch") return;
                      onSessionTabDragStart(session, {
                        pointerId: event.pointerId,
                        clientX: event.clientX,
                        clientY: event.clientY,
                      });
                    }
                  : undefined
              }
            >
              <span
                className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusDotClassName(session))}
              />
              {tab.kind === "sftp" ? (
                <FolderTree className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <Terminal className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="min-w-0 truncate">
                {tab.kind === "sftp"
                  ? `${t("workspaceSshTerminal.sftpTab")} · ${sessionTitle(session, t("workspaceSshTerminal.title"))}`
                  : sessionTitle(session, t("workspaceSshTerminal.title"))}
              </span>
            </button>
            <button
              type="button"
              className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/75 hover:bg-background hover:text-foreground"
              title={t("workspaceSshTerminal.closeTab")}
              aria-label={t("workspaceSshTerminal.closeTab")}
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      {error ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1 truncate">{error}</div>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 bg-background">
        {shouldRenderPanes && openTabRecords.length > 0 ? (
          openTabRecords.map(({ tab, session }) => {
            const isActiveTerminal = effectiveActiveTabId === tab.id;
            return (
              <div
                key={tab.id}
                aria-hidden={!isActiveTerminal}
                className={cn("absolute inset-0 min-h-0", isActiveTerminal ? "block" : "hidden")}
              >
                {tab.kind === "sftp" ? (
                  <Suspense
                    fallback={
                      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                        {t("workspaceSshTerminal.loading")}
                      </div>
                    }
                  >
                    <WorkspaceSftpPanel
                      client={sftpClient}
                      session={session}
                      isActive={isActiveTerminal}
                      onError={setError}
                      onOpenFile={
                        onOpenSftpFile ? (request) => onOpenSftpFile(session, request) : undefined
                      }
                    />
                  </Suspense>
                ) : paneLeasedSessionIds?.has(session.id) ? (
                  <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/70">
                      <Terminal className="h-5 w-5" />
                    </div>
                    <div>{t("workspaceSshTerminal.openedInWorkbench")}</div>
                    {onFocusLeasedSession ? (
                      <button
                        type="button"
                        className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted"
                        onClick={() => onFocusLeasedSession(session.id)}
                      >
                        {t("workspaceSshTerminal.focusWorkbenchPane")}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <XTermViewport
                    client={client}
                    session={session}
                    theme={theme}
                    isActive={isActiveTerminal}
                    onError={(_sessionId, message) => setError(message)}
                  />
                )}
              </div>
            );
          })
        ) : openTabRecords.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/70">
              <Terminal className="h-5 w-5" />
            </div>
            <div>{t("workspaceSshTerminal.empty")}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
