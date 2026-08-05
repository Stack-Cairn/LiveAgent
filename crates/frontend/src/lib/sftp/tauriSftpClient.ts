import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  SftpActionResponse,
  SftpClient,
  SftpEntry,
  SftpListResponse,
  SftpStatResponse,
  SftpTransfer,
  SftpTransferEvent,
  SftpTransferResponse,
} from "./types";

type RawSftpEntry = Partial<SftpEntry> & {
  size_bytes?: number;
};

type RawSftpTransfer = Partial<SftpTransfer> & {
  session_id?: string;
  source_path?: string;
  target_path?: string;
  current_path?: string;
  bytes_done?: number;
  bytes_total?: number;
  files_done?: number;
  files_total?: number;
};

type RawSftpListResponse = Partial<SftpListResponse> & {
  entries?: RawSftpEntry[];
};

type RawSftpStatResponse = Partial<SftpStatResponse> & {
  entry?: RawSftpEntry | null;
};

type RawSftpActionResponse = Partial<SftpActionResponse> & {
  entry?: RawSftpEntry | null;
  transfer?: RawSftpTransfer | null;
};

type RawSftpTransferResponse = {
  transfer?: RawSftpTransfer | null;
};

type RawSftpTransferEvent = {
  kind?: string;
  transfer?: RawSftpTransfer | null;
};

function normalizeEntry(entry: RawSftpEntry): SftpEntry {
  return {
    path: entry.path ?? "",
    name: entry.name ?? "",
    kind: entry.kind ?? "file",
    sizeBytes: Number(entry.sizeBytes ?? entry.size_bytes ?? 0),
    mtime: Number(entry.mtime ?? 0),
  };
}

function normalizeTransfer(transfer: RawSftpTransfer): SftpTransfer {
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

function normalizeList(response: RawSftpListResponse): SftpListResponse {
  return {
    path: response.path ?? "",
    entries: (response.entries ?? []).map(normalizeEntry),
  };
}

function normalizeStat(response: RawSftpStatResponse): SftpStatResponse {
  return {
    exists: response.exists === true,
    entry: response.entry ? normalizeEntry(response.entry) : null,
  };
}

function normalizeAction(response: RawSftpActionResponse): SftpActionResponse {
  return {
    action: response.action ?? "",
    path: response.path ?? "",
    entry: response.entry ? normalizeEntry(response.entry) : null,
    transfer: response.transfer ? normalizeTransfer(response.transfer) : null,
  };
}

function normalizeTransferResponse(response: RawSftpTransferResponse): SftpTransferResponse {
  if (!response.transfer) {
    throw new Error("SFTP transfer response did not include a transfer");
  }
  return { transfer: normalizeTransfer(response.transfer) };
}

function normalizeTransferEvent(event: RawSftpTransferEvent): SftpTransferEvent | null {
  if (!event.transfer) return null;
  return {
    kind: event.kind ?? "",
    transfer: normalizeTransfer(event.transfer),
  };
}

export const tauriSftpClient: SftpClient = {
  async list(params) {
    return normalizeList(
      await invoke<RawSftpListResponse>("sftp_list", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        side: params.side,
        path: params.path,
      }),
    );
  },
  async stat(params) {
    return normalizeStat(
      await invoke<RawSftpStatResponse>("sftp_stat", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        side: params.side,
        path: params.path,
      }),
    );
  },
  async mkdir(params) {
    return normalizeAction(
      await invoke<RawSftpActionResponse>("sftp_mkdir", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        side: params.side,
        path: params.path,
      }),
    );
  },
  async rename(params) {
    return normalizeAction(
      await invoke<RawSftpActionResponse>("sftp_rename", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        side: params.side,
        from_path: params.fromPath,
        to_path: params.toPath,
      }),
    );
  },
  async delete(params) {
    return normalizeAction(
      await invoke<RawSftpActionResponse>("sftp_delete", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        side: params.side,
        path: params.path,
        recursive: params.recursive ?? false,
      }),
    );
  },
  async transfer(params) {
    return normalizeTransferResponse(
      await invoke<RawSftpTransferResponse>("sftp_transfer", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        direction: params.direction,
        source_path: params.sourcePath,
        target_path: params.targetPath,
        recursive: params.recursive ?? false,
        overwrite: params.overwrite ?? false,
      }),
    );
  },
  async cancelTransfer(params) {
    await invoke("sftp_cancel_transfer", {
      session_id: params.sessionId,
      transfer_id: params.transferId,
    });
  },
  subscribeTransfers(listener) {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen<RawSftpTransferEvent>("sftp:event", (event) => {
      if (!active) return;
      const normalized = normalizeTransferEvent(event.payload);
      if (normalized) {
        listener(normalized);
      }
    }).then((cleanup) => {
      if (!active) {
        cleanup();
        return;
      }
      unlisten = cleanup;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  },
};
