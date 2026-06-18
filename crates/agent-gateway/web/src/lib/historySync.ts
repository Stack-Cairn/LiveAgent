import type {
  ConversationSummary,
  GatewayHistoryEvent,
  RunningConversationSummary,
} from "./gatewayTypes";

type ReconcileConversationSummariesOptions = {
  retainConversationIds?: Iterable<string>;
  preserveTitleConversationIds?: Iterable<string>;
  preserveUpdatedAtConversationIds?: Iterable<string>;
};

type MergeConversationSummaryOptions = {
  preserveExistingTitle?: boolean;
  preserveExistingUpdatedAt?: boolean;
};

type ApplyGatewayHistoryEventOptions = {
  preserveTitleConversationIds?: Iterable<string>;
  preserveUpdatedAtConversationIds?: Iterable<string>;
};

const SECONDS_TIMESTAMP_MAX = 10_000_000_000;

function normalizeComparableTimestamp(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value < SECONDS_TIMESTAMP_MAX ? value * 1000 : value;
}

function mergeRequiredText(
  nextValue: string | null | undefined,
  previousValue?: string,
  options?: {
    nextUpdatedAt?: number;
    preserveExisting?: boolean;
    previousUpdatedAt?: number;
  },
) {
  const nextText = nextValue?.trim() ?? "";
  const previousText = previousValue?.trim() ?? "";
  if (previousText && options?.preserveExisting) {
    return previousText;
  }
  if (nextText) {
    if (
      previousText &&
      normalizeComparableTimestamp(options?.previousUpdatedAt) >
        normalizeComparableTimestamp(options?.nextUpdatedAt)
    ) {
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

function sameConversationSummary(left: ConversationSummary, right: ConversationSummary) {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.created_at === right.created_at &&
    left.updated_at === right.updated_at &&
    left.message_count === right.message_count &&
    left.provider_id === right.provider_id &&
    left.model === right.model &&
    left.session_id === right.session_id &&
    left.cwd === right.cwd &&
    left.is_pinned === right.is_pinned &&
    left.pinned_at === right.pinned_at &&
    left.is_shared === right.is_shared
  );
}

function mergeConversationSummary(
  existing: ConversationSummary | undefined,
  nextConversation: ConversationSummary,
  options?: MergeConversationSummaryOptions,
) {
  if (!existing) {
    return nextConversation;
  }

  const merged = {
    ...existing,
    ...nextConversation,
    title: mergeRequiredText(nextConversation.title, existing.title, {
      nextUpdatedAt: nextConversation.updated_at,
      preserveExisting: options?.preserveExistingTitle,
      previousUpdatedAt: existing.updated_at,
    }),
    updated_at: options?.preserveExistingUpdatedAt
      ? existing.updated_at
      : nextConversation.updated_at,
    provider_id: mergeOptionalText(nextConversation.provider_id, existing.provider_id),
    model: mergeOptionalText(nextConversation.model, existing.model),
    session_id: mergeOptionalText(nextConversation.session_id, existing.session_id),
    cwd: mergeOptionalText(nextConversation.cwd, existing.cwd),
    is_pinned: nextConversation.is_pinned ?? existing.is_pinned,
    is_shared: nextConversation.is_shared ?? existing.is_shared,
    pinned_at:
      "pinned_at" in nextConversation ? nextConversation.pinned_at : existing.pinned_at,
  };

  return sameConversationSummary(existing, merged) ? existing : merged;
}

function sameConversationSummaryList(
  left: ConversationSummary[],
  right: ConversationSummary[],
) {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

export function sortConversationSummaries(
  conversations: ConversationSummary[],
): ConversationSummary[] {
  return [...conversations].sort((a, b) => {
    const aPinned = a.is_pinned === true;
    const bPinned = b.is_pinned === true;
    if (aPinned !== bPinned) {
      return aPinned ? -1 : 1;
    }
    if (aPinned && bPinned) {
      const pinnedDelta = (b.pinned_at ?? 0) - (a.pinned_at ?? 0);
      if (pinnedDelta !== 0) return pinnedDelta;
    }
    const updatedDelta = b.updated_at - a.updated_at;
    if (updatedDelta !== 0) return updatedDelta;
    return a.id.localeCompare(b.id);
  });
}

export function normalizeRunningConversationIds(ids: readonly unknown[] | undefined) {
  if (!ids || ids.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of ids) {
    const value = typeof id === "string" ? id.trim() : "";
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function normalizeRunningConversationSummary(
  value: unknown,
): RunningConversationSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const conversationId =
    typeof source.conversation_id === "string" ? source.conversation_id.trim() : "";
  if (!conversationId) {
    return null;
  }
  const cwd = typeof source.cwd === "string" ? source.cwd.trim() : "";
  const runId = typeof source.run_id === "string" ? source.run_id.trim() : "";
  const firstSeq =
    typeof source.first_seq === "number" &&
    Number.isFinite(source.first_seq) &&
    source.first_seq > 0
      ? Math.floor(source.first_seq)
      : undefined;
  const latestSeq =
    typeof source.latest_seq === "number" &&
    Number.isFinite(source.latest_seq) &&
    source.latest_seq > 0
      ? Math.floor(source.latest_seq)
      : undefined;
  const runEpoch =
    typeof source.run_epoch === "number" &&
    Number.isFinite(source.run_epoch) &&
    source.run_epoch > 0
      ? Math.floor(source.run_epoch)
      : undefined;
  const updatedAt =
    typeof source.updated_at === "number" && Number.isFinite(source.updated_at)
      ? source.updated_at
      : undefined;
  return {
    conversation_id: conversationId,
    run_id: runId || undefined,
    cwd: cwd || undefined,
    first_seq: firstSeq,
    latest_seq: latestSeq,
    run_epoch: runEpoch,
    updated_at: updatedAt,
  };
}

export function normalizeRunningConversations(
  conversations: readonly unknown[] | undefined,
  fallbackIds?: readonly unknown[],
) {
  const seen = new Set<string>();
  const normalized: RunningConversationSummary[] = [];
  for (const value of conversations ?? []) {
    const summary = normalizeRunningConversationSummary(value);
    if (!summary || seen.has(summary.conversation_id)) {
      continue;
    }
    seen.add(summary.conversation_id);
    normalized.push(summary);
  }
  for (const id of normalizeRunningConversationIds(fallbackIds)) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push({ conversation_id: id });
  }
  return normalized;
}

export function resolveRunningConversationStreamAfterSeq(firstSeq: unknown) {
  if (typeof firstSeq !== "number" || !Number.isFinite(firstSeq) || firstSeq <= 1) {
    return 0;
  }
  return Math.floor(firstSeq) - 1;
}

export function upsertConversationSummary(
  conversations: ConversationSummary[],
  nextConversation: ConversationSummary,
  options?: MergeConversationSummaryOptions,
): ConversationSummary[] {
  const existing = conversations.find((item) => item.id === nextConversation.id);
  const merged = mergeConversationSummary(existing, nextConversation, options);
  const next = conversations.filter((item) => item.id !== nextConversation.id);
  const sorted = sortConversationSummaries([merged, ...next]);
  return sameConversationSummaryList(conversations, sorted) ? conversations : sorted;
}

export function reconcileConversationSummaries(
  currentConversations: ConversationSummary[],
  nextConversations: ConversationSummary[],
  options?: ReconcileConversationSummariesOptions,
): ConversationSummary[] {
  const retainConversationIds = new Set(
    Array.from(options?.retainConversationIds ?? [])
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const preserveTitleConversationIds = new Set(
    Array.from(options?.preserveTitleConversationIds ?? [])
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const preserveUpdatedAtConversationIds = new Set(
    Array.from(options?.preserveUpdatedAtConversationIds ?? [])
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const currentById = new Map(currentConversations.map((item) => [item.id, item]));
  const nextIds = new Set<string>();
  const mergedConversations: ConversationSummary[] = [];

  for (const nextConversation of nextConversations) {
    const id = nextConversation.id.trim();
    if (!id || nextIds.has(id)) {
      continue;
    }
    nextIds.add(id);
    mergedConversations.push(
      mergeConversationSummary(currentById.get(nextConversation.id), nextConversation, {
        preserveExistingTitle: preserveTitleConversationIds.has(id),
        preserveExistingUpdatedAt: preserveUpdatedAtConversationIds.has(id),
      }),
    );
  }

  for (const currentConversation of currentConversations) {
    if (
      !nextIds.has(currentConversation.id) &&
      retainConversationIds.has(currentConversation.id)
    ) {
      mergedConversations.push(currentConversation);
    }
  }

  const sorted = sortConversationSummaries(mergedConversations);
  return sameConversationSummaryList(currentConversations, sorted)
    ? currentConversations
    : sorted;
}

export function applyGatewayHistoryEvent(
  conversations: ConversationSummary[],
  event: GatewayHistoryEvent,
  options?: ApplyGatewayHistoryEventOptions,
): ConversationSummary[] {
  switch (event.kind) {
    case "delete":
      return conversations.filter((item) => item.id !== event.conversation_id);
    case "running":
    case "idle":
      return conversations;
    case "upsert": {
      const conversationId = event.conversation_id.trim();
      const preserveTitleConversationIds = new Set(
        Array.from(options?.preserveTitleConversationIds ?? [])
          .map((id) => id.trim())
          .filter(Boolean),
      );
      const preserveUpdatedAtConversationIds = new Set(
        Array.from(options?.preserveUpdatedAtConversationIds ?? [])
          .map((id) => id.trim())
          .filter(Boolean),
      );
      return upsertConversationSummary(conversations, event.conversation, {
        preserveExistingTitle: preserveTitleConversationIds.has(conversationId),
        preserveExistingUpdatedAt: preserveUpdatedAtConversationIds.has(conversationId),
      });
    }
  }
}
