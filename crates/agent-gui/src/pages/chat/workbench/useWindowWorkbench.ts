import {
  applyWorkbenchCommand,
  decodeWorkbenchLayout,
  encodeWorkbenchLayout,
  findPaneIdByConversationId,
  findPaneIdBySurfaceKey,
  isWorkbenchLayoutValid,
  terminalLaunchSpecIsInProject,
  WORKBENCH_LAYOUT_SCHEMA_VERSION,
  type WorkbenchCommand,
  type WorkbenchCommandContext,
  type WorkbenchCommandError,
  type WorkbenchCommandResult,
  type WorkbenchGeometry,
  type WorkbenchLayout,
  type WorkbenchMoveTarget,
  type WorkbenchOpenTarget,
} from "@liveagent/ui/lib/workbench/index";
import {
  type PaneNode,
  type PaneRecord,
  type ProjectRef,
  surfaceIdentityKey,
  type TerminalWorkbenchSurface,
} from "@liveagent/ui/lib/workbench/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const WORKBENCH_LAYOUT_STORAGE_KEY = "liveagent.sessionWorkbench.layout.v1";
const PERSIST_DEBOUNCE_MS = 250;
export const ROOT_CONVERSATION_PANE_ID = "root-conversation-pane";

let paneIdCounter = 0;

function createPaneId(): string {
  paneIdCounter += 1;
  return `pane-${Date.now().toString(36)}-${paneIdCounter.toString(36)}`;
}

function conversationPaneRecord(
  paneId: string,
  conversationId: string,
  project: ProjectRef,
): PaneRecord {
  return {
    paneId,
    surface: { kind: "conversation", conversationId, project },
    view: {},
  };
}

function singlePaneLayout(conversationId: string, project: ProjectRef): WorkbenchLayout {
  return {
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    revision: 0,
    root: { type: "leaf", paneId: ROOT_CONVERSATION_PANE_ID },
    panes: {
      [ROOT_CONVERSATION_PANE_ID]: conversationPaneRecord(
        ROOT_CONVERSATION_PANE_ID,
        conversationId,
        project,
      ),
    },
    focusedPaneId: ROOT_CONVERSATION_PANE_ID,
  };
}

function removeLeaf(node: PaneNode, paneId: string): { node: PaneNode | null; found: boolean } {
  if (node.type === "leaf") {
    return node.paneId === paneId ? { node: null, found: true } : { node, found: false };
  }
  const first = removeLeaf(node.first, paneId);
  if (first.found) {
    return { node: first.node ? { ...node, first: first.node } : node.second, found: true };
  }
  const second = removeLeaf(node.second, paneId);
  if (second.found) {
    return { node: second.node ? { ...node, second: second.node } : node.first, found: true };
  }
  return { node, found: false };
}

export type LiveWorkbenchSurfaces = {
  validConversationIds: ReadonlySet<string>;
};

function surfaceIsLive(pane: PaneRecord, live: LiveWorkbenchSurfaces): boolean {
  switch (pane.surface.kind) {
    case "conversation":
      return live.validConversationIds.has(pane.surface.conversationId);
    case "localTerminal":
    case "sshTerminal":
      // A persisted launchSpec whose cwd escaped its own project can never be
      // started (the backend re-derives containment and rejects it), so the
      // pane is not live. Dropping it here also stops a tampered layout file
      // from parking an out-of-project cwd in the window as a restartable
      // placeholder.
      if (!terminalLaunchSpecIsInProject(pane.surface)) return false;
      // Terminal panes otherwise always survive restore: their launchSpec is a
      // full recovery identity. Dead sessions restore as a dormant "exited"
      // placeholder (no PTY is created until the user restarts), so keeping
      // the pane is safe even when the live-session probe failed.
      return true;
    case "unsupported":
      // Forward-compat passthrough: newer-version panes must survive restore.
      return true;
  }
}

/**
 * Drop panes whose surface no longer maps to anything live; their splits
 * collapse. Used when restoring a persisted layout against the live sidebar
 * and terminal registry.
 */
export function filterLayoutToLiveSurfaces(
  layout: WorkbenchLayout,
  live: LiveWorkbenchSurfaces,
): WorkbenchLayout {
  let root = layout.root;
  const panes: Record<string, PaneRecord> = {};
  for (const [paneId, pane] of Object.entries(layout.panes)) {
    if (surfaceIsLive(pane, live)) {
      panes[paneId] = pane;
      continue;
    }
    if (root) {
      const removal = removeLeaf(root, paneId);
      if (removal.found) root = removal.node;
    }
  }
  const focusedPaneId =
    layout.focusedPaneId && panes[layout.focusedPaneId]
      ? layout.focusedPaneId
      : root
        ? firstLeafId(root)
        : null;
  return {
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    revision: layout.revision,
    root,
    panes: root ? panes : {},
    focusedPaneId: root ? focusedPaneId : null,
  };
}

