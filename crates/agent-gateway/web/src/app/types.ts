import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";
import type { ChatEntry } from "@/lib/chatUi";
import type { ChatRuntimeControls, CustomProvider } from "@/lib/settings";

export type ReloadHistoryOptions = {
  preferredConversationId?: string;
  hydrateSelection?: boolean;
  skipSelectionSync?: boolean;
  silent?: boolean;
  adoptPendingDraftConversation?: boolean;
};

export type OverlayState = "closed" | "entering" | "open" | "leaving";

export type LiveConversationStreamMeta = {
  hasStream: boolean;
  toolStatus: string | null;
  toolStatusIsCompaction: boolean;
};

export type ConversationRuntimeEntry = {
  messages: ChatEntry[];
  error: string | null;
  toolStatus: string | null;
  toolStatusIsCompaction: boolean;
  isSending: boolean;
  workdir?: string;
};

export type RunningConversationRuntime = {
  runId?: string;
  workdir?: string;
  firstSeq?: number;
  runEpoch?: number;
  updatedAt: number;
};

export type PendingDraftConversationMigration = {
  draftConversationId: string;
  startedAt: number;
};

export type SendChatOptions = {
  conversationId?: string;
  clientRequestId?: string;
  uploadedFiles?: PendingUploadedFile[];
  runtimeControls?: ChatRuntimeControls;
  workdir?: string;
  editMessageRef?: HistoryMessageRef;
  optimisticUserEntryId?: string;
  skipOptimisticUserEntry?: boolean;
  queuePolicy?: "auto" | "append" | "interrupt";
};

export type SendChatFn = (message: string, options?: SendChatOptions) => Promise<void>;

export type ModelProviderSource = Pick<CustomProvider, "id" | "name" | "type" | "activeModels">;

export type TunnelManagerToolChange = {
  action: "create" | "close";
  projectPathKey: string;
};
