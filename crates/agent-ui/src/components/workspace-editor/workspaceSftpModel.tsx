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
