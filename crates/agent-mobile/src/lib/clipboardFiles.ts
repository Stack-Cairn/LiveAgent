function clipboardFileExtension(mimeType: string) {
  switch (mimeType.trim().toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    case "application/pdf":
      return "pdf";
    case "text/plain":
      return "txt";
    case "text/markdown":
      return "md";
    case "application/json":
      return "json";
    default:
      return "bin";
  }
}

function isClipboardUploadMimeType(mimeType: string) {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized.startsWith("image/")) return true;
  return (
    normalized === "application/pdf" ||
    normalized === "text/markdown" ||
    normalized === "application/json"
  );
}

function normalizeClipboardFile(file: File, index: number) {
  if (file.name.trim()) {
    return file;
  }
  const extension = clipboardFileExtension(file.type);
  const fallbackName = `clipboard-file-${index + 1}.${extension}`;
  return new File([file], fallbackName, {
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified || Date.now(),
  });
}

function clipboardFileKey(file: File) {
  return [file.name.trim() || "__clipboard_file__", file.type, file.size, file.lastModified].join(
    "\u0000",
  );
}

function appendUniqueClipboardFile(files: File[], seen: Set<string>, file: File | null) {
  if (!file) return;
  const key = clipboardFileKey(file);
  if (seen.has(key)) return;
  seen.add(key);
  files.push(normalizeClipboardFile(file, files.length));
}

export function extractClipboardFiles(data: DataTransfer | null | undefined) {
  const files: File[] = [];
  const seen = new Set<string>();
  if (!data) return files;

  const clipboardFiles = Array.from(data.files ?? []);
  if (clipboardFiles.length > 0) {
    for (const file of clipboardFiles) {
      appendUniqueClipboardFile(files, seen, file);
    }
    return files;
  }

  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    appendUniqueClipboardFile(files, seen, item.getAsFile());
  }

  return files;
}

export function clipboardHasFileSignal(data: DataTransfer | null | undefined) {
  if (!data) return false;
  if (Array.from(data.items ?? []).some((item) => item.kind === "file")) {
    return true;
  }
  return Array.from(data.types ?? []).some((type) => {
    const normalized = type.trim().toLowerCase();
    return normalized === "files" || isClipboardUploadMimeType(normalized);
  });
}

export async function readClipboardFiles() {
  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.read !== "function") {
    return [];
  }

  const files: File[] = [];
  const seen = new Set<string>();
  const items = await clipboard.read();
  for (const item of items) {
    const type = item.types.find(isClipboardUploadMimeType);
    if (!type) continue;
    const blob = await item.getType(type);
    const file = new File(
      [blob],
      `clipboard-file-${files.length + 1}.${clipboardFileExtension(type)}`,
      {
        type,
        lastModified: Date.now(),
      },
    );
    appendUniqueClipboardFile(files, seen, file);
  }
  return files;
}
