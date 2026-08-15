import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import type { MutableRefObject } from "react";
import { useCallback, useEffect } from "react";

import type { ActivityStore } from "@/lib/chat/stream/activityStore";
import type { ChatCommandPipeline } from "@/lib/chat/stream/chatCommandPipeline";
import type { TranscriptStoreRegistry } from "@/lib/chat/stream/useConversationChat";
import type { AgentStatus, HistoryDetail } from "@/lib/gatewayTypes";

import { resolveVisibleConversationId } from "../historyUtils";

type Options = {
  activeWorkspaceProjectPath: string;
  activityStore: ActivityStore;
  chatCommandPipeline: ChatCommandPipeline;
  composerDraftCacheRef: MutableRefObject<Map<string, MentionComposerDraft>>;
  composerDraftOwnerRef: MutableRefObject<string>;
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  conversationId: string;
  conversationIdRef: MutableRefObject<string>;
  conversationWorkdirsRef: MutableRefObject<Map<string, string>>;
  getPendingUploadsForConversation: (conversationId: string) => PendingUploadedFile[];
  isAgentMode: boolean;
  isLocalDraftConversationId: (conversationId: string) => boolean;
  selectedHistory: HistoryDetail | null;
  selectedHistoryId: string;
  selectedHistoryIdRef: MutableRefObject<string>;
  selectedHistoryRef: MutableRefObject<HistoryDetail | null>;
  sidebarStore: SidebarStore;
  status: AgentStatus | null;
  statusRef: MutableRefObject<AgentStatus | null>;
  transcriptStoreRegistry: TranscriptStoreRegistry;
};

export function useGatewayConversationState(options: Options) {
  const getVisibleComposerConversationId = useCallback(
    () =>
      resolveVisibleConversationId(
        options.selectedHistoryIdRef.current,
        options.conversationIdRef.current,
      ),
    [options.selectedHistoryIdRef, options.conversationIdRef],
  );
  const cacheVisibleComposerDraft = useCallback(
    (ownerId = options.composerDraftOwnerRef.current) => {
      const targetId = ownerId.trim();
      const composer = options.composerRef.current;
      if (!targetId || options.composerDraftOwnerRef.current !== targetId || !composer) {
        return;
      }
      const draft = composer.getDraft();
      if (draft.isEmpty || !draft.text.trim()) {
        options.composerDraftCacheRef.current.delete(targetId);
      } else {
        options.composerDraftCacheRef.current.set(targetId, draft);
      }
    },
    [options.composerDraftCacheRef, options.composerDraftOwnerRef, options.composerRef],
  );
  const prepareComposerForConversationChange = useCallback(() => {
    cacheVisibleComposerDraft();
    options.composerDraftOwnerRef.current = "";
  }, [cacheVisibleComposerDraft, options.composerDraftOwnerRef]);
  const restoreCachedComposerDraft = useCallback(
    (targetIdInput: string) => {
      const targetId = targetIdInput.trim();
      const composer = options.composerRef.current;
      if (!targetId || !composer) return;
      const draft = options.composerDraftCacheRef.current.get(targetId);
      if (draft) composer.setDraft(draft);
      else composer.clear();
      options.composerDraftOwnerRef.current = targetId;
    },
    [options.composerDraftCacheRef, options.composerDraftOwnerRef, options.composerRef],
  );
  const clearCachedComposerDraft = useCallback(
    (targetIdInput = getVisibleComposerConversationId()) => {
      const targetId = targetIdInput.trim();
      if (targetId) options.composerDraftCacheRef.current.delete(targetId);
    },
    [getVisibleComposerConversationId, options.composerDraftCacheRef],
  );
  const getDisplayedConversationId = useCallback(
    () => getVisibleComposerConversationId().trim(),
    [getVisibleComposerConversationId],
  );
  const isDisplayedConversation = useCallback(
    (targetId: string) =>
      Boolean(targetId.trim()) && getDisplayedConversationId() === targetId.trim(),
    [getDisplayedConversationId],
  );
  const loadComposerHistoryPrompts = useCallback(() => {
    const store = options.transcriptStoreRegistry.peek(getDisplayedConversationId());
    if (!store) return [];
    const prompts: string[] = [];
    for (const row of store.getSnapshot().rows) {
      if (row.kind === "user" && row.text.trim()) prompts.push(row.text);
    }
    return prompts;
  }, [getDisplayedConversationId, options.transcriptStoreRegistry]);
  const applyLiveConversationTitle = useCallback(
    (targetIdInput: string, titleInput: string) => {
      const id = targetIdInput.trim();
      const title = titleInput.trim();
      if (!id || !title) return;
      const now = Date.now();
      const existing = options.sidebarStore.peek(id);
      options.sidebarStore.upsertLocal({
        id,
        title,
        providerId: existing?.providerId ?? "",
        model: existing?.model ?? "",
        sessionId: existing?.sessionId,
        cwd: existing?.cwd,
        messageCount: existing?.messageCount ?? 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing?.updatedAt ?? now,
        isPinned: existing?.isPinned,
        pinnedAt: existing ? existing.pinnedAt : null,
        isShared: existing?.isShared,
        isPending: existing?.isPending,
      });
    },
    [options.sidebarStore],
  );
  const isConversationBusy = useCallback(
    (targetIdInput: string) => {
      const id = targetIdInput.trim();
      return Boolean(
        id &&
          (options.activityStore.isRunning(id) ||
            options.chatCommandPipeline.hasPending(id) ||
            options.transcriptStoreRegistry.peek(id)?.getSnapshot().activeRun != null),
      );
    },
    [options.activityStore, options.chatCommandPipeline, options.transcriptStoreRegistry],
  );

  useEffect(() => {
    options.conversationIdRef.current = options.conversationId;
  }, [options.conversationId, options.conversationIdRef]);
  useEffect(() => {
    options.selectedHistoryIdRef.current = options.selectedHistoryId;
  }, [options.selectedHistoryId, options.selectedHistoryIdRef]);
  useEffect(() => {
    options.statusRef.current = options.status;
  }, [options.status, options.statusRef]);
  useEffect(() => {
    options.selectedHistoryRef.current = options.selectedHistory;
  }, [options.selectedHistory, options.selectedHistoryRef]);
  useEffect(() => {
    const workdir = options.activeWorkspaceProjectPath.trim();
    const id = getDisplayedConversationId();
    if (
      !options.isAgentMode ||
      !workdir ||
      !id ||
      !options.isLocalDraftConversationId(id) ||
      isConversationBusy(id) ||
      (options.transcriptStoreRegistry.peek(id)?.getSnapshot().entryCount ?? 0) > 0 ||
      options.getPendingUploadsForConversation(id).length > 0
    ) {
      return;
    }
    options.conversationWorkdirsRef.current.set(id, workdir);
  }, [
    getDisplayedConversationId,
    isConversationBusy,
    options.activeWorkspaceProjectPath,
    options.conversationWorkdirsRef,
    options.getPendingUploadsForConversation,
    options.isAgentMode,
    options.isLocalDraftConversationId,
    options.transcriptStoreRegistry,
  ]);

  return {
    applyLiveConversationTitle,
    cacheVisibleComposerDraft,
    clearCachedComposerDraft,
    getDisplayedConversationId,
    getVisibleComposerConversationId,
    isConversationBusy,
    isDisplayedConversation,
    loadComposerHistoryPrompts,
    prepareComposerForConversationChange,
    restoreCachedComposerDraft,
  };
}
