import {
  normalizeSftpActionResponse,
  normalizeSftpListResponse,
  normalizeSftpStatResponse,
  normalizeSftpTransferEvent,
  normalizeSftpTransferResponse,
  type RawSftpActionResponse,
  type RawSftpListResponse,
  type RawSftpStatResponse,
  type RawSftpTransferEvent,
  type RawSftpTransferResponse,
} from "@liveagent/ui/lib/sftp/normalization";
import type { SftpClient } from "@liveagent/ui/lib/sftp/types";
import { invoke, listen } from "../tauriBridge";

export const tauriSftpClient: SftpClient = {
  async list(params) {
    return normalizeSftpListResponse(
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
    return normalizeSftpStatResponse(
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
    return normalizeSftpActionResponse(
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
    return normalizeSftpActionResponse(
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
    return normalizeSftpActionResponse(
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
    return normalizeSftpTransferResponse(
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
      const normalized = normalizeSftpTransferEvent(event.payload);
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
