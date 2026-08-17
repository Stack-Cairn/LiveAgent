import type { ReactNode } from "react";
import type { PaneGeometry, WorkbenchRect } from "../../lib/workbench/geometry";
import { paneRendersCompact } from "../../lib/workbench/geometry";
import type { PaneRecord } from "../../lib/workbench/types";
import { PaneFrame } from "./PaneFrame";

export type PaneSurfaceRenderContext = {
  isFocused: boolean;
  rect: WorkbenchRect;
  paneCount: number;
  /**
   * Derived per render from the pane rect (below the compact width threshold)
   * OR the pane's explicit `view.compactChrome` override — never written back
   * to layout state, so resize jitter cannot trigger revision churn.
   */
  isCompact: boolean;
};

export type PaneSurfaceLayerProps = {
  panes: Record<string, PaneRecord>;
  paneGeometries: readonly PaneGeometry[];
  focusedPaneId: string | null;
  renderPaneContent: (pane: PaneRecord, context: PaneSurfaceRenderContext) => ReactNode;
  renderPaneChrome?: (pane: PaneRecord, context: PaneSurfaceRenderContext) => ReactNode;
  getPaneRegionLabel: (pane: PaneRecord) => string;
  onFocusPane?: (paneId: string) => void;
};

/**
 * Flat, stable pane layer. Frames are keyed by paneId and rendered in a
 * paneId-sorted order that is independent of tree structure, so moves and
 * splits only update rects — React never remounts a surviving pane's DOM.
 */
export function PaneSurfaceLayer(props: PaneSurfaceLayerProps) {
  const {
    panes,
    paneGeometries,
    focusedPaneId,
    renderPaneContent,
    renderPaneChrome,
    getPaneRegionLabel,
    onFocusPane,
  } = props;

  const ordered = [...paneGeometries].sort((a, b) => a.paneId.localeCompare(b.paneId));
  const paneCount = ordered.length;

  return (
    <>
      {ordered.map(({ paneId, rect }) => {
        const pane = panes[paneId];
        if (!pane) return null;
        const context: PaneSurfaceRenderContext = {
          isFocused: focusedPaneId === paneId,
          rect,
          paneCount,
          isCompact: paneRendersCompact(rect.width, pane.view),
        };
        return (
          <PaneFrame
            key={paneId}
            paneId={paneId}
            rect={rect}
            isFocused={context.isFocused}
            chromeless={paneCount < 2}
            regionLabel={getPaneRegionLabel(pane)}
            onFocusRequest={
              onFocusPane && !context.isFocused ? () => onFocusPane(paneId) : undefined
            }
            chrome={renderPaneChrome?.(pane, context) ?? null}
          >
            {renderPaneContent(pane, context)}
          </PaneFrame>
        );
      })}
    </>
  );
}
