import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RightDockProjectState } from "../../lib/settings";
import type {
  TerminalClient,
  TerminalSession,
  TerminalShellOption,
  TerminalSnapshot,
} from "../../lib/terminal/types";
import {
  areSessionsEqual,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  rightDockNeighborTabId,
  sortSessions,
  terminalSessionBelongsToProject,
} from "./rightDockModel";

const PENDING_CREATE_ACTIVATION_TIMEOUT_MS = 15_000;

type UseRightDockSessionsOptions = {
  client: TerminalClient;
  cwd: string;
  externalSessions?: TerminalSession[];
  externalSessionsLoaded?: boolean;
  isOpen: boolean;
  projectPathKey: string;
  projectState: RightDockProjectState;
  terminalReady: boolean;
  onProjectStateChange: (
    updater: (current: RightDockProjectState) => RightDockProjectState,
  ) => void;
  onSessionsChange?: (sessions: TerminalSession[]) => void;
};

// Terminal tab existence is derived from the live session list; the persisted
// project state only records user intent (active tab, order). This hook
// therefore never reconciles sessions back into settings — the only settings
// writes below are direct user gestures (activate, close).
export function useRightDockSessions(options: UseRightDockSessionsOptions) {
  const {
    client,
    cwd,
    externalSessions,
    externalSessionsLoaded,
    isOpen,
    onProjectStateChange,
    onSessionsChange,
    projectPathKey,
    projectState,
    terminalReady,
  } = options;
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [internalSessionsLoaded, setInternalSessionsLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [closingSessionIds, setClosingSessionIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingCloseSessionId, setPendingCloseSessionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shellOptions, setShellOptions] = useState<TerminalShellOption[]>([]);
  const sessionsRef = useRef<TerminalSession[]>([]);
  const initialTerminalSnapshotsRef = useRef<Map<string, TerminalSnapshot>>(new Map());
  const lastProjectPathKeyRef = useRef(projectPathKey);
  const pendingCreateActivationRef = useRef<{
    knownSessionIds: Set<string>;
    requestedAt: number;
  } | null>(null);
  const isControlled = externalSessions !== undefined;
  const sessionsLoaded = isControlled ? (externalSessionsLoaded ?? true) : internalSessionsLoaded;
  const localSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          session.kind !== "ssh" && terminalSessionBelongsToProject(session, projectPathKey),
      ),
    [projectPathKey, sessions],
  );
  const sshSessions = useMemo(
    () => sessions.filter((session) => session.kind === "ssh"),
    [sessions],
  );
  const activeSession = useMemo(
    () =>
      localSessions.find((session) => session.id === projectState.activeTabId) ??
      (sessionsLoaded ? (localSessions[0] ?? null) : null),
    [localSessions, projectState.activeTabId, sessionsLoaded],
  );
  const pendingCloseSession = useMemo(
    () => localSessions.find((session) => session.id === pendingCloseSessionId) ?? null,
    [localSessions, pendingCloseSessionId],
  );

  // Single mutation path for the session list: compute first, then set state
  // and notify — never from inside a state updater.
  const commitSessions = useCallback(
    (nextSessions: TerminalSession[], notifyParent: boolean) => {
      const sorted = sortSessions(nextSessions);
      if (areSessionsEqual(sessionsRef.current, sorted)) return;
      sessionsRef.current = sorted;
      setSessions(sorted);
      if (notifyParent) {
        onSessionsChange?.(sorted);
      }
    },
    [onSessionsChange],
  );

  const activateTerminalSession = useCallback(
    (session: TerminalSession) => {
      onProjectStateChange((current) => {
        if (current.activeTabId === session.id && current.tabOrder.includes(session.id)) {
          return current;
        }
        return {
          ...current,
          activeTabId: session.id,
          tabOrder: current.tabOrder.includes(session.id)
            ? current.tabOrder
            : [...current.tabOrder, session.id],
        };
      });
    },
    [onProjectStateChange],
  );

  useEffect(() => {
    if (!externalSessions) return;
    commitSessions(externalSessions, false);
  }, [commitSessions, externalSessions]);

  const refreshSessions = useCallback(() => {
    if (!terminalReady) {
      commitSessions([], false);
      return;
    }
    setLoading(true);
    setError(null);
    void client
      .list()
      .then((nextSessions) => {
        commitSessions(nextSessions, !isControlled);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setLoading(false);
        setInternalSessionsLoaded(true);
      });
  }, [client, commitSessions, isControlled, terminalReady]);

  useEffect(() => {
    if (!isOpen || isControlled) return;
    refreshSessions();
  }, [isControlled, isOpen, refreshSessions]);

  useEffect(() => {
    if (!terminalReady) {
      setShellOptions([]);
      return;
    }
    let cancelled = false;
    void client
      .shellOptions()
      .then((response) => {
        if (cancelled) return;
        setShellOptions(response.options);
      })
      .catch(() => {
        if (!cancelled) {
          setShellOptions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, terminalReady]);

  useEffect(() => {
    if (!terminalReady || isControlled) return;
    return client.subscribe((event) => {
      if (event.kind === "output") return;
      const current = sessionsRef.current;
      let next = current;
      if (event.kind === "closed") {
        next = current.filter((session) => session.id !== event.sessionId);
      } else {
        const index = current.findIndex((session) => session.id === event.sessionId);
        if (index >= 0 && event.session) {
          next = [...current];
          next[index] = event.session;
        } else if (event.kind === "created" && event.session) {
          next = [...current, event.session];
        }
      }
      commitSessions(next, true);
    });
  }, [client, commitSessions, isControlled, terminalReady]);

  useEffect(() => {
    if (lastProjectPathKeyRef.current === projectPathKey) return;
    lastProjectPathKeyRef.current = projectPathKey;
    initialTerminalSnapshotsRef.current.clear();
    pendingCreateActivationRef.current = null;
    setPendingCloseSessionId("");
    setClosingSessionIds(new Set());
    if (!isControlled) {
      setInternalSessionsLoaded(false);
    }
  }, [isControlled, projectPathKey]);

  useEffect(() => {
    if (!pendingCloseSessionId) return;
    if (!localSessions.some((session) => session.id === pendingCloseSessionId)) {
      setPendingCloseSessionId("");
    }
  }, [localSessions, pendingCloseSessionId]);

  useEffect(() => {
    // A terminal created by this client can surface through the shared session
    // list instead of the create response (created broadcast racing the RPC, or
    // the response lost to socket recovery) — still switch the dock to it.
    const pending = pendingCreateActivationRef.current;
    if (!pending) return;
    if (Date.now() - pending.requestedAt > PENDING_CREATE_ACTIVATION_TIMEOUT_MS) {
      pendingCreateActivationRef.current = null;
      return;
    }
    const createdSession = localSessions
      .filter((session) => !pending.knownSessionIds.has(session.id))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!createdSession) return;
    pendingCreateActivationRef.current = null;
    setError(null);
    activateTerminalSession(createdSession);
  }, [activateTerminalSession, localSessions]);

  const rememberTerminalSnapshot = useCallback(
    (snapshot: TerminalSnapshot) => {
      initialTerminalSnapshotsRef.current.set(snapshot.session.id, snapshot);
      const next = [
        ...sessionsRef.current.filter((session) => session.id !== snapshot.session.id),
        snapshot.session,
      ];
      commitSessions(next, true);
    },
    [commitSessions],
  );

  const reconcileSshSessions = useCallback(
    (nextSshSessions: TerminalSession[]) => {
      const normalizedSshSessions = nextSshSessions.filter(
        (session) => session.kind === "ssh" && session.id,
      );
      const nextSshSessionIds = new Set(normalizedSshSessions.map((session) => session.id));
      for (const session of sessionsRef.current) {
        if (session.kind === "ssh" && !nextSshSessionIds.has(session.id)) {
          initialTerminalSnapshotsRef.current.delete(session.id);
        }
      }
      commitSessions(
        [
          ...sessionsRef.current.filter((session) => session.kind !== "ssh"),
          ...normalizedSshSessions,
        ],
        true,
      );
    },
    [commitSessions],
  );

  const forgetTerminalSession = useCallback(
    (sessionId: string) => {
      initialTerminalSnapshotsRef.current.delete(sessionId);
      setPendingCloseSessionId((current) => (current === sessionId ? "" : current));
      commitSessions(
        sessionsRef.current.filter((item) => item.id !== sessionId),
        true,
      );
    },
    [commitSessions],
  );

  const createTerminal = useCallback(
    (shell?: string) => {
      if (!terminalReady || creating) return;
      setCreating(true);
      setError(null);
      pendingCreateActivationRef.current = {
        knownSessionIds: new Set(localSessions.map((session) => session.id)),
        requestedAt: Date.now(),
      };
      void client
        .create({
          cwd,
          projectPathKey,
          shell: shell?.trim() || undefined,
          cols: DEFAULT_TERMINAL_COLS,
          rows: DEFAULT_TERMINAL_ROWS,
        })
        .then((snapshot) => {
          pendingCreateActivationRef.current = null;
          rememberTerminalSnapshot(snapshot);
          activateTerminalSession(snapshot.session);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setCreating(false));
    },
    [
      activateTerminalSession,
      client,
      creating,
      cwd,
      localSessions,
      projectPathKey,
      rememberTerminalSnapshot,
      terminalReady,
    ],
  );

  const closeSession = useCallback(
    (session: TerminalSession) => {
      if (closingSessionIds.has(session.id)) return;
      setError(null);
      setClosingSessionIds((current) => new Set(current).add(session.id));
      void client
        .close(session.id, session.projectPathKey)
        .then(() => {
          forgetTerminalSession(session.id);
          // The close is this client's gesture, so it also owns moving the
          // active tab off the dead session; remote clients only fall back at
          // render time and never write.
          onProjectStateChange((current) => {
            const tabOrder = current.tabOrder.filter((id) => id !== session.id);
            if (current.activeTabId !== session.id) {
              return tabOrder.length === current.tabOrder.length
                ? current
                : { ...current, tabOrder };
            }
            const fallback = rightDockNeighborTabId(current.tabOrder, session.id);
            return {
              ...current,
              ...(fallback ? { activeTabId: fallback } : {}),
              tabOrder,
            };
          });
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() =>
          setClosingSessionIds((current) => {
            if (!current.has(session.id)) return current;
            const next = new Set(current);
            next.delete(session.id);
            return next;
          }),
        );
    },
    [client, closingSessionIds, forgetTerminalSession, onProjectStateChange],
  );

  const handleCloseRequest = useCallback(
    (session: TerminalSession) => {
      setError(null);
      if (session.running && pendingCloseSessionId !== session.id) {
        activateTerminalSession(session);
        setPendingCloseSessionId(session.id);
        return;
      }
      closeSession(session);
    },
    [activateTerminalSession, closeSession, pendingCloseSessionId],
  );

  const handleInitialTerminalSnapshotConsumed = useCallback((sessionId: string) => {
    initialTerminalSnapshotsRef.current.delete(sessionId);
  }, []);

  const clearPendingCloseSession = useCallback(() => {
    setPendingCloseSessionId("");
  }, []);

  return {
    activateTerminalSession,
    activeSession,
    clearPendingCloseSession,
    closeSession,
    closingSessionIds,
    createTerminal,
    creating,
    error,
    forgetTerminalSession,
    handleCloseRequest,
    handleInitialTerminalSnapshotConsumed,
    initialTerminalSnapshotsRef,
    loading,
    localSessions,
    pendingCloseSession,
    pendingCloseSessionId,
    reconcileSshSessions,
    rememberTerminalSnapshot,
    sessionsLoaded,
    setError,
    shellOptions,
    sshSessions,
  };
}
