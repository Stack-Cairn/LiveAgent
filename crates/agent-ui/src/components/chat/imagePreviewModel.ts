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

export type ImagePreviewAttachment = {
  workdir: string;
  absolutePath: string;
  relativePath: string;
};

export type ImagePreviewSlide = {
  src: string;
  alt?: string;
  title?: string;
  width?: number;
  height?: number;
  dataBase64?: string;
  mimeType?: string;
  sizeBytes?: number;
  fileName?: string;
  attachment?: ImagePreviewAttachment;
};

export type ResolvedImagePreviewData = {
  dataBase64: string;
  mimeType: string;
  sizeBytes: number;
};

export const IMAGE_VIEWER_MIN_SCALE = 0.25;
export const IMAGE_VIEWER_MAX_SCALE = 4;
export const IMAGE_VIEWER_ZOOM_RATIO = 1.05;

const IMAGE_VIEWER_WHEEL_ZOOM_SENSITIVITY = Math.log(IMAGE_VIEWER_ZOOM_RATIO) / 100;
const BASE64_CHUNK_SIZE = 0x8000;

function finiteSize(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeMimeType(mimeType: string | undefined) {
  return mimeType?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function mimeTypeFromFileName(fileName: string | undefined) {
  const extension = fileName?.trim().split(".").pop()?.toLowerCase();
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function byteLengthFromBase64(dataBase64: string) {
  const normalized = dataBase64.trim().replace(/\s/g, "");
  if (!normalized) return 0;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_SIZE);
    for (let index = 0; index < chunk.length; index += 1) {
      binary += String.fromCharCode(chunk[index] ?? 0);
    }
  }
  return btoa(binary);
}

function decodeDataUrl(src: string): ResolvedImagePreviewData | null {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i.exec(src);
  if (!match) return null;

  const mimeType = normalizeMimeType(match[1]);
  const payload = match[3] ?? "";
  if (match[2]) {
    const dataBase64 = payload.replace(/\s/g, "");
    return {
      dataBase64,
      mimeType,
      sizeBytes: byteLengthFromBase64(dataBase64),
    };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(payload);
  } catch {
    // Invalid percent escapes are an image-load failure, not a render failure.
    return null;
  }
  const dataBase64 = bytesToBase64(new TextEncoder().encode(decoded));
  return {
    dataBase64,
    mimeType,
    sizeBytes: byteLengthFromBase64(dataBase64),
  };
}

export function getImagePreviewMimeType(slide: ImagePreviewSlide) {
  const explicitMimeType = normalizeMimeType(slide.mimeType);
  if (explicitMimeType !== "application/octet-stream") return explicitMimeType;

  const dataUrl = decodeDataUrl(slide.src);
  if (dataUrl) return dataUrl.mimeType;

  return mimeTypeFromFileName(getImagePreviewFileName(slide, ""));
}

const SLIDE_KEY_SAMPLE_THRESHOLD = 256;

function fnv1aHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function compactSlideKeyPart(value: string) {
  if (value.length <= SLIDE_KEY_SAMPLE_THRESHOLD) return value;
  // 长度+头尾采样区分不了"同模板只改中间"的 SVG（相同 XML 头/尾、等长正文），
  // 必须叠加全串哈希才能覆盖正文差异。
  return `${value.length}:${fnv1aHash(value)}:${value.slice(0, 96)}:${value.slice(-32)}`;
}

const slideKeyCache = new WeakMap<ImagePreviewSlide, string>();

/**
 * 换灯片检测用的紧凑指纹。src/dataBase64 对内联图是 MB 级巨串，绝不能整串
 * 进 React key 或 effect deps——每次渲染都会重新物化一份并触发全量比较，
 * 缩放/拖拽的每帧重渲染会把分配速率推到每秒数百 MB（SVG 预览内存暴涨主因）。
 * 全串哈希只在每个 slide 对象上算一次（WeakMap 缓存，依赖上游 sources/slides
 * 的 useMemo 身份稳定链），后续每帧渲染都是缓存命中，摊还后仍是 O(1)。
 */
export function getImagePreviewSlideKey(slide: ImagePreviewSlide) {
  const cached = slideKeyCache.get(slide);
  if (cached !== undefined) return cached;
  const key = `${compactSlideKeyPart(slide.src)}\0${compactSlideKeyPart(slide.dataBase64 ?? "")}`;
  slideKeyCache.set(slide, key);
  return key;
}

export function getImagePreviewDisplaySource(slide: ImagePreviewSlide) {
  const source = slide.src.trim();
  if (source) return source;

  const inlineData = slide.dataBase64?.trim().replace(/\s/g, "");
  if (!inlineData) return "";
  return `data:${getImagePreviewMimeType(slide)};base64,${inlineData}`;
}

export function clampImagePreviewIndex(index: number, slideCount: number) {
  if (slideCount <= 0) return 0;
  return Math.min(Math.max(index, 0), slideCount - 1);
}

export function normalizeImagePreviewIndex(index: number | undefined) {
  return Number.isFinite(index) ? Math.trunc(index as number) : 0;
}

export function getImagePreviewFileName(slide: ImagePreviewSlide, fallback = "image") {
  const candidate = (slide.fileName || slide.title || slide.alt || "").trim();
  if (candidate) {
    const normalized = candidate.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    return normalized.slice(lastSlash + 1) || fallback;
  }

  const mimeType = normalizeMimeType(slide.mimeType);
  const extension =
    mimeType === "image/jpeg"
      ? "jpg"
      : mimeType === "image/png"
        ? "png"
        : mimeType === "image/gif"
          ? "gif"
          : mimeType === "image/webp"
            ? "webp"
            : mimeType === "image/svg+xml"
              ? "svg"
              : mimeType === "image/bmp"
                ? "bmp"
                : mimeType === "image/x-icon"
                  ? "ico"
                  : "image";
  return `${fallback}.${extension}`;
}

export function getImagePreviewDisplayName(slide: ImagePreviewSlide) {
  return getImagePreviewFileName(slide, "image");
}

export function isVerifiedImagePreviewAttachment(
  attachment: ImagePreviewAttachment | undefined,
): attachment is ImagePreviewAttachment {
  if (!attachment) return false;
  return Boolean(
    typeof attachment.workdir === "string" &&
      attachment.workdir.trim() &&
      typeof attachment.absolutePath === "string" &&
      attachment.absolutePath.trim() &&
      typeof attachment.relativePath === "string" &&
      attachment.relativePath.trim(),
  );
}

export function getImagePreviewCapabilities(slide: ImagePreviewSlide, supportsSystemOpen: boolean) {
  const hasSource = Boolean(slide.src.trim() || slide.dataBase64?.trim());
  const hasAttachment = isVerifiedImagePreviewAttachment(slide.attachment);
  return {
    canSave: hasSource,
    canCopyImage: hasSource,
    // Only the desktop host can revalidate and act on local attachment paths.
    canCopyPaths: hasAttachment && supportsSystemOpen,
    canOpenSystem: hasAttachment && supportsSystemOpen,
  };
}

/** Resolves only the display source supplied by the caller, including proxy URLs. */
export async function resolveImagePreviewData(
  slide: ImagePreviewSlide,
): Promise<ResolvedImagePreviewData> {
  const inlineData = slide.dataBase64?.trim();
  if (inlineData) {
    return {
      dataBase64: inlineData,
      mimeType: getImagePreviewMimeType(slide),
      sizeBytes: slide.sizeBytes ?? byteLengthFromBase64(inlineData),
    };
  }

  const dataUrl = decodeDataUrl(slide.src);
  if (dataUrl) {
    return {
      ...dataUrl,
      mimeType: getImagePreviewMimeType(slide),
      sizeBytes: slide.sizeBytes ?? dataUrl.sizeBytes,
    };
  }

  if (!slide.src.trim()) throw new Error("Image source is unavailable");
  const response = await fetch(slide.src);
  if (!response.ok) throw new Error(`Failed to load image data (${response.status})`);
  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    dataBase64: bytesToBase64(bytes),
    mimeType:
      getImagePreviewMimeType(slide) === "application/octet-stream"
        ? normalizeMimeType(blob.type)
        : getImagePreviewMimeType(slide),
    sizeBytes: slide.sizeBytes ?? bytes.byteLength,
  };
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

export function rotatedImageViewerSize(size: ImageViewerSize, rotation: number): ImageViewerSize {
  const normalizedRotation = normalizeImageViewerRotation(rotation);
  if (normalizedRotation === 90 || normalizedRotation === 270) {
    return { width: finiteSize(size.height), height: finiteSize(size.width) };
  }
  return { width: finiteSize(size.width), height: finiteSize(size.height) };
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
  return { width: naturalWidth * ratio, height: naturalHeight * ratio };
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
  options: { imageSize: ImageViewerSize; viewportSize: ImageViewerSize },
): ImageViewerState {
  const scale = clampImageViewerScale(state.scale);
  const rotation = Number.isFinite(state.rotation) ? Math.round(state.rotation / 90) * 90 : 0;
  const pan = clampImageViewerPan(state, { ...options, scale, rotation });
  return { ...pan, scale, rotation };
}

export function zoomImageViewerAtPoint(
  state: ImageViewerState,
  nextScale: number,
  anchor: ImageViewerPan,
  options: { imageSize: ImageViewerSize; viewportSize: ImageViewerSize },
): ImageViewerState {
  const previousScale = clampImageViewerScale(state.scale);
  const scale = clampImageViewerScale(nextScale);
  if (scale === previousScale) return clampImageViewerState(state, options);

  const x = anchor.x - ((anchor.x - state.x) * scale) / previousScale;
  const y = anchor.y - ((anchor.y - state.y) * scale) / previousScale;
  return clampImageViewerState({ ...state, x, y, scale }, options);
}

export function resetImageViewerState(): ImageViewerState {
  return { scale: 1, rotation: 0, x: 0, y: 0 };
}
