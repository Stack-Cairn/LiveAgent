import { createUuid } from "@liveagent/ui/lib/shared/id";
import type { AppSettings } from "../../../lib/settings";

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

export function isRemoteSettingsConfigured(remote: AppSettings["remote"]) {
  return remote.gatewayUrl.trim() !== "" && remote.token.trim() !== "";
}

export function buildFallbackGatewayStatus(remote: AppSettings["remote"]): GatewayRuntimeStatus {
  return {
    online: false,
    enabled: remote.enabled,
    configured: isRemoteSettingsConfigured(remote),
    gatewayUrl: remote.gatewayUrl.trim(),
    sessionId: null,
    connectedSince: null,
    lastHeartbeat: null,
    lastError: null,
  };
}

export function createLocalGatewayChatRunId(conversationId: string) {
  return `conversation-live-${conversationId}-${createUuid()}`;
}
