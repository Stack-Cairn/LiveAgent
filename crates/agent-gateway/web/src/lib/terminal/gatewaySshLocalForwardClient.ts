// Web transport for SSH local port forwarding: operations relay through the
// gateway's terminal.ssh_local_forward_* websocket actions to the
// desktop-owned registry, and lifecycle events arrive as terminal events of
// kind "ssh_local_forward". This file is the per-platform adapter — the
// desktop frontend ships its own copy speaking Tauri invoke
// (tauriSshLocalForwardClient.ts).

import type {
  SshLocalForwardClient,
  SshLocalForwardEvent,
} from "@liveagent/ui/lib/terminal/sshLocalForwardTypes";
import { getGatewayWebSocketClient, onGatewayWebSocketClientReplaced } from "@/lib/gatewaySocket";
import { loadToken } from "@/lib/storage";

function client() {
  return getGatewayWebSocketClient(loadToken().trim());
}

export const gatewaySshLocalForwardClient: SshLocalForwardClient = {
  async list(params) {
    return client().listSshLocalForwards(params);
  },
  async start(params) {
    return client().startSshLocalForward(params);
  },
  async stop(params) {
    return client().stopSshLocalForward(params);
  },
  /** Advisory loopback-port probe against the desktop machine; `true` means
   * the port looked free there. The authoritative bind still happens in
   * `start`, so treat this as UX only. */
  async checkLocalPort(port) {
    return client().checkSshLocalForwardPort(port);
  },
  async subscribe(listener: (event: SshLocalForwardEvent) => void) {
    // Subscriptions live on one client instance; when the singleton is
    // replaced (token change) re-attach to the new instance. The panel
    // re-lists after subscribing, so missed events converge via revision.
    let detach = client().subscribeSshLocalForward(listener);
    const detachReplaced = onGatewayWebSocketClientReplaced(() => {
      detach();
      detach = client().subscribeSshLocalForward(listener);
    });
    return () => {
      detach();
      detachReplaced();
    };
  },
};
