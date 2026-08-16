import {
  getPendingToolApprovalsSnapshot,
  type PendingToolApprovalSummary,
  subscribeToolApprovalsForConversation,
} from "../../../lib/tools/toolApproval";

export class ConversationApprovalStore {
  getSnapshot(conversationId: string): PendingToolApprovalSummary[] {
    return getPendingToolApprovalsSnapshot(conversationId);
  }

  subscribe(conversationId: string, listener: () => void): () => void {
    return subscribeToolApprovalsForConversation(conversationId, listener);
  }
}

export function createConversationApprovalStore(): ConversationApprovalStore {
  return new ConversationApprovalStore();
}
