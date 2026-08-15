export const supportsExternalWorkspaceOpen = false;
export const workspaceOverlayStackClassName = "z-40";

export async function readWorkspaceClipboardText() {
  return null;
}

function base64ToBytes(data: string) {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function fileExtension(fileName: string) {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot).toLowerCase() : null;
}

async function drawImageBlobToCanvas(source: Blob) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image clipboard canvas is unavailable");

  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(source);
      try {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        context.drawImage(bitmap, 0, 0);
        return canvas;
      } finally {
        bitmap.close();
      }
    } catch {
      // SVG and some browser-supported image codecs are not always accepted
      // by createImageBitmap, so use the regular image decoder as a fallback.
    }
  }

  const blobUrl = URL.createObjectURL(source);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Failed to decode image for clipboard"));
      image.src = blobUrl;
    });
    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error("Image has no drawable dimensions");
    }
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    context.drawImage(image, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export async function saveWorkspacePreviewImage(request: {
  data: string;
  fileName: string;
  mimeType: string;
}) {
  const bytes = base64ToBytes(request.data);
  const blob = new Blob([bytes.buffer], { type: request.mimeType });
  const windowWithPicker = window as Window & {
    showSaveFilePicker?: (options: {
      suggestedName: string;
      types?: Array<{ accept: Record<string, string[]>; description: string }>;
    }) => Promise<{
      createWritable: () => Promise<{
        close: () => Promise<void>;
        write: (data: Blob) => Promise<void>;
      }>;
    }>;
  };
  if (windowWithPicker.showSaveFilePicker) {
    try {
      const extension = fileExtension(request.fileName);
      const handle = await windowWithPicker.showSaveFilePicker({
        suggestedName: request.fileName,
        types: extension
          ? [
              {
                accept: { [request.mimeType || "application/octet-stream"]: [extension] },
                description: "Image",
              },
            ]
          : undefined,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      throw error;
    }
  }

  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = request.fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
}

export async function copyWorkspacePreviewImage(request: { data: string; mimeType: string }) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard is unavailable");
  }
  const source = new Blob([base64ToBytes(request.data).buffer], { type: request.mimeType });
  const canvas = await drawImageBlobToCanvas(source);
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode image for clipboard"));
    }, "image/png");
  });
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export function WorkspaceOverlayTitleBar() {
  return null;
}
