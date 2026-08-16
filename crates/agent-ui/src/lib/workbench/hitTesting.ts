import {
  type DividerGeometry,
  type WorkbenchGeometry,
  type WorkbenchRect,
  workbenchRectContains,
} from "./geometry";
import type { WorkbenchEdge } from "./types";

export type WorkbenchDropTarget =
  | { kind: "canvas-empty" }
  | { kind: "canvas-edge"; edge: WorkbenchEdge }
  | { kind: "divider"; splitId: string; edge: WorkbenchEdge }
  | { kind: "pane-edge"; paneId: string; edge: WorkbenchEdge }
  | { kind: "pane-center"; paneId: string };

export type WorkbenchHitTestOptions = {
  /** Width of the canvas-edge band, in CSS pixels. */
  canvasEdgeInset?: number;
  /** Fraction of a pane rect that counts as its edge band (0..0.5). */
  paneEdgeFraction?: number;
  /** Extra padding around divider rects to make them easier to hit. */
  dividerHitPadding?: number;
};

const DEFAULT_CANVAS_EDGE_INSET = 16;
const DEFAULT_PANE_EDGE_FRACTION = 0.24;
const DEFAULT_DIVIDER_HIT_PADDING = 4;

function inflateRect(rect: WorkbenchRect, amount: number): WorkbenchRect {
  return {
    left: rect.left - amount,
    top: rect.top - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

function dividerEdge(divider: DividerGeometry, x: number, y: number): WorkbenchEdge {
  if (divider.axis === "horizontal") {
    return x < divider.rect.left + divider.rect.width / 2 ? "left" : "right";
  }
  return y < divider.rect.top + divider.rect.height / 2 ? "top" : "bottom";
}

/**
 * Resolve the drop target for a pointer position against a frozen geometry
 * snapshot. Priority: canvas-edge > divider > pane-edge > pane-center.
 * Returns null when the pointer is outside the canvas.
 */
export function hitTestWorkbenchDrop(
  geometry: WorkbenchGeometry,
  x: number,
  y: number,
  options?: WorkbenchHitTestOptions,
): WorkbenchDropTarget | null {
  const { canvas } = geometry;
  if (!workbenchRectContains(canvas, x, y)) return null;
  if (geometry.panes.length === 0) return { kind: "canvas-empty" };

  const inset = options?.canvasEdgeInset ?? DEFAULT_CANVAS_EDGE_INSET;
  const distances: Array<[WorkbenchEdge, number]> = [
    ["left", x - canvas.left],
    ["right", canvas.left + canvas.width - x],
    ["top", y - canvas.top],
    ["bottom", canvas.top + canvas.height - y],
  ];
  let nearestEdge: WorkbenchEdge | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [edge, distance] of distances) {
    if (distance <= inset && distance < nearestDistance) {
      nearestEdge = edge;
      nearestDistance = distance;
    }
  }
  if (nearestEdge) return { kind: "canvas-edge", edge: nearestEdge };

  const dividerPadding = options?.dividerHitPadding ?? DEFAULT_DIVIDER_HIT_PADDING;
  for (const divider of geometry.dividers) {
    if (workbenchRectContains(inflateRect(divider.rect, dividerPadding), x, y)) {
      return { kind: "divider", splitId: divider.splitId, edge: dividerEdge(divider, x, y) };
    }
  }

  const fraction = Math.min(
    0.5,
    Math.max(0, options?.paneEdgeFraction ?? DEFAULT_PANE_EDGE_FRACTION),
  );
  for (const pane of geometry.panes) {
    if (!workbenchRectContains(pane.rect, x, y)) continue;
    const bandX = pane.rect.width * fraction;
    const bandY = pane.rect.height * fraction;
    const paneDistances: Array<[WorkbenchEdge, number, number]> = [
      ["left", x - pane.rect.left, bandX],
      ["right", pane.rect.left + pane.rect.width - x, bandX],
      ["top", y - pane.rect.top, bandY],
      ["bottom", pane.rect.top + pane.rect.height - y, bandY],
    ];
    let paneEdge: WorkbenchEdge | null = null;
    let paneEdgeScore = Number.POSITIVE_INFINITY;
    for (const [edge, distance, band] of paneDistances) {
      if (band <= 0) continue;
      const score = distance / band;
      if (distance <= band && score < paneEdgeScore) {
        paneEdge = edge;
        paneEdgeScore = score;
      }
    }
    if (paneEdge) return { kind: "pane-edge", paneId: pane.paneId, edge: paneEdge };
    return { kind: "pane-center", paneId: pane.paneId };
  }
  return null;
}

function halfRect(rect: WorkbenchRect, edge: WorkbenchEdge): WorkbenchRect {
  switch (edge) {
    case "left":
      return { ...rect, width: Math.floor(rect.width / 2) };
    case "right": {
      const width = Math.floor(rect.width / 2);
      return { ...rect, left: rect.left + rect.width - width, width };
    }
    case "top":
      return { ...rect, height: Math.floor(rect.height / 2) };
    case "bottom": {
      const height = Math.floor(rect.height / 2);
      return { ...rect, top: rect.top + rect.height - height, height };
    }
  }
}

/**
 * The final rect a drop would produce, for the drop preview overlay.
 * Mirrors the reducer's 0.5-ratio insertion semantics.
 */
export function previewRectForDropTarget(
  geometry: WorkbenchGeometry,
  target: WorkbenchDropTarget,
): WorkbenchRect | null {
  switch (target.kind) {
    case "canvas-empty":
      return geometry.canvas;
    case "canvas-edge":
      return halfRect(geometry.canvas, target.edge);
    case "pane-edge": {
      const pane = geometry.panes.find((item) => item.paneId === target.paneId);
      return pane ? halfRect(pane.rect, target.edge) : null;
    }
    case "pane-center": {
      const pane = geometry.panes.find((item) => item.paneId === target.paneId);
      return pane ? pane.rect : null;
    }
    case "divider": {
      const divider = geometry.dividers.find((item) => item.splitId === target.splitId);
      if (!divider) return null;
      const { splitArea, rect, axis } = divider;
      if (axis === "horizontal") {
        const firstRegion: WorkbenchRect = {
          ...splitArea,
          width: rect.left - splitArea.left,
        };
        const secondRegion: WorkbenchRect = {
          ...splitArea,
          left: rect.left + rect.width,
          width: splitArea.left + splitArea.width - (rect.left + rect.width),
        };
        return target.edge === "left" || target.edge === "top"
          ? halfRect(firstRegion, "right")
          : halfRect(secondRegion, "left");
      }
      const firstRegion: WorkbenchRect = {
        ...splitArea,
        height: rect.top - splitArea.top,
      };
      const secondRegion: WorkbenchRect = {
        ...splitArea,
        top: rect.top + rect.height,
        height: splitArea.top + splitArea.height - (rect.top + rect.height),
      };
      return target.edge === "top" || target.edge === "left"
        ? halfRect(firstRegion, "bottom")
        : halfRect(secondRegion, "top");
    }
  }
}
