import { invoke } from "@liveagent/app/shims/tauriCore";
import { listen } from "@liveagent/app/shims/tauriEvent";
import { useEffect, useMemo, useState } from "react";
import { isKBrainBackendEnabled, isTauriHost } from "../../../lib/host";
import type { AppSettings } from "../../../lib/settings";
import { buildFallbackGatewayStatus, type GatewayRuntimeStatus } from "./gatewayRuntimeStatusModel";

type UseGatewayStatusParams = {
  remote: AppSettings["remote"];
};

/**
 * Tracks the desktop gateway runtime status: one initial `gateway_status`
 * fetch plus a `gateway:status` event subscription, both re-armed when the
 * connection-relevant remote settings change.
 */
export function useGatewayStatus(params: UseGatewayStatusParams) {
  const { remote } = params;
  const remoteSnapshot = useMemo(
    () => ({
      agentId: remote.agentId,
      autoReconnect: remote.autoReconnect,
      enabled: remote.enabled,
      managedLocal: remote.managedLocal,
      localGatewayPort: remote.localGatewayPort,
      localGatewayToken: remote.localGatewayToken,
      gatewayUrl: remote.gatewayUrl,
      gatewayPort: remote.gatewayPort,
      heartbeatInterval: remote.heartbeatInterval,
      token: remote.token,
    }),
    [
      remote.agentId,
      remote.autoReconnect,
      remote.enabled,
      remote.managedLocal,
      remote.localGatewayPort,
      remote.localGatewayToken,
      remote.gatewayUrl,
      remote.gatewayPort,
      remote.heartbeatInterval,
      remote.token,
    ],
  );
  const [remoteRuntimeStatus, setRemoteRuntimeStatus] = useState<GatewayRuntimeStatus>(() =>
    buildFallbackGatewayStatus(remoteSnapshot),
  );

  useEffect(() => {
    if (isKBrainBackendEnabled() && !isTauriHost()) return;
    let cancelled = false;
    setRemoteRuntimeStatus(buildFallbackGatewayStatus(remoteSnapshot));

    void invoke<GatewayRuntimeStatus>("gateway_status")
      .then((status) => {
        if (!cancelled) {
          setRemoteRuntimeStatus(status);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRemoteRuntimeStatus(buildFallbackGatewayStatus(remoteSnapshot));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [remoteSnapshot]);

  useEffect(() => {
    if (isKBrainBackendEnabled() && !isTauriHost()) return;
    let cancelled = false;
    let dispose: (() => void) | null = null;

    void listen<GatewayRuntimeStatus>("gateway:status", (event) => {
      if (!cancelled) {
        setRemoteRuntimeStatus(event.payload);
      }
    })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        dispose = unlisten;
      })
      .catch(() => {
        if (!cancelled) {
          setRemoteRuntimeStatus(buildFallbackGatewayStatus(remoteSnapshot));
        }
      });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [remoteSnapshot]);

  return { remoteRuntimeStatus, setRemoteRuntimeStatus };
}
