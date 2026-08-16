import type { ProjectRef } from "@liveagent/ui/lib/workbench/types";
import type {
  ConversationControllerActions,
  ConversationSurfaceController,
  ConversationSurfaceSnapshot,
} from "./conversationControllerTypes";
import type { ConversationRuntimeRegistry } from "./createConversationRuntimeRegistry";

type CreateConversationSurfaceControllerParams = {
  conversationId: string;
  project: ProjectRef;
  registry: ConversationRuntimeRegistry;
  actions: ConversationControllerActions;
};

const IDLE_COMPACTION = { phase: "idle" } as const;

export function createConversationSurfaceController(
  params: CreateConversationSurfaceControllerParams,
): ConversationSurfaceController {
  const conversationId = params.conversationId.trim();
  if (!conversationId) {
    throw new Error("ConversationSurfaceController requires a conversationId.");
  }

  const listeners = new Set<() => void>();
  let unsubscribeRuntime: (() => void) | null = null;
  let unsubscribeDraft: (() => void) | null = null;
  let unsubscribeUploads: (() => void) | null = null;
  let unsubscribeQueue: (() => void) | null = null;
  let unsubscribeApprovals: (() => void) | null = null;
  let disposed = false;
  let snapshot: ConversationSurfaceSnapshot = readSnapshot();

  function readSnapshot(): ConversationSurfaceSnapshot {
    const runtime = params.registry.getSnapshot(conversationId);
    return {
      conversationId,
      project: params.project,
      runtime,
      draft: params.registry.drafts.getSnapshot(conversationId),
      uploads: params.registry.uploads.getSnapshot(conversationId),
      queue: params.registry.queue.getSnapshot(conversationId),
      approvals: params.registry.approvals.getSnapshot(conversationId),
      model: runtime?.selectedModel ?? null,
      compaction: runtime?.compactionStatus ?? IDLE_COMPACTION,
    };
  }

  function refresh(emit: boolean) {
    const next = readSnapshot();
    if (
      next.runtime === snapshot.runtime &&
      next.draft === snapshot.draft &&
      next.uploads === snapshot.uploads &&
      next.queue === snapshot.queue &&
      next.approvals === snapshot.approvals &&
      next.model === snapshot.model &&
      next.compaction === snapshot.compaction
    ) {
      return;
    }
    snapshot = next;
    if (!emit) return;
    for (const listener of Array.from(listeners)) {
      listener();
    }
  }

  function connect() {
    if (unsubscribeRuntime || disposed) return;
    unsubscribeRuntime = params.registry.subscribe(conversationId, () => refresh(true));
    unsubscribeDraft = params.registry.drafts.subscribe(conversationId, () => refresh(true));
    unsubscribeUploads = params.registry.uploads.subscribe(conversationId, () => refresh(true));
    unsubscribeQueue = params.registry.queue.subscribe(conversationId, () => refresh(true));
    unsubscribeApprovals = params.registry.approvals.subscribe(conversationId, () => refresh(true));
  }

  function disconnect() {
    unsubscribeRuntime?.();
    unsubscribeDraft?.();
    unsubscribeUploads?.();
    unsubscribeQueue?.();
    unsubscribeApprovals?.();
    unsubscribeRuntime = null;
    unsubscribeDraft = null;
    unsubscribeUploads = null;
    unsubscribeQueue = null;
    unsubscribeApprovals = null;
  }

  return {
    conversationId,
    project: params.project,
    getSnapshot() {
      refresh(false);
      return snapshot;
    },
    subscribe(listener) {
      if (disposed) return () => undefined;
      connect();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) disconnect();
      };
    },
    retainView() {
      if (disposed) return () => undefined;
      return params.registry.retainView(conversationId);
    },
    setDraft(draft) {
      if (draft.isEmpty) {
        params.registry.drafts.delete(conversationId);
        return;
      }
      params.registry.drafts.set(conversationId, draft);
    },
    clearDraft() {
      params.registry.drafts.delete(conversationId);
    },
    hydrate() {
      return params.actions.hydrate({ conversationId, project: params.project });
    },
    send(draft) {
      return params.actions.send({ conversationId, draft });
    },
    stop() {
      params.actions.stop({ conversationId });
    },
    compact() {
      return params.actions.compact({ conversationId });
    },
    retry() {
      return params.actions.retry({ conversationId });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disconnect();
      listeners.clear();
    },
  };
}
