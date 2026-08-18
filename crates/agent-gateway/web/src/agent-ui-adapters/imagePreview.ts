export const supportsSystemImageOpen = false;
export const supportsDirectUploadedImageCopy = false;

type ImagePreviewSaveData = {
  dataBase64: string;
  fileName: string;
  mimeType: string;
};

type ImagePreviewSaveRequest = Pick<ImagePreviewSaveData, "fileName" | "mimeType">;
type ImagePreviewCopyData = Pick<ImagePreviewSaveData, "dataBase64" | "mimeType">;
type ImagePreviewCopyRequest = ImagePreviewCopyData | PromiseLike<ImagePreviewCopyData>;

function base64ToBytes(dataBase64: string) {
  const binary = window.atob(dataBase64);
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
      // SVG and browser-specific codecs can require the regular image decoder.
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

function imagePreviewBlob(data: Pick<ImagePreviewSaveData, "dataBase64" | "mimeType">) {
  return new Blob([base64ToBytes(data.dataBase64).buffer], { type: data.mimeType });
}

export async function prepareImagePreviewSave(request: ImagePreviewSaveRequest) {
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
      return async (data: ImagePreviewSaveData) => {
        const writable = await handle.createWritable();
        await writable.write(imagePreviewBlob(data));
        await writable.close();
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      throw error;
    }
  }

  return async (data: ImagePreviewSaveData) => {
    const blobUrl = URL.createObjectURL(imagePreviewBlob(data));
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = data.fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
  };
}

export async function saveImagePreviewData(request: ImagePreviewSaveData) {
  const writeImage = await prepareImagePreviewSave(request);
  if (!writeImage) return false;
  await writeImage(request);
  return true;
}

export function copyImagePreviewData(request: ImagePreviewCopyRequest) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    return Promise.reject(new Error("Image clipboard is unavailable"));
  }
  const png = Promise.resolve(request).then(async (data) => {
    const source = new Blob([base64ToBytes(data.dataBase64).buffer], {
      type: data.mimeType,
    });
    const canvas = await drawImageBlobToCanvas(source);
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Could not encode image for clipboard"));
      }, "image/png");
    });
  });
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export async function prepareUploadedImagePreviewCopy(_request: {
  workdir: string;
  absolutePath: string;
}) {
  // WebUI never receives a trusted local path, so it has nothing to predecode.
}

export async function copyUploadedImagePreview(_request: {
  workdir: string;
  absolutePath: string;
}) {
  throw new Error("Direct image attachment copying is unavailable in WebUI");
}

export async function openUploadedImageInSystemViewer(_request: {
  workdir: string;
  absolutePath: string;
}) {
  throw new Error("Opening an image in the system viewer is unavailable in WebUI");
}
