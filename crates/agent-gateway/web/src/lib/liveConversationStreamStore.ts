import { pushChatEvent, type ChatEntry } from "./chatUi";
import type { ChatEvent } from "./gatewayTypes";

export type LiveConversationStreamSnapshot = {
  revision: number;
  entries: ChatEntry[];
  toolStatus: string | null;
  toolStatusIsCompaction: boolean;
};

export type LiveConversationStreamStore = {
  getSnapshot: () => LiveConversationStreamSnapshot;
  subscribe: (listener: () => void) => () => void;
  appendEvent: (event: ChatEvent, options?: { flush?: boolean }) => void;
  setToolStatus: (
    toolStatus: string | null | undefined,
    isCompaction?: boolean,
    options?: { flush?: boolean },
  ) => void;
  reset: () => void;
  flush: () => void;
};

const EMPTY_SNAPSHOT: LiveConversationStreamSnapshot = {
  revision: 0,
  entries: [],
  toolStatus: null,
  toolStatusIsCompaction: false,
};
const LIVE_STREAM_COMMIT_INTERVAL_MS = 48;
const LIVE_STREAM_LONG_TEXT_COMMIT_INTERVAL_MS = 80;
const LIVE_STREAM_BACKGROUND_COMMIT_INTERVAL_MS = 160;
const LIVE_STREAM_RAF_FALLBACK_MS = 250;
const LIVE_STREAM_LONG_TEXT_LENGTH = 6000;

function normalizeOptionalStatus(value: string | null | undefined) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function canUseAnimationFrame() {
  return (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function" &&
    typeof window.cancelAnimationFrame === "function"
  );
}

function canUseTimeout() {
  return (
    typeof window !== "undefined" &&
    typeof window.setTimeout === "function" &&
    typeof window.clearTimeout === "function"
  );
}

function isDocumentVisible() {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function shouldUseAnimationFrameForCommit() {
  return canUseAnimationFrame() && isDocumentVisible();
}

function getLatestLiveTextLength(snapshot: LiveConversationStreamSnapshot) {
  for (let index = snapshot.entries.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.entries[index];
    if (!entry) {
      continue;
    }
    if (entry.kind === "assistant" || entry.kind === "thinking") {
      return entry.text.length;
    }
    if (entry.kind === "user" || entry.kind === "checkpoint" || entry.kind === "error") {
      break;
    }
  }
  return 0;
}

function readChatEventSeq(event: ChatEvent) {
  const seq = event.seq;
  return typeof seq === "number" && Number.isFinite(seq) && seq > 0
    ? Math.floor(seq)
    : null;
}

function isTerminalChatEvent(event: ChatEvent) {
  if (event.type === "done" || event.type === "error") {
    return true;
  }
  if (event.type !== "completed" && event.type !== "failed" && event.type !== "cancelled") {
    return false;
  }
  return (
    event.state === "completed" ||
    event.state === "failed" ||
    event.state === "cancelled"
  );
}

function isChatControlEvent(event: ChatEvent) {
  switch (event.type) {
    case "accepted":
    case "user_message":
    case "rebased":
    case "projection_updated":
    case "delivered":
    case "claimed":
    case "starting":
    case "queued_in_gui":
    case "started":
    case "progress":
    case "completed":
    case "failed":
    case "cancelled":
      return true;
    default:
      return false;
  }
}

function shouldAppendChatEvent(event: ChatEvent) {
  if (event.type === "user_message") {
    return true;
  }
  if (event.type === "error" || event.type === "failed") {
    return true;
  }
  return event.type !== "done" && !isChatControlEvent(event);
}

function resolveCommitInterval(snapshot: LiveConversationStreamSnapshot) {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") {
    return LIVE_STREAM_BACKGROUND_COMMIT_INTERVAL_MS;
  }
  return getLatestLiveTextLength(snapshot) >= LIVE_STREAM_LONG_TEXT_LENGTH
    ? LIVE_STREAM_LONG_TEXT_COMMIT_INTERVAL_MS
    : LIVE_STREAM_COMMIT_INTERVAL_MS;
}

