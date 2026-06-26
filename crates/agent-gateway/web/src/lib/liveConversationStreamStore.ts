import { pushChatEvent, type ChatEntry } from "./chatUi";
import type { ChatEvent, ChatRuntimeSnapshotEvent } from "./gatewayTypes";

export type LiveConversationStreamSnapshot = {
  revision: number;
  entries: ChatEntry[];
  toolStatus: string | null;
  toolStatusIsCompaction: boolean;
};

export type LiveConversationStreamStore = {
  getSnapshot: () => LiveConversationStreamSnapshot;
  subscribe: (listener: () => void) => () => void;
  applySnapshot: (event: ChatRuntimeSnapshotEvent, options?: { flush?: boolean }) => void;
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

function readRuntimeSnapshotRevision(event: ChatRuntimeSnapshotEvent) {
  return typeof event.revision === "number" && Number.isFinite(event.revision) && event.revision > 0
    ? Math.floor(event.revision)
    : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSnapshotChatEntry(value: unknown): value is ChatEntry {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.kind !== "string") {
    return false;
  }
  switch (value.kind) {
    case "user":
      return typeof value.text === "string" && Array.isArray(value.attachments);
    case "assistant":
    case "thinking":
    case "error":
      return typeof value.text === "string";
    case "tool_call":
      return isRecord(value.toolCall);
    case "tool_result":
      return isRecord(value.toolResult);
    case "hosted_search":
      return isRecord(value.hostedSearch);
    default:
      return false;
  }
}

function parseRuntimeSnapshotEntries(entriesJson: string | undefined) {
  const raw = typeof entriesJson === "string" ? entriesJson.trim() : "";
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSnapshotChatEntry) : [];
  } catch {
    return [];
  }
}

function isTerminalChatEvent(event: ChatEvent) {
  if (event.type === "done" || event.type === "error") {
    return true;
  }
  return event.type === "completed" || event.type === "failed" || event.type === "cancelled";
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
  let latestRuntimeSnapshotRevision = 0;
  let latestRuntimeSnapshotSeq = 0;
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
        if (latestRuntimeSnapshotSeq > 0 && eventSeq <= latestRuntimeSnapshotSeq) {
          return;
        }
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
    applySnapshot: (event, options) => {
      const eventSeq = readChatEventSeq(event);
      const snapshotRevision = readRuntimeSnapshotRevision(event);
      if (
        snapshotRevision > 0 &&
        latestRuntimeSnapshotRevision > 0 &&
        snapshotRevision < latestRuntimeSnapshotRevision
      ) {
        return;
      }
      if (
        snapshotRevision > 0 &&
        latestRuntimeSnapshotRevision > 0 &&
        snapshotRevision === latestRuntimeSnapshotRevision &&
        eventSeq !== null &&
        latestRuntimeSnapshotSeq > 0 &&
        eventSeq <= latestRuntimeSnapshotSeq
      ) {
        return;
      }

      const entries = parseRuntimeSnapshotEntries(event.entries_json);
      const toolStatus = normalizeOptionalStatus(event.tool_status);
      const toolStatusIsCompaction = Boolean(toolStatus) && event.tool_status_is_compaction === true;

      latestRuntimeSnapshotRevision = Math.max(latestRuntimeSnapshotRevision, snapshotRevision);
      if (eventSeq !== null) {
        latestRuntimeSnapshotSeq = Math.max(latestRuntimeSnapshotSeq, eventSeq);
        seenEventSeqs.add(eventSeq);
      }
      updateDraft(
        (previous) => {
          if (
            previous.entries === entries &&
            previous.toolStatus === toolStatus &&
            previous.toolStatusIsCompaction === toolStatusIsCompaction
          ) {
            return previous;
          }
          return {
            ...previous,
            entries,
            toolStatus,
            toolStatusIsCompaction,
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
      latestRuntimeSnapshotRevision = 0;
      latestRuntimeSnapshotSeq = 0;
      cancelScheduledCommit();
      commit();
    },
    flush: () => {
      cancelScheduledCommit();
      commit();
    },
  };
}
