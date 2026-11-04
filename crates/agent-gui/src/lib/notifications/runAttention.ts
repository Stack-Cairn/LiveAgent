// Run-attention model: which conversations need the user after a background
// run (finished, or blocked on an approval / question), plus the device-local
// unread set behind the sidebar dot and the Dock badge.

export type RunAttentionKind = "completed" | "approval" | "question";

export type RunAttentionEvent = {
  kind: RunAttentionKind;
  conversationId: string;
};

export type RunAttentionState = {
  running: ReadonlySet<string>;
  approvals: ReadonlySet<string>;
  questions: ReadonlySet<string>;
};

/** Transitions between two snapshots that deserve the user's attention. */
export function diffRunAttention(
  previous: RunAttentionState,
  next: RunAttentionState,
): RunAttentionEvent[] {
  const events: RunAttentionEvent[] = [];
  for (const conversationId of next.approvals) {
    if (!previous.approvals.has(conversationId)) {
      events.push({ kind: "approval", conversationId });
    }
  }
  for (const conversationId of next.questions) {
    if (!previous.questions.has(conversationId) && !next.approvals.has(conversationId)) {
      events.push({ kind: "question", conversationId });
    }
  }
  for (const conversationId of previous.running) {
    if (!next.running.has(conversationId)) {
      events.push({ kind: "completed", conversationId });
    }
  }
  return events;
}

export type RunAttentionContext = {
  /** The conversation shown in the chat view (empty when another view is open). */
  visibleConversationId: string;
  /** Whether the app window is focused and visible. */
  windowFocused: boolean;
};

/** What to do for one event: mark the conversation unread and/or notify. */
export function resolveRunAttention(
  event: RunAttentionEvent,
  context: RunAttentionContext,
): { markUnread: boolean; notify: boolean } {
  const userIsLooking =
    context.windowFocused && context.visibleConversationId === event.conversationId;
  if (userIsLooking) return { markUnread: false, notify: false };
  return {
    // Blocked rows already carry their own sidebar pill; unread marks replies.
    markUnread:
      event.kind === "completed" && context.visibleConversationId !== event.conversationId,
    // While the window is focused the sidebar shows the state; only a
    // backgrounded app warrants a system notification.
    notify: !context.windowFocused,
  };
}

export function runAttentionBadgeCount(
  unread: ReadonlySet<string>,
  approvals: ReadonlySet<string>,
  questions: ReadonlySet<string>,
): number {
  const ids = new Set(unread);
  for (const id of approvals) ids.add(id);
  for (const id of questions) ids.add(id);
  return ids.size;
}

const UNREAD_STORAGE_KEY = "liveagent.unread-conversations.v1";
const UNREAD_LIMIT = 200;

export type UnreadConversationStore = {
  getSnapshot: () => ReadonlySet<string>;
  subscribe: (listener: () => void) => () => void;
  mark: (conversationId: string) => void;
  clear: (conversationId: string) => void;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function createUnreadConversationStore(
  storage: StorageLike | null = defaultStorage(),
): UnreadConversationStore {
  let snapshot: ReadonlySet<string> = readUnread(storage);
  const listeners = new Set<() => void>();

  const commit = (next: Set<string>) => {
    snapshot = next;
    try {
      storage?.setItem(UNREAD_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // Storage full or unavailable: the in-memory set still works.
    }
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mark: (conversationId) => {
      if (!conversationId || snapshot.has(conversationId)) return;
      const next = new Set(snapshot);
      next.add(conversationId);
      // Oldest marks go first once the cap is hit (Set keeps insertion order).
      while (next.size > UNREAD_LIMIT) {
        const oldest = next.values().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      commit(next);
    },
    clear: (conversationId) => {
      if (!snapshot.has(conversationId)) return;
      const next = new Set(snapshot);
      next.delete(conversationId);
      commit(next);
    },
  };
}

function readUnread(storage: StorageLike | null): ReadonlySet<string> {
  try {
    const raw = storage?.getItem(UNREAD_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0));
  } catch {
    return new Set();
  }
}
