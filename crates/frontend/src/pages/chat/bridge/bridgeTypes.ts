import type { MutableRefObject } from "react";
import type { MentionComposerDraft } from "../../../components/chat/MentionComposer";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import type { ChatRuntimeControls, ExecutionMode, ProviderId } from "../../../lib/settings";
import type { ConversationRuntimeEntry } from "../runtime/chatPageRuntime";

export type BackendSelectedModelEvent = {
  customProviderId: string;
  model: string;
  providerType: string;
};

export type BackendChatRuntimeControlsEvent = Pick<
  ChatRuntimeControls,
  "thinkingEnabled" | "nativeWebSearchEnabled" | "reasoning"
>;

export type BackendChatRequestEvent = {
  requestId: string;
  conversationId: string;
  clientRequestId?: string;
  message: string;
  rebased?: boolean;
  baseMessageRef?: HistoryMessageRef;
  selectedModel?: BackendSelectedModelEvent;
  runtimeControls?: BackendChatRuntimeControlsEvent;
  executionMode?: string;
  workdir?: string;
  uploadedFiles?: PendingUploadedFile[];
  queuePolicy?: "auto" | "append" | "interrupt" | string;
};

export type BackendChatClaimedRequest = {
  requestId: string;
  clientRequestId: string;
  conversationId: string;
  state: string;
  attempt: number;
  leaseMs: number;
  request: BackendChatRequestEvent;
};

export type BackendChatRequestReadyEvent = {
  requestId?: string;
  reason?: string;
};

export type EnsureBackendBridgeConversationReadyOptions = {
  rebased?: boolean;
};

export type BackendChatCancelEvent = {
  requestId: string;
  conversationId: string;
};

export type ActiveBackendBridgeRequest = {
  requestId: string;
  conversationId: string;
  clientRequestId?: string;
  workerId?: string;
  startedAt: number;
  selectedModelOverride?: BackendSelectedModelEvent;
  runtimeControlsOverride?: ChatRuntimeControls;
  executionModeOverride?: ExecutionMode;
  workdirOverride?: string;
};

export type SendChatAction = (overrides?: {
  textOverride?: string;
  composerDraftOverride?: MentionComposerDraft;
  uploadedFilesOverride?: PendingUploadedFile[];
  conversationIdOverride?: string;
  executionModeOverride?: ExecutionMode;
  workdirOverride?: string;
  runtimeControlsOverride?: ChatRuntimeControls;
  backendBridgeRequestOverride?: ActiveBackendBridgeRequest | null;
  preserveComposerOnStart?: boolean;
  beforeRuntimeStart?: () => Promise<void>;
  afterInitialHistoryPersist?: () => Promise<void>;
  // Edit-resend atomically replaces this user message and its following
  // history before the model runtime starts, then forwards the same anchor
  // so other connected clients can apply the rebase.
  editResendBaseMessageRef?: HistoryMessageRef;
}) => Promise<boolean>;

export type BackendBridgeRuntimeRefs = {
  currentConversationIdRef: MutableRefObject<string>;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  ensureBackendBridgeConversationReadyRef: MutableRefObject<
    (id: string, options?: EnsureBackendBridgeConversationReadyOptions) => Promise<string>
  >;
  sendActionRef: MutableRefObject<SendChatAction>;
};

export function normalizeBackendProviderType(value: string): ProviderId | null {
  const normalized = value.trim();
  if (
    normalized === "codex" ||
    normalized === "claude_code" ||
    normalized === "gemini" ||
    normalized === "xai"
  ) {
    return normalized;
  }
  return null;
}

export function normalizeBackendExecutionMode(
  value: string | null | undefined,
): ExecutionMode | undefined {
  switch (value?.trim()) {
    case "tools":
    case "agent-dev":
      return value.trim() as ExecutionMode;
    default:
      return undefined;
  }
}

export function normalizeBackendWorkdir(value: string | null | undefined): string | undefined {
  const normalized = value?.trim() ?? "";
  return normalized || undefined;
}
