import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  LocalTunnelClient,
  TunnelCreateInput,
  TunnelStateSnapshot,
  TunnelUpdateInput,
} from "./constants";

export function createTauriTunnelClient(): LocalTunnelClient {
  const listeners = new Set<(snapshot: TunnelStateSnapshot) => void>();
  let unlistenPromise: Promise<() => void> | null = null;
  const normalizeSnapshot = (payload: unknown): TunnelStateSnapshot => {
    const raw = (payload ?? {}) as Partial<TunnelStateSnapshot>;
    return {
      revision: raw.revision ?? 0,
      agentOnline: raw.agentOnline === true,
      relay: raw.relay ?? null,
      tunnels: raw.tunnels ?? [],
    };
  };
  return {
    subscribeTunnelState: (listener) => {
      listeners.add(listener);
      if (!unlistenPromise) {
        unlistenPromise = listen<TunnelStateSnapshot>("tunnel:state", (event) => {
          const snapshot = normalizeSnapshot(event.payload);
          for (const subscriber of [...listeners]) {
            subscriber(snapshot);
          }
        });
      }
      void invoke<TunnelStateSnapshot>("tunnel_state")
        .then((payload) => {
          if (listeners.has(listener)) {
            listener(normalizeSnapshot(payload));
          }
        })
        .catch(() => {});
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && unlistenPromise) {
          const pending = unlistenPromise;
          unlistenPromise = null;
          void pending.then((unlisten) => unlisten()).catch(() => {});
        }
      };
    },
    createTunnel: (input: TunnelCreateInput) => invoke<void>("tunnel_create", { input }),
    updateTunnel: (input: TunnelUpdateInput) => invoke<void>("tunnel_update", { input }),
    closeTunnel: (id: string) => invoke<void>("tunnel_close", { tunnel_id: id }),
    checkTunnel: (id?: string) => invoke<void>("tunnel_check", { tunnel_id: id }),
  };
}
