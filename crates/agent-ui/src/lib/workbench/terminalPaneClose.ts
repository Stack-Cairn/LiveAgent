import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalClient, TerminalSession } from "../terminal/types";
import type { TerminalPaneBindingStore } from "./terminalPaneBindingStore";
import type { PaneRecord, WorkbenchLayout } from "./types";

/**
 * What closing a pane means for the terminal it hosts:
 * - `close-pane`: nothing to terminate (non-terminal pane, dormant/placeholder
 *   surface, or a binding whose session is already gone) — just close the view;
 * - `confirm`: a running session — ask in place before killing it;
 * - `terminate`: an exited session — close it and let the `closed` event take
 *   the pane down.
 */
export type TerminalPaneCloseAction =
  | { kind: "close-pane" }
  | { kind: "confirm"; session: TerminalSession }
  | { kind: "terminate"; session: TerminalSession };

export function resolveTerminalPaneCloseAction(
  pane: PaneRecord | undefined,
  sessions: readonly TerminalSession[],
  bindings: Pick<TerminalPaneBindingStore, "get">,
): TerminalPaneCloseAction {
  if (!pane) return { kind: "close-pane" };
  const surface = pane.surface;
  if (surface.kind !== "localTerminal" && surface.kind !== "sshTerminal") {
    return { kind: "close-pane" };
  }
  const sessionId = bindings.get(surface.surfaceId);
  const session = sessionId ? sessions.find((entry) => entry.id === sessionId) : undefined;
  if (!session) return { kind: "close-pane" };
  return session.running ? { kind: "confirm", session } : { kind: "terminate", session };
}

export type TerminalPaneCloseRequest = {
  paneId: string;
  sessionId: string;
  /** close() in flight — the confirm button is disabled meanwhile. */
  busy: boolean;
};

export type UseTerminalPaneCloseFlowParams = {
  client: TerminalClient | null;
  /** Authoritative session list as rendered; the hook keeps its own ref. */
  sessions: readonly TerminalSession[];
  bindings: Pick<TerminalPaneBindingStore, "get">;
  /** Current layout as rendered; the hook keeps its own ref. */
  layout: WorkbenchLayout;
  /** The host's pane close (bindings cleanup, focus hand-off). */
  closePane: (paneId: string) => void;
  onError?: (message: string) => void;
};

/**
 * The pane's × normally closes the pane after the backend confirms the
 * session is gone (`closed` event → host closes the pane). If that event is
 * lost, this fallback closes the pane once the session has left the list.
 */
const CLOSED_EVENT_FALLBACK_MS = 1500;

/**
 * Closing a terminal pane terminates its terminal (no detach back to the
 * Right Dock). Running sessions get an in-pane confirmation first; the pane
 * itself is closed by the page's `closed`-event hook so the session never
 * flashes through the dock between "pane gone" and "process gone".
 */
export function useTerminalPaneCloseFlow(params: UseTerminalPaneCloseFlowParams) {
  const { client, sessions, bindings, layout, closePane, onError } = params;
  const [pendingClose, setPendingClose] = useState<TerminalPaneCloseRequest | null>(null);
  // Values drive the effect below; refs give the async close() continuation
  // the latest snapshot without depending on the host's own ref plumbing.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const closePaneRef = useRef(closePane);
  closePaneRef.current = closePane;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const terminate = useCallback(
    (paneId: string, session: TerminalSession) => {
      if (!client) {
        closePaneRef.current(paneId);
        return;
      }
      setPendingClose((current) =>
        current?.paneId === paneId ? { ...current, busy: true } : current,
      );
      const paneStillOpen = () => Boolean(layoutRef.current.panes[paneId]);
      const sessionGone = () => !sessionsRef.current.some((entry) => entry.id === session.id);
      void client
        .close(session.id, session.projectPathKey)
        .then(() => {
          setPendingClose((current) => (current?.paneId === paneId ? null : current));
          window.setTimeout(() => {
            if (paneStillOpen() && sessionGone()) closePaneRef.current(paneId);
          }, CLOSED_EVENT_FALLBACK_MS);
        })
        .catch(async (error: unknown) => {
          // A ghost session (backend already forgot it) fails close forever;
          // verify against the live list and treat "already gone" as closed.
          const alive = await client
            .list()
            .then((live) => live.some((entry) => entry.id === session.id))
            .catch(() => true);
          setPendingClose((current) => (current?.paneId === paneId ? null : current));
          if (!alive) {
            if (paneStillOpen()) closePaneRef.current(paneId);
            return;
          }
          onErrorRef.current?.(error instanceof Error ? error.message : String(error));
        });
    },
    [client],
  );

  const requestClosePane = useCallback(
    (paneId: string) => {
      const action = resolveTerminalPaneCloseAction(
        layoutRef.current.panes[paneId],
        sessionsRef.current,
        bindings,
      );
      if (action.kind === "close-pane") {
        closePaneRef.current(paneId);
        return;
      }
      if (action.kind === "terminate") {
        terminate(paneId, action.session);
        return;
      }
      setPendingClose({ paneId, sessionId: action.session.id, busy: false });
    },
    [bindings, terminate],
  );

  const confirmClose = useCallback(() => {
    if (!pendingClose || pendingClose.busy) return;
    const session = sessionsRef.current.find((entry) => entry.id === pendingClose.sessionId);
    if (!session) {
      setPendingClose(null);
      closePaneRef.current(pendingClose.paneId);
      return;
    }
    terminate(pendingClose.paneId, session);
  }, [pendingClose, terminate]);

  const cancelClose = useCallback(() => {
    setPendingClose((current) => (current?.busy ? current : null));
  }, []);

  // The confirmation belongs to one pane/session pair: it disappears when
  // the pane is closed by other means or the session vanishes from the list.
  useEffect(() => {
    if (!pendingClose) return;
    if (!layout.panes[pendingClose.paneId]) {
      setPendingClose(null);
      return;
    }
    if (!pendingClose.busy && !sessions.some((entry) => entry.id === pendingClose.sessionId)) {
      setPendingClose(null);
    }
  }, [layout, pendingClose, sessions]);

  return { pendingClose, requestClosePane, confirmClose, cancelClose };
}