export function createLiveConversationStreamStore(): LiveConversationStreamStore {
  let draft = EMPTY_SNAPSHOT;
  let snapshot = EMPTY_SNAPSHOT;
  let rafId: number | null = null;
  let timeoutId: number | null = null;
  let rafFallbackTimeoutId: number | null = null;
  let lastCommitAt = 0;
  const seenEventSeqs = new Set<number>();
  const listeners = new Set<() => void>();

  const emitChange = () => {
    listeners.forEach((listener) => listener());
  };

  const cancelScheduledCommit = () => {
    if (rafId !== null && canUseAnimationFrame()) {
      window.cancelAnimationFrame(rafId);
    }
    rafId = null;
    if (timeoutId !== null && canUseTimeout()) {
      window.clearTimeout(timeoutId);
    }
    timeoutId = null;
    if (rafFallbackTimeoutId !== null && canUseTimeout()) {
      window.clearTimeout(rafFallbackTimeoutId);
    }
    rafFallbackTimeoutId = null;
  };

  const commit = () => {
    rafId = null;
    timeoutId = null;
    rafFallbackTimeoutId = null;
    if (snapshot === draft) {
      return;
    }
    snapshot = draft;
    lastCommitAt = Date.now();
    emitChange();
  };

  const scheduleCommit = () => {
    if (
      rafId !== null ||
      timeoutId !== null ||
      rafFallbackTimeoutId !== null ||
      snapshot === draft
    ) {
      return;
    }

    const elapsed = Date.now() - lastCommitAt;
    const delay = Math.max(0, resolveCommitInterval(draft) - elapsed);
    const scheduleFrame = () => {
      timeoutId = null;
      if (!shouldUseAnimationFrameForCommit()) {
        commit();
        return;
      }
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        if (rafFallbackTimeoutId !== null && canUseTimeout()) {
          window.clearTimeout(rafFallbackTimeoutId);
        }
        rafFallbackTimeoutId = null;
        commit();
      });
      if (canUseTimeout()) {
        rafFallbackTimeoutId = window.setTimeout(() => {
          rafFallbackTimeoutId = null;
          if (rafId !== null && canUseAnimationFrame()) {
            window.cancelAnimationFrame(rafId);
          }
          rafId = null;
          commit();
        }, LIVE_STREAM_RAF_FALLBACK_MS);
      }
    };
    if (delay <= 0 || !canUseTimeout()) {
      scheduleFrame();
    } else {
      timeoutId = window.setTimeout(scheduleFrame, delay);
    }
  };

  const updateDraft = (
    updater: (previous: LiveConversationStreamSnapshot) => LiveConversationStreamSnapshot,
    options?: { flush?: boolean },
  ) => {
    const next = updater(draft);
    if (next === draft) {
      if (options?.flush) {
        cancelScheduledCommit();
        commit();
      }
      return;
    }
    draft = {
      ...next,
      revision: draft.revision + 1,
    };
    if (options?.flush) {
      cancelScheduledCommit();
      commit();
    } else {
      scheduleCommit();
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    appendEvent: (event, options) => {
      const eventSeq = readChatEventSeq(event);
      if (eventSeq !== null) {
        if (seenEventSeqs.has(eventSeq)) {
          return;
        }
        seenEventSeqs.add(eventSeq);
      }

      if (event.type === "tool_status") {
        updateDraft(
          (previous) => {
            const status = normalizeOptionalStatus(event.status);
            const isCompaction = Boolean(status) && event.isCompaction === true;
            if (
              previous.toolStatus === status &&
              previous.toolStatusIsCompaction === isCompaction
            ) {
              return previous;
            }
            return {
              ...previous,
              toolStatus: status,
              toolStatusIsCompaction: isCompaction,
            };
          },
          options,
        );
        return;
      }

      updateDraft(
        (previous) => {
          const terminal = isTerminalChatEvent(event);
          const nextEntries = shouldAppendChatEvent(event)
            ? pushChatEvent(previous.entries, event)
            : previous.entries;
          const shouldClearStatus = terminal;
          if (
            nextEntries === previous.entries &&
            (!shouldClearStatus ||
              (previous.toolStatus === null && !previous.toolStatusIsCompaction))
          ) {
            return previous;
          }
          return {
            ...previous,
            entries: nextEntries,
            toolStatus: shouldClearStatus ? null : previous.toolStatus,
            toolStatusIsCompaction: shouldClearStatus
              ? false
              : previous.toolStatusIsCompaction,
          };
        },
        options,
      );
    },
    setToolStatus: (toolStatus, isCompaction = false, options) => {
      updateDraft(
        (previous) => {
          const status = normalizeOptionalStatus(toolStatus);
          const nextIsCompaction = Boolean(status) && isCompaction;
          if (
            previous.toolStatus === status &&
            previous.toolStatusIsCompaction === nextIsCompaction
          ) {
            return previous;
          }
          return {
            ...previous,
            toolStatus: status,
            toolStatusIsCompaction: nextIsCompaction,
          };
        },
        options,
      );
    },
    reset: () => {
      if (
        draft.entries.length === 0 &&
        draft.toolStatus === null &&
        !draft.toolStatusIsCompaction
      ) {
        cancelScheduledCommit();
        return;
      }
      draft = {
        ...EMPTY_SNAPSHOT,
        revision: draft.revision + 1,
      };
      seenEventSeqs.clear();
      cancelScheduledCommit();
      commit();
    },
    flush: () => {
      cancelScheduledCommit();
      commit();
    },
  };
}
