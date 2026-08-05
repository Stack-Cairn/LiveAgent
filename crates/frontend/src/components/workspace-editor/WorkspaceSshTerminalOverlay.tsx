import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "../../i18n";
import type { SftpClient } from "../../lib/sftp/types";
import { cn } from "../../lib/shared/utils";
import type {
  SshTerminalTab,
  SshTerminalTabKind,
  SshTerminalTabsSnapshot,
  TerminalClient,
  TerminalSession,
} from "../../lib/terminal/types";
import { AlertTriangle, FolderTree, RefreshCw, Terminal, X } from "../icons";
import { MacOsTitleBarSpacer } from "../MacOsTitleBarSpacer";
import { XTermViewport } from "../project-tools/XTermViewport";
import { WorkspaceSftpPanel } from "./WorkspaceSftpPanel";

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
};

const SSH_TERMINAL_OVERLAY_ANIMATION_MS = 180;

function sshSessionStatus(session: TerminalSession) {
  const status = session.ssh?.status ?? (session.running ? "connected" : "disconnected");
  if (status === "connected" && !session.running) return "disconnected";
  return status;
}

function sessionTitle(session: TerminalSession, fallback: string) {
  return session.title || session.ssh?.hostName || fallback;
}

function sessionEndpointLabel(session: TerminalSession) {
  const ssh = session.ssh;
  if (!ssh) return session.cwd || session.projectPathKey;
  const userPrefix = ssh.username.trim() ? `${ssh.username.trim()}@` : "";
  return `${userPrefix}${ssh.host}:${ssh.port}`;
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
  const { openRequest, projectPathKey, sessions, client, sftpClient, theme, isOpen, onHide } =
    props;
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
  const hideTimerRef = useRef<number | null>(null);

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
    void client
      .openSshTerminalTab({ sessionId: openRequest.sessionId, kind })
      .then((snapshot) => {
        applyTabsSnapshot(snapshot);
        setActiveTabId(requestedTabId);
      })
      .catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
      });
  }, [applyTabsSnapshot, cancelPendingHide, client, openRequest]);

  useEffect(() => {
    if (!projectPathKey || !isOpen) return;
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
  }, [applyTabsSnapshot, client, isOpen, projectPathKey]);

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

  useEffect(
    () => () => {
      cancelPendingHide();
    },
    [cancelPendingHide],
  );

  return (
    <div
      className={cn(
        "absolute inset-0 z-50 flex min-h-0 min-w-0 transform-gpu flex-col overflow-hidden border-r border-border bg-background transition-[opacity,transform,box-shadow] duration-200 ease-out motion-reduce:transition-none",
        isVisible
          ? "pointer-events-auto translate-x-0 opacity-100 shadow-2xl"
          : "pointer-events-none -translate-x-2 opacity-0 shadow-lg",
      )}
    >
      <MacOsTitleBarSpacer className="bg-muted/45" />
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

      <div className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-background px-2 pt-1">
        {openTabRecords.map(({ tab, session }) => (
          <div
            key={tab.id}
            className={cn(
              "group flex h-8 max-w-[14rem] shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-xs transition-colors",
              tab.id === effectiveActiveTabId
                ? "border-border bg-muted text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
            title={sessionEndpointLabel(session)}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              onClick={() => activateTab(tab.id)}
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
                  <WorkspaceSftpPanel
                    client={sftpClient}
                    session={session}
                    isActive={isActiveTerminal}
                    onError={setError}
                  />
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
