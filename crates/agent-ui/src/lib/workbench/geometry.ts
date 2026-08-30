import type {
  PaneNode,
  PaneRecord,
  WorkbenchAxis,
  WorkbenchEdge,
  WorkbenchSurfaceSpec,
} from "./types";

/** Integer CSS-pixel rectangle relative to the workbench canvas origin. */
export type WorkbenchRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type PaneGeometry = {
  paneId: string;
  rect: WorkbenchRect;
};

export type DividerGeometry = {
  splitId: string;
  axis: WorkbenchAxis;
  /** The visual/hit rect of the divider itself. */
  rect: WorkbenchRect;
  /** The rect of the whole split region the divider belongs to. */
  splitArea: WorkbenchRect;
};

export type WorkbenchGeometry = {
  canvas: WorkbenchRect;
  panes: PaneGeometry[];
  dividers: DividerGeometry[];
};

export const WORKBENCH_DIVIDER_SIZE = 8;
export const WORKBENCH_MIN_SPLIT_RATIO = 0.05;
export const WORKBENCH_MAX_SPLIT_RATIO = 0.95;
export const MIN_CONVERSATION_PANE_WIDTH = 320;
export const MIN_CONVERSATION_PANE_HEIGHT = 220;
// Terminal panes: xterm renders at fontSize 13 / lineHeight 1.3, i.e. cells of
// ~8px × 17px. A terminal stops being usable below ~20 cols × 6 rows, so with
// horizontal padding and the chrome strip that folds to 220×140 CSS pixels.
export const MIN_TERMINAL_PANE_WIDTH = 220;
export const MIN_TERMINAL_PANE_HEIGHT = 140;
export const MIN_FILE_TREE_PANE_WIDTH = 240;
export const MIN_FILE_TREE_PANE_HEIGHT = 180;
// Unsupported placeholders only show a short message; keep them small enough
// to never block a restore.
export const MIN_UNSUPPORTED_PANE_WIDTH = 160;
export const MIN_UNSUPPORTED_PANE_HEIGHT = 120;
/** Below this pane width the chrome and surfaces switch to compact rendering. */
export const WORKBENCH_COMPACT_PANE_WIDTH = 360;

export type SurfaceMinSize = { minWidth: number; minHeight: number };

/** Hard minimum CSS-pixel size a pane must keep, resolved per surface kind. */
export function surfaceMinSize(surface: WorkbenchSurfaceSpec): SurfaceMinSize {
  switch (surface.kind) {
    case "fileTree":
      return { minWidth: MIN_FILE_TREE_PANE_WIDTH, minHeight: MIN_FILE_TREE_PANE_HEIGHT };
    case "localTerminal":
    case "sshTerminal":
      return { minWidth: MIN_TERMINAL_PANE_WIDTH, minHeight: MIN_TERMINAL_PANE_HEIGHT };
    case "unsupported":
      return { minWidth: MIN_UNSUPPORTED_PANE_WIDTH, minHeight: MIN_UNSUPPORTED_PANE_HEIGHT };
    default:
      return { minWidth: MIN_CONVERSATION_PANE_WIDTH, minHeight: MIN_CONVERSATION_PANE_HEIGHT };
  }
}

export function surfaceMinSizeForAxis(surface: WorkbenchSurfaceSpec, axis: WorkbenchAxis): number {
  const size = surfaceMinSize(surface);
  return axis === "horizontal" ? size.minWidth : size.minHeight;
}

/**
 * Minimum extent a subtree needs along `axis`: leaves resolve their surface's
 * hard minimum, same-axis splits sum both sides plus the divider, cross-axis
 * splits take the larger side. Panes missing from `panes` (corrupt layouts)
 * fall back to the conversation minimum — the strictest default.
 */
export function subtreeMinSizeForAxis(
  node: PaneNode | null,
  panes: Record<string, PaneRecord>,
  axis: WorkbenchAxis,
  dividerSize: number = WORKBENCH_DIVIDER_SIZE,
): number {
  if (!node) return 0;
  if (node.type === "leaf") {
    const pane = panes[node.paneId];
    return pane ? surfaceMinSizeForAxis(pane.surface, axis) : minPaneSizeForAxis(axis);
  }
  const first = subtreeMinSizeForAxis(node.first, panes, axis, dividerSize);
  const second = subtreeMinSizeForAxis(node.second, panes, axis, dividerSize);
  return node.axis === axis ? first + dividerSize + second : Math.max(first, second);
}

/** Whether a pane rect is narrow enough for compact chrome/surface rendering. */
export function paneRendersCompact(rectWidth: number): boolean {
  return rectWidth < WORKBENCH_COMPACT_PANE_WIDTH;
}

