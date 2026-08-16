import type { QueuedChatTurn } from "../queue/chatTurnQueue";

export type ConversationQueueListener = () => void;

const EMPTY_QUEUE: QueuedChatTurn[] = [];
Object.freeze(EMPTY_QUEUE);

export class ConversationQueueStore {
  #queue: QueuedChatTurn[] = EMPTY_QUEUE;
  readonly #conversationSnapshots = new Map<string, QueuedChatTurn[]>();
  readonly #listenersByConversation = new Map<string, Set<ConversationQueueListener>>();
  readonly #allListeners = new Set<ConversationQueueListener>();

  getAllSnapshot(): QueuedChatTurn[] {
    return this.#queue;
  }

  getSnapshot(conversationId: string): QueuedChatTurn[] {
    return this.#conversationSnapshots.get(conversationId.trim()) ?? EMPTY_QUEUE;
  }

  subscribeAll(listener: ConversationQueueListener): () => void {
    this.#allListeners.add(listener);
    return () => this.#allListeners.delete(listener);
  }

  subscribe(conversationId: string, listener: ConversationQueueListener): () => void {
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

  update(updater: (current: QueuedChatTurn[]) => QueuedChatTurn[]): QueuedChatTurn[] {
    return this.set(updater(this.#queue));
  }

  set(queue: readonly QueuedChatTurn[]): QueuedChatTurn[] {
    const previous = this.#queue;
    const next = queue.slice();
    if (areSameQueue(previous, next)) return previous;
    this.#queue = next;

    const conversationIds = new Set<string>();
    for (const item of previous) conversationIds.add(item.conversationId);
    for (const item of next) conversationIds.add(item.conversationId);

    for (const conversationId of conversationIds) {
      const key = conversationId.trim();
      if (!key) continue;
      const previousSnapshot = this.getSnapshot(key);
      const nextSnapshot = next.filter((item) => item.conversationId === key);
      if (areSameQueue(previousSnapshot, nextSnapshot)) continue;
      if (nextSnapshot.length > 0) {
        this.#conversationSnapshots.set(key, nextSnapshot);
      } else {
        this.#conversationSnapshots.delete(key);
      }
      this.#emitConversation(key);
    }

    for (const listener of Array.from(this.#allListeners)) {
      listener();
    }
    return next;
  }

  clearConversation(conversationId: string): QueuedChatTurn[] {
    const key = conversationId.trim();
    if (!key) return this.#queue;
    return this.set(this.#queue.filter((item) => item.conversationId !== key));
  }

  clear(): void {
    this.set(EMPTY_QUEUE);
  }

  #emitConversation(conversationId: string): void {
    const listeners = this.#listenersByConversation.get(conversationId);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
      listener();
    }
  }
}

function areSameQueue(
  previous: readonly QueuedChatTurn[],
  next: readonly QueuedChatTurn[],
): boolean {
  return previous.length === next.length && previous.every((item, index) => item === next[index]);
}

export function createConversationQueueStore(): ConversationQueueStore {
  return new ConversationQueueStore();
}
