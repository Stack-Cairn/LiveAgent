// Lazy history-window bookkeeping for opening/refreshing a conversation.
//
// The web end renders a conversation from tail windows of the persisted
// history (`history.get` with `max_messages`). Instead of hydrating the full
// conversation at idle — which makes open cost and per-turn quiet-refresh
// cost proportional to the conversation's lifetime size — the app tracks,
// per conversation, the oldest persisted message it has loaded:
//
//   oldestOffset — number of persisted messages ABOVE the loaded window
//                  (0 means the window starts at the very first message)
//   lastTotal    — the freshest total_message_count this client observed:
//                  the latest applied fetch, bumped forward by history-upsert
//                  summary counts (noteHistoryWindowTotal)
//
// Requests are EDGE-ANCHORED: a quiet refresh asks for
// `lastTotal - oldestOffset` messages, so the window always spans everything
// persisted after the established edge (covering every exchange streamed
// this session — alignEnrich requires the window to reach the live turns)
// while messages above the edge stay unfetched until the user pages up.
// "Load earlier" grows the request beyond the edge by a page.
//
// Because the tail window is anchored to the END of the conversation,
// concurrent appends between "compute request size" and "serve response"
// SLIP the returned window's top edge below the established one. Applying a
// slipped window could hand alignEnrich a window that no longer covers the
// rendered region's coverage counts (its count-coincidence full-window branch
// could then rebuild the region without the rows above the slipped edge), so
// slipped responses are never applied: the caller retries once with the
// corrected size from the response's authoritative total, and skips the
// cycle when the edge slipped again (the app's quiet-refresh loops converge
// on a later pass).
//
// The slip retry is the SAFETY NET, not the steady state: the desktop
// persists a run's messages before it reports completion, and the history
// upsert it publishes at that flush carries the new total. Folding that
// total into `lastTotal` (noteHistoryWindowTotal) before the busy→idle
// refresh plans its span makes the common post-turn refresh a single
// request; only a lossy/dropped upsert (they are best-effort broadcasts)
// leaves a stale span behind for the retry to correct.

export type HistoryWindowState = {
  /** Persisted messages above the loaded window (0 = window starts at message 0). */
  oldestOffset: number;
  /** Freshest observed total: latest applied response, bumped by upsert counts. */
  lastTotal: number;
};

export type HistoryWindowCounts = {
  totalMessageCount: number;
  returnedMessageCount: number;
  hasMore: boolean;
};

export type HistoryWindowVerdict =
  | { action: "apply"; nextState: HistoryWindowState }
  | { action: "retry"; retryMaxMessages: number };

function asNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

// Extracts usable window counts from a HistoryDetail-shaped response. Returns
// null when the producer did not report counts (defensive: bookkeeping is
// then dropped and the conversation falls back to plain tail-window fetches).
export function readHistoryWindowCounts(detail: {
  total_message_count?: number;
  returned_message_count?: number;
  has_more?: boolean;
}): HistoryWindowCounts | null {
  const total = asNonNegativeInt(detail.total_message_count);
  const returned = asNonNegativeInt(detail.returned_message_count);
  if (total === null || returned === null || total === 0 || returned === 0 || returned > total) {
    return null;
  }
  return {
    totalMessageCount: total,
    returnedMessageCount: returned,
    hasMore: detail.has_more === true,
  };
}

// Computes the max_messages for the next history fetch. `undefined` means
// fetch the full conversation (no window cap).
export function planHistoryWindowRequest(
  state: HistoryWindowState | undefined,
  options: {
    initialWindowMessages: number;
    extendMessages?: number;
  },
): number | undefined {
  const extend = Math.max(0, Math.floor(options.extendMessages ?? 0));
  if (!state) {
    return options.initialWindowMessages + extend;
  }
  if (state.oldestOffset <= 0) {
    // The window already reaches the first message: the conversation is
    // fully loaded and stays fully loaded (mirrors the pre-lazy behavior
    // after a full hydration).
    return undefined;
  }
  const spanned = Math.max(0, state.lastTotal - state.oldestOffset);
  return Math.max(options.initialWindowMessages, spanned) + extend;
}

// State adopted from an applied response.
export function adoptHistoryWindowState(counts: HistoryWindowCounts): HistoryWindowState {
  const edge = counts.hasMore
    ? Math.max(0, counts.totalMessageCount - counts.returnedMessageCount)
    : 0;
  return { oldestOffset: edge, lastTotal: counts.totalMessageCount };
}

// Folds an out-of-band total — a history upsert's summary message_count, the
// same total_message_count authority the fetch responses report — into the
// bookkeeping, so the next planned span already covers messages appended
// since the last applied fetch. Without this, every post-turn quiet refresh
// under-requests by exactly the flushed message count and burns a slipped-
// edge retry (two full window fetches per turn instead of one).
//
// Totals only move forward: a stale/invalid count returns the state
// untouched (identity — callers can skip the write), and truncations
// (edit-resend) converge through the fetch path, whose complete responses
// re-establish both fields authoritatively.
export function noteHistoryWindowTotal(
  state: HistoryWindowState,
  totalMessageCount: unknown,
): HistoryWindowState {
  const total = asNonNegativeInt(totalMessageCount);
  if (total === null || total <= state.lastTotal) {
    return state;
  }
  return { oldestOffset: state.oldestOffset, lastTotal: total };
}

// Decides whether a windowed response is safe to apply. See the module
// docblock for why slipped edges must not be applied. Callers retry at most
// once; a second "retry" verdict means "skip this cycle".
export function evaluateHistoryWindowResponse(params: {
  previous: HistoryWindowState | undefined;
  counts: HistoryWindowCounts;
  extendMessages?: number;
}): HistoryWindowVerdict {
  const { previous, counts } = params;
  const nextState = adoptHistoryWindowState(counts);
  if (!previous || !counts.hasMore) {
    // First observation establishes the edge; a complete fetch is always safe.
    return { action: "apply", nextState };
  }
  if (nextState.oldestOffset <= previous.oldestOffset) {
    return { action: "apply", nextState };
  }
  // The top edge slipped below the established one (the conversation grew
  // while the request was in flight): re-request anchored on the response's
  // authoritative total.
  const extend = Math.max(0, Math.floor(params.extendMessages ?? 0));
  const retryMaxMessages = Math.max(1, counts.totalMessageCount - previous.oldestOffset + extend);
  return { action: "retry", retryMaxMessages };
}

// Drops leading window entries that belong to a turn whose user message sits
// above the fetched window (windows with has_more only). Keeping the top of
// the rendered region aligned to a turn boundary keeps every parsed entry id
// stable across "load earlier" expansions: headless entries take their ids
// from a window-relative anchor ("ht:^>N") and would be re-keyed once their
// real user anchor scrolls into the window, which would break the
// virtualizer's keyed scroll anchoring and re-mount those rows.
//
// Leading checkpoint (compaction summary) entries are kept: their ids derive
// from the persisted summary id (window-position independent), and dropping
// them would hide the compaction marker for conversations whose window opens
// inside a compacted segment.
export function trimLeadingHeadlessEntries<T extends { kind: string }>(entries: T[]): T[] {
  const firstUserIndex = entries.findIndex((entry) => entry.kind === "user");
  if (firstUserIndex < 0) {
    // No user anchor in the whole window (one exchange larger than the
    // window): render as-is rather than blanking the transcript.
    return entries;
  }
  if (firstUserIndex === 0) {
    return entries;
  }
  const kept = entries.filter(
    (entry, index) => index >= firstUserIndex || entry.kind === "checkpoint",
  );
  return kept.length === entries.length ? entries : kept;
}
