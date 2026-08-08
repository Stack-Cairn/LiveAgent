// Web transport for the ManagedProcess store: panel operations are relayed
// through the gateway's process.* websocket protocol to the desktop-owned
// registry, and state arrives via the process.state broadcast (replayed on
// connect from the gateway cache). This file is the per-platform adapter —
// the desktop frontend ships its own copy speaking Tauri invoke.

import type {
  ManagedProcessBackend,
  ManagedProcessState,
} from "@liveagent/ui/lib/managed-process/types";
import {
  getGatewayWebSocketClient,
  type ManagedProcessStatePayload,
  onGatewayWebSocketClientReplaced,
} from "../gatewaySocket";
import { loadToken } from "../storage";

function client() {
  return getGatewayWebSocketClient(loadToken().trim());
}

function toState(payload: ManagedProcessStatePayload): ManagedProcessState {
  return { ready: true, ...payload };
}

export const backend: ManagedProcessBackend = {
  async fetchState(): Promise<ManagedProcessState> {
    return toState(await client().processSnapshot());
  },

  async stop(id: string): Promise<ManagedProcessState | null> {
    const state = await client().processStop(id);
    return state ? toState(state) : null;
  },

  async clear(id?: string): Promise<ManagedProcessState | null> {
    const state = await client().processClear(id);
    return state ? toState(state) : null;
  },

  readLog(id: string, maxBytes?: number) {
    return client().processReadLog(id, maxBytes);
  },

  subscribe(onState: (state: ManagedProcessState) => void): () => void {
    const handler = (state: ManagedProcessStatePayload) => {
      onState(toState(state));
    };
    // Subscriptions live on one client instance; when the singleton is
    // replaced (token change) re-attach to the new instance and refetch the
    // state missed during the swap.
    let detach = client().subscribeProcessState(handler);
    const detachReplaced = onGatewayWebSocketClientReplaced(() => {
      detach();
      detach = client().subscribeProcessState(handler);
      client()
        .processSnapshot()
        .then(handler)
        .catch(() => {});
    });
    return () => {
      detach();
      detachReplaced();
    };
  },
};
