export type ImageViewerSize = {
  width: number;
  height: number;
};

export type ImageViewerPan = {
  x: number;
  y: number;
};

export type ImageViewerState = ImageViewerPan & {
  scale: number;
  rotation: number;
};

export const IMAGE_VIEWER_MIN_SCALE = 0.25;
export const IMAGE_VIEWER_MAX_SCALE = 4;
export const IMAGE_VIEWER_ZOOM_RATIO = 1.05;

const IMAGE_VIEWER_WHEEL_ZOOM_SENSITIVITY = Math.log(IMAGE_VIEWER_ZOOM_RATIO) / 100;

function finiteSize(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isAbsoluteWorkspacePath(path: string) {
  return (
    path.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(path) ||
    /^\\\\/.test(path) ||
    /^\/\/[^/\\]+[\\/][^/\\]+/.test(path)
  );
}

/** Returns an absolute local path without changing workspace API paths. */
export function workspaceImageAbsolutePathForCopy(workdir: string, path: string) {
  const rawPath = path.trim();
  if (isAbsoluteWorkspacePath(rawPath)) return rawPath;

  const normalizedPath = rawPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const root = workdir.trim();
  if (!normalizedPath) return root;
  if (!root) return normalizedPath;

  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const trimmedRoot = root.replace(/[\\/]+$/, "");
  const relativePath = normalizedPath.replace(/\//g, separator);
  return trimmedRoot ? `${trimmedRoot}${separator}${relativePath}` : `${separator}${relativePath}`;
}

/** Returns a path relative to the workspace root when the source is inside it. */
export function workspaceImageRelativePathForCopy(workdir: string, path: string) {
  const rawPath = path.trim();
  if (!isAbsoluteWorkspacePath(rawPath)) {
    return rawPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }

  const root = workdir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const absolutePath = rawPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return rawPath;

  const isWindowsPath = /^[a-zA-Z]:\//.test(root) || root.startsWith("//");
  const comparableRoot = isWindowsPath ? root.toLowerCase() : root;
  const comparablePath = isWindowsPath ? absolutePath.toLowerCase() : absolutePath;
  if (comparablePath === comparableRoot) return "";
  if (comparablePath.startsWith(`${comparableRoot}/`)) {
    return absolutePath.slice(root.length + 1);
  }
  return rawPath;
}

export function clampImageViewerScale(scale: number) {
  return Math.min(Math.max(scale, IMAGE_VIEWER_MIN_SCALE), IMAGE_VIEWER_MAX_SCALE);
}

export function imageViewerScaleAfterStep(scale: number, direction: -1 | 1) {
  const currentScale = clampImageViewerScale(scale);
  return clampImageViewerScale(currentScale * IMAGE_VIEWER_ZOOM_RATIO ** direction);
}

export function imageViewerScaleAfterWheelDelta(scale: number, deltaY: number, deltaMode: number) {
  const currentScale = clampImageViewerScale(scale);
  if (!Number.isFinite(deltaY) || deltaY === 0) return currentScale;

  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 100 : deltaY;
  return clampImageViewerScale(
    currentScale * Math.exp(-pixels * IMAGE_VIEWER_WHEEL_ZOOM_SENSITIVITY),
  );
}

export function normalizeImageViewerRotation(degrees: number) {
  const next = Math.round(degrees / 90) * 90;
  return ((next % 360) + 360) % 360;
}

export function fitImageViewerSize(
  naturalSize: ImageViewerSize,
  viewportSize: ImageViewerSize,
  rotation = 0,
): ImageViewerSize {
  const naturalWidth = finiteSize(naturalSize.width);
  const naturalHeight = finiteSize(naturalSize.height);
  const viewportWidth = finiteSize(viewportSize.width);
  const viewportHeight = finiteSize(viewportSize.height);
  if (!naturalWidth || !naturalHeight || !viewportWidth || !viewportHeight) {
    return { width: 0, height: 0 };
  }

  const rotatedSize = rotatedImageViewerSize(
    { width: naturalWidth, height: naturalHeight },
    rotation,
  );
  const ratio = Math.min(viewportWidth / rotatedSize.width, viewportHeight / rotatedSize.height);
  return {
    width: naturalWidth * ratio,
    height: naturalHeight * ratio,
  };
}

export function rotatedImageViewerSize(size: ImageViewerSize, rotation: number): ImageViewerSize {
  const normalizedRotation = normalizeImageViewerRotation(rotation);
  if (normalizedRotation === 90 || normalizedRotation === 270) {
    return { width: finiteSize(size.height), height: finiteSize(size.width) };
  }
  return { width: finiteSize(size.width), height: finiteSize(size.height) };
}

export function clampImageViewerPan(
  pan: ImageViewerPan,
  options: {
    imageSize: ImageViewerSize;
    viewportSize: ImageViewerSize;
    scale: number;
    rotation: number;
  },
): ImageViewerPan {
  const viewportWidth = finiteSize(options.viewportSize.width);
  const viewportHeight = finiteSize(options.viewportSize.height);
  const imageSize = rotatedImageViewerSize(options.imageSize, options.rotation);
  const scale = clampImageViewerScale(options.scale);
  if (!viewportWidth || !viewportHeight || !imageSize.width || !imageSize.height) {
    return { x: 0, y: 0 };
  }

  const maxX = Math.max(0, (imageSize.width * scale - viewportWidth) / 2);
  const maxY = Math.max(0, (imageSize.height * scale - viewportHeight) / 2);
  return {
    x: maxX ? Math.min(Math.max(Number.isFinite(pan.x) ? pan.x : 0, -maxX), maxX) : 0,
    y: maxY ? Math.min(Math.max(Number.isFinite(pan.y) ? pan.y : 0, -maxY), maxY) : 0,
  };
}

export function clampImageViewerState(
  state: ImageViewerState,
  options: {
    imageSize: ImageViewerSize;
    viewportSize: ImageViewerSize;
  },
): ImageViewerState {
  const scale = clampImageViewerScale(state.scale);
  // Keep the angle continuous for CSS transitions. Geometry helpers normalize it
  // independently, so 360 degrees still has the same dimensions as 0 degrees.
  const rotation = Number.isFinite(state.rotation) ? Math.round(state.rotation / 90) * 90 : 0;
  const pan = clampImageViewerPan(state, { ...options, scale, rotation });
  return { ...pan, scale, rotation };
}

export function zoomImageViewerAtPoint(
  state: ImageViewerState,
  nextScale: number,
  anchor: ImageViewerPan,
  options: {
    imageSize: ImageViewerSize;
    viewportSize: ImageViewerSize;
  },
): ImageViewerState {
  const previousScale = clampImageViewerScale(state.scale);
  const scale = clampImageViewerScale(nextScale);
  if (scale === previousScale) return clampImageViewerState(state, options);

  // The pointer is expressed relative to the view centre. Preserving the same
  // image-space coordinate beneath it works for every 90-degree rotation.
  const x = anchor.x - ((anchor.x - state.x) * scale) / previousScale;
  const y = anchor.y - ((anchor.y - state.y) * scale) / previousScale;
  return clampImageViewerState({ ...state, x, y, scale }, options);
}

export function resetImageViewerState(): ImageViewerState {
  return { scale: 1, rotation: 0, x: 0, y: 0 };
}
