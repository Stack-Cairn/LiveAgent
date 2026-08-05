import { createUuid } from "../../../lib/shared/id";

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

/**
 * 远程设置里已经没有「连到哪个 Gateway」了，拿不到运行时状态时只能当离线。
 */
export const OFFLINE_GATEWAY_STATUS: GatewayRuntimeStatus = {
  online: false,
  enabled: false,
  configured: false,
  gatewayUrl: null,
  sessionId: null,
  connectedSince: null,
  lastHeartbeat: null,
  lastError: null,
};

export function createLocalGatewayChatRunId(conversationId: string) {
  return `conversation-live-${conversationId}-${createUuid()}`;
}
