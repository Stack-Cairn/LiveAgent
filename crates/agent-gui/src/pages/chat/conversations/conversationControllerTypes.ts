import type { MentionComposerDraft } from "@liveagent/ui/components/chat/MentionComposer";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import type { ProjectRef } from "@liveagent/ui/lib/workbench/types";
import type { CompactionStatus } from "../../../lib/chat/compaction/types";
import type { SelectedModel } from "../../../lib/settings";
import type { PendingToolApprovalSummary } from "../../../lib/tools/toolApproval";
import type { QueuedChatTurn } from "../queue/chatTurnQueue";
import type { ConversationRuntimeEntry } from "../runtime/chatPageRuntime";

export type ConversationApprovalSlice = PendingToolApprovalSummary[];
export type ConversationModelSlice = SelectedModel | null;
export type ConversationCompactionSlice = CompactionStatus;
export type ConversationLifecycleSlice = {
  hydrating: boolean;
  hydrationFailed: boolean;
};

export type ConversationSurfaceSnapshot = {
  conversationId: string;
  project: ProjectRef;
  runtime: ConversationRuntimeEntry | null;
  draft: MentionComposerDraft | null;
  uploads: PendingUploadedFile[];
  queue: QueuedChatTurn[];
  approvals: ConversationApprovalSlice;
  model: ConversationModelSlice;
  compaction: ConversationCompactionSlice;
  lifecycle: ConversationLifecycleSlice;
};

export type ConversationControllerActions = {
  hydrate(input: { conversationId: string; project: ProjectRef }): Promise<void>;
  send(input: { conversationId: string; draft: MentionComposerDraft }): Promise<void>;
  stop(input: { conversationId: string }): void;
  compact(input: { conversationId: string }): Promise<void>;
  retry(input: { conversationId: string }): Promise<void>;
};

export type ConversationSurfaceController = {
  readonly conversationId: string;
  readonly project: ProjectRef;
  getSnapshot(): ConversationSurfaceSnapshot;
  subscribe(listener: () => void): () => void;
  retainView(): () => void;
  setDraft(draft: MentionComposerDraft): void;
  clearDraft(): void;
  hydrate(): Promise<void>;
  send(draft: MentionComposerDraft): Promise<void>;
  stop(): void;
  compact(): Promise<void>;
  retry(): Promise<void>;
  dispose(): void;
};
