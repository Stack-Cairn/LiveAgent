import type { WorkbenchDragPayload } from "./dragMachine";
import type { WorkbenchDropTarget, WorkbenchMoveTarget, WorkbenchOpenTarget } from "./index";
import { findPaneIdBySurfaceKey } from "./invariants";
import {
  type ProjectRef,
  type ProjectToolSurfaceKind,
  type ProjectToolWorkbenchSurface,
  projectToolSurfaceIdentityKey,
  type WorkbenchLayout,
} from "./types";

export type ProjectToolDropPayload = Extract<WorkbenchDragPayload, { kind: "projectTool" }>;

export type ProjectToolDropDeps = {
  layout: WorkbenchLayout;
  openProjectToolSurface(
    surface: ProjectToolWorkbenchSurface,
    target: WorkbenchOpenTarget,
  ): { paneId: string } | null;
  movePane(paneId: string, target: WorkbenchMoveTarget): boolean;
  focusPane(paneId: string): unknown;
};

export type ProjectToolDropResult =
  | { action: "moved" | "focused" | "opened"; paneId: string }
  | { action: "ignored" };

export function projectToolSurface(
  tool: ProjectToolSurfaceKind,
  project: ProjectRef,
): ProjectToolWorkbenchSurface {
  // The mapped union has one member per kind; a generic `{ kind, project }`
  // object is every member at once, which TS cannot infer without the cast.
  return { kind: tool, project } as ProjectToolWorkbenchSurface;
}

/**
 * Drop transaction for a singleton project tool dragged from the Right Dock
 * (or moved through the "open in split" menu):
 * - a pane already hosts the tool → dropping on that pane's center focuses
 *   it, any other target moves it, an empty canvas ignores the drop;
 * - no pane yet → open the surface at the target.
 * Identity is per scope (`projectToolSurfaceIdentityKey`), so a second
 * project's file tree opens beside the first while the same project's tool
 * only ever moves.
 */
export function commitProjectToolDrop(
  payload: ProjectToolDropPayload,
  target: WorkbenchDropTarget,
  deps: ProjectToolDropDeps,
): ProjectToolDropResult {
  const existingPaneId = findPaneIdBySurfaceKey(
    deps.layout,
    projectToolSurfaceIdentityKey(payload.tool, payload.project.projectPathKey),
  );
  if (target.kind === "pane-center") {
    if (existingPaneId && target.paneId === existingPaneId) {
      deps.focusPane(existingPaneId);
      return { action: "focused", paneId: existingPaneId };
    }
    return { action: "ignored" };
  }
  if (existingPaneId) {
    if (target.kind === "canvas-empty") return { action: "ignored" };
    return deps.movePane(existingPaneId, target)
      ? { action: "moved", paneId: existingPaneId }
      : { action: "ignored" };
  }
  const opened = deps.openProjectToolSurface(
    projectToolSurface(payload.tool, payload.project),
    target,
  );
  return opened ? { action: "opened", paneId: opened.paneId } : { action: "ignored" };
}

export type ProjectToolOpenInSplitDeps = Pick<
  ProjectToolDropDeps,
  "layout" | "openProjectToolSurface" | "focusPane"
> & {
  /** Auto-dock beside the focused pane; null when no legal split space is left. */
  resolveAutoDockTarget(): WorkbenchOpenTarget | null;
  onNoSpace(): void;
};

/**
 * Menu / keyboard entry that mirrors a drag-out without pointer geometry:
 * focus the existing pane, otherwise auto-dock a new one.
 */
export function openProjectToolInSplit(
  tool: ProjectToolSurfaceKind,
  project: ProjectRef,
  deps: ProjectToolOpenInSplitDeps,
): ProjectToolDropResult {
  const existingPaneId = findPaneIdBySurfaceKey(
    deps.layout,
    projectToolSurfaceIdentityKey(tool, project.projectPathKey),
  );
  if (existingPaneId) {
    deps.focusPane(existingPaneId);
    return { action: "focused", paneId: existingPaneId };
  }
  const target = deps.resolveAutoDockTarget();
  if (!target) {
    deps.onNoSpace();
    return { action: "ignored" };
  }
  const opened = deps.openProjectToolSurface(projectToolSurface(tool, project), target);
  return opened ? { action: "opened", paneId: opened.paneId } : { action: "ignored" };
}

/**
 * Tools currently leased by a workbench pane for `projectPathKey`. The dock
 * hides the tab/content/launcher tile of every leased tool so the interactive
 * view exists exactly once per window.
 */
export function leasedProjectToolKinds(
  layout: Pick<WorkbenchLayout, "panes">,
  projectPathKey: string,
  kinds: readonly ProjectToolSurfaceKind[],
): ReadonlySet<ProjectToolSurfaceKind> {
  const leased = new Set<ProjectToolSurfaceKind>();
  for (const kind of kinds) {
    if (findPaneIdBySurfaceKey(layout, projectToolSurfaceIdentityKey(kind, projectPathKey))) {
      leased.add(kind);
    }
  }
  return leased;
}
