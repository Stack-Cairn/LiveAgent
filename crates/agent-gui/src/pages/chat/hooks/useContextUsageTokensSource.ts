import {
  buildContextUsageScanItems,
  deriveContextUsageTokens,
} from "@liveagent/ui/lib/chat/contextUsage";
import { useMemo } from "react";
import type { CompactionController } from "../../../lib/chat/compaction/controller";
import type { RenderTimelineItem } from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";

export function useContextUsageTokensSource(params: {
  isRunning: boolean;
  conversationId: string;
  transcriptItems: readonly RenderTimelineItem[];
  liveTranscriptStore: LiveTranscriptStore;
  getCompactionController: (conversationId: string) => CompactionController;
}) {
  const {
    isRunning,
    conversationId,
    transcriptItems,
    liveTranscriptStore,
    getCompactionController,
  } = params;

  return useMemo(() => {
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
  }, [conversationId, getCompactionController, isRunning, liveTranscriptStore, transcriptItems]);
}
