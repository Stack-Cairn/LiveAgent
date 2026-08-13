import type {
  SftpActionResponse,
  SftpEntry,
  SftpListResponse,
  SftpStatResponse,
  SftpTransfer,
  SftpTransferEvent,
  SftpTransferResponse,
} from "./types";

export type RawSftpEntry = Partial<SftpEntry> & {
  size_bytes?: number;
};

export type RawSftpTransfer = Partial<SftpTransfer> & {
  session_id?: string;
  source_path?: string;
  target_path?: string;
  current_path?: string;
  bytes_done?: number;
  bytes_total?: number;
  files_done?: number;
  files_total?: number;
};

export type RawSftpListResponse = Partial<SftpListResponse> & {
  entries?: RawSftpEntry[];
};

export type RawSftpStatResponse = Partial<SftpStatResponse> & {
  entry?: RawSftpEntry | null;
};

export type RawSftpActionResponse = Partial<SftpActionResponse> & {
  entry?: RawSftpEntry | null;
  transfer?: RawSftpTransfer | null;
};

export type RawSftpTransferResponse = {
  transfer?: RawSftpTransfer | null;
};

export type RawSftpTransferEvent = {
  kind?: string;
  transfer?: RawSftpTransfer | null;
};

export type RawSftpResponse = RawSftpListResponse &
  RawSftpStatResponse &
  RawSftpActionResponse &
  RawSftpTransferResponse;

export function normalizeSftpEntry(entry: RawSftpEntry): SftpEntry {
  return {
    path: entry.path ?? "",
    name: entry.name ?? "",
    kind: entry.kind ?? "file",
    sizeBytes: Number(entry.sizeBytes ?? entry.size_bytes ?? 0),
    mtime: Number(entry.mtime ?? 0),
  };
}

export function normalizeSftpTransfer(transfer: RawSftpTransfer): SftpTransfer {
  return {
    id: transfer.id ?? "",
    sessionId: transfer.sessionId ?? transfer.session_id ?? "",
    direction: transfer.direction ?? "",
    status: transfer.status ?? "",
    sourcePath: transfer.sourcePath ?? transfer.source_path ?? "",
    targetPath: transfer.targetPath ?? transfer.target_path ?? "",
    currentPath: transfer.currentPath ?? transfer.current_path ?? "",
    bytesDone: Number(transfer.bytesDone ?? transfer.bytes_done ?? 0),
    bytesTotal: Number(transfer.bytesTotal ?? transfer.bytes_total ?? 0),
    filesDone: Number(transfer.filesDone ?? transfer.files_done ?? 0),
    filesTotal: Number(transfer.filesTotal ?? transfer.files_total ?? 0),
    error: transfer.error ?? null,
  };
}

export function normalizeSftpListResponse(response: RawSftpListResponse): SftpListResponse {
  return {
    path: response.path ?? "",
    entries: (response.entries ?? []).map(normalizeSftpEntry),
  };
}

export function normalizeSftpStatResponse(response: RawSftpStatResponse): SftpStatResponse {
  return {
    exists: response.exists === true,
    entry: response.entry ? normalizeSftpEntry(response.entry) : null,
  };
}

export function normalizeSftpActionResponse(response: RawSftpActionResponse): SftpActionResponse {
  return {
    action: response.action ?? "",
    path: response.path ?? "",
    entry: response.entry ? normalizeSftpEntry(response.entry) : null,
    transfer: response.transfer ? normalizeSftpTransfer(response.transfer) : null,
  };
}

export function normalizeSftpTransferResponse(
  response: RawSftpTransferResponse,
): SftpTransferResponse {
  if (!response.transfer) {
    throw new Error("SFTP transfer response did not include a transfer");
  }
  return { transfer: normalizeSftpTransfer(response.transfer) };
}

export function normalizeSftpTransferEvent(event: RawSftpTransferEvent): SftpTransferEvent | null {
  if (!event.transfer) return null;
  return {
    kind: event.kind ?? "",
    transfer: normalizeSftpTransfer(event.transfer),
  };
}
