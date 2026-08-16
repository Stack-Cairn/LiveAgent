import type { MentionComposerDraft } from "@liveagent/ui/components/chat/MentionComposer";

export type ConversationDraftListener = () => void;

export class ConversationDraftStore extends Map<string, MentionComposerDraft> {
  readonly #listenersByConversation = new Map<string, Set<ConversationDraftListener>>();

  getSnapshot(conversationId: string): MentionComposerDraft | null {
    return this.get(conversationId.trim()) ?? null;
  }

  subscribe(conversationId: string, listener: ConversationDraftListener): () => void {
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

  set(conversationId: string, draft: MentionComposerDraft): this {
    const key = conversationId.trim();
    if (!key) return this;
    super.set(key, draft);
    this.#emit(key);
    return this;
  }

  delete(conversationId: string): boolean {
    const key = conversationId.trim();
    if (!key) return false;
    const deleted = super.delete(key);
    if (deleted) this.#emit(key);
    return deleted;
  }

  clear(): void {
    const conversationIds = Array.from(this.keys());
    super.clear();
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

export function createConversationDraftStore(): ConversationDraftStore {
  return new ConversationDraftStore();
}
