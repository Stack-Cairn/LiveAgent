import { createUuid } from "@liveagent/ui/lib/shared/id";
import {
  isRemoteSettingsConfigured,
  type RemoteGatewaySettings,
} from "../../../lib/settings/remoteGateway";

export type GatewayRuntimeStatus = {
  online: boolean;
  enabled: boolean;
  configured: boolean;
  gatewayUrl?: string | null;
  sessionId?: string | null;
  connectedSince?: number | null;
  lastHeartbeat?: number | null;
  lastError?: string | null;
};

type GatewayFallbackSettings = RemoteGatewaySettings;

export { isRemoteSettingsConfigured };

/**
 * Whether runs started on this desktop are mirrored to the Gateway so a WebUI can watch
 * them and answer their approvals. A Gateway hosted on this computer (managedLocal) keeps
 * its token in localGatewayToken, so the external URL + token test alone missed it.
 */
export function mirrorsLocalRunsToGateway(remote: GatewayFallbackSettings, gatewayMirror: boolean) {
  return gatewayMirror && remote.enabled && isRemoteSettingsConfigured(remote);
}

export function buildFallbackGatewayStatus(remote: GatewayFallbackSettings): GatewayRuntimeStatus {
  return {
    online: false,
    enabled: remote.enabled,
    configured: isRemoteSettingsConfigured(remote),
    gatewayUrl: remote.managedLocal
      ? `http://127.0.0.1:${remote.localGatewayPort}`
      : remote.gatewayUrl.trim(),
    sessionId: null,
    connectedSince: null,
    lastHeartbeat: null,
    lastError: null,
  };
}

export function createLocalGatewayChatRunId(conversationId: string) {
  return `conversation-live-${conversationId}-${createUuid()}`;
}
