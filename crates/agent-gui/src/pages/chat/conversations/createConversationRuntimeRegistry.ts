import type { ConversationRuntimeEntry } from "../runtime/chatPageRuntime";
import {
  type ConversationApprovalStore,
  createConversationApprovalStore,
} from "./conversationApprovalStore";
import {
  type ConversationDraftStore,
  createConversationDraftStore,
} from "./conversationDraftStore";
import {
  type ConversationQueueStore,
  createConversationQueueStore,
} from "./conversationQueueStore";
import {
  type ConversationUploadStore,
  createConversationUploadStore,
} from "./conversationUploadStore";

export type ConversationRuntimeListener = () => void;

export class ConversationRuntimeRegistry extends Map<string, ConversationRuntimeEntry> {
  readonly #listenersByConversation = new Map<string, Set<ConversationRuntimeListener>>();
  readonly #viewCounts = new Map<string, number>();
  readonly drafts: ConversationDraftStore;
  readonly uploads: ConversationUploadStore;
  readonly queue: ConversationQueueStore;
  readonly approvals: ConversationApprovalStore;

  constructor(
    entries?: Iterable<readonly [string, ConversationRuntimeEntry]>,
    drafts = createConversationDraftStore(),
    uploads = createConversationUploadStore(),
    queue = createConversationQueueStore(),
    approvals = createConversationApprovalStore(),
  ) {
    super();
    this.drafts = drafts;
    this.uploads = uploads;
    this.queue = queue;
    this.approvals = approvals;
    if (!entries) return;
    for (const [conversationId, entry] of entries) {
      super.set(conversationId.trim(), entry);
    }
  }

  getSnapshot(conversationId: string): ConversationRuntimeEntry | null {
    return this.get(conversationId.trim()) ?? null;
  }

  subscribe(conversationId: string, listener: ConversationRuntimeListener): () => void {
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

  set(conversationId: string, entry: ConversationRuntimeEntry): this {
    const key = conversationId.trim();
    if (!key) return this;
    super.set(key, entry);
    this.#emit(key);
    return this;
  }

  setRuntimeEntry(conversationId: string, entry: ConversationRuntimeEntry): void {
    const key = conversationId.trim();
    if (!key) return;
    if (super.has(key)) {
      super.delete(key);
    }
    super.set(key, entry);
    this.#emit(key);
  }

  delete(conversationId: string): boolean {
    const key = conversationId.trim();
    if (!key) return false;
    const deletedRuntime = super.delete(key);
    const deletedDraft = this.drafts.delete(key);
    if (deletedRuntime || deletedDraft) {
      this.#viewCounts.delete(key);
    }
    if (deletedRuntime) {
      this.#emit(key);
    }
    return deletedRuntime || deletedDraft;
  }

  clear(): void {
    const conversationIds = Array.from(this.keys());
    super.clear();
    this.drafts.clear();
    this.#viewCounts.clear();
    for (const conversationId of conversationIds) {
      this.#emit(conversationId);
    }
  }

  retainView(conversationId: string): () => void {
    const key = conversationId.trim();
    if (!key) return () => undefined;
    this.#viewCounts.set(key, (this.#viewCounts.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseView(key);
    };
  }

  releaseView(conversationId: string): void {
    const key = conversationId.trim();
    const count = this.#viewCounts.get(key) ?? 0;
    if (count <= 1) {
      this.#viewCounts.delete(key);
      return;
    }
    this.#viewCounts.set(key, count - 1);
  }

  getViewCount(conversationId: string): number {
    return this.#viewCounts.get(conversationId.trim()) ?? 0;
  }

  #emit(conversationId: string): void {
    const listeners = this.#listenersByConversation.get(conversationId);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
      listener();
    }
  }
}

export function createConversationRuntimeRegistry(
  entries?: Iterable<readonly [string, ConversationRuntimeEntry]>,
): ConversationRuntimeRegistry {
  return new ConversationRuntimeRegistry(entries);
}
