import type { MentionComposerDraft } from "../../../components/chat/MentionComposer";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import type { ChatRuntimeControls, ExecutionMode } from "../../../lib/settings";

export type EnsureBackendBridgeConversationReadyOptions = {
  rebased?: boolean;
};

export type SendChatAction = (overrides?: {
  textOverride?: string;
  composerDraftOverride?: MentionComposerDraft;
  uploadedFilesOverride?: PendingUploadedFile[];
  conversationIdOverride?: string;
  executionModeOverride?: ExecutionMode;
  workdirOverride?: string;
  runtimeControlsOverride?: ChatRuntimeControls;
  preserveComposerOnStart?: boolean;
  // Edit-resend atomically replaces this user message and its following
  // history before the model runtime starts, then forwards the same anchor
  // so other connected clients can apply the rebase.
  editResendBaseMessageRef?: HistoryMessageRef;
}) => Promise<boolean>;
