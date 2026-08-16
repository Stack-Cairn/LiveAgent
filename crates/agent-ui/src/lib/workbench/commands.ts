import type { PaneRecord, WorkbenchEdge, WorkbenchLayout } from "./types";

export type WorkbenchOpenTarget =
  | { kind: "canvas-empty" }
  | { kind: "canvas-edge"; edge: WorkbenchEdge }
  | { kind: "pane-edge"; paneId: string; edge: WorkbenchEdge }
  | { kind: "divider"; splitId: string; edge: WorkbenchEdge };

export type WorkbenchMoveTarget =
  | Exclude<WorkbenchOpenTarget, { kind: "canvas-empty" }>
  | { kind: "pane-center"; paneId: string };

type RevisionedWorkbenchCommand = {
  expectedRevision: number;
};

export type WorkbenchCommand = RevisionedWorkbenchCommand &
  (
    | { type: "OPEN_PANE"; pane: PaneRecord; target: WorkbenchOpenTarget }
    | { type: "MOVE_PANE"; paneId: string; target: WorkbenchMoveTarget }
    | { type: "SWAP_PANES"; firstPaneId: string; secondPaneId: string }
    | { type: "CLOSE_PANE"; paneId: string }
    | { type: "RESIZE_SPLIT"; splitId: string; ratio: number }
    | { type: "EQUALIZE_SPLIT"; splitId: string }
    | { type: "FOCUS_PANE"; paneId: string }
  );

export type WorkbenchCommandErrorCode =
  | "duplicate-conversation"
  | "duplicate-surface"
  | "invalid-layout"
  | "minimum-size"
  | "pane-not-found"
  | "stale-revision"
  | "target-not-found"
  | "unsupported-surface";

export type WorkbenchCommandError = {
  code: WorkbenchCommandErrorCode;
  message: string;
  currentRevision: number;
};

export type WorkbenchCommandResult =
  | { ok: true; layout: WorkbenchLayout }
  | { ok: false; error: WorkbenchCommandError };

export function getWorkbenchRevisionError(
  layout: Pick<WorkbenchLayout, "revision">,
  expectedRevision: number,
): WorkbenchCommandError | null {
  if (Number.isInteger(expectedRevision) && expectedRevision === layout.revision) {
    return null;
  }
  return {
    code: "stale-revision",
    message: `Workbench revision changed from ${expectedRevision} to ${layout.revision}.`,
    currentRevision: layout.revision,
  };
}
