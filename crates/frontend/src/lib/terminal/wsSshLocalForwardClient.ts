import { backendInvoke, subscribeBackendEvent } from "../backend/transport";
import type {
  RawSshLocalForwardAction,
  RawSshLocalForwardEvent,
  RawSshLocalForwardSnapshot,
  SshLocalForwardClient,
} from "./sshLocalForwardTypes";
import {
  normalizeSshLocalForwardAction,
  normalizeSshLocalForwardEvent,
  normalizeSshLocalForwardSnapshot,
} from "./sshLocalForwardTypes";

export const wsSshLocalForwardClient: SshLocalForwardClient = {
  async list(params) {
    return normalizeSshLocalForwardSnapshot(
      await backendInvoke<RawSshLocalForwardSnapshot>("terminal_ssh_local_forward_list", {
        session_id: params?.sessionId,
        project_path_key: params?.projectPathKey,
      }),
    );
  },
  async start(params) {
    return normalizeSshLocalForwardAction(
      await backendInvoke<RawSshLocalForwardAction>("terminal_ssh_local_forward_start", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        remote_host: params.remoteHost,
        remote_port: params.remotePort,
        local_port: params.localPort ?? 0,
      }),
    );
  },
  async stop(params) {
    return normalizeSshLocalForwardAction(
      await backendInvoke<RawSshLocalForwardAction>("terminal_ssh_local_forward_stop", {
        forward_id: params.forwardId,
        session_id: params.sessionId,
      }),
    );
  },
  /** Advisory loopback-port probe; `true` means the port looked free. The
   * authoritative bind still happens in `start`, so treat this as UX only. */
  async checkLocalPort(port) {
    return backendInvoke<boolean>("terminal_ssh_local_forward_check_port", {
      local_port: port,
    });
  },
  async subscribe(listener) {
    return subscribeBackendEvent("terminal:ssh-local-forward", (event) => {
      listener(normalizeSshLocalForwardEvent(event.payload as RawSshLocalForwardEvent));
    });
  },
};
