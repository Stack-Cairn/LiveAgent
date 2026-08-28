import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type { ChatCommandOutcome } from "@/lib/chat/stream/chatCommandPipeline";
import type { ChatRuntimeControls, CustomProvider } from "@/lib/settings";

export type SendChatOptions = {
  conversationId?: string;
  clientRequestId?: string;
  uploadedFiles?: PendingUploadedFile[];
  referencedConversations?: ConversationMentionReference[];
  runtimeControls?: ChatRuntimeControls;
  workdir?: string;
  editMessageRef?: HistoryMessageRef;
  queuePolicy?: "auto" | "append" | "interrupt";
  // false for queue-destined sends: no transcript echo, the queue panel owns
  // the prompt until it actually runs.
  optimisticEcho?: boolean;
};

export type SendChatFn = (
  message: string,
  options?: SendChatOptions,
) => Promise<ChatCommandOutcome | null>;

export type ModelProviderSource = Pick<CustomProvider, "id" | "name" | "type" | "activeModels">;

export type TunnelManagerToolChange = {
  action: "create" | "close";
  projectPathKey: string;
};
