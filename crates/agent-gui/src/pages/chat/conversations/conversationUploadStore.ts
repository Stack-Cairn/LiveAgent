import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";

export type ConversationUploadListener = () => void;

const EMPTY_UPLOADS: PendingUploadedFile[] = [];
Object.freeze(EMPTY_UPLOADS);

export class ConversationUploadStore {
  readonly #uploadsByConversation = new Map<string, PendingUploadedFile[]>();
  readonly #listenersByConversation = new Map<string, Set<ConversationUploadListener>>();

  getSnapshot(conversationId: string): PendingUploadedFile[] {
    return this.#uploadsByConversation.get(conversationId.trim()) ?? EMPTY_UPLOADS;
  }

  subscribe(conversationId: string, listener: ConversationUploadListener): () => void {
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

  set(conversationId: string, uploads: readonly PendingUploadedFile[]): void {
    const key = conversationId.trim();
    if (!key) return;
    const previous = this.getSnapshot(key);
    const next = uploads.slice();
    if (areSameUploads(previous, next)) return;
    if (next.length > 0) {
      this.#uploadsByConversation.set(key, next);
    } else {
      this.#uploadsByConversation.delete(key);
    }
    this.#emit(key);
  }

  delete(conversationId: string): boolean {
    const key = conversationId.trim();
    if (!key) return false;
    const deleted = this.#uploadsByConversation.delete(key);
    if (deleted) this.#emit(key);
    return deleted;
  }

  clear(): void {
    const conversationIds = Array.from(this.#uploadsByConversation.keys());
    this.#uploadsByConversation.clear();
    for (const conversationId of conversationIds) {
      this.#emit(conversationId);
    }
  }

  #emit(conversationId: string): void {
    const listeners = this.#listenersByConversation.get(conversationId);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
      listener();
    }
  }
}

function areSameUploads(
  previous: readonly PendingUploadedFile[],
  next: readonly PendingUploadedFile[],
): boolean {
  return previous.length === next.length && previous.every((item, index) => item === next[index]);
}

export function createConversationUploadStore(): ConversationUploadStore {
  return new ConversationUploadStore();
}
