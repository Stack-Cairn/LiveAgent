import type { MentionComposerDraft } from "@liveagent/ui/components/chat/MentionComposer";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import type { MutableRefObject } from "react";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import type {
  ChatRuntimeControls,
  CommandSafetyMode,
  ExecutionMode,
  ProviderId,
} from "../../../lib/settings";
import type { ConversationRuntimeEntry } from "../runtime/chatPageRuntime";

export type GatewaySelectedModelEvent = {
  customProviderId: string;
  model: string;
  providerType: string;
};

export type GatewayChatRuntimeControlsEvent = Pick<
  ChatRuntimeControls,
  "thinkingEnabled" | "nativeWebSearchEnabled" | "reasoning" | "planModeEnabled"
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
  commandSafetyMode?: string;
  uploadedFiles?: PendingUploadedFile[];
  referencedConversations?: ConversationMentionReference[];
  queuePolicy?: "auto" | "append" | "interrupt" | string;
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
  commandSafetyModeOverride?: CommandSafetyMode;
};

export type SendChatAction = (overrides?: {
  textOverride?: string;
  composerDraftOverride?: MentionComposerDraft;
  uploadedFilesOverride?: PendingUploadedFile[];
  conversationIdOverride?: string;
  executionModeOverride?: ExecutionMode;
  workdirOverride?: string;
  commandSafetyModeOverride?: CommandSafetyMode;
  runtimeControlsOverride?: ChatRuntimeControls;
  gatewayBridgeRequestOverride?: ActiveGatewayBridgeRequest | null;
  preserveComposerOnStart?: boolean;
  beforeRuntimeStart?: () => Promise<void>;
  afterInitialHistoryPersist?: () => Promise<void>;
  // Edit-resend atomically replaces this user message and its following
  // history before the model runtime starts, then forwards the same anchor
  // so other connected clients can apply the rebase.
  editResendBaseMessageRef?: HistoryMessageRef;
}) => Promise<boolean>;

export type GatewayBridgeRuntimeRefs = {
  currentConversationIdRef: MutableRefObject<string>;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  ensureGatewayBridgeConversationReadyRef: MutableRefObject<
    (id: string, options?: EnsureGatewayBridgeConversationReadyOptions) => Promise<string>
  >;
  sendActionRef: MutableRefObject<SendChatAction>;
};

export function normalizeGatewayProviderType(value: string): ProviderId | null {
  const normalized = value.trim();
  if (
    normalized === "codex" ||
    normalized === "claude_code" ||
    normalized === "gemini" ||
    normalized === "xai" ||
    normalized === "deepseek"
  ) {
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

// 命令安全模式的网关归一化。返回 undefined(而非某个默认模式)表示"远端未指定",
// 让 useSendChatTurn 的优先级链回落到本地 settings.system.commandSafetyMode;绝不
// 默认成 "auto",以免静默下调桌面端已选的更严格模式(fail-closed)。
export function normalizeGatewayCommandSafetyMode(
  value: string | null | undefined,
): CommandSafetyMode | undefined {
  switch (value?.trim()) {
    case "ask":
    case "auto":
    case "sandbox":
    case "sandboxOffline":
      return value.trim() as CommandSafetyMode;
    default:
      return undefined;
  }
}

export function normalizeGatewayWorkdir(value: string | null | undefined): string | undefined {
  const normalized = value?.trim() ?? "";
  return normalized || undefined;
}
