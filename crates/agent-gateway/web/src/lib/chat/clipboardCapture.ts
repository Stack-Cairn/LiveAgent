export type ClipboardImageReadResult =
  | { ok: true; files: File[] }
  | { ok: false; reason: "unsupported" | "denied" | "empty" | "error"; message: string };

export type DisplayCaptureResult =
  | { ok: true; file: File }
  | {
      ok: false;
      reason: "unsupported" | "cancelled" | "error";
      message: string;
    };

/** Supported clipboard image MIME → file extension (no silent re-labeling). */
const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

const PREFERRED_IMAGE_MIME_ORDER = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/bmp",
] as const;

function normalizeMime(mimeType: string): string {
  return mimeType.trim().toLowerCase().split(";")[0]?.trim() ?? "";
}

/** Return a known extension for a supported image MIME, or null if unsupported. */
export function extensionForImageMime(mimeType: string): string | null {
  const normalized = normalizeMime(mimeType);
  return IMAGE_MIME_EXTENSIONS[normalized] ?? null;
}

export function clipboardImageMimeTypes(types: readonly string[]): string[] {
  return types.filter((type) => type.toLowerCase().startsWith("image/"));
}

/**
 * Prefer one representation per ClipboardItem: PNG/JPEG first, then other
 * supported types. Unsupported image/* (svg/tiff/avif/…) are skipped unless
 * they are the only option and we can map them — currently they are skipped
 * so we never label raw bytes as .png without conversion.
 */
export function pickPreferredImageMime(types: readonly string[]): string | null {
  const imageTypes = clipboardImageMimeTypes(types);
  if (imageTypes.length === 0) return null;

  const byNormalized = new Map<string, string>();
  for (const type of imageTypes) {
    const normalized = normalizeMime(type);
    if (!byNormalized.has(normalized)) byNormalized.set(normalized, type);
  }

  for (const preferred of PREFERRED_IMAGE_MIME_ORDER) {
    const original = byNormalized.get(preferred);
    if (original && extensionForImageMime(original)) return original;
  }

  for (const type of imageTypes) {
    if (extensionForImageMime(type)) return type;
  }
  return null;
}

/** Convert ClipboardItem-like entries into image Files (testable without DOM). */
export async function filesFromClipboardItems(
  items: ReadonlyArray<{
    types: readonly string[];
    getType: (type: string) => Promise<Blob>;
  }>,
  now = Date.now(),
): Promise<File[]> {
  const files: File[] = [];
  let index = 0;
  for (const item of items) {
    const preferred = pickPreferredImageMime(item.types ?? []);
    if (!preferred) continue;

    // Try preferred first, then other supported types on read failure.
    const imageTypes = clipboardImageMimeTypes(item.types ?? []);
    const ordered: string[] = [preferred];
    for (const type of imageTypes) {
      if (type !== preferred && extensionForImageMime(type)) ordered.push(type);
    }

    let accepted = false;
    for (const type of ordered) {
      const extension = extensionForImageMime(type);
      if (!extension) continue;
      try {
        const blob = await item.getType(type);
        if (!blob || blob.size <= 0) continue;
        const mime = normalizeMime(type) || normalizeMime(blob.type) || `image/${extension}`;
        const file = new File([blob], `clipboard-image-${now}-${index + 1}.${extension}`, {
          type: mime,
          lastModified: now,
        });
        files.push(file);
        index += 1;
        accepted = true;
        break;
      } catch {
        // Try next representation for this ClipboardItem.
      }
    }
    if (!accepted) {
      // No readable supported representation — skip the item entirely.
    }
  }
  return files;
}

export async function readClipboardImageFiles(
  clipboard: Pick<Clipboard, "read"> | null | undefined = typeof navigator !== "undefined"
    ? navigator.clipboard
    : null,
): Promise<ClipboardImageReadResult> {
  if (!clipboard || typeof clipboard.read !== "function") {
    return {
      ok: false,
      reason: "unsupported",
      message: "Clipboard image read is not supported in this environment.",
    };
  }

  try {
    const items = await clipboard.read();
    const files = await filesFromClipboardItems(items);
    if (files.length === 0) {
      return {
        ok: false,
        reason: "empty",
        message: "No image found on the clipboard.",
      };
    }
    return { ok: true, files };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const denied = /not allowed|denied|permission|secure context|document is not focused/i.test(
      message,
    );
    return {
      ok: false,
      reason: denied ? "denied" : "error",
      message: message || "Failed to read clipboard images.",
    };
  }
}

async function blobFromVideoFrame(video: HTMLVideoElement, mime = "image/png"): Promise<Blob> {
  const width = video.videoWidth || 0;
  const height = video.videoHeight || 0;
  if (width <= 0 || height <= 0) {
    throw new Error("Screenshot capture produced an empty frame.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Screenshot canvas is unavailable.");
  }
  context.drawImage(video, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), mime);
  });
  if (!blob || blob.size <= 0) {
    throw new Error("Screenshot capture failed to encode the frame.");
  }
  return blob;
}

export async function captureDisplayFrameToFile(
  mediaDevices: Pick<MediaDevices, "getDisplayMedia"> | null | undefined = typeof navigator !==
  "undefined"
    ? navigator.mediaDevices
    : null,
  now = Date.now(),
): Promise<DisplayCaptureResult> {
  if (!mediaDevices || typeof mediaDevices.getDisplayMedia !== "function") {
    return {
      ok: false,
      reason: "unsupported",
      message: "Screen capture is not supported in this environment.",
    };
  }

  let stream: MediaStream | null = null;
  try {
    stream = await mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      return {
        ok: false,
        reason: "error",
        message: "Screen capture returned no video track.",
      };
    }

    const video = document.createElement("video");
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;

    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Failed to load screen capture stream."));
      };
      const cleanup = () => {
        video.removeEventListener("loadeddata", onLoaded);
        video.removeEventListener("error", onError);
      };
      video.addEventListener("loadeddata", onLoaded, { once: true });
      video.addEventListener("error", onError, { once: true });
      void video.play().catch(onError);
    });

    // Let the first frame settle on slower GPUs.
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    const blob = await blobFromVideoFrame(video);
    const file = new File([blob], `screenshot-${now}.png`, {
      type: "image/png",
      lastModified: now,
    });
    return { ok: true, file };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = /not allowed|permission denied|abort|cancel/i.test(message);
    return {
      ok: false,
      reason: cancelled ? "cancelled" : "error",
      message: message || "Screen capture failed.",
    };
  } finally {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
  }
}
