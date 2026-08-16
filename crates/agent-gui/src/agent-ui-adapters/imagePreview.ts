import { invoke } from "@tauri-apps/api/core";

export const supportsSystemImageOpen = true;
export const supportsDirectUploadedImageCopy = true;

type ImagePreviewSaveData = {
  dataBase64: string;
  fileName: string;
  mimeType: string;
};

type ImagePreviewSaveRequest = Pick<ImagePreviewSaveData, "fileName" | "mimeType">;
type ImagePreviewCopyData = Pick<ImagePreviewSaveData, "dataBase64" | "mimeType">;
type ImagePreviewCopyRequest = ImagePreviewCopyData | PromiseLike<ImagePreviewCopyData>;

const BASE64_CHUNK_SIZE = 0x8000;

function base64ToBytes(dataBase64: string) {
  const binary = window.atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_SIZE);
    for (let index = 0; index < chunk.length; index += 1) {
      binary += String.fromCharCode(chunk[index] ?? 0);
    }
  }
  return window.btoa(binary);
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
      // SVG and WebView-specific codecs can require the regular image decoder.
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

async function canvasToPng(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode image for clipboard"));
    }, "image/png");
  });
}

export async function prepareImagePreviewSave(request: ImagePreviewSaveRequest) {
  const saveToken = await invoke<string | null>("system_prepare_preview_file_save", {
    file_name: request.fileName,
  });
  if (!saveToken) return null;

  return async (data: ImagePreviewSaveData) => {
    await invoke<boolean>("system_write_preview_file", {
      save_token: saveToken,
      data_base64: data.dataBase64,
      mime_type: data.mimeType,
    });
  };
}

export async function saveImagePreviewData(request: ImagePreviewSaveData) {
  const writeImage = await prepareImagePreviewSave(request);
  if (!writeImage) return false;
  await writeImage(request);
  return true;
}

export async function copyImagePreviewData(request: ImagePreviewCopyRequest) {
  const data = await request;
  const source = new Blob([base64ToBytes(data.dataBase64).buffer], { type: data.mimeType });
  const png = await canvasToPng(await drawImageBlobToCanvas(source));
  const dataBase64 = bytesToBase64(new Uint8Array(await png.arrayBuffer()));
  await invoke("system_clipboard_write_image", {
    data_base64: dataBase64,
    mime_type: "image/png",
  });
}

export async function prepareUploadedImagePreviewCopy(request: {
  workdir: string;
  absolutePath: string;
}) {
  await invoke("system_prepare_uploaded_image_clipboard", {
    workdir: request.workdir,
    absolute_path: request.absolutePath,
  });
}

export async function copyUploadedImagePreview(request: { workdir: string; absolutePath: string }) {
  await invoke("system_clipboard_write_uploaded_image", {
    workdir: request.workdir,
    absolute_path: request.absolutePath,
  });
}

export async function openUploadedImageInSystemViewer(request: {
  workdir: string;
  absolutePath: string;
}) {
  await invoke("system_open_uploaded_image", {
    workdir: request.workdir,
    absolute_path: request.absolutePath,
  });
}
