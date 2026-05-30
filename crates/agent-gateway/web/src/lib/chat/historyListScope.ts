import type { ConversationSummary, HistoryListFilter } from "../gatewayTypes";

export function historyConversationMatchesFilter(
  conversation: ConversationSummary | undefined,
  filter?: HistoryListFilter,
) {
  if (!conversation) {
    return false;
  }
  if (filter?.cwdEmpty) {
    return !conversation.cwd?.trim();
  }
  const cwd = filter?.cwd?.trim();
  if (cwd) {
    return conversation.cwd?.trim() === cwd;
  }
  return true;
}

export function filterConversationSummariesForScope(
  conversations: ConversationSummary[],
  filter?: HistoryListFilter,
) {
  const filtered = conversations.filter((conversation) =>
    historyConversationMatchesFilter(conversation, filter),
  );
  return filtered.length === conversations.length ? conversations : filtered;
}
