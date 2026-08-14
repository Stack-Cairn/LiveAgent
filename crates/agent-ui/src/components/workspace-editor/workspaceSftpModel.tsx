import { getFileTypeIcon } from "@liveagent/ui/components/chat/fileTypeIcons";
import type { SftpEntry, SftpSide, SftpTransfer } from "@liveagent/ui/lib/sftp/types";

const FILE_ICON_CLASS = "h-4 w-4 shrink-0";
const FOLDER_ICON_CLASS = "h-4 w-4 shrink-0";

export type DragPayloadItem = {
  path: string;
  kind: string;
};

export type DragPayload = DragPayloadItem & {
  side: SftpSide;
  items?: DragPayloadItem[];
};

export function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

export function entryIcon(entry: SftpEntry, className?: string) {
  if (entry.kind === "directory") {
    const FolderIcon = getFileTypeIcon(entry.name || entry.path, "dir");
    return <FolderIcon className={className ?? FOLDER_ICON_CLASS} />;
  }
  const FileIcon = getFileTypeIcon(entry.name || entry.path, "file");
  return <FileIcon className={className ?? FILE_ICON_CLASS} />;
}

export function transferProgress(transfer: SftpTransfer | null) {
  if (!transfer) return 0;
  if (transfer.status === "completed") return 100;
  if (transfer.bytesTotal > 0) {
    return Math.min(100, Math.max(0, Math.round((transfer.bytesDone / transfer.bytesTotal) * 100)));
  }
  if (transfer.filesTotal > 0) {
    return Math.min(100, Math.max(0, Math.round((transfer.filesDone / transfer.filesTotal) * 100)));
  }
  return transfer.status === "running" ? 8 : 0;
}

export function transferTone(transfer: SftpTransfer | null) {
  if (!transfer) return "bg-muted-foreground";
  if (transfer.status === "completed") return "bg-emerald-500";
  if (transfer.status === "failed") return "bg-destructive";
  if (transfer.status === "cancelled") return "bg-muted-foreground";
  return "bg-sky-500";
}

export function dragItems(payload: DragPayload): DragPayloadItem[] {
  return payload.items?.length ? payload.items : [{ path: payload.path, kind: payload.kind }];
}

// Remote editing is text-only in v1: Monaco cannot render these formats and a
// lossy round-trip would corrupt them, so known binary extensions get no edit
// entry point at all. Anything else is allowed and the strict UTF-8 read on
// the Rust side is the final gate.
const REMOTE_EDIT_BLOCKED_EXTENSIONS = new Set([
  // images
  "avif",
  "bmp",
  "gif",
  "heic",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
  "webp",
  // documents
  "doc",
  "docx",
  "odp",
  "ods",
  "odt",
  "pdf",
  "ppt",
  "pptx",
  "rtf",
  "xls",
  "xlsb",
  "xlsm",
  "xlsx",
  // audio / video
  "aac",
  "flac",
  "m4a",
  "m4v",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "oga",
  "ogg",
  "ogv",
  "wav",
  "webm",
  // archives
  "7z",
  "bz2",
  "gz",
  "jar",
  "rar",
  "tar",
  "tgz",
  "xz",
  "zip",
  "zst",
  // binaries
  "a",
  "bin",
  "class",
  "dll",
  "dylib",
  "exe",
  "o",
  "so",
  "wasm",
]);

export function canEditRemoteEntry(entry: DragPayloadItem): boolean {
  if (entry.kind !== "file") return false;
  const name = basename(entry.path);
  const extensionIndex = name.lastIndexOf(".");
  if (extensionIndex <= 0) return true;
  const extension = name.slice(extensionIndex + 1).toLowerCase();
  return !REMOTE_EDIT_BLOCKED_EXTENSIONS.has(extension);
}
