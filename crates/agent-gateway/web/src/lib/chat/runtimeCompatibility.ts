import type { AgentStatus } from "@/lib/gatewayTypes";

export const CHAT_RUNTIME_PROTOCOL_INCOMPATIBLE = "protocol_incompatible";

export function isChatRuntimeProtocolIncompatible(status: AgentStatus | null | undefined): boolean {
  return (
    status?.online === true && status.runtime_state?.trim() === CHAT_RUNTIME_PROTOCOL_INCOMPATIBLE
  );
}
