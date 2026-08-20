import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
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
      gatewayUrl: remote.gatewayUrl,
      gatewayPort: remote.gatewayPort,
      heartbeatInterval: remote.heartbeatInterval,
      token: remote.token,
    }),
    [
      remote.agentId,
      remote.autoReconnect,
      remote.enabled,
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
    let cancelled = false;

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
