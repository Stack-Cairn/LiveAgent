/**
 * Pending "jump to message" request produced by the conversation search dialog.
 * The dialog records the target before opening the conversation; the transcript
 * consumes it once the matching row is loaded (or gives up after paging).
 */
export type SearchJumpTarget = {
  conversationId: string;
  messageId?: string;
  messageIndex?: number;
};

let pending: SearchJumpTarget | null = null;
const listeners = new Set<() => void>();

/** Subscribe to target changes, so a jump within the already-open conversation still runs. */
export function subscribeSearchJumpTarget(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSearchJumpTargetSnapshot(): SearchJumpTarget | null {
  return pending;
}

export function setSearchJumpTarget(target: SearchJumpTarget | null) {
  pending =
    target?.conversationId.trim() && (target.messageId || target.messageIndex !== undefined)
      ? target
      : null;

  for (const listener of listeners) listener();
}

export function peekSearchJumpTarget(conversationId: string): SearchJumpTarget | null {
  return pending && pending.conversationId === conversationId ? pending : null;
}

export function clearSearchJumpTarget(target: SearchJumpTarget) {
  if (pending === target) pending = null;
}

export type JumpCandidate = {
  kind: string;
  key: string;
  messageId?: string;
  messageIndex?: number;
};

/**
 * Pick the row key the transcript should scroll to for `target`.
 * `items` are timeline items in display order. Returns null when the target
 * is not part of the currently loaded window.
 */
export function resolveSearchJumpRowKey(
  items: readonly JumpCandidate[],
  target: SearchJumpTarget,
): string | null {
  const byId = target.messageId
    ? items.findIndex((item) => item.messageId === target.messageId)
    : -1;
  let hit = byId;
  if (hit < 0 && target.messageIndex !== undefined) {
    const index = target.messageIndex;
    // Assistant groups only carry their starting index, so match by range:
    // the last item whose index is <= target owns it.
    for (let i = 0; i < items.length; i += 1) {
      const start = items[i].messageIndex;
      if (start === undefined) continue;
      if (start === index) {
        hit = i;
        break;
      }
      if (start < index) hit = i;
      else break;
    }
  }
  if (hit < 0) return null;
  for (let i = hit; i >= 0; i -= 1) {
    if (items[i].kind === "user") return items[i].key;
  }
  return null;
}
