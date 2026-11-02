import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
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
  /** 输入框“/”指令：经 K-brain 的 goal 接口开始本轮，或本条是提示词指令。 */
  goalAction?: "set" | "resume";
  goalText?: string;
  promptCommand?: boolean;
  planCommand?: boolean;
  waitForStart?: boolean;
};

export type SendChatFn = (
  message: string,
  options?: SendChatOptions,
) => Promise<ChatCommandOutcome | null>;

export type ModelProviderSource = Pick<
  CustomProvider,
  "id" | "name" | "type" | "requestFormat" | "activeModels"
>;

export type TunnelManagerToolChange = {
  action: "create" | "close";
  projectPathKey: string;
};
