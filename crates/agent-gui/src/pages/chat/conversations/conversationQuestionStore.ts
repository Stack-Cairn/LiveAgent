import {
  getPendingAskUserQuestionsSnapshot,
  type PendingAskUserQuestionSummary,
  subscribeAskUserQuestionsForConversation,
} from "../../../lib/tools/askUserQuestionTools";

export class ConversationQuestionStore {
  getSnapshot(conversationId: string): PendingAskUserQuestionSummary[] {
    return getPendingAskUserQuestionsSnapshot(conversationId);
  }

  subscribe(conversationId: string, listener: () => void): () => void {
    return subscribeAskUserQuestionsForConversation(conversationId, listener);
  }
}

export function createConversationQuestionStore(): ConversationQuestionStore {
  return new ConversationQuestionStore();
}
