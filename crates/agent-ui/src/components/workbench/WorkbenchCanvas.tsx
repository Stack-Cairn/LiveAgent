import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/shared/utils";
import {
  computeWorkbenchGeometry,
  subtreeMinSizeForAxis,
  type WorkbenchGeometry,
  type WorkbenchRect,
} from "../../lib/workbench/geometry";

import type { PaneNode, PaneRecord, WorkbenchLayout } from "../../lib/workbench/types";
import { DividerLayer, type DividerSideMinSizes } from "./DividerLayer";
import { DockIntentOverlay } from "./DockIntentOverlay";
import { PaneSurfaceLayer, type PaneSurfaceRenderContext } from "./PaneSurfaceLayer";

/**
 * Visual gutter between panes. The gutter shares the canvas background with a
 * centered hairline, so panes read as flush surfaces separated by a 1px rule.
 */
export const WORKBENCH_CANVAS_DIVIDER_SIZE = 6;

export type WorkbenchCanvasLabels = {
  paneRegion: (pane: PaneRecord) => string;
  separator: string;
};

export type WorkbenchCanvasProps = {
  layout: WorkbenchLayout;
  labels: WorkbenchCanvasLabels;
  renderPaneContent: (pane: PaneRecord, context: PaneSurfaceRenderContext) => ReactNode;
  renderPaneChrome?: (pane: PaneRecord, context: PaneSurfaceRenderContext) => ReactNode;
  /** Commit a divider resize (one layout transaction per pointer-up). */
  onResizeSplit?: (splitId: string, ratio: number) => void;
  /** Double-click on a divider equalizes its split. */
  onEqualizeSplit?: (splitId: string) => void;
  onFocusPane?: (paneId: string) => void;
  /** Reported whenever the frozen-able geometry snapshot changes. */
  onGeometryChange?: (geometry: WorkbenchGeometry) => void;
  dropPreview?: { rect: WorkbenchRect; label?: string } | null;
  emptyState?: ReactNode;
  dividerSize?: number;
  minPaneWidth?: number;
  minPaneHeight?: number;
  className?: string;
};

function withRatioOverride(node: PaneNode | null, splitId: string, ratio: number): PaneNode | null {
  if (!node || node.type === "leaf") return node;
  if (node.splitId === splitId) return { ...node, ratio };
  return {
    ...node,
    first: withRatioOverride(node.first, splitId, ratio) as PaneNode,
    second: withRatioOverride(node.second, splitId, ratio) as PaneNode,
  };
}

function findSplitNode(
  node: PaneNode | null,
  splitId: string,
): Extract<PaneNode, { type: "split" }> | null {
  if (!node || node.type === "leaf") return null;
  if (node.splitId === splitId) return node;
  return findSplitNode(node.first, splitId) ?? findSplitNode(node.second, splitId);
}

/**
 * Window-level pane canvas: measures itself, turns the pane tree into
 * integer-pixel rects, and renders the stable surface, divider and preview
 * layers. Divider drags preview locally at frame rate and commit exactly one
 * layout transaction on pointer-up.
 */
export function WorkbenchCanvas(props: WorkbenchCanvasProps) {
  const {
    layout,
    labels,
    renderPaneContent,
    renderPaneChrome,
    onResizeSplit,
    onEqualizeSplit,
    onFocusPane,
    onGeometryChange,
    dropPreview,
    emptyState,
    dividerSize = WORKBENCH_CANVAS_DIVIDER_SIZE,
    minPaneWidth,
    minPaneHeight,
    className,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const [resizePreview, setResizePreview] = useState<{ splitId: string; ratio: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setCanvasSize((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const previewRoot = useMemo(() => {
    if (!resizePreview) return layout.root;
    return withRatioOverride(layout.root, resizePreview.splitId, resizePreview.ratio);
  }, [layout.root, resizePreview]);

  const geometry = useMemo<WorkbenchGeometry | null>(() => {
    if (!canvasSize || canvasSize.width <= 0 || canvasSize.height <= 0) return null;
    return computeWorkbenchGeometry(
      previewRoot,
      { left: 0, top: 0, width: canvasSize.width, height: canvasSize.height },
      { dividerSize },
    );
  }, [previewRoot, canvasSize, dividerSize]);

  // Only committed (non-preview) geometry is a valid drag-freeze snapshot.
  const committedGeometry = useMemo<WorkbenchGeometry | null>(() => {
    if (!resizePreview) return geometry;
    if (!canvasSize || canvasSize.width <= 0 || canvasSize.height <= 0) return null;
    return computeWorkbenchGeometry(
      layout.root,
      { left: 0, top: 0, width: canvasSize.width, height: canvasSize.height },
      { dividerSize },
    );
  }, [geometry, resizePreview, layout.root, canvasSize, dividerSize]);

  useLayoutEffect(() => {
    if (committedGeometry) onGeometryChange?.(committedGeometry);
  }, [committedGeometry, onGeometryChange]);

  const handleResizePreview = useCallback((splitId: string, ratio: number) => {
    setResizePreview({ splitId, ratio });
  }, []);

  const handleResizeCommit = useCallback(
    (splitId: string, ratio: number) => {
      setResizePreview(null);
      onResizeSplit?.(splitId, ratio);
    },
    [onResizeSplit],
  );

  const getPaneRegionLabel = useCallback((pane: PaneRecord) => labels.paneRegion(pane), [labels]);

  // Per-split side minimums (per-kind subtree sums) for the divider clamp: a
  // terminal side may compress further than a conversation side.
  const minSizesForSplit = useCallback(
    (splitId: string): DividerSideMinSizes | null => {
      const split = findSplitNode(layout.root, splitId);
      if (!split) return null;
      return {
        firstMin: subtreeMinSizeForAxis(split.first, layout.panes, split.axis, dividerSize),
        secondMin: subtreeMinSizeForAxis(split.second, layout.panes, split.axis, dividerSize),
      };
    },
    [layout.root, layout.panes, dividerSize],
  );

  return (
    <div
      ref={containerRef}
      data-workbench-canvas=""
      className={cn("relative flex-1 min-h-0 min-w-0 overflow-hidden bg-background", className)}
    >
      {layout.root === null || !geometry ? (
        layout.root === null ? (
          emptyState
        ) : null
      ) : (
        <>
          <PaneSurfaceLayer
            panes={layout.panes}
            paneGeometries={geometry.panes}
            focusedPaneId={layout.focusedPaneId}
            renderPaneContent={renderPaneContent}
            renderPaneChrome={renderPaneChrome}
            getPaneRegionLabel={getPaneRegionLabel}
            onFocusPane={onFocusPane}
          />
          <DividerLayer
            dividers={geometry.dividers}
            dividerSize={dividerSize}
            separatorLabel={labels.separator}
            minPaneWidth={minPaneWidth}
            minPaneHeight={minPaneHeight}
            minSizesForSplit={minSizesForSplit}
            onResizePreview={handleResizePreview}
            onResizeCommit={handleResizeCommit}
            onEqualize={onEqualizeSplit}
          />
          {dropPreview ? (
            <DockIntentOverlay rect={dropPreview.rect} label={dropPreview.label} />
          ) : null}
        </>
      )}
    </div>
  );
}
