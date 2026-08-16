import {
  buildContextUsageScanItems,
  deriveContextUsageTokens,
} from "@liveagent/ui/lib/chat/contextUsage";
import { useMemo } from "react";
import type { CompactionController } from "../../../lib/chat/compaction/controller";
import type { RenderTimelineItem } from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";

export type ContextUsageTokensSourceParams = {
  isRunning: boolean;
  conversationId: string;
  transcriptItems: readonly RenderTimelineItem[];
  liveTranscriptStore: LiveTranscriptStore;
  getCompactionController: (conversationId: string) => CompactionController;
};

/**
 * Pure factory shared by the current conversation (memoized via the hook
 * below) and workbench background panes, which build one source per pane
 * from their runtime cache entry and per-conversation live store.
 */
export function createContextUsageTokensSource(params: ContextUsageTokensSourceParams) {
  const {
    isRunning,
    conversationId,
    transcriptItems,
    liveTranscriptStore,
    getCompactionController,
  } = params;

  let cache: {
    rounds: unknown;
    draft: string;
    runtimeValue: number | undefined;
    value: number | undefined;
  } | null = null;
  return {
    subscribe: liveTranscriptStore.subscribe,
    getContextUsageTokens: () => {
      const live = liveTranscriptStore.getSnapshot();
      const includeLive = isRunning && !live.isSettled;
      const rounds = includeLive ? live.liveRounds : null;
      const draft = includeLive ? live.draftAssistantText : "";
      const runtimeValue = getCompactionController(conversationId).contextUsageTokens;
      if (
        cache &&
        cache.rounds === rounds &&
        cache.draft === draft &&
        cache.runtimeValue === runtimeValue
      ) {
        return cache.value;
      }
      let value: number | undefined;
      if (isRunning && runtimeValue !== undefined) {
        value = runtimeValue;
      } else {
        const transcriptValue = deriveContextUsageTokens(
          buildContextUsageScanItems(transcriptItems, includeLive ? live : null),
        );
        value = transcriptValue ?? runtimeValue;
      }
      cache = { rounds, draft, runtimeValue, value };
      return value;
    },
  };
}

export function useContextUsageTokensSource(params: ContextUsageTokensSourceParams) {
  const {
    isRunning,
    conversationId,
    transcriptItems,
    liveTranscriptStore,
    getCompactionController,
  } = params;

  return useMemo(
    () =>
      createContextUsageTokensSource({
        isRunning,
        conversationId,
        transcriptItems,
        liveTranscriptStore,
        getCompactionController,
      }),
    [conversationId, getCompactionController, isRunning, liveTranscriptStore, transcriptItems],
  );
}