export function workbenchEdgeAxis(edge: WorkbenchEdge): WorkbenchAxis {
  return edge === "left" || edge === "right" ? "horizontal" : "vertical";
}

/**
 * Hard minimum a pane must keep along `axis` for the layout to stay usable.
 * Conversation-sized: the historical default when no surface is in scope.
 */
export function minPaneSizeForAxis(axis: WorkbenchAxis): number {
  return axis === "horizontal" ? MIN_CONVERSATION_PANE_WIDTH : MIN_CONVERSATION_PANE_HEIGHT;
}

/**
 * Whether halving `rect` along `axis` leaves room for an incoming surface on
 * one side and the region's existing content on the other. Splits always
 * start at ratio 0.5, so each side gets exactly half the usable extent.
 */
export function canSplitRectForMinSizes(input: {
  rect: WorkbenchRect;
  axis: WorkbenchAxis;
  incomingMin: number;
  existingMin: number;
  dividerSize?: number;
}): boolean {
  const dividerSize = input.dividerSize ?? WORKBENCH_DIVIDER_SIZE;
  const total = (input.axis === "horizontal" ? input.rect.width : input.rect.height) - dividerSize;
  const half = total / 2;
  return half >= input.incomingMin && half >= input.existingMin;
}

/**
 * Whether halving `rect` along `axis` leaves both sides at or above the hard
 * minimum. Splits always start at ratio 0.5, so this is the exact feasibility
 * test for inserting a pane into that region.
 */
export function canSplitRectOnAxis(
  rect: WorkbenchRect,
  axis: WorkbenchAxis,
  dividerSize: number = WORKBENCH_DIVIDER_SIZE,
): boolean {
  const min = minPaneSizeForAxis(axis);
  return canSplitRectForMinSizes({ rect, axis, incomingMin: min, existingMin: min, dividerSize });
}

/** Drop targets that insert a new pane by splitting an existing region. */
export type WorkbenchSplitTarget =
  | { kind: "canvas-edge"; edge: WorkbenchEdge }
  | { kind: "pane-edge"; paneId: string; edge: WorkbenchEdge }
  | { kind: "divider"; splitId: string; edge: WorkbenchEdge };

/**
 * The region a split target would halve, plus the axis it is halved along.
 * Returns null when the target no longer exists in `geometry` — callers treat
 * that as a missing target rather than a space failure.
 */
export function splitRegionForTarget(
  geometry: WorkbenchGeometry,
  target: WorkbenchSplitTarget,
): { rect: WorkbenchRect; axis: WorkbenchAxis } | null {
  if (target.kind === "canvas-edge") {
    return { rect: geometry.canvas, axis: workbenchEdgeAxis(target.edge) };
  }
  if (target.kind === "pane-edge") {
    const pane = geometry.panes.find((entry) => entry.paneId === target.paneId);
    return pane ? { rect: pane.rect, axis: workbenchEdgeAxis(target.edge) } : null;
  }
  const divider = geometry.dividers.find((entry) => entry.splitId === target.splitId);
  if (!divider) return null;
  // A divider insert halves the region on the chosen side of the bar, along
  // the existing split's own axis.
  const before = target.edge === "left" || target.edge === "top";
  const { rect: bar, splitArea } = divider;
  const rect: WorkbenchRect =
    divider.axis === "horizontal"
      ? before
        ? { ...splitArea, width: bar.left - splitArea.left }
        : {
            ...splitArea,
            left: bar.left + bar.width,
            width: splitArea.left + splitArea.width - (bar.left + bar.width),
          }
      : before
        ? { ...splitArea, height: bar.top - splitArea.top }
        : {
            ...splitArea,
            top: bar.top + bar.height,
            height: splitArea.top + splitArea.height - (bar.top + bar.height),
          };
  return { rect, axis: divider.axis };
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(WORKBENCH_MAX_SPLIT_RATIO, Math.max(WORKBENCH_MIN_SPLIT_RATIO, ratio));
}

/**
 * Clamp a proposed split ratio so both sides keep at least `minSize` CSS
 * pixels along the split axis. Falls back to plain ratio clamping when the
 * region is too small to honour the minimum on both sides.
 */
export function clampRatioToMinSize(input: {
  ratio: number;
  axis: WorkbenchAxis;
  splitArea: WorkbenchRect;
  minSize: number;
  dividerSize?: number;
}): number {
  return clampRatioToSideMinSizes({
    ratio: input.ratio,
    axis: input.axis,
    splitArea: input.splitArea,
    firstMin: input.minSize,
    secondMin: input.minSize,
    dividerSize: input.dividerSize,
  });
}

