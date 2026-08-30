import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";

const EMPTY_PENDING_UPLOADS: PendingUploadedFile[] = [];

/** Conversation-keyed observable attachment storage shared by every Pane. */
export function createPendingUploadsRegistry() {
  const filesByConversation = new Map<string, PendingUploadedFile[]>();
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  return {
    get(conversationId: string): PendingUploadedFile[] {
      return filesByConversation.get(conversationId.trim()) ?? EMPTY_PENDING_UPLOADS;
    },
    set(conversationId: string, files: readonly PendingUploadedFile[]): PendingUploadedFile[] {
      const key = conversationId.trim();
      const snapshot = files.slice();
      if (!key) return snapshot;
      if (snapshot.length > 0) filesByConversation.set(key, snapshot);
      else filesByConversation.delete(key);
      emit();
      return snapshot;
    },
    move(previousId: string, nextId: string): void {
      const previous = previousId.trim();
      const next = nextId.trim();
      if (!previous || !next || previous === next) return;
      const files = filesByConversation.get(previous);
      if (files === undefined) return;
      filesByConversation.delete(previous);
      filesByConversation.set(next, files);
      emit();
    },
    clear(): void {
      if (filesByConversation.size === 0) return;
      filesByConversation.clear();
      emit();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type PendingUploadsRegistry = ReturnType<typeof createPendingUploadsRegistry>;
