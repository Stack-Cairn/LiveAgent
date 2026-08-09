import type {
  LocalTunnelClient,
  TunnelCreateInput,
  TunnelStateSnapshot,
  TunnelUpdateInput,
} from "@liveagent/ui/lib/tunnels/constants";
import { invoke } from "../tauriBridge";
import { listen } from "../tauriBridge";

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
      gatewayUnsupported: raw.gatewayUnsupported === true,
    };
  };
  return {
    subscribeTunnelState: (listener) => {
      listeners.add(listener);
      if (!unlistenPromise) {
        unlistenPromise = listen<TunnelStateSnapshot>("gateway:tunnel-state", (event) => {
          const snapshot = normalizeSnapshot(event.payload);
          for (const subscriber of [...listeners]) {
            subscriber(snapshot);
          }
        });
      }
      void invoke<TunnelStateSnapshot>("gateway_tunnel_state")
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
    createTunnel: (input: TunnelCreateInput) => invoke<void>("gateway_tunnel_create", { input }),
    updateTunnel: (input: TunnelUpdateInput) => invoke<void>("gateway_tunnel_update", { input }),
    closeTunnel: (id: string) => invoke<void>("gateway_tunnel_close", { tunnel_id: id }),
    checkTunnel: (id?: string) => invoke<void>("gateway_tunnel_check", { tunnel_id: id }),
  };
}
