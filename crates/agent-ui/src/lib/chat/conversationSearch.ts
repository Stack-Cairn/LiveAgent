import type { MentionComposerConversation } from "@liveagent/ui/components/chat/MentionComposerModel";
import { memorySearch } from "@liveagent/ui/lib/memory/api";

const HISTORY_SEARCH_FETCH_LIMIT = 80;
const HISTORY_SEARCH_RESULT_LIMIT = 30;

function normalizePreview(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export type PersistedConversationSearchResult = {
  id: string;
  title: string;
  cwd?: string;
  updatedAt?: number;
  searchPreview?: string;
};

export async function searchPersistedConversations(params: {
  query: string;
  currentWorkdir?: string;
  excludeConversationId?: string;
  limit?: number;
}): Promise<PersistedConversationSearchResult[]> {
  const query = params.query.trim();
  if (!query) return [];

  const response = await memorySearch({
    query,
    includeHistory: true,
    limit: HISTORY_SEARCH_FETCH_LIMIT,
  });
  const excludedId = params.excludeConversationId?.trim();
  const byConversation = new Map<string, PersistedConversationSearchResult & { score: number }>();
  for (const match of response.historyMatches ?? []) {
    const id = match.conversationId.trim();
    const title = match.title.trim();
    if (!id || !title || id === excludedId) continue;
    const existing = byConversation.get(id);
    const score = Number.isFinite(match.score) ? match.score : 0;
    if (existing && existing.score >= score) continue;
    byConversation.set(id, {
      id,
      title,
      cwd: match.cwd?.trim() || undefined,
      updatedAt: match.updatedAt,
      searchPreview: normalizePreview(match.snippet),
      score,
    });
  }

  const currentWorkdir = params.currentWorkdir?.trim();
  return [...byConversation.values()]
    .sort((a, b) => {
      const aSameWorkdir = Boolean(currentWorkdir && a.cwd === currentWorkdir);
      const bSameWorkdir = Boolean(currentWorkdir && b.cwd === currentWorkdir);
      if (aSameWorkdir !== bSameWorkdir) return aSameWorkdir ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    })
    .slice(0, Math.max(1, params.limit ?? HISTORY_SEARCH_RESULT_LIMIT))
    .map(({ score: _score, ...conversation }) => conversation);
}

export async function searchMentionConversations(params: {
  query: string;
  currentConversationId: string;
  currentWorkdir?: string;
  limit?: number;
}): Promise<MentionComposerConversation[]> {
  return searchPersistedConversations({
    query: params.query,
    currentWorkdir: params.currentWorkdir,
    excludeConversationId: params.currentConversationId,
    limit: params.limit,
  });
}