/**
 * Clamp a proposed split ratio so each side keeps its own minimum extent —
 * the per-kind divider clamp (a terminal side may compress further than a
 * conversation side). Falls back to the plain 0.05–0.95 clamp when the region
 * cannot honour both minimums (e.g. a very small window).
 */
export function clampRatioToSideMinSizes(input: {
  ratio: number;
  axis: WorkbenchAxis;
  splitArea: WorkbenchRect;
  firstMin: number;
  secondMin: number;
  dividerSize?: number;
}): number {
  const dividerSize = input.dividerSize ?? WORKBENCH_DIVIDER_SIZE;
  const total =
    (input.axis === "horizontal" ? input.splitArea.width : input.splitArea.height) - dividerSize;
  const base = clampSplitRatio(input.ratio);
  if (total <= 0) return base;
  if (input.firstMin + input.secondMin >= total) {
    // Degenerate region: fall back to the symmetric behaviour so tiny
    // windows still resize instead of pinning the divider.
    const minRatio = Math.max(input.firstMin, input.secondMin) / total;
    if (minRatio * 2 >= 1) return 0.5;
    return Math.min(1 - minRatio, Math.max(minRatio, base));
  }
  const lower = input.firstMin / total;
  const upper = 1 - input.secondMin / total;
  return Math.min(upper, Math.max(lower, base));
}

export function roundWorkbenchRect(rect: WorkbenchRect): WorkbenchRect {
  const left = Math.round(rect.left);
  const top = Math.round(rect.top);
  return {
    left,
    top,
    width: Math.max(0, Math.round(rect.left + rect.width) - left),
    height: Math.max(0, Math.round(rect.top + rect.height) - top),
  };
}

export function workbenchRectContains(rect: WorkbenchRect, x: number, y: number): boolean {
  return (
    x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height
  );
}

/**
 * Compute integer-pixel pane and divider rects for a pane tree.
 *
 * The first child receives `floor(usable * ratio)` and the second child the
 * exact remainder, so panes and dividers tile the canvas with no gaps and no
 * overlaps regardless of ratio precision.
 */
export function computeWorkbenchGeometry(
  root: PaneNode | null,
  canvas: WorkbenchRect,
  options?: { dividerSize?: number },
): WorkbenchGeometry {
  const dividerSize = Math.max(0, Math.round(options?.dividerSize ?? WORKBENCH_DIVIDER_SIZE));
  const normalizedCanvas = roundWorkbenchRect(canvas);
  const panes: PaneGeometry[] = [];
  const dividers: DividerGeometry[] = [];

  const visit = (node: PaneNode, area: WorkbenchRect) => {
    if (node.type === "leaf") {
      panes.push({ paneId: node.paneId, rect: area });
      return;
    }
    const ratio = clampSplitRatio(node.ratio);
    let firstRect: WorkbenchRect;
    let dividerRect: WorkbenchRect;
    let secondRect: WorkbenchRect;
    if (node.axis === "horizontal") {
      const usable = Math.max(0, area.width - dividerSize);
      const firstWidth = Math.floor(usable * ratio);
      firstRect = { left: area.left, top: area.top, width: firstWidth, height: area.height };
      dividerRect = {
        left: area.left + firstWidth,
        top: area.top,
        width: Math.min(dividerSize, area.width - firstWidth),
        height: area.height,
      };
      secondRect = {
        left: dividerRect.left + dividerRect.width,
        top: area.top,
        width: Math.max(0, area.left + area.width - (dividerRect.left + dividerRect.width)),
        height: area.height,
      };
    } else {
      const usable = Math.max(0, area.height - dividerSize);
      const firstHeight = Math.floor(usable * ratio);
      firstRect = { left: area.left, top: area.top, width: area.width, height: firstHeight };
      dividerRect = {
        left: area.left,
        top: area.top + firstHeight,
        width: area.width,
        height: Math.min(dividerSize, area.height - firstHeight),
      };
      secondRect = {
        left: area.left,
        top: dividerRect.top + dividerRect.height,
        width: area.width,
        height: Math.max(0, area.top + area.height - (dividerRect.top + dividerRect.height)),
      };
    }
    dividers.push({ splitId: node.splitId, axis: node.axis, rect: dividerRect, splitArea: area });
    visit(node.first, firstRect);
    visit(node.second, secondRect);
  };

  if (root) {
    visit(root, normalizedCanvas);
  }
  return { canvas: normalizedCanvas, panes, dividers };
}
