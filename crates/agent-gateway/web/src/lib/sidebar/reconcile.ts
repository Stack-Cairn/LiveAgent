// Pure reducers for the sidebar conversation list: sort, merge, upsert,
// authoritative reconcile, and backend-event application. Framework-free and
// byte-mirrored between agent-gui and agent-gateway/web.

import type { SidebarBackendEvent, SidebarConversation } from "./types";

export type MergeSidebarConversationOptions = {
  preserveExistingTitle?: boolean;
  preserveExistingUpdatedAt?: boolean;
};

export type ReconcileSidebarConversationsOptions = {
  // Ids kept even when absent from the authoritative list: local pending
  // drafts, in-flight mutations, and adapter-protected conversations. This is
  // the ONLY retain source — a blanket retain-all resurrects deletions made
  // by other clients while this one was offline.
  retainConversationIds?: Iterable<string>;
  preserveTitleConversationIds?: Iterable<string>;
  preserveUpdatedAtConversationIds?: Iterable<string>;
  // True when the authoritative list covers the whole scope (the backend
  // returned less than a full page). When false, the list is only
  // authoritative for the sorted prefix it spans: current items that sort
  // beyond its last entry cannot be judged and are kept.
  authoritativeComplete?: boolean;
};

export function compareSidebarConversations(a: SidebarConversation, b: SidebarConversation) {
  const aPinned = a.isPinned === true;
  const bPinned = b.isPinned === true;
  if (aPinned !== bPinned) {
    return aPinned ? -1 : 1;
  }
  if (aPinned && bPinned) {
    const pinnedDelta = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
    if (pinnedDelta !== 0) return pinnedDelta;
  }
  const updatedDelta = b.updatedAt - a.updatedAt;
  if (updatedDelta !== 0) return updatedDelta;
  return a.id.localeCompare(b.id);
}

export function sortSidebarConversations(
  conversations: readonly SidebarConversation[],
): SidebarConversation[] {
  return [...conversations].sort(compareSidebarConversations);
}

function mergeRequiredText(
  nextValue: string | null | undefined,
  previousValue: string | undefined,
  options: {
    nextUpdatedAt: number;
    previousUpdatedAt: number;
    preserveExisting?: boolean;
  },
) {
  const nextText = nextValue?.trim() ?? "";
  const previousText = previousValue?.trim() ?? "";
  if (previousText && options.preserveExisting) {
    return previousText;
  }
  if (nextText) {
    if (previousText && options.previousUpdatedAt > options.nextUpdatedAt) {
      return previousText;
    }
    return nextText;
  }
  return previousValue ?? "";
}

function mergeOptionalText(
  nextValue: string | null | undefined,
  previousValue: string | undefined,
) {
  if (typeof nextValue !== "string") {
    return previousValue;
  }
  return nextValue.trim() ? nextValue : previousValue;
}

function sameSidebarConversation(left: SidebarConversation, right: SidebarConversation) {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.providerId === right.providerId &&
    left.model === right.model &&
    left.sessionId === right.sessionId &&
    left.cwd === right.cwd &&
    left.messageCount === right.messageCount &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.isPinned === right.isPinned &&
    left.pinnedAt === right.pinnedAt &&
    left.isShared === right.isShared &&
    left.isPending === right.isPending
  );
}

export function mergeSidebarConversation(
  existing: SidebarConversation | undefined,
  next: SidebarConversation,
  options?: MergeSidebarConversationOptions,
): SidebarConversation {
  if (!existing) {
    return next;
  }

  const merged: SidebarConversation = {
    ...existing,
    ...next,
    title: mergeRequiredText(next.title, existing.title, {
      nextUpdatedAt: next.updatedAt,
      previousUpdatedAt: existing.updatedAt,
      preserveExisting: options?.preserveExistingTitle,
    }),
    updatedAt: options?.preserveExistingUpdatedAt ? existing.updatedAt : next.updatedAt,
    providerId: mergeOptionalText(next.providerId, existing.providerId) ?? "",
    model: mergeOptionalText(next.model, existing.model) ?? "",
    sessionId: mergeOptionalText(next.sessionId, existing.sessionId),
    cwd: mergeOptionalText(next.cwd, existing.cwd),
    isPinned: next.isPinned ?? existing.isPinned,
    pinnedAt: "pinnedAt" in next ? next.pinnedAt : existing.pinnedAt,
    isShared: next.isShared ?? existing.isShared,
    isPending: next.isPending === true ? true : undefined,
  };

  return sameSidebarConversation(existing, merged) ? existing : merged;
}

