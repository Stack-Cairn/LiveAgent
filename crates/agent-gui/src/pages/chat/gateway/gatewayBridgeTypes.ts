import type { MutableRefObject } from "react";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import type { ChatHistorySummary } from "../../../lib/chat/history/chatHistory";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import type {
  ChatRuntimeControls,
  ExecutionMode,
  ProviderId,
  SystemToolId,
} from "../../../lib/settings";
import type { ConversationRuntimeEntry } from "../runtime/chatPageRuntime";

export type GatewaySelectedModelEvent = {
  customProviderId: string;
  model: string;
  providerType: string;
};

export type GatewayChatRuntimeControlsEvent = Pick<
  ChatRuntimeControls,
  "thinkingEnabled" | "nativeWebSearchEnabled" | "reasoning"
>;

export type GatewayChatRequestEvent = {
  requestId: string;
  conversationId: string;
  clientRequestId?: string;
  message: string;
  rebased?: boolean;
  baseMessageRef?: HistoryMessageRef;
  selectedModel?: GatewaySelectedModelEvent;
  runtimeControls?: GatewayChatRuntimeControlsEvent;
  executionMode?: string;
  workdir?: string;
  selectedSystemTools?: string[];
  uploadedFiles?: PendingUploadedFile[];
};

export type GatewayChatClaimedRequest = {
  requestId: string;
  clientRequestId: string;
  conversationId: string;
  state: string;
  attempt: number;
  leaseMs: number;
  request: GatewayChatRequestEvent;
};

export type GatewayChatRequestReadyEvent = {
  requestId?: string;
  reason?: string;
};

export type EnsureGatewayBridgeConversationReadyOptions = {
  rebased?: boolean;
  baseMessageRef?: HistoryMessageRef;
};

export type GatewayChatCancelEvent = {
  requestId: string;
  conversationId: string;
};

export type ActiveGatewayBridgeRequest = {
  requestId: string;
  conversationId: string;
  clientRequestId?: string;
  workerId?: string;
  startedAt: number;
  selectedModelOverride?: GatewaySelectedModelEvent;
  runtimeControlsOverride?: ChatRuntimeControls;
  executionModeOverride?: ExecutionMode;
  workdirOverride?: string;
  selectedSystemToolIdsOverride?: SystemToolId[];
};

export type SendChatAction = (overrides?: {
  textOverride?: string;
  uploadedFilesOverride?: PendingUploadedFile[];
  conversationIdOverride?: string;
  executionModeOverride?: ExecutionMode;
  workdirOverride?: string;
  selectedSystemToolIdsOverride?: SystemToolId[];
  runtimeControlsOverride?: ChatRuntimeControls;
  gatewayBridgeRequestOverride?: ActiveGatewayBridgeRequest | null;
  beforeRuntimeStart?: () => Promise<void>;
  afterInitialHistoryPersist?: () => Promise<void>;
}) => Promise<void>;

export type GatewayBridgeRuntimeRefs = {
  currentConversationIdRef: MutableRefObject<string>;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  historyItemsRef: MutableRefObject<ChatHistorySummary[]>;
  ensureGatewayBridgeConversationReadyRef: MutableRefObject<
    (id: string, options?: EnsureGatewayBridgeConversationReadyOptions) => Promise<string>
  >;
  sendActionRef: MutableRefObject<SendChatAction>;
};

export function normalizeGatewayProviderType(value: string): ProviderId | null {
  const normalized = value.trim();
  if (normalized === "codex" || normalized === "claude_code" || normalized === "gemini") {
    return normalized;
  }
  return null;
}

export function normalizeGatewayExecutionMode(
  value: string | null | undefined,
): ExecutionMode | undefined {
  switch (value?.trim()) {
    case "tools":
    case "agent-dev":
    case "text":
      return value.trim() as ExecutionMode;
    default:
      return undefined;
  }
}

export function normalizeGatewayWorkdir(value: string | null | undefined): string | undefined {
  const normalized = value?.trim() ?? "";
  return normalized || undefined;
}
