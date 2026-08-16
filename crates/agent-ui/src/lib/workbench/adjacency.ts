import type { WorkbenchGeometry, WorkbenchRect } from "./geometry";
import type { WorkbenchEdge } from "./types";

function perpendicularOverlap(a: WorkbenchRect, b: WorkbenchRect, horizontal: boolean): number {
  if (horizontal) {
    return Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  }
  return Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
}

/**
 * Find the spatially adjacent pane in `direction` for keyboard focus moves.
 * Candidates must start past the source rect in that direction; the winner is
 * the nearest one, with perpendicular overlap breaking ties.
 */
export function findAdjacentPaneId(
  geometry: WorkbenchGeometry,
  fromPaneId: string,
  direction: WorkbenchEdge,
): string | null {
  const from = geometry.panes.find((pane) => pane.paneId === fromPaneId);
  if (!from) return null;
  const horizontal = direction === "left" || direction === "right";

  let bestPaneId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestOverlap = Number.NEGATIVE_INFINITY;
  for (const pane of geometry.panes) {
    if (pane.paneId === fromPaneId) continue;
    let distance: number;
    switch (direction) {
      case "left":
        distance = from.rect.left - (pane.rect.left + pane.rect.width);
        break;
      case "right":
        distance = pane.rect.left - (from.rect.left + from.rect.width);
        break;
      case "top":
        distance = from.rect.top - (pane.rect.top + pane.rect.height);
        break;
      case "bottom":
        distance = pane.rect.top - (from.rect.top + from.rect.height);
        break;
    }
    if (distance < 0) continue;
    const overlap = perpendicularOverlap(from.rect, pane.rect, horizontal);
    if (overlap <= 0) continue;
    if (distance < bestDistance || (distance === bestDistance && overlap > bestOverlap)) {
      bestPaneId = pane.paneId;
      bestDistance = distance;
      bestOverlap = overlap;
    }
  }
  return bestPaneId;
}
