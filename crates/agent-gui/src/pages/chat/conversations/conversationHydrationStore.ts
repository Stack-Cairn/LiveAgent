export type ConversationHydrationPhase = "hydrating" | "failed";

export type ConversationHydrationListener = () => void;

/**
 * Per-conversation hydration lifecycle, bucketed by conversationId so two
 * panes hydrating at once never clobber each other (the legacy page-level
 * single slot could only describe one conversation at a time). Absent key =
 * idle; "hydrating" and "failed" are mutually exclusive per conversation.
 */
export class ConversationHydrationStore {
  readonly #phases = new Map<string, ConversationHydrationPhase>();
  readonly #listenersByConversation = new Map<string, Set<ConversationHydrationListener>>();

  getSnapshot(conversationId: string): ConversationHydrationPhase | null {
    return this.#phases.get(conversationId.trim()) ?? null;
  }

  isHydrating(conversationId: string): boolean {
    return this.getSnapshot(conversationId) === "hydrating";
  }

  isFailed(conversationId: string): boolean {
    return this.getSnapshot(conversationId) === "failed";
  }

  subscribe(conversationId: string, listener: ConversationHydrationListener): () => void {
    const key = conversationId.trim();
    if (!key) return () => undefined;
    const listeners = this.#listenersByConversation.get(key) ?? new Set();
    listeners.add(listener);
    this.#listenersByConversation.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#listenersByConversation.delete(key);
      }
    };
  }

  /** A load started: the conversation is hydrating; a stale fail mark clears. */
  markHydrating(conversationId: string): void {
    this.#set(conversationId, "hydrating");
  }

  /** The load failed: replaces "hydrating"; a retry will mark hydrating again. */
  markFailed(conversationId: string): void {
    this.#set(conversationId, "failed");
  }

  /** The load finished (or was superseded): only clears a "hydrating" mark. */
  clearHydrating(conversationId: string): void {
    this.#clearPhase(conversationId, "hydrating");
  }

  /** Recovery outside retry (e.g. bridge restored the entry): clears "failed". */
  clearFailed(conversationId: string): void {
    this.#clearPhase(conversationId, "failed");
  }

  /** The conversation is gone: drop its bucket entirely. */
  delete(conversationId: string): void {
    const key = conversationId.trim();
    if (!key || !this.#phases.has(key)) return;
    this.#phases.delete(key);
    this.#emit(key);
  }

  /** Global load cancellation (sequence bump invalidated every in-flight load). */
  clearAllHydrating(): void {
    const keys = Array.from(this.#phases.entries())
      .filter(([, phase]) => phase === "hydrating")
      .map(([key]) => key);
    for (const key of keys) {
      this.#phases.delete(key);
      this.#emit(key);
    }
  }

  /** Registry teardown: drop every bucket. */
  clear(): void {
    const keys = Array.from(this.#phases.keys());
    this.#phases.clear();
    for (const key of keys) {
      this.#emit(key);
    }
  }

  #set(conversationId: string, phase: ConversationHydrationPhase): void {
    const key = conversationId.trim();
    if (!key || this.#phases.get(key) === phase) return;
    this.#phases.set(key, phase);
    this.#emit(key);
  }

  #clearPhase(conversationId: string, phase: ConversationHydrationPhase): void {
    const key = conversationId.trim();
    if (!key || this.#phases.get(key) !== phase) return;
    this.#phases.delete(key);
    this.#emit(key);
  }

  #emit(conversationId: string): void {
    const listeners = this.#listenersByConversation.get(conversationId);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
      listener();
    }
  }
}

export function createConversationHydrationStore(): ConversationHydrationStore {
  return new ConversationHydrationStore();
}