function firstLeafId(node: PaneNode): string {
  return node.type === "leaf" ? node.paneId : firstLeafId(node.first);
}

/** First conversation pane in tree order, or null when none exists. */
function firstConversationId(layout: WorkbenchLayout): string | null {
  const walk = (node: PaneNode): string | null => {
    if (node.type === "leaf") {
      const surface = layout.panes[node.paneId]?.surface;
      return surface?.kind === "conversation" ? surface.conversationId : null;
    }
    return walk(node.first) ?? walk(node.second);
  };
  return layout.root ? walk(layout.root) : null;
}

/** Distributive omit of the CAS field; filled in from the live revision. */
type WorkbenchCommandInput = WorkbenchCommand extends infer Command
  ? Command extends WorkbenchCommand
    ? Omit<Command, "expectedRevision">
    : never
  : never;

export type WorkbenchLayoutPersistenceAdapter = {
  load(): Promise<string | null>;
  save(input: { payloadJson: string; schemaVersion: number; revision: number }): void;
  saveCorrupted(raw: string): void;
};

export type UseWindowWorkbenchParams = {
  enabled: boolean;
  initialConversationId: string;
  initialProject: ProjectRef;
  /** Native layout persistence; omitted in tests and non-workbench sessions. */
  persistence?: WorkbenchLayoutPersistenceAdapter;
  /**
   * Live canvas geometry. Supplying it turns on the reducer's pixel feasibility
   * checks (minimum pane sizes on split, per-side clamping on resize) for every
   * command this hook dispatches; omit it and the reducer stays permissive.
   */
  geometryRef?: { readonly current: WorkbenchGeometry | null };
  /** The canvas' real divider thickness; defaults to the geometry library's. */
  dividerSize?: number;
  /** Called for every rejected command, so the page can surface a reason. */
  onCommandError?: (error: WorkbenchCommandError) => void;
};

export type WorkbenchOpenConversationInput = {
  conversationId: string;
  project: ProjectRef;
};

export type WindowWorkbench = {
  layout: WorkbenchLayout;
  layoutRef: React.MutableRefObject<WorkbenchLayout>;
  paneIdForConversation(conversationId: string): string | null;
  /** Raw transaction entry point (drag commits pass their frozen revision). */
  dispatch(command: WorkbenchCommand): WorkbenchCommandResult;
  focusPane(paneId: string): PaneRecord | null;
  openConversation(
    input: WorkbenchOpenConversationInput,
    target: WorkbenchOpenTarget,
  ): { paneId: string } | null;
  /** Open a terminal surface, focusing its existing pane when already placed. */
  openTerminalSurface(
    surface: TerminalWorkbenchSurface,
    target: WorkbenchOpenTarget,
  ): { paneId: string } | null;
  movePane(paneId: string, target: WorkbenchMoveTarget): boolean;
  closePane(paneId: string): { closedFocused: boolean; nextConversationId: string | null };
  resizeSplit(splitId: string, ratio: number): void;
  equalizeSplit(splitId: string): void;
  /** Keep the focused pane bound to the page's current conversation. */
  syncCurrentConversation(conversationId: string, project: ProjectRef): void;
  /**
   * One-shot restore of the persisted layout. `focusConversationId` is null
   * when the restored layout holds no conversation pane (e.g. terminals only).
   */
  attemptRestore(
    live: LiveWorkbenchSurfaces,
  ): Promise<{ focusConversationId: string | null } | null>;
};

/**
 * Window-level workbench layout owner. The layout is authoritative for pane
 * topology and focus; the page's "current conversation" is kept equal to the
 * focused pane's conversation by `syncCurrentConversation` plus the caller
 * selecting a conversation whenever focus moves to another pane.
 */