function sameSidebarConversationList(
  left: readonly SidebarConversation[],
  right: readonly SidebarConversation[],
) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function upsertSidebarConversation(
  conversations: readonly SidebarConversation[],
  next: SidebarConversation,
  options?: MergeSidebarConversationOptions,
): readonly SidebarConversation[] {
  const existing = conversations.find((item) => item.id === next.id);
  const merged = mergeSidebarConversation(existing, next, options);
  const rest = conversations.filter((item) => item.id !== next.id);
  const sorted = sortSidebarConversations([merged, ...rest]);
  return sameSidebarConversationList(conversations, sorted) ? conversations : sorted;
}

function toTrimmedIdSet(ids: Iterable<string> | undefined) {
  const set = new Set<string>();
  for (const id of ids ?? []) {
    const trimmed = id.trim();
    if (trimmed) {
      set.add(trimmed);
    }
  }
  return set;
}

export function reconcileSidebarConversations(
  currentConversations: readonly SidebarConversation[],
  authoritativeConversations: readonly SidebarConversation[],
  options?: ReconcileSidebarConversationsOptions,
): readonly SidebarConversation[] {
  const retainConversationIds = toTrimmedIdSet(options?.retainConversationIds);
  const preserveTitleConversationIds = toTrimmedIdSet(options?.preserveTitleConversationIds);
  const preserveUpdatedAtConversationIds = toTrimmedIdSet(
    options?.preserveUpdatedAtConversationIds,
  );
  const currentById = new Map(currentConversations.map((item) => [item.id, item]));
  const authoritativeIds = new Set<string>();
  const merged: SidebarConversation[] = [];

  for (const authoritative of authoritativeConversations) {
    const id = authoritative.id.trim();
    if (!id || authoritativeIds.has(id)) {
      continue;
    }
    authoritativeIds.add(id);
    merged.push(
      mergeSidebarConversation(currentById.get(authoritative.id), authoritative, {
        preserveExistingTitle: preserveTitleConversationIds.has(id),
        preserveExistingUpdatedAt: preserveUpdatedAtConversationIds.has(id),
      }),
    );
  }

  // The last authoritative entry bounds the sorted range the backend page
  // covers; absent current items sorting past it are outside the page's
  // authority and must be kept (they came from deeper pagination).
  const boundary =
    options?.authoritativeComplete === false && merged.length > 0
      ? merged[merged.length - 1]
      : null;

  for (const current of currentConversations) {
    if (authoritativeIds.has(current.id)) {
      continue;
    }
    if (
      current.isPending === true ||
      retainConversationIds.has(current.id) ||
      (boundary !== null && compareSidebarConversations(current, boundary) > 0)
    ) {
      merged.push(current);
    }
  }

  const sorted = sortSidebarConversations(merged);
  return sameSidebarConversationList(currentConversations, sorted) ? currentConversations : sorted;
}

export type ApplySidebarBackendEventOptions = {
  preserveTitleConversationIds?: Iterable<string>;
  preserveUpdatedAtConversationIds?: Iterable<string>;
};

export function applySidebarBackendEvent(
  conversations: readonly SidebarConversation[],
  event: SidebarBackendEvent,
  options?: ApplySidebarBackendEventOptions,
): readonly SidebarConversation[] {
  switch (event.kind) {
    case "delete": {
      const filtered = conversations.filter((item) => item.id !== event.conversationId);
      return filtered.length === conversations.length ? conversations : filtered;
    }
    case "running":
    case "idle":
      return conversations;
    case "upsert": {
      const conversationId = event.conversationId.trim();
      const preserveTitleConversationIds = toTrimmedIdSet(options?.preserveTitleConversationIds);
      const preserveUpdatedAtConversationIds = toTrimmedIdSet(
        options?.preserveUpdatedAtConversationIds,
      );
      return upsertSidebarConversation(conversations, event.conversation, {
        preserveExistingTitle: preserveTitleConversationIds.has(conversationId),
        preserveExistingUpdatedAt: preserveUpdatedAtConversationIds.has(conversationId),
      });
    }
  }
}
