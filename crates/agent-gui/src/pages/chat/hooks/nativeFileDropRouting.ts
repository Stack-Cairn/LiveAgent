export const WORKSPACE_FOLDER_DROP_ZONE_SELECTOR = "[data-workspace-folder-drop-zone]";
export const FILE_UPLOAD_DROP_ZONE_SELECTOR = "[data-file-upload-drop-zone]";

export type NativeFileDropTarget = "workspace" | "upload" | null;

type DropPosition = {
  x: number;
  y: number;
};

type DropZoneElement = {
  getBoundingClientRect: () => {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
};

type DropTargetDocument = {
  querySelectorAll: (selector: string) => ArrayLike<DropZoneElement>;
};

export function logicalDropPoint(position: DropPosition, scaleFactor: number): DropPosition {
  const safeScaleFactor = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return {
    x: position.x / safeScaleFactor,
    y: position.y / safeScaleFactor,
  };
}

/**
 * Wry's drag position is platform-native despite Tauri exposing the common
 * payload as PhysicalPosition. Windows reports physical client pixels, while
 * macOS (AppKit NSPoint) and Linux (GTK widget coordinates) already report
 * logical points. Only Windows therefore needs DPI conversion before DOM hit
 * testing.
 */
export function nativeDropPositionScaleFactor(userAgent: string, deviceScaleFactor: number) {
  if (!/\bWindows\b/i.test(userAgent)) return 1;
  return Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0 ? deviceScaleFactor : 1;
}

function pointIntersectsDropZone(point: DropPosition, zone: DropZoneElement, tolerancePx: number) {
  const rect = zone.getBoundingClientRect();
  return (
    point.x >= rect.left - tolerancePx &&
    point.x <= rect.right + tolerancePx &&
    point.y >= rect.top - tolerancePx &&
    point.y <= rect.bottom + tolerancePx
  );
}

function pointIntersectsSelector(
  point: DropPosition,
  targetDocument: DropTargetDocument,
  selector: string,
  tolerancePx: number,
  combineZones = false,
) {
  const zones = targetDocument.querySelectorAll(selector);
  const zoneList = Array.from(zones);
  if (!combineZones) {
    return zoneList.some((zone) => pointIntersectsDropZone(point, zone, tolerancePx));
  }

  const rects = zoneList
    .map((zone) => zone.getBoundingClientRect())
    .filter((rect) => rect.right > rect.left && rect.bottom >= rect.top);
  if (rects.length === 0) return false;
  const combinedZone: DropZoneElement = {
    getBoundingClientRect: () => ({
      left: Math.min(...rects.map((rect) => rect.left)),
      top: Math.min(...rects.map((rect) => rect.top)),
      right: Math.max(...rects.map((rect) => rect.right)),
      bottom: Math.max(...rects.map((rect) => rect.bottom)),
    }),
  };
  return pointIntersectsDropZone(point, combinedZone, tolerancePx);
}

/**
 * Normalize a native drag position before DOM hit testing. The caller supplies
 * the platform-specific position scale returned by
 * nativeDropPositionScaleFactor.
 */
export function resolveNativeFileDropTarget(
  position: DropPosition,
  options?: {
    scaleFactor?: number;
    document?: DropTargetDocument;
  },
): NativeFileDropTarget {
  const targetDocument = options?.document ?? document;
  const scaleFactor = options?.scaleFactor ?? window.devicePixelRatio;
  const point = logicalDropPoint(position, scaleFactor);
  // The business boundary comes entirely from the currently rendered page
  // frames. No sidebar width, composer position, or application pixel range is
  // hard-coded here. Workspace wins only if the live workspace frame contains
  // the point; uploads use the exact live composer dialog with no tolerance.
  if (
    pointIntersectsSelector(point, targetDocument, WORKSPACE_FOLDER_DROP_ZONE_SELECTOR, 0, true)
  ) {
    return "workspace";
  }
  if (pointIntersectsSelector(point, targetDocument, FILE_UPLOAD_DROP_ZONE_SELECTOR, 0)) {
    return "upload";
  }
  return null;
}

/**
 * Drop routing is authoritative at release time: the cached hover target is
 * only visual state and must never override the drop event's final position.
 */
export function resolveFinalNativeFileDropTarget(
  _hoverTarget: NativeFileDropTarget,
  dropPosition: DropPosition,
  options?: {
    scaleFactor?: number;
    document?: DropTargetDocument;
  },
) {
  return resolveNativeFileDropTarget(dropPosition, options);
}

export function isWorkspaceFolderDropTarget(
  position: DropPosition,
  options?: {
    scaleFactor?: number;
    document?: DropTargetDocument;
  },
) {
  return resolveNativeFileDropTarget(position, options) === "workspace";
}
