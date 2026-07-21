import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";
import type { TranscriptSnapshot, TranscriptStore } from "../transcript/transcriptStore";
import { createTranscriptStore } from "../transcript/transcriptStore";
import type { ActivityStore } from "./activityStore";
import type { ConversationStreamEvent, ConversationSubscribeResult } from "./streamTypes";

// Registry of transcript stores, one per conversation. Stores persist across
// conversation switches so revisiting a conversation keeps its tail state;
// they are dropped when the conversation is deleted or re-keyed.
export type TranscriptStoreRegistry = {
  get(conversationId: string): TranscriptStore;
  peek(conversationId: string): TranscriptStore | null;
  move(fromConversationId: string, toConversationId: string): void;
  remove(conversationId: string): void;
  clear(): void;
};

export function createTranscriptStoreRegistry(hooks?: {
  // A store detected run-topology divergence (see createTranscriptStore's
  // onDivergence); reported with the conversation id the store is currently
  // registered under so the app can resubscribe that conversation's stream.
  onDivergence?: (conversationId: string) => void;
}): TranscriptStoreRegistry {
  const stores = new Map<string, TranscriptStore>();
  // Mutable identity per store: `move` re-keys a draft store to its real
  // conversation id, and divergence must report the current key.
  const storeIds = new WeakMap<TranscriptStore, { conversationId: string }>();
  return {
    get(conversationId) {
      let store = stores.get(conversationId);
      if (!store) {
        const identity = { conversationId };
        store = createTranscriptStore({
          onDivergence: () => hooks?.onDivergence?.(identity.conversationId),
        });
        storeIds.set(store, identity);
        stores.set(conversationId, store);
      }
      return store;
    },
    peek(conversationId) {
      return stores.get(conversationId) ?? null;
    },
    move(fromConversationId, toConversationId) {
      const store = stores.get(fromConversationId);
      if (!store) {
        return;
      }
      stores.delete(fromConversationId);
      stores.set(toConversationId, store);
      const identity = storeIds.get(store);
      if (identity) {
        identity.conversationId = toConversationId;
      }
    },
    remove(conversationId) {
      stores.delete(conversationId);
    },
    clear() {
      stores.clear();
    },
  };
}

const EMPTY_TRANSCRIPT: TranscriptSnapshot = {
  rows: [],
  liveStartIndex: -1,
  activeTurnKey: null,
  entryCount: 0,
  activeRun: null,
  toolStatus: null,
  toolStatusIsCompaction: false,
  retryAttempts: [],
  foldRevision: 0,
  revision: 0,
};

export type ConversationChatBinding = {
  transcript: TranscriptSnapshot;
  // The conversation has an active run (from the transcript's own stream
  // state — activityStore covers non-visible conversations).
  busy: boolean;
};

// Binds the visible conversation to its transcript store and a persistent
// stream subscription. Subscribing eagerly — before any run exists — is what
// makes queue auto-sends race-free: the events just flow in.
export function useConversationChat(params: {
  api: GatewayWebSocketClientLike | null;
  conversationId: string | null;
  registry: TranscriptStoreRegistry;
  activityStore: ActivityStore;
  isLocalDraft: (conversationId: string) => boolean;
  // Extra chances for the app layer to observe stream traffic (titles,
  // pending-command settlement, tunnel events, queue refreshes).
  onStreamEvent?: (conversationId: string, event: ConversationStreamEvent) => void;
  onStreamSync?: (conversationId: string, result: ConversationSubscribeResult) => void;
  hasPendingCommand: (conversationId: string) => boolean;
  pendingRevision: number;
}): ConversationChatBinding {
  const {
    api,
    conversationId,
    registry,
    activityStore,
    isLocalDraft,
    onStreamEvent,
    onStreamSync,
    hasPendingCommand,
    pendingRevision,
  } = params;

  const onStreamEventRef = useRef(onStreamEvent);
  onStreamEventRef.current = onStreamEvent;
  const onStreamSyncRef = useRef(onStreamSync);
  onStreamSyncRef.current = onStreamSync;

  const store = useMemo(
    () => (conversationId ? registry.get(conversationId) : null),
    [conversationId, registry],
  );

  useEffect(() => {
    if (!api || !conversationId || !store || isLocalDraft(conversationId)) {
      return;
    }
    const cleanup = api.subscribeConversationStream(conversationId, {
      onSync: (result) => {
        store.applySync(result);
        onStreamSyncRef.current?.(conversationId, result);
      },
      onEvent: (event) => {
        store.applyEvent(event);
        onStreamEventRef.current?.(conversationId, event);
      },
    });
    return cleanup;
  }, [api, conversationId, store, isLocalDraft]);

  // Streamed deltas commit on a coarse timer while the tab is hidden (rAF is
  // frozen there); flushing on refocus paints the accumulated tail in the
  // same frame the tab becomes visible instead of a beat later.
  useEffect(() => {
    if (!store || typeof document === "undefined" || typeof window === "undefined") {
      return;
    }
    const flushIfVisible = () => {
      if (document.visibilityState !== "hidden") {
        store.flush();
      }
    };
    document.addEventListener("visibilitychange", flushIfVisible);
    window.addEventListener("pageshow", flushIfVisible);
    return () => {
      document.removeEventListener("visibilitychange", flushIfVisible);
      window.removeEventListener("pageshow", flushIfVisible);
    };
  }, [store]);

  const subscribeTranscript = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : () => {}),
    [store],
  );
  const getTranscript = useCallback(
    () => (store ? store.getSnapshot() : EMPTY_TRANSCRIPT),
    [store],
  );
  const transcript = useSyncExternalStore(subscribeTranscript, getTranscript, getTranscript);

  const subscribeActivity = useCallback(
    (listener: () => void) => activityStore.subscribe(listener),
    [activityStore],
  );
  const getActivityRevision = useCallback(
    () => activityStore.getSnapshot().revision,
    [activityStore],
  );
  useSyncExternalStore(subscribeActivity, getActivityRevision, getActivityRevision);

  const busy = Boolean(
    conversationId &&
      (transcript.activeRun !== null ||
        hasPendingCommand(conversationId) ||
        activityStore.isRunning(conversationId)),
  );
  void pendingRevision;

  return { transcript, busy };
}