export function useWindowWorkbench(params: UseWindowWorkbenchParams): WindowWorkbench {
  const {
    enabled,
    initialConversationId,
    initialProject,
    persistence,
    geometryRef,
    dividerSize,
    onCommandError,
  } = params;

  const [layout, setLayout] = useState<WorkbenchLayout>(() =>
    singlePaneLayout(initialConversationId, initialProject),
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const restoreAttemptedRef = useRef(false);
  // Writes stay disabled until the restore round-trip finished, so a fresh
  // boot layout cannot clobber a stored multi-pane layout mid-load.
  const restoreCompletedRef = useRef(false);
  const persistTimerRef = useRef<number | null>(null);
  const persistenceRef = useRef(persistence);
  persistenceRef.current = persistence;
  const geometrySourceRef = useRef(geometryRef);
  geometrySourceRef.current = geometryRef;
  const dividerSizeRef = useRef(dividerSize);
  dividerSizeRef.current = dividerSize;
  const commandErrorRef = useRef(onCommandError);
  commandErrorRef.current = onCommandError;

  /**
   * Pixel context for the reducer's feasibility checks, read fresh per command
   * so a resize between renders never judges against a stale canvas. Only the
   * canvas rect is used — the reducer re-derives pane rects from the tree — so
   * a geometry that lags the layout by one frame is still correct. Returns
   * undefined before the canvas has ever measured, which keeps the reducer's
   * pre-existing permissive behaviour instead of guessing a size.
   */
  const commandContext = useCallback((): WorkbenchCommandContext | undefined => {
    const canvas = geometrySourceRef.current?.current?.canvas;
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return undefined;
    return {
      canvasSize: { width: canvas.width, height: canvas.height },
      dividerSize: dividerSizeRef.current,
    };
  }, []);

  useEffect(() => {
    if (!enabled || !persistenceRef.current || !restoreCompletedRef.current) return;
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      persistenceRef.current?.save({
        payloadJson: encodeWorkbenchLayout(layout),
        schemaVersion: layout.schemaVersion,
        revision: layout.revision,
      });
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [enabled, layout]);

  const dispatch = useCallback(
    (command: WorkbenchCommand): WorkbenchCommandResult => {
      // Callers may pin their own context (a drag commit freezes the geometry
      // it previewed against); everything else picks up the live canvas.
      const contextual =
        command.context === undefined ? { ...command, context: commandContext() } : command;
      const result = applyWorkbenchCommand(layoutRef.current, contextual);
      if (result.ok) {
        layoutRef.current = result.layout;
        setLayout(result.layout);
      } else {
        commandErrorRef.current?.(result.error);
      }
      return result;
    },
    [commandContext],
  );

  const dispatchCurrent = useCallback(
    (command: WorkbenchCommandInput): WorkbenchCommandResult =>
      dispatch({
        ...command,
        expectedRevision: layoutRef.current.revision,
      } as WorkbenchCommand),
    [dispatch],
  );

  const paneIdForConversation = useCallback(
    (conversationId: string) => findPaneIdByConversationId(layoutRef.current, conversationId),
    [],
  );

  const focusPane = useCallback(
    (paneId: string): PaneRecord | null => {
      const pane = layoutRef.current.panes[paneId];
      if (!pane) return null;
      dispatchCurrent({ type: "FOCUS_PANE", paneId });
      return pane;
    },
    [dispatchCurrent],
  );

  const openConversation = useCallback(
    (
      input: WorkbenchOpenConversationInput,
      target: WorkbenchOpenTarget,
    ): { paneId: string } | null => {
      const existingPaneId = findPaneIdByConversationId(layoutRef.current, input.conversationId);
      if (existingPaneId) {
        dispatchCurrent({ type: "FOCUS_PANE", paneId: existingPaneId });
        return { paneId: existingPaneId };
      }
      const paneId = createPaneId();
      const result = dispatchCurrent({
        type: "OPEN_PANE",
        pane: conversationPaneRecord(paneId, input.conversationId, input.project),
        target,
      });
      return result.ok ? { paneId } : null;
    },
    [dispatchCurrent],
  );

  const openTerminalSurface = useCallback(
    (surface: TerminalWorkbenchSurface, target: WorkbenchOpenTarget): { paneId: string } | null => {
      const existingPaneId = findPaneIdBySurfaceKey(layoutRef.current, surfaceIdentityKey(surface));
      if (existingPaneId) {
        dispatchCurrent({ type: "FOCUS_PANE", paneId: existingPaneId });
        return { paneId: existingPaneId };
      }
      const paneId = createPaneId();
      const result = dispatchCurrent({
        type: "OPEN_PANE",
        pane: { paneId, surface, view: {} },
        target,
      });
      return result.ok ? { paneId } : null;
    },
    [dispatchCurrent],
  );

  const movePane = useCallback(
    (paneId: string, target: WorkbenchMoveTarget): boolean => {
      const result = dispatchCurrent({ type: "MOVE_PANE", paneId, target });
      return result.ok;
    },
    [dispatchCurrent],
  );

  const closePane = useCallback(
    (paneId: string): { closedFocused: boolean; nextConversationId: string | null } => {
      const closedFocused = layoutRef.current.focusedPaneId === paneId;
      const result = dispatchCurrent({ type: "CLOSE_PANE", paneId });
      if (!result.ok) return { closedFocused: false, nextConversationId: null };
      const nextFocused = result.layout.focusedPaneId;
      const nextPane = nextFocused ? result.layout.panes[nextFocused] : null;
      // Focus landing on a terminal/unsupported pane keeps the page's current
      // conversation unchanged: only conversation panes yield a next id.
      return {
        closedFocused,
        nextConversationId:
          nextPane?.surface.kind === "conversation" ? nextPane.surface.conversationId : null,
      };
    },
    [dispatchCurrent],
  );

  const resizeSplit = useCallback(
    (splitId: string, ratio: number) => {
      dispatchCurrent({ type: "RESIZE_SPLIT", splitId, ratio });
    },
    [dispatchCurrent],
  );

  const equalizeSplit = useCallback(
    (splitId: string) => {
      dispatchCurrent({ type: "EQUALIZE_SPLIT", splitId });
    },
    [dispatchCurrent],
  );

  const syncCurrentConversation = useCallback((conversationId: string, project: ProjectRef) => {
    const current = layoutRef.current;
    const key = conversationId.trim();
    if (!key) return;

    const commit = (next: WorkbenchLayout) => {
      if (!isWorkbenchLayoutValid(next)) return;
      layoutRef.current = next;
      setLayout(next);
    };

    // Empty canvas: the current conversation becomes a fresh root pane.
    if (!current.root || !current.focusedPaneId) {
      commit({
        ...singlePaneLayout(key, project),
        revision: current.revision + 1,
      });
      return;
    }

    const focusedPane = current.panes[current.focusedPaneId];
    if (!focusedPane) return;
    // Terminal/unsupported panes never host a conversation: focusing one must
    // not pull the page's current conversation into it.
    if (focusedPane.surface.kind !== "conversation") return;

    if (focusedPane.surface.conversationId === key) {
      const focusedProject = focusedPane.surface.project;
      if (
        focusedProject.projectId === project.projectId &&
        focusedProject.projectPathKey === project.projectPathKey
      ) {
        return;
      }
      commit({
        ...current,
        revision: current.revision + 1,
        panes: {
          ...current.panes,
          [focusedPane.paneId]: {
            ...focusedPane,
            surface: { kind: "conversation", conversationId: key, project },
          },
        },
      });
      return;
    }

    // Another pane already hosts the conversation: focus moves there so the
    // uniqueness invariant holds (never two panes for one conversation).
    const existingPaneId = findPaneIdByConversationId(current, key);
    if (existingPaneId) {
      commit({ ...current, revision: current.revision + 1, focusedPaneId: existingPaneId });
      return;
    }

    // The page navigated to a conversation with no pane: the focused pane
    // follows it, exactly like the legacy single-pane behaviour.
    commit({
      ...current,
      revision: current.revision + 1,
      panes: {
        ...current.panes,
        [focusedPane.paneId]: {
          ...focusedPane,
          surface: { kind: "conversation", conversationId: key, project },
        },
      },
    });
  }, []);

  const attemptRestore = useCallback(
    async (live: LiveWorkbenchSurfaces): Promise<{ focusConversationId: string | null } | null> => {
      if (restoreAttemptedRef.current) return null;
      restoreAttemptedRef.current = true;
      try {
        const adapter = persistenceRef.current;
        if (!enabled || !adapter) return null;
        let raw: string | null = null;
        try {
          raw = await adapter.load();
        } catch {
          return null;
        }
        if (!raw) return null;
        const decoded = decodeWorkbenchLayout(raw);
        if (!decoded.ok) {
          // Keep a diagnostic copy of the corrupted payload, then fall back.
          adapter.saveCorrupted(raw);
          return null;
        }
        const filtered = filterLayoutToLiveSurfaces(decoded.layout, live);
        if (!filtered.root || !filtered.focusedPaneId || !isWorkbenchLayoutValid(filtered)) {
          return null;
        }
        // Nothing to restore beyond what boot already shows.
        if (Object.keys(filtered.panes).length < 2) return null;
        // Keep revisions monotonic across sessions so persisted records keep
        // increasing rather than restarting from the boot layout's zero.
        const next = {
          ...filtered,
          revision: Math.max(filtered.revision, layoutRef.current.revision) + 1,
        };
        layoutRef.current = next;
        setLayout(next);
        const focusedPane = filtered.panes[filtered.focusedPaneId];
        // Focus restored onto a terminal/unsupported pane: fall back to the
        // first conversation pane in tree order, or null when none survive.
        return {
          focusConversationId:
            focusedPane.surface.kind === "conversation"
              ? focusedPane.surface.conversationId
              : firstConversationId(filtered),
        };
      } finally {
        restoreCompletedRef.current = true;
      }
    },
    [enabled],
  );

  return useMemo(
    () => ({
      layout,
      layoutRef,
      paneIdForConversation,
      dispatch,
      focusPane,
      openConversation,
      openTerminalSurface,
      movePane,
      closePane,
      resizeSplit,
      equalizeSplit,
      syncCurrentConversation,
      attemptRestore,
    }),
    [
      layout,
      paneIdForConversation,
      dispatch,
      focusPane,
      openConversation,
      openTerminalSurface,
      movePane,
      closePane,
      resizeSplit,
      equalizeSplit,
      syncCurrentConversation,
      attemptRestore,
    ],
  );
}
