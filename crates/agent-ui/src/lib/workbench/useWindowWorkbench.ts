import { useCallback, useMemo, useRef, useState } from "react";
import {
  applyWorkbenchCommand,
  findPaneIdByConversationId,
  findPaneIdBySurfaceKey,
  isWorkbenchLayoutValid,
  type WorkbenchCommand,
  type WorkbenchCommandContext,
  type WorkbenchCommandError,
  type WorkbenchCommandResult,
  type WorkbenchGeometry,
  type WorkbenchMoveTarget,
  type WorkbenchOpenTarget,
} from "./index";
import {
  type FileTreeWorkbenchSurface,
  type PaneRecord,
  type ProjectRef,
  surfaceIdentityKey,
  type TerminalWorkbenchSurface,
  WORKBENCH_LAYOUT_SCHEMA_VERSION,
  type WorkbenchLayout,
} from "./types";

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

/**
 * Draft promotion: rebind the pane hosting `fromConversationId` to
 * `toConversationId` in place. Topology, focus and view state are preserved so
 * the pane (and its DOM) never remounts. Returns null when nothing must change
 * (blank/identical ids, no pane hosts the source) or when the rename would
 * break the one-pane-per-conversation invariant (target already hosted).
 */
export function renameWorkbenchConversation(
  layout: WorkbenchLayout,
  fromConversationId: string,
  toConversationId: string,
): WorkbenchLayout | null {
  const from = fromConversationId.trim();
  const to = toConversationId.trim();
  if (!from || !to || from === to) return null;
  const paneId = findPaneIdByConversationId(layout, from);
  if (!paneId) return null;
  if (findPaneIdByConversationId(layout, to)) return null;
  const pane = layout.panes[paneId];
  if (!pane || pane.surface.kind !== "conversation") return null;
  const next: WorkbenchLayout = {
    ...layout,
    revision: layout.revision + 1,
    panes: {
      ...layout.panes,
      [paneId]: { ...pane, surface: { ...pane.surface, conversationId: to } },
    },
  };
  return isWorkbenchLayoutValid(next) ? next : null;
}

/** Distributive omit of the CAS field; filled in from the live revision. */
type WorkbenchCommandInput = WorkbenchCommand extends infer Command
  ? Command extends WorkbenchCommand
    ? Omit<Command, "expectedRevision">
    : never
  : never;

export type UseWindowWorkbenchParams = {
  initialConversationId: string;
  initialProject: ProjectRef;
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
  /** Open the project's singleton file tree surface. */
  openFileTreeSurface(
    surface: FileTreeWorkbenchSurface,
    target: WorkbenchOpenTarget,
  ): { paneId: string } | null;
  movePane(paneId: string, target: WorkbenchMoveTarget): boolean;
  /** Draft promotion: rebind the pane hosting `fromId` to `toId` in place. */
  renameConversation(fromConversationId: string, toConversationId: string): void;
  closePane(paneId: string): { closedFocused: boolean; nextConversationId: string | null };
  resizeSplit(splitId: string, ratio: number): void;
  equalizeSplit(splitId: string): void;
  /** Keep the focused pane bound to the page's current conversation. */
  syncCurrentConversation(conversationId: string, project: ProjectRef): void;
};

/**
 * Window-level workbench layout owner. The layout is authoritative for pane
 * topology and focus; the page's "current conversation" is kept equal to the
 * focused pane's conversation by `syncCurrentConversation` plus the caller
 * selecting a conversation whenever focus moves to another pane.
 */
export function useWindowWorkbench(params: UseWindowWorkbenchParams): WindowWorkbench {
  const { initialConversationId, initialProject, geometryRef, dividerSize, onCommandError } =
    params;

  const [layout, setLayout] = useState<WorkbenchLayout>(() =>
    singlePaneLayout(initialConversationId, initialProject),
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
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

  const openFileTreeSurface = useCallback(
    (surface: FileTreeWorkbenchSurface, target: WorkbenchOpenTarget): { paneId: string } | null => {
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

  const renameConversation = useCallback((fromConversationId: string, toConversationId: string) => {
    const next = renameWorkbenchConversation(
      layoutRef.current,
      fromConversationId,
      toConversationId,
    );
    if (!next) return;
    layoutRef.current = next;
    setLayout(next);
  }, []);

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

  return useMemo(
    () => ({
      layout,
      layoutRef,
      paneIdForConversation,
      dispatch,
      focusPane,
      openConversation,
      openTerminalSurface,
      openFileTreeSurface,
      movePane,
      renameConversation,
      closePane,
      resizeSplit,
      equalizeSplit,
      syncCurrentConversation,
    }),
    [
      layout,
      paneIdForConversation,
      dispatch,
      focusPane,
      openConversation,
      openTerminalSurface,
      openFileTreeSurface,
      movePane,
      renameConversation,
      closePane,
      resizeSplit,
      equalizeSplit,
      syncCurrentConversation,
    ],
  );
}
