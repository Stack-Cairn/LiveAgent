import type {
  ChatHistoryListFilter,
  ChatHistorySummary,
} from "../../lib/chat/history/chatHistory";
import { sortHistoryItems } from "../../lib/chat/page/chatPageHelpers";

export function chatHistoryFilterKey(filter?: ChatHistoryListFilter) {
  if (filter?.cwdEmpty) return "cwd-empty";
  const cwd = filter?.cwd?.trim();
  return cwd ? `cwd:${cwd}` : "all";
}

export function historyItemMatchesFilter(
  item: ChatHistorySummary,
  filter?: ChatHistoryListFilter,
) {
  if (filter?.cwdEmpty) {
    return !item.cwd?.trim();
  }
  const cwd = filter?.cwd?.trim();
  if (cwd) {
    return item.cwd?.trim() === cwd;
  }
  return true;
}

export function filterHistoryItemsForScope(
  items: ChatHistorySummary[],
  filter?: ChatHistoryListFilter,
) {
  const filtered = items.filter((item) => historyItemMatchesFilter(item, filter));
  return filtered.length === items.length ? items : filtered;
}

export function sortScopedHistoryItems(
  items: ChatHistorySummary[],
  filter?: ChatHistoryListFilter,
) {
  return sortHistoryItems(filterHistoryItemsForScope(items, filter));
}

export function mergeScopedHistoryPage(
  current: ChatHistorySummary[],
  nextPage: ChatHistorySummary[],
  filter?: ChatHistoryListFilter,
) {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of nextPage) {
    byId.set(item.id, item);
  }
  return sortScopedHistoryItems(Array.from(byId.values()), filter);
}
